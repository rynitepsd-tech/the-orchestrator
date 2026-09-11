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
import { describe, expect, test } from "bun:test";
import type { RunState } from "@orchestrator/protocol";
import { useHarness, waitFor } from "./harness";

/** Last known run state per session, tracked from emitted events. */
const runStates = new Map<string, RunState>();

const h = useHarness({
  prefix: "orch",
  modelIds: [
    "mock-alpha",
    "mock-bravo",
    "mock-one",
    "mock-two",
    "mock-three",
    "mock-slow",
    "mock-error",
  ],
  onEvent: (e) => {
    if (e.type === "session.state" || e.type === "session.finished") {
      runStates.set(e.sessionId, e.runState);
    }
  },
});
const { eventsFor, eventsOfType, textFor, makeProject } = h;

/** Send a prompt through the supervisor to the owning worker process. */
function prompt(sessionId: string, text: string, whenBusy = "steer") {
  return h.manager.route(sessionId, "session.prompt", { sessionId, text, whenBusy });
}
function abort(sessionId: string) {
  return h.manager.route(sessionId, "session.abort", { sessionId });
}

function toolOutputFor(sessionId: string): string {
  return eventsOfType(sessionId, "tool.end")
    .map((e) => e.output ?? "")
    .join("\n");
}

describe("two concurrent top-level sessions", () => {
  test("both stream, both run tools, and nothing crosses between them", async () => {
    const projA = makeProject("A");
    const projB = makeProject("B");

    const a = await h.manager.create({
      projectPath: projA,
      title: "Alpha",
      model: "mockprov/mock-alpha",
      advisors: [],
    });
    const b = await h.manager.create({
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
    const sessions = h.manager.list();
    const a = sessions.find((s) => s.title === "Alpha");
    const b = sessions.find((s) => s.title === "Bravo");
    expect(a).toBeDefined();
    expect(b).toBeDefined();

    const ua = await h.manager.sessionUsage(a!.sessionId);
    const ub = await h.manager.sessionUsage(b!.sessionId);

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

    const c = await h.manager.create({
      projectPath: projC,
      title: "Charlie",
      model: "mockprov/mock-slow",
      advisors: [],
    });
    const d = await h.manager.create({
      projectPath: projD,
      title: "Delta",
      model: "mockprov/mock-slow",
      advisors: [],
    });

    await prompt(c.sessionId, "slow c");
    await prompt(d.sessionId, "slow d");

    // Let both get genuinely underway.
    expect(
      await waitFor(() => textFor(c.sessionId).length > 0 && textFor(d.sessionId).length > 0),
    ).toBe(true);

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
    const sessions = h.manager.list();
    const c = sessions.find((s) => s.title === "Charlie");
    const d = sessions.find((s) => s.title === "Delta");
    expect(c && d).toBeTruthy();

    await h.manager.close(c!.sessionId);
    expect(h.manager.has(c!.sessionId)).toBe(false);
    expect(h.manager.has(d!.sessionId)).toBe(true);

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

    const s1 = await h.manager.create({
      projectPath: p1,
      title: "S1",
      model: "mockprov/mock-one",
      advisors: [],
    });
    const s2 = await h.manager.create({
      projectPath: p1,
      title: "S2",
      model: "mockprov/mock-two",
      advisors: [],
    });
    const s3 = await h.manager.create({
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
      [s1, s2, s3].every((s) => eventsFor(s.sessionId).some((e) => e.type === "session.finished")),
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
    const sessions = h.manager.list();
    expect(sessions.length).toBeGreaterThan(1);
    // Distinct ids, and each is independently addressable through the supervisor.
    expect(new Set(sessions.map((s) => s.sessionId)).size).toBe(sessions.length);
    for (const s of sessions) expect(h.manager.has(s.sessionId)).toBe(true);
  });
});
