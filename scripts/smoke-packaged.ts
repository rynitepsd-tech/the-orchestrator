/**
 * Packaged smoke test.
 *
 * Drives the engine binary INSIDE the built .app, not a dev-server build. This
 * is the test that catches the failures that only exist once packaged: a
 * missing native addon, an architecture mismatch, a bundler-stripped dynamic
 * import, or config discovery that worked only from a source checkout.
 *
 * Verifies the packaged engine can: start, discover the user's OMP config,
 * load the model registry, create a session, run a real tool, persist, and quit.
 *
 * Usage: bun run scripts/smoke-packaged.ts [path/to/The Orchestrator.app]
 */
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const DEFAULT_APP = resolve(
  import.meta.dir,
  "..",
  "apps/desktop/src-tauri/target/release/bundle/macos/The Orchestrator.app",
);

const appPath = process.argv[2] ?? DEFAULT_APP;
const enginePath = join(appPath, "Contents/Resources/engine/orchestrator-engine");

if (!existsSync(enginePath)) {
  console.error(`✗ engine not found inside the app bundle:\n  ${enginePath}`);
  console.error("  Run: bun run build:engine && bun run app");
  process.exit(1);
}

const results: Array<{ name: string; ok: boolean; detail?: string }> = [];
const check = (name: string, ok: boolean, detail?: string) => {
  results.push({ name, ok, detail });
  console.log(`${ok ? "✓" : "✗"} ${name}${detail ? ` — ${detail}` : ""}`);
};

// --- architecture ----------------------------------------------------------
const file = Bun.spawnSync(["file", "-b", enginePath]);
const arch = new TextDecoder().decode(file.stdout).trim();
const hostArch = process.arch === "arm64" ? "arm64" : "x86_64";
check("engine architecture matches host", arch.includes(hostArch), `${arch.slice(0, 60)}`);

const addon = join(appPath, "Contents/Resources/engine", `pi_natives.darwin-${process.arch}.node`);
check("native addon ships beside the engine", existsSync(addon));

// --- boot the packaged engine ---------------------------------------------
const project = mkdtempSync(join(tmpdir(), "orch-smoke-"));
writeFileSync(join(project, "SMOKE.txt"), "packaged smoke test\n");

// A local mock provider so the packaged app can run a REAL session, with a
// real tool call, without spending a cent of the user's API credit.
const { startMockProvider } = await import("../packages/engine/test/mock-provider");
const mock = startMockProvider();

const proc = Bun.spawn([enginePath], {
  stdin: "pipe",
  stdout: "pipe",
  stderr: "pipe",
  env: {
    ...process.env,
    ORCHESTRATOR_LOG_LEVEL: "warn",
    ORCHESTRATOR_TEST_MODE: "1",
    ORCHESTRATOR_TEST_PROVIDERS: JSON.stringify([
      { name: "mockprov", baseUrl: mock.url, apiKey: "mock-key", modelIds: ["mock-smoke"] },
    ]),
  },
});

const frames: any[] = [];
let buf = "";
const td = new TextDecoder();

const pump = (async () => {
  const reader = proc.stdout.getReader();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += td.decode(value, { stream: true });
    let i: number;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      if (line.trim()) {
        try {
          frames.push(JSON.parse(line));
        } catch {
          /* non-protocol line on stdout would be a bug; ignored here */
        }
      }
    }
  }
})();

const stderrText: string[] = [];
void (async () => {
  const reader = proc.stderr.getReader();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    stderrText.push(td.decode(value, { stream: true }));
  }
})();

const send = (type: string, payload: unknown, requestId: string) =>
  proc.stdin.write(`${JSON.stringify({ protocolVersion: 1, requestId, type, payload })}\n`);

async function waitFor(pred: () => boolean, ms = 90_000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (pred()) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return false;
}

const findResp = (id: string) => frames.find((f) => f.requestId === id);
const findEvent = (t: string) => frames.find((f) => f.event?.type === t);

try {
  // 1. starts and reports ready
  const ready = await waitFor(() => !!findEvent("engine.ready"), 90_000);
  check("packaged engine starts and reaches ready", ready);
  if (!ready) throw new Error("engine never became ready");

  const info = findEvent("engine.ready").event.info;
  check("reports the pinned OMP version", info.ompVersion === "17.3.8", `OMP ${info.ompVersion}`);
  check("engine architecture reported", info.arch === process.arch, info.arch);

  // 2. discovers the user's real OMP config
  check(
    "discovers the OMP agent directory",
    typeof info.agentDir === "string" && info.agentDir.includes(".omp"),
    info.agentDir,
  );

  // 3. model registry loads
  send("models.list", {}, "m1");
  await waitFor(() => !!findResp("m1"), 120_000);
  const models = findResp("m1");
  const count = models?.result?.models?.length ?? 0;
  check("model registry loads", models?.ok === true && count > 0, `${count} models`);

  // 4. providers resolve from existing credentials
  send("providers.list", {}, "p1");
  await waitFor(() => !!findResp("p1"));
  const provs = findResp("p1");
  const authed = (provs?.result?.providers ?? []).filter((p: any) => p.authenticated);
  check("reuses existing OMP credentials", provs?.ok === true, `${authed.length} authenticated`);

  // 5. project opens
  send("project.open", { path: project }, "o1");
  await waitFor(() => !!findResp("o1"));
  check("opens a project", findResp("o1")?.ok === true);

  // 6. session discovery works against real session storage
  send("sessions.discover", {}, "d1");
  await waitFor(() => !!findResp("d1"), 60_000);
  const disc = findResp("d1");
  check(
    "discovers persisted OMP sessions",
    disc?.ok === true,
    `${disc?.result?.sessions?.length ?? 0} found`,
  );

  // 7. THE REAL TEST: create a session in the packaged app and run a tool.
  send(
    "sessions.create",
    { projectPath: project, title: "Smoke", model: "mockprov/mock-smoke", advisors: [] },
    "c1",
  );
  await waitFor(() => !!findResp("c1"), 90_000);
  const created = findResp("c1");
  check("creates a session in a worker process", created?.ok === true, created?.error?.message);

  if (created?.ok) {
    const sid = created.result.session.sessionId;

    send("session.prompt", { sessionId: sid, text: "smoke", whenBusy: "steer" }, "pr1");
    await waitFor(() => !!findResp("pr1"), 30_000);
    check("accepts a prompt", findResp("pr1")?.ok === true);

    const finished = await waitFor(
      () => frames.some((f) => f.event?.type === "session.finished"),
      120_000,
    );
    check("streams a turn to completion", finished);

    const toolEnd = frames.find((f) => f.event?.type === "tool.end");
    check(
      "executes a real tool inside the packaged app",
      !!toolEnd && toolEnd.event.ok === true,
      toolEnd ? `${toolEnd.event.callId}` : "no tool.end event",
    );
    check(
      "tool ran in the session's own project directory",
      !!toolEnd && String(toolEnd.event.output ?? "").includes("SMOKE-FROM-TOOL"),
    );

    const persisted = frames.find((f) => f.event?.type === "session.persisted");
    check(
      "persists the session where OMP can find it",
      !!persisted && String(persisted.event.ompSessionPath).includes(".omp/agent/sessions"),
    );

    send("usage.session", { sessionId: sid }, "u1");
    await waitFor(() => !!findResp("u1"), 20_000);
    const usage = findResp("u1");
    const tot = usage?.result?.breakdown?.total;
    check(
      "attributes usage for the session",
      usage?.ok === true && (tot?.inputTokens ?? 0) > 0,
      tot ? `${tot.inputTokens} in / ${tot.outputTokens} out` : undefined,
    );

    // 7b. transcript replay from the worker's history buffer
    send("session.transcript", { sessionId: sid }, "t1");
    await waitFor(() => !!findResp("t1"), 20_000);
    const replay = findResp("t1");
    const replayTypes = new Set((replay?.result?.events ?? []).map((e: any) => e.type));
    check(
      "serves transcript replay",
      replay?.ok === true && replayTypes.has("user.message") && replayTypes.has("tool.end"),
      `${replay?.result?.events?.length ?? 0} events`,
    );

    // 7c. fork with upstream semantics, packaged
    send("session.fork", { sessionId: sid, title: "Smoke fork" }, "f1");
    await waitFor(() => !!findResp("f1"), 90_000);
    const forked = findResp("f1");
    check(
      "forks the session into a new live worker",
      forked?.ok === true && forked.result.session.sessionId !== sid,
      forked?.error?.message,
    );

    // 7d. the approval bridge, end to end in the packaged binary
    send(
      "sessions.create",
      {
        projectPath: project,
        title: "Smoke approval",
        model: "mockprov/mock-smoke",
        advisors: [],
        approvalMode: "always-ask",
      },
      "c2",
    );
    await waitFor(() => !!findResp("c2"), 90_000);
    const created2 = findResp("c2");
    check("creates a gated session", created2?.ok === true, created2?.error?.message);
    if (created2?.ok) {
      const sid2 = created2.result.session.sessionId;
      send("session.prompt", { sessionId: sid2, text: "smoke", whenBusy: "steer" }, "pr2");
      const gotApproval = await waitFor(
        () =>
          frames.some((f) => f.event?.type === "approval.request" && f.event.sessionId === sid2),
        60_000,
      );
      check("gated tool blocks on approval", gotApproval);
      if (gotApproval) {
        const req = frames.find(
          (f) => f.event?.type === "approval.request" && f.event.sessionId === sid2,
        ).event;
        send(
          "approval.respond",
          { sessionId: sid2, approvalId: req.approvalId, optionId: "allow_once" },
          "a1",
        );
        const done2 = await waitFor(
          () =>
            frames.some((f) => f.event?.type === "session.finished" && f.event.sessionId === sid2),
          120_000,
        );
        const tool2 = frames.find(
          (f) => f.event?.type === "tool.end" && f.event.sessionId === sid2,
        );
        check("approval releases the tool", done2 && tool2?.event?.ok === true);
      }
    }
  }

  // 8. clean shutdown
  send("engine.shutdown", {}, "s1");
  await waitFor(() => !!findResp("s1"), 20_000);
  check("acknowledges shutdown", findResp("s1")?.ok === true);

  const exited = await Promise.race([
    proc.exited.then(() => true),
    new Promise<boolean>((r) => setTimeout(() => r(false), 15_000)),
  ]);
  check("exits cleanly without orphaning", exited);
} catch (e) {
  check("smoke run completed", false, String((e as Error)?.message ?? e));
} finally {
  try {
    proc.kill();
  } catch {
    /* already gone */
  }
  await pump.catch(() => {});
  mock.stop();
  rmSync(project, { recursive: true, force: true });
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);

if (failed.length) {
  const err = stderrText.join("").slice(-3000);
  if (err.trim()) console.error(`\n--- engine stderr (tail) ---\n${err}`);
  process.exit(1);
}
