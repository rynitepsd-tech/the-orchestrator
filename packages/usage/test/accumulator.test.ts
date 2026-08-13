import { describe, expect, test } from "bun:test";
import type { UsageRecord } from "@orchestrator/protocol";
import { totalTokens } from "@orchestrator/protocol";
import { UsageAccumulator, usageKey } from "../src/accumulator";

const SESSION = "sess-1";
const PROJECT = "proj-1";

function rec(p: {
  actorType: UsageRecord["actorType"];
  actorId: string;
  actorName?: string;
  messageId: string;
  input: number;
  output: number;
  model?: string;
  provider?: string;
  cost?: number;
  source?: UsageRecord["source"];
  cacheRead?: number;
  cacheWrite?: number;
}): UsageRecord {
  return {
    key: usageKey({ sessionId: SESSION, actorId: p.actorId, messageId: p.messageId }),
    sessionId: SESSION,
    projectId: PROJECT,
    actorType: p.actorType,
    actorId: p.actorId,
    actorName: p.actorName,
    provider: p.provider ?? "mock",
    model: p.model ?? "mock-model",
    inputTokens: p.input,
    outputTokens: p.output,
    cacheReadTokens: p.cacheRead ?? 0,
    cacheWriteTokens: p.cacheWrite ?? 0,
    cost: p.cost,
    source: p.source ?? "live-event",
  };
}

/** The exact scenario from the product acceptance test. */
function scenarioRecords(source: UsageRecord["source"] = "live-event"): UsageRecord[] {
  return [
    rec({ actorType: "primary", actorId: "primary", messageId: "m1", input: 10_000, output: 2_000, source }),
    rec({
      actorType: "advisor",
      actorId: "advisor:architecture",
      actorName: "Architecture",
      messageId: "a1",
      input: 3_000,
      output: 1_000,
      source,
    }),
    rec({
      actorType: "advisor",
      actorId: "advisor:reviewer",
      actorName: "Code Reviewer",
      messageId: "b1",
      input: 4_000,
      output: 1_000,
      source,
    }),
    rec({
      actorType: "subagent",
      actorId: "task:explore",
      actorName: "Explore",
      messageId: "s1",
      input: 5_000,
      output: 2_000,
      source,
    }),
  ];
}

describe("acceptance: deterministic synthetic usage", () => {
  test("totals match the specified scenario exactly", () => {
    const acc = new UsageAccumulator();
    acc.ingestMany(scenarioRecords());
    const b = acc.breakdown(SESSION);

    expect(b.total.inputTokens).toBe(22_000);
    expect(b.total.outputTokens).toBe(6_000);
    expect(totalTokens(b.total)).toBe(28_000);
  });

  test("splits primary, advisors, and subagents rather than collapsing to one number", () => {
    const acc = new UsageAccumulator();
    acc.ingestMany(scenarioRecords());
    const b = acc.breakdown(SESSION);

    expect(b.primary.inputTokens).toBe(10_000);
    expect(b.primary.outputTokens).toBe(2_000);

    expect(b.advisors).toHaveLength(2);
    const arch = b.advisors.find((a) => a.actorName === "Architecture");
    const rev = b.advisors.find((a) => a.actorName === "Code Reviewer");
    expect(arch?.tokens.inputTokens).toBe(3_000);
    expect(rev?.tokens.inputTokens).toBe(4_000);

    expect(b.subagents.runs).toBe(1);
    expect(b.subagents.tokens.inputTokens).toBe(5_000);
  });

  test("totals are unchanged after a simulated restart + reindex", () => {
    const acc = new UsageAccumulator();
    acc.ingestMany(scenarioRecords("live-event"));
    const before = acc.breakdown(SESSION);

    // Restart: a fresh accumulator loads the SAME turns from persisted OMP data.
    const restarted = new UsageAccumulator();
    restarted.ingestMany(scenarioRecords("omp-session"));
    // And a later reindex sees them again.
    restarted.ingestMany(scenarioRecords("omp-session"));

    const after = restarted.breakdown(SESSION);
    expect(after.total).toEqual(before.total);
    expect(totalTokens(after.total)).toBe(28_000);
  });
});

describe("de-duplication", () => {
  test("the same tokens seen live then persisted are counted once", () => {
    const acc = new UsageAccumulator();
    acc.ingestMany(scenarioRecords("live-event"));
    acc.ingestMany(scenarioRecords("omp-session"));
    expect(totalTokens(acc.breakdown(SESSION).total)).toBe(28_000);
    expect(acc.size()).toBe(4);
  });

  test("triple observation (live + session + reindex) still counts once", () => {
    const acc = new UsageAccumulator();
    acc.ingestMany(scenarioRecords("live-event"));
    acc.ingestMany(scenarioRecords("omp-session"));
    acc.ingestMany(scenarioRecords("omp-session"));
    expect(totalTokens(acc.breakdown(SESSION).total)).toBe(28_000);
  });

  test("cumulative live updates replace rather than sum", () => {
    const acc = new UsageAccumulator();
    // OMP reports usage cumulatively during a stream: 0 -> partial -> final.
    acc.ingest(rec({ actorType: "primary", actorId: "primary", messageId: "m1", input: 0, output: 0 }));
    acc.ingest(rec({ actorType: "primary", actorId: "primary", messageId: "m1", input: 1_000, output: 40 }));
    acc.ingest(rec({ actorType: "primary", actorId: "primary", messageId: "m1", input: 1_500, output: 50 }));

    const b = acc.breakdown(SESSION);
    expect(b.total.inputTokens).toBe(1_500);
    expect(b.total.outputTokens).toBe(50);
    expect(acc.size()).toBe(1);
  });

  test("persisted data is not clobbered by a late live event", () => {
    const acc = new UsageAccumulator();
    acc.ingest(
      rec({ actorType: "primary", actorId: "primary", messageId: "m1", input: 1_500, output: 50, source: "omp-session" }),
    );
    // A straggler live event with stale (lower) numbers must not win.
    const changed = acc.ingest(
      rec({ actorType: "primary", actorId: "primary", messageId: "m1", input: 900, output: 10, source: "live-event" }),
    );
    expect(changed).toBe(false);
    expect(acc.breakdown(SESSION).total.inputTokens).toBe(1_500);
  });

  test("distinct messages accumulate", () => {
    const acc = new UsageAccumulator();
    acc.ingest(rec({ actorType: "primary", actorId: "primary", messageId: "m1", input: 100, output: 10 }));
    acc.ingest(rec({ actorType: "primary", actorId: "primary", messageId: "m2", input: 200, output: 20 }));
    const b = acc.breakdown(SESSION);
    expect(b.total.inputTokens).toBe(300);
    expect(b.total.outputTokens).toBe(30);
  });
});

describe("session isolation", () => {
  test("usage never crosses sessions", () => {
    const acc = new UsageAccumulator();
    const a = rec({ actorType: "primary", actorId: "primary", messageId: "m1", input: 100, output: 10 });
    const b: UsageRecord = {
      ...a,
      sessionId: "sess-2",
      key: usageKey({ sessionId: "sess-2", actorId: "primary", messageId: "m1" }),
      inputTokens: 999,
    };
    acc.ingestMany([a, b]);

    expect(acc.breakdown("sess-1").total.inputTokens).toBe(100);
    expect(acc.breakdown("sess-2").total.inputTokens).toBe(999);
  });

  test("clearSession removes only that session", () => {
    const acc = new UsageAccumulator();
    const a = rec({ actorType: "primary", actorId: "primary", messageId: "m1", input: 100, output: 10 });
    const b: UsageRecord = {
      ...a,
      sessionId: "sess-2",
      key: usageKey({ sessionId: "sess-2", actorId: "primary", messageId: "m1" }),
    };
    acc.ingestMany([a, b]);
    acc.clearSession("sess-1");
    expect(acc.recordsFor("sess-1")).toHaveLength(0);
    expect(acc.recordsFor("sess-2")).toHaveLength(1);
  });
});

describe("cost honesty", () => {
  test("cost is undefined when no record reports one", () => {
    const acc = new UsageAccumulator();
    acc.ingestMany(scenarioRecords());
    const b = acc.breakdown(SESSION);
    expect(b.total.cost).toBeUndefined();
  });

  test("partial cost coverage is flagged, not silently summed as complete", () => {
    const acc = new UsageAccumulator();
    acc.ingest(rec({ actorType: "primary", actorId: "primary", messageId: "m1", input: 100, output: 10, cost: 0.5 }));
    acc.ingest(rec({ actorType: "advisor", actorId: "advisor:x", messageId: "a1", input: 50, output: 5 }));
    const b = acc.breakdown(SESSION);
    expect(b.costPartial).toBe(true);
    expect(b.total.cost).toBe(0.5);
  });

  test("full cost coverage is not flagged partial", () => {
    const acc = new UsageAccumulator();
    acc.ingest(rec({ actorType: "primary", actorId: "primary", messageId: "m1", input: 100, output: 10, cost: 0.5 }));
    acc.ingest(rec({ actorType: "advisor", actorId: "advisor:x", messageId: "a1", input: 50, output: 5, cost: 0.25 }));
    const b = acc.breakdown(SESSION);
    expect(b.costPartial).toBe(false);
    expect(b.total.cost).toBeCloseTo(0.75);
  });
});

describe("model rollup", () => {
  test("groups by provider/model and sorts by volume", () => {
    const acc = new UsageAccumulator();
    acc.ingest(
      rec({ actorType: "primary", actorId: "primary", messageId: "m1", input: 100, output: 10, model: "small", provider: "p" }),
    );
    acc.ingest(
      rec({ actorType: "advisor", actorId: "advisor:x", messageId: "a1", input: 5_000, output: 500, model: "big", provider: "p" }),
    );
    const b = acc.breakdown(SESSION);
    expect(b.byModel[0].model).toBe("big");
    expect(b.byModel[1].model).toBe("small");
  });
});
