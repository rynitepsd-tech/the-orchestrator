/**
 * CONCURRENCY REGRESSION TEST — hard product requirement.
 *
 * Several top-level OMP sessions must run simultaneously inside one engine
 * process with no cross-talk. Upstream warns that the default process-global
 * AgentRegistry admits only one "Main" identity per generation, so this test
 * exists to catch any regression in the isolation the engine sets up.
 *
 * Asserts: both stream, both execute tools, events/transcripts/cwd/usage never
 * cross, aborting one leaves the other running, disposing one leaves the other
 * running.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discoverAuthStorage } from "@oh-my-pi/pi-coding-agent";
import type { ProductEvent } from "@orchestrator/protocol";
import { ompAgentDir } from "@orchestrator/omp-adapter";
import { RuntimeManager } from "../src/runtime-manager";
import { ModelRegistry, registerMockModels, startMockProvider, type MockServer } from "./mock-provider";

let mock: MockServer;
let manager: RuntimeManager;
let registry: ModelRegistry;
const roots: string[] = [];

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

  const agentDir = ompAgentDir();
  const auth = await discoverAuthStorage(agentDir);
  registry = new ModelRegistry(auth as never);
  registerMockModels(registry, mock.url, [
    "mock-alpha",
    "mock-bravo",
    "mock-one",
    "mock-two",
    "mock-three",
    "mock-slow",
    "mock-error",
  ]);

  manager = new RuntimeManager({
    agentDir,
    testMode: true,
    modelRegistryOverride: registry,
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
    await manager.get(a.sessionId).prompt("do alpha");
    await manager.get(b.sessionId).prompt("do bravo");

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

    const ua = manager.get(a!.sessionId).usageBreakdown();
    const ub = manager.get(b!.sessionId).usageBreakdown();

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

    // Records are tagged with the owning session only.
    for (const r of manager.get(a!.sessionId).usageRecords()) {
      expect(r.sessionId).toBe(a!.sessionId);
    }
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

    await manager.get(c.sessionId).prompt("slow c");
    await manager.get(d.sessionId).prompt("slow d");

    // Let both get genuinely underway.
    expect(await waitFor(() => textFor(c.sessionId).length > 0 && textFor(d.sessionId).length > 0)).toBe(
      true,
    );

    await manager.get(c.sessionId).abort();
    expect(manager.get(c.sessionId).runState).toBe("interrupted");

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

    await manager.get(d!.sessionId).abort();
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
      manager.get(s1.sessionId).prompt("go 1"),
      manager.get(s2.sessionId).prompt("go 2"),
      manager.get(s3.sessionId).prompt("go 3"),
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

describe("registry isolation invariant", () => {
  test("each session gets a distinct agent identity", async () => {
    const { agentIdFor } = await import("@orchestrator/omp-adapter");
    const ids = manager.list().map((s) => agentIdFor(s.sessionId));
    expect(new Set(ids).size).toBe(ids.length);
    // None may be the bare upstream default that collides process-globally.
    for (const id of ids) expect(id).not.toBe("Main");
  });
});
