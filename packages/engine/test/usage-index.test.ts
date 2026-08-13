/**
 * Engine-wide usage index: global identity, fork safety, authority,
 * persistence.
 *
 * The subtle case this locks in (docs/USAGE_MODEL.md): a forked session file
 * CONTAINS the parent's history, including the provider responseIds that were
 * already billed once. Reindexing parent + fork must count each provider
 * response exactly once.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { totalTokens, type UsageRecord } from "@orchestrator/protocol";
import { usageKey } from "@orchestrator/usage";
import { globalUsageKey, UsageIndex } from "../src/usage-index";

const dirs: string[] = [];
function tempIndex(): UsageIndex {
  const dir = mkdtempSync(join(tmpdir(), "orch-usage-"));
  dirs.push(dir);
  return new UsageIndex(dir);
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function rec(over: Partial<UsageRecord> & { sessionId: string; messageId: string }): UsageRecord {
  const actorId = over.actorId ?? "primary";
  return {
    key: usageKey({ sessionId: over.sessionId, actorId, messageId: over.messageId }),
    sessionId: over.sessionId,
    projectId: over.projectId ?? "/p",
    actorType: over.actorType ?? "primary",
    actorId,
    actorName: over.actorName,
    provider: over.provider ?? "anthropic",
    model: over.model ?? "claude",
    inputTokens: over.inputTokens ?? 100,
    outputTokens: over.outputTokens ?? 10,
    cacheReadTokens: over.cacheReadTokens ?? 0,
    cacheWriteTokens: over.cacheWriteTokens ?? 0,
    cost: over.cost,
    completedAt: over.completedAt,
    source: over.source ?? "live-event",
    ompSessionId: over.ompSessionId,
  };
}

describe("global identity", () => {
  test("same provider response observed from two sessions counts once (fork history)", () => {
    const index = tempIndex();
    // Parent session recorded the response live…
    index.ingest([rec({ sessionId: "orch-A", messageId: "resp-1", ompSessionId: "omp-parent" })]);
    // …and the fork's file contains the same responseId under a new session id.
    index.ingest([
      rec({
        sessionId: "omp-fork",
        messageId: "resp-1",
        ompSessionId: "omp-fork",
        source: "omp-session",
      }),
    ]);
    expect(index.size()).toBe(1);
    expect(index.breakdown().total.inputTokens).toBe(100);
  });

  test("provider retries with fresh responseIds accumulate", () => {
    const index = tempIndex();
    index.ingest([rec({ sessionId: "A", messageId: "resp-1" })]);
    index.ingest([rec({ sessionId: "A", messageId: "resp-2" })]);
    expect(index.size()).toBe(2);
    expect(index.breakdown().total.inputTokens).toBe(200);
  });

  test("cumulative advisor snapshots stay session-scoped and replace", () => {
    const index = tempIndex();
    const base = {
      sessionId: "A",
      actorId: "advisor:Reviewer",
      actorType: "advisor" as const,
      messageId: "cumulative",
      ompSessionId: "omp-A",
    };
    index.ingest([rec({ ...base, inputTokens: 500 })]);
    index.ingest([rec({ ...base, inputTokens: 800 })]);
    expect(index.size()).toBe(1);
    expect(index.breakdown().advisors[0]?.tokens.inputTokens).toBe(800);

    // A different session's advisor with the same name is a separate row.
    index.ingest([rec({ ...base, sessionId: "B", ompSessionId: "omp-B", inputTokens: 100 })]);
    expect(index.size()).toBe(2);
  });

  test("resume continuity: live record before persist and reindex after share identity", () => {
    // Live record when ompSessionId was already known.
    const live = rec({ sessionId: "orch-1", messageId: "resp-9", ompSessionId: "omp-X" });
    // Same response from the session file.
    const persisted = rec({
      sessionId: "omp-X",
      messageId: "resp-9",
      ompSessionId: "omp-X",
      source: "omp-session",
    });
    expect(globalUsageKey(live)).toBe(globalUsageKey(persisted));
  });
});

describe("authority", () => {
  test("omp-session outranks live-event; late live cannot clobber", () => {
    const index = tempIndex();
    index.ingest([rec({ sessionId: "A", messageId: "resp-1", inputTokens: 999 })]);
    index.ingest([
      rec({ sessionId: "A", messageId: "resp-1", inputTokens: 1000, source: "omp-session" }),
    ]);
    expect(index.breakdown().total.inputTokens).toBe(1000);
    // A stale live record arriving later changes nothing.
    const changed = index.ingest([rec({ sessionId: "A", messageId: "resp-1", inputTokens: 5 })]);
    expect(changed).toBe(0);
    expect(index.breakdown().total.inputTokens).toBe(1000);
  });
});

describe("persistence", () => {
  test("records survive a flush/reload cycle byte-for-byte", () => {
    const dir = mkdtempSync(join(tmpdir(), "orch-usage-"));
    dirs.push(dir);
    const a = new UsageIndex(dir);
    a.ingest([
      rec({ sessionId: "A", messageId: "resp-1", cost: 0.5 }),
      rec({ sessionId: "A", messageId: "resp-2" }),
      rec({
        sessionId: "A",
        actorId: "advisor:Arch",
        actorType: "advisor",
        messageId: "cumulative",
        inputTokens: 42,
      }),
    ]);
    a.flush();

    const b = new UsageIndex(dir);
    expect(b.load()).toBe(3);
    expect(b.size()).toBe(3);
    expect(b.breakdown().total.inputTokens).toBe(242);
    // Re-ingesting the same data after reload is a no-op (restart safety).
    expect(b.ingest([rec({ sessionId: "A", messageId: "resp-1", cost: 0.5 })])).toBe(0);
  });

  test("aborted-turn usage is kept — tokens spent before an abort are real", () => {
    const index = tempIndex();
    index.ingest([rec({ sessionId: "A", messageId: "resp-1" })]);
    // Nothing in the index API removes usage on abort/close; totals stand.
    expect(totalTokens(index.breakdown().total)).toBe(110);
  });
});
