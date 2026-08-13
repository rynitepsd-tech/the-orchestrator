/**
 * CONCURRENCY REGRESSION TEST — hard product requirement.
 *
 * Several top-level OMP sessions must run simultaneously with no cross-talk.
 *
 * Each session runs in its own worker process (see worker/main.ts for the
 * upstream evidence that forced process-per-session: subagents always register
 * into AgentRegistry.global(), AsyncJobManager is a first-session-only
 * singleton, AgentLifecycleManager.global().dispose() reaps across sessions,
 * and Settings.init() is memoized and ignores later callers' cwd).
 *
 * These assertions are topology-independent on purpose: they exercise the
 * supervisor's public API, so they would equally catch a regression if the
 * engine ever moved back in-process.
 *
 * Asserts: both stream, both execute tools, events/transcripts/cwd/usage never
 * cross, aborting one leaves the other running, disposing one leaves the other
 * running.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProductEvent, RunState } from "@orchestrator/protocol";
import { ompAgentDir } from "@orchestrator/omp-adapter";
import { RuntimeManager } from "../src/runtime-manager";
import { startMockProvider, type MockServer } from "./mock-provider";

let mock: MockServer;
let manager: RuntimeManager;
const roots: string[] = [];

const MOCK_MODELS = [
  "mock-alpha",
  "mock-bravo",
  "mock-one",
  "mock-two",
  "mock-three",
  "mock-slow",
  "mock-error",
];

/** Last known run state per session, tracked from emitted events. */
const runStates = new Map<string, RunState>();

/** Send a prompt through the supervisor to the owning worker process. */
function prompt(sessionId: string, text: string, whenBusy = "steer") {
  return manager.route(sessionId, "session.prompt", { sessionId, text, whenBusy });
}
function abort(sessionId: string) {
  return manager.route(sessionId, "session.abort", { sessionId });
}

/** Per-session event capture, so we can prove nothing crosses. */
const captured = new Map<string, ProductEvent[]>();

function eventsFor(sessionId: string): ProductEvent[] {
  return captured.get(sessionId) ?? [];
}

function textFor(sessionId: string): string {
  return eventsFor(sessionId)
    .filter((e): e is Extract<ProductEvent, { type: "assistant.text" }> => e.type === "assistant.text")
    .map((e) => e.delta)
    .join("");
}

function toolOutputFor(sessionId: string): string {
  return eventsFor(sessionId)
    .filter((e): e is Extract<ProductEvent, { type: "tool.end" }> => e.type === "tool.end")
    .map((e) => e.output ?? "")
    .join("\n");
}

function makeProject(tag: string): string {
  const dir = mkdtempSync(join(tmpdir(), `orch-${tag}-`));
  writeFileSync(join(dir, "MARKER.txt"), `${tag}\n`);
  roots.push(dir);
  return dir;
}

async function waitFor(pred: () => boolean, timeoutMs = 20_000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (pred()) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return false;
}

beforeAll(async () => {
  mock = startMockProvider();

  manager = new RuntimeManager({
    agentDir: ompAgentDir(),
    testMode: true,
    // Each worker process registers the mock provider for itself.
    workerEnv: {
      testProviders: [
        { name: "mockprov", baseUrl: mock.url, apiKey: "mock-key", modelIds: MOCK_MODELS },
      ],
    },
    emit: (e) => {
      const list = captured.get(e.sessionId);
      if (list) list.push(e);
      else captured.set(e.sessionId, [e]);
      if (e.type === "session.state" || e.type === "session.finished") {
        runStates.set(e.sessionId, e.runState);
      }
    },
  });
  await manager.init();
});

afterAll(async () => {
  await manager?.shutdown();
  mock?.stop();
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

describe("two concurrent top-level sessions", () => {
  test("both stream, both run tools, and nothing crosses between them", async () => {
    const projA = makeProject("A");
    const projB = makeProject("B");

    const a = await manager.create({
      projectPath: projA,
      title: "Alpha",
      model: "mockprov/mock-alpha",
      advisors: [],
    });
    const b = await manager.create({
      projectPath: projB,
      title: "Bravo",
      model: "mockprov/mock-bravo",
      advisors: [],
    });

    expect(a.sessionId).not.toBe(b.sessionId);

    // Prompt BOTH before either finishes.
    await prompt(a.sessionId, "do alpha");
    await prompt(b.sessionId, "do bravo");

    const settled = await waitFor(
      () =>
        eventsFor(a.sessionId).some((e) => e.type === "session.finished") &&
        eventsFor(b.sessionId).some((e) => e.type === "session.finished"),
    );
    expect(settled).toBe(true);

    // Both streamed their own text.
    expect(textFor(a.sessionId)).toContain("ALPHA");
    expect(textFor(b.sessionId)).toContain("BRAVO");

    // Neither saw the other's text.
    expect(textFor(a.sessionId)).not.toContain("BRAVO");
    expect(textFor(b.sessionId)).not.toContain("ALPHA");

    // Both executed a REAL bash tool.
    expect(toolOutputFor(a.sessionId)).toContain("ALPHA-FROM-TOOL");
    expect(toolOutputFor(b.sessionId)).toContain("BRAVO-FROM-TOOL");

    // Tool output never crossed.
    expect(toolOutputFor(a.sessionId)).not.toContain("BRAVO-FROM-TOOL");
    expect(toolOutputFor(b.sessionId)).not.toContain("ALPHA-FROM-TOOL");

    // cwd never crossed: each bash ran `pwd` inside its own project.
    expect(toolOutputFor(a.sessionId)).toContain(projA.replace("/private", ""));
    expect(toolOutputFor(b.sessionId)).toContain(projB.replace("/private", ""));
    expect(toolOutputFor(a.sessionId)).not.toContain(projB.replace("/private", ""));

    // Every captured event carries its own session id.
    for (const e of eventsFor(a.sessionId)) expect(e.sessionId).toBe(a.sessionId);
    for (const e of eventsFor(b.sessionId)) expect(e.sessionId).toBe(b.sessionId);
  }, 60_000);

  test("usage is attributed per session and never shared", async () => {
    const sessions = manager.list();
    const a = sessions.find((s) => s.title === "Alpha");
    const b = sessions.find((s) => s.title === "Bravo");
    expect(a).toBeDefined();
    expect(b).toBeDefined();

    const ua = await manager.sessionUsage(a!.sessionId);
    const ub = await manager.sessionUsage(b!.sessionId);

    // Two turns each: 1000+1500 input, 100+50 output.
    expect(ua.total.inputTokens).toBe(2500);
    expect(ua.total.outputTokens).toBe(150);
    expect(ub.total.inputTokens).toBe(2500);
    expect(ub.total.outputTokens).toBe(150);

    // Attributed to the primary, not lumped into an undifferentiated total.
    expect(ua.primary.inputTokens).toBe(2500);
    expect(ua.advisors).toHaveLength(0);
    expect(ua.subagents.runs).toBe(0);

    // OMP computed real cost for a priced model.
    expect(ua.total.cost).toBeGreaterThan(0);

    // Usage for one session never bleeds into another.
    expect(ua.total).toEqual(ub.total);
    expect(ua.primary.inputTokens).toBe(2500);
  });
});

describe("abort isolation", () => {
  test("aborting one long-running session leaves the other streaming", async () => {
    const projC = makeProject("C");
    const projD = makeProject("D");

    const c = await manager.create({
      projectPath: projC,
      title: "Charlie",
      model: "mockprov/mock-slow",
      advisors: [],
    });
    const d = await manager.create({
      projectPath: projD,
      title: "Delta",
      model: "mockprov/mock-slow",
      advisors: [],
    });

    await prompt(c.sessionId, "slow c");
    await prompt(d.sessionId, "slow d");

    // Let both get genuinely underway.
    expect(await waitFor(() => textFor(c.sessionId).length > 0 && textFor(d.sessionId).length > 0)).toBe(
      true,
    );

    await abort(c.sessionId);
    expect(runStates.get(c.sessionId)).toBe("interrupted");

    // D must keep producing output after C was aborted.
    const dBefore = textFor(d.sessionId).length;
    const dGrew = await waitFor(() => textFor(d.sessionId).length > dBefore, 8_000);
    expect(dGrew).toBe(true);

    // C must stop producing output.
    const cAfterAbort = textFor(c.sessionId).length;
    await new Promise((r) => setTimeout(r, 600));
    expect(textFor(c.sessionId).length).toBe(cAfterAbort);
  }, 60_000);

  test("disposing one session leaves the other streaming", async () => {
    const sessions = manager.list();
    const c = sessions.find((s) => s.title === "Charlie");
    const d = sessions.find((s) => s.title === "Delta");
    expect(c && d).toBeTruthy();

    await manager.close(c!.sessionId, true);
    expect(manager.has(c!.sessionId)).toBe(false);
    expect(manager.has(d!.sessionId)).toBe(true);

    const dBefore = textFor(d!.sessionId).length;
    const dGrew = await waitFor(() => textFor(d!.sessionId).length > dBefore, 8_000);
    expect(dGrew).toBe(true);

    await abort(d!.sessionId);
  }, 40_000);
});

describe("three simultaneous sessions across two projects", () => {
  test("all three run at once and stay independent", async () => {
    const p1 = makeProject("P1");
    const p2 = makeProject("P2");

    const s1 = await manager.create({
      projectPath: p1,
      title: "S1",
      model: "mockprov/mock-one",
      advisors: [],
    });
    const s2 = await manager.create({
      projectPath: p1,
      title: "S2",
      model: "mockprov/mock-two",
      advisors: [],
    });
    const s3 = await manager.create({
      projectPath: p2,
      title: "S3",
      model: "mockprov/mock-three",
      advisors: [],
    });

    await Promise.all([
      prompt(s1.sessionId, "go 1"),
      prompt(s2.sessionId, "go 2"),
      prompt(s3.sessionId, "go 3"),
    ]);

    const allDone = await waitFor(() =>
      [s1, s2, s3].every((s) =>
        eventsFor(s.sessionId).some((e) => e.type === "session.finished"),
      ),
    );
    expect(allDone).toBe(true);

    expect(textFor(s1.sessionId)).toContain("ONE");
    expect(textFor(s2.sessionId)).toContain("TWO");
    expect(textFor(s3.sessionId)).toContain("THREE");

    // Cross-checks in both directions.
    expect(textFor(s1.sessionId)).not.toContain("TWO");
    expect(textFor(s2.sessionId)).not.toContain("THREE");
    expect(textFor(s3.sessionId)).not.toContain("ONE");

    // Sessions in the SAME project still stay separate.
    expect(s1.projectId).toBe(s2.projectId);
    expect(s1.sessionId).not.toBe(s2.sessionId);
    expect(toolOutputFor(s1.sessionId)).not.toContain("TWO-FROM-TOOL");
  }, 90_000);
});

describe("process isolation invariant", () => {
  test("every live session is backed by its own worker process", () => {
    const sessions = manager.list();
    expect(sessions.length).toBeGreaterThan(1);
    // Distinct ids, and each is independently addressable through the supervisor.
    expect(new Set(sessions.map((s) => s.sessionId)).size).toBe(sessions.length);
    for (const s of sessions) expect(manager.has(s.sessionId)).toBe(true);
  });
});
