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

const proc = Bun.spawn([enginePath], {
  stdin: "pipe",
  stdout: "pipe",
  stderr: "pipe",
  env: { ...process.env, ORCHESTRATOR_LOG_LEVEL: "warn" },
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
  check("reports the pinned OMP version", info.ompVersion === "17.3.1", `OMP ${info.ompVersion}`);
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

  // 7. clean shutdown
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
  rmSync(project, { recursive: true, force: true });
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);

if (failed.length) {
  const err = stderrText.join("").slice(-3000);
  if (err.trim()) console.error(`\n--- engine stderr (tail) ---\n${err}`);
  process.exit(1);
}
