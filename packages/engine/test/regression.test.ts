/**
 * PERMANENT REGRESSIONS — bugs found once, encoded forever.
 *
 * 1. Paths with spaces: this repo itself lives under "Desktop/The Orchestrator";
 *    worker spawning must never percent-encode paths (new URL().pathname bug).
 * 2. Duplicate completion: a turn yields exactly ONE authoritative
 *    session.finished, and an aborted turn can never become "completed".
 * 3. Worker crash: a killed worker interrupts only its own session, is removed
 *    from routing, and later routing errors are actionable.
 * 4. Fork: upstream forkFrom semantics — history preserved, new identity,
 *    original untouched, both immediately runnable.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ompAgentDir } from "@orchestrator/omp-adapter";
import type { ProductEvent } from "@orchestrator/protocol";
import { RuntimeManager } from "../src/runtime-manager";
import { type MockServer, startMockProvider } from "./mock-provider";

let mock: MockServer;
let manager: RuntimeManager;
const roots: string[] = [];
const captured = new Map<string, ProductEvent[]>();

const eventsFor = (id: string) => captured.get(id) ?? [];
const finishedFor = (id: string) =>
  eventsFor(id).filter(
    (e): e is Extract<ProductEvent, { type: "session.finished" }> => e.type === "session.finished",
  );
const textFor = (id: string) =>
  eventsFor(id)
    .filter(
      (e): e is Extract<ProductEvent, { type: "assistant.text" }> => e.type === "assistant.text",
    )
    .map((e) => e.delta)
    .join("");

async function waitFor(pred: () => boolean, timeoutMs = 30_000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (pred()) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return false;
}

function makeProject(tag: string): string {
  const dir = mkdtempSync(join(tmpdir(), `orch-reg-${tag}-`));
  writeFileSync(join(dir, "MARKER.txt"), `${tag}\n`);
  roots.push(dir);
  return dir;
}

beforeAll(async () => {
  mock = startMockProvider();
  manager = new RuntimeManager({
    agentDir: ompAgentDir(),
    testMode: true,
    workerEnv: {
      testProviders: [
        {
          name: "mockprov",
          baseUrl: mock.url,
          apiKey: "mock-key",
          modelIds: ["mock-alpha", "mock-bravo", "mock-one", "mock-slow"],
        },
      ],
    },
    emit: (e) => {
      const list = captured.get(e.sessionId);
      if (list) list.push(e);
      else captured.set(e.sessionId, [e]);
    },
  });
  await manager.init();
});

afterAll(async () => {
  await manager?.shutdown();
  mock?.stop();
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

describe("path handling", () => {
  test("a project path containing spaces runs tools in the right directory", async () => {
    const base = mkdtempSync(join(tmpdir(), "orch-reg-space-"));
    roots.push(base);
    const dir = join(base, "My Project With Spaces");
    mkdirSync(dir);
    writeFileSync(join(dir, "MARKER.txt"), "spaces\n");

    const s = await manager.create({
      projectPath: dir,
      title: "Spaces",
      model: "mockprov/mock-alpha",
      advisors: [],
    });
    await manager.route(s.sessionId, "session.prompt", { sessionId: s.sessionId, text: "go" });
    expect(await waitFor(() => finishedFor(s.sessionId).length > 0)).toBe(true);

    const toolEnd = eventsFor(s.sessionId).find((e) => e.type === "tool.end") as any;
    expect(toolEnd?.ok).toBe(true);
    // pwd output proves the tool ran inside the spaced path, un-mangled.
    expect(String(toolEnd?.output ?? "")).toContain("My Project With Spaces");
    expect(String(toolEnd?.output ?? "")).not.toContain("%20");
  }, 60_000);
});

describe("completion authority", () => {
  test("an aborted turn finishes exactly once, as interrupted, never completed", async () => {
    const s = await manager.create({
      projectPath: makeProject("abort"),
      title: "Abort",
      model: "mockprov/mock-slow",
      advisors: [],
    });
    await manager.route(s.sessionId, "session.prompt", { sessionId: s.sessionId, text: "go" });
    expect(await waitFor(() => textFor(s.sessionId).length > 0)).toBe(true);
    await manager.route(s.sessionId, "session.abort", { sessionId: s.sessionId });

    expect(await waitFor(() => finishedFor(s.sessionId).length > 0)).toBe(true);
    // Let any racing emitter fire before asserting exact-once.
    await new Promise((r) => setTimeout(r, 500));
    expect(finishedFor(s.sessionId).length).toBe(1);
    expect(finishedFor(s.sessionId)[0].runState).toBe("interrupted");

    // A later state event must never claim completion for the aborted turn.
    const states = eventsFor(s.sessionId).filter((e) => e.type === "session.state") as any[];
    const afterFinish = states.slice(states.findIndex((e) => e.runState === "interrupted"));
    expect(afterFinish.every((e) => e.runState !== "completed")).toBe(true);
  }, 60_000);

  test("a normal turn also finishes exactly once", async () => {
    const s = await manager.create({
      projectPath: makeProject("once"),
      title: "Once",
      model: "mockprov/mock-bravo",
      advisors: [],
    });
    await manager.route(s.sessionId, "session.prompt", { sessionId: s.sessionId, text: "go" });
    expect(await waitFor(() => finishedFor(s.sessionId).length > 0)).toBe(true);
    await new Promise((r) => setTimeout(r, 500));
    expect(finishedFor(s.sessionId).length).toBe(1);
    expect(finishedFor(s.sessionId)[0].runState).toBe("completed");
  }, 60_000);
});

describe("worker crash containment", () => {
  test("killing one worker interrupts only that session and unregisters it", async () => {
    const victim = await manager.create({
      projectPath: makeProject("victim"),
      title: "Victim",
      model: "mockprov/mock-slow",
      advisors: [],
    });
    const bystander = await manager.create({
      projectPath: makeProject("bystander"),
      title: "Bystander",
      model: "mockprov/mock-one",
      advisors: [],
    });

    await manager.route(victim.sessionId, "session.prompt", {
      sessionId: victim.sessionId,
      text: "go",
    });
    expect(await waitFor(() => textFor(victim.sessionId).length > 0)).toBe(true);

    const stats = await manager.workerStats();
    const pid = stats.find((w) => w.sessionId === victim.sessionId)?.pid;
    expect(pid).toBeGreaterThan(0);
    process.kill(pid!, "SIGKILL");

    // The crash is reported as interruption with a preserved-transcript note…
    expect(
      await waitFor(() =>
        eventsFor(victim.sessionId).some(
          (e) => e.type === "session.failed" && (e as any).error?.kind === "engine",
        ),
      ),
    ).toBe(true);
    expect(await waitFor(() => finishedFor(victim.sessionId).length > 0)).toBe(true);
    expect(finishedFor(victim.sessionId)[0].runState).toBe("interrupted");

    // …the dead worker no longer routes, with an actionable error…
    expect(manager.has(victim.sessionId)).toBe(false);
    await expect(
      manager.route(victim.sessionId, "session.prompt", {
        sessionId: victim.sessionId,
        text: "again",
      }),
    ).rejects.toThrow(/resume/i);

    // …and the bystander is untouched.
    await manager.route(bystander.sessionId, "session.prompt", {
      sessionId: bystander.sessionId,
      text: "go",
    });
    expect(await waitFor(() => finishedFor(bystander.sessionId).length > 0)).toBe(true);
    expect(finishedFor(bystander.sessionId)[0].runState).toBe("completed");
  }, 90_000);
});

describe("session fork", () => {
  test("fork preserves history, gets a new identity, and both sides keep working", async () => {
    const project = makeProject("fork");
    const original = await manager.create({
      projectPath: project,
      title: "Original",
      model: "mockprov/mock-alpha",
      advisors: [],
    });
    await manager.route(original.sessionId, "session.prompt", {
      sessionId: original.sessionId,
      text: "first turn",
    });
    expect(await waitFor(() => finishedFor(original.sessionId).length > 0)).toBe(true);

    const sourcePath = manager
      .list()
      .find((s) => s.sessionId === original.sessionId)?.ompSessionPath;
    expect(sourcePath).toBeTruthy();
    const originalBytes = readFileSync(sourcePath!, "utf8");

    const fork = await manager.fork({
      sourcePath: sourcePath!,
      projectPath: project,
      title: "Forked",
      model: "mockprov/mock-bravo",
    });
    expect(fork.sessionId).not.toBe(original.sessionId);

    const forkPath = manager.list().find((s) => s.sessionId === fork.sessionId)?.ompSessionPath;
    expect(forkPath).toBeTruthy();
    expect(forkPath).not.toBe(sourcePath);
    expect(existsSync(forkPath!)).toBe(true);

    // The fork carries the original's history and records its lineage.
    const forkBytes = readFileSync(forkPath!, "utf8");
    expect(forkBytes).toContain("ALPHA-FROM-TOOL");
    const header = JSON.parse(
      forkBytes.split("\n").find((l) => l.includes('"type":"session"')) ?? "{}",
    );
    expect(header.parentSession).toBeTruthy();

    // Fork runs on its own model without disturbing the original…
    await manager.route(fork.sessionId, "session.prompt", {
      sessionId: fork.sessionId,
      text: "fork turn",
    });
    expect(await waitFor(() => finishedFor(fork.sessionId).length > 0)).toBe(true);
    expect(textFor(fork.sessionId)).toContain("BRAVO");

    // …whose file is byte-identical until IT is prompted again.
    expect(readFileSync(sourcePath!, "utf8")).toBe(originalBytes);

    // The original continues independently; histories diverge safely.
    await manager.route(original.sessionId, "session.prompt", {
      sessionId: original.sessionId,
      text: "second original turn",
    });
    expect(await waitFor(() => finishedFor(original.sessionId).length >= 2)).toBe(true);
    expect(readFileSync(forkPath!, "utf8")).not.toContain("second original turn");
  }, 90_000);
});
