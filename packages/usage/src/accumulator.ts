/**
 * Usage accumulation and de-duplication.
 *
 * The correctness problem this solves
 * -----------------------------------
 * The same tokens can be observed three times:
 *   1. live streaming events while a turn runs,
 *   2. the persisted OMP session .jsonl after the turn settles,
 *   3. a later reindex of that same file.
 * Summing those triple-counts. Two rules prevent it:
 *
 *   R1 (identity)  Every record carries a deterministic `key` derived from the
 *                  upstream message identity. Records sharing a key describe the
 *                  SAME tokens and REPLACE one another — they are never summed.
 *
 *   R2 (authority) When two records share a key, the one from the more
 *                  authoritative source wins. Persisted OMP data outranks live
 *                  counters, because live usage arrives cumulatively during a
 *                  stream and the final value supersedes every earlier one.
 *
 * Verified against OMP 17.3.1: usage on a streaming message accumulates
 * (0 -> partial -> final) rather than arriving as deltas, so within a single
 * source the LAST value for a key is authoritative, never the sum.
 */
import {
  addTokens,
  emptyTokenCounts,
  type TokenCounts,
  type UsageBreakdown,
  type UsageRecord,
  type UsageSource,
} from "@orchestrator/protocol";

/** Higher wins when two records share a key. */
const SOURCE_AUTHORITY: Record<UsageSource, number> = {
  "live-event": 0,
  "advisor-log": 1,
  "subagent-log": 1,
  "omp-session": 2,
};

/**
 * Build the deterministic identity for a usage observation.
 *
 * Must be computable identically from a live event and from the persisted
 * record describing the same message — that equality is what makes
 * de-duplication work.
 */
export function usageKey(parts: {
  sessionId: string;
  actorId: string;
  /** Upstream message id. Falls back to a turn/sequence identifier. */
  messageId: string;
}): string {
  return `${parts.sessionId}\u0000${parts.actorId}\u0000${parts.messageId}`;
}

export class UsageAccumulator {
  /** key -> record. Replacement semantics, never additive. */
  readonly #records = new Map<string, UsageRecord>();

  /**
   * Record an observation. Returns true when it changed stored state, so
   * callers can avoid emitting redundant UI updates.
   */
  ingest(record: UsageRecord): boolean {
    const existing = this.#records.get(record.key);
    if (!existing) {
      this.#records.set(record.key, record);
      return true;
    }

    const incomingAuthority = SOURCE_AUTHORITY[record.source];
    const existingAuthority = SOURCE_AUTHORITY[existing.source];

    // Lower authority never overwrites higher authority. This is what stops a
    // late live event from clobbering reconciled persisted data.
    if (incomingAuthority < existingAuthority) return false;

    // Same source and same numbers: nothing to do.
    if (
      incomingAuthority === existingAuthority &&
      existing.inputTokens === record.inputTokens &&
      existing.outputTokens === record.outputTokens &&
      existing.cacheReadTokens === record.cacheReadTokens &&
      existing.cacheWriteTokens === record.cacheWriteTokens &&
      existing.cost === record.cost
    ) {
      return false;
    }

    this.#records.set(record.key, record);
    return true;
  }

  ingestMany(records: Iterable<UsageRecord>): boolean {
    let changed = false;
    for (const r of records) changed = this.ingest(r) || changed;
    return changed;
  }

  /** Drop every record for a session (e.g. before a full reconcile). */
  clearSession(sessionId: string): void {
    for (const [k, r] of this.#records) {
      if (r.sessionId === sessionId) this.#records.delete(k);
    }
  }

  /** The stored record for a key, if any — for callers that merge attribution. */
  get(key: string): UsageRecord | undefined {
    return this.#records.get(key);
  }

  records(): UsageRecord[] {
    return [...this.#records.values()];
  }

  recordsFor(sessionId: string): UsageRecord[] {
    return this.records().filter((r) => r.sessionId === sessionId);
  }

  size(): number {
    return this.#records.size;
  }

  breakdown(sessionId?: string): UsageBreakdown {
    const rows = sessionId ? this.recordsFor(sessionId) : this.records();
    return summarize(rows);
  }
}

function tokensOf(r: UsageRecord): TokenCounts {
  return {
    inputTokens: r.inputTokens,
    outputTokens: r.outputTokens,
    cacheReadTokens: r.cacheReadTokens,
    cacheWriteTokens: r.cacheWriteTokens,
  };
}

/** Sum cost only when every contributing record reported one. */
function sumCost(rows: UsageRecord[]): { cost?: number; partial: boolean } {
  if (rows.length === 0) return { cost: undefined, partial: false };
  let total = 0;
  let missing = false;
  for (const r of rows) {
    if (typeof r.cost === "number" && Number.isFinite(r.cost)) total += r.cost;
    else missing = true;
  }
  if (missing && total === 0) return { cost: undefined, partial: true };
  return { cost: total, partial: missing };
}

export function summarize(rows: UsageRecord[]): UsageBreakdown {
  const primaryRows = rows.filter((r) => r.actorType === "primary");
  const advisorRows = rows.filter((r) => r.actorType === "advisor");
  const subagentRows = rows.filter((r) => r.actorType === "subagent");

  const primaryTokens = primaryRows.reduce<TokenCounts>(
    (acc, r) => addTokens(acc, tokensOf(r)),
    emptyTokenCounts(),
  );
  const primaryCost = sumCost(primaryRows);

  // Advisors grouped by actor identity so named advisors stay distinguishable.
  const advisorMap = new Map<string, UsageRecord[]>();
  for (const r of advisorRows) {
    const list = advisorMap.get(r.actorId);
    if (list) list.push(r);
    else advisorMap.set(r.actorId, [r]);
  }
  const advisors = [...advisorMap.entries()].map(([actorId, group]) => {
    const cost = sumCost(group);
    return {
      actorId,
      actorName: group[0]?.actorName,
      model: group[0]?.model,
      tokens: group.reduce<TokenCounts>((a, r) => addTokens(a, tokensOf(r)), emptyTokenCounts()),
      cost: cost.cost,
    };
  });
  advisors.sort((a, b) => (a.actorName ?? a.actorId).localeCompare(b.actorName ?? b.actorId));

  // Subagent "runs" counts distinct actors, not records.
  const subagentActors = new Set(subagentRows.map((r) => r.actorId));
  const subagentCost = sumCost(subagentRows);

  // Per-model rollup across every actor type.
  const modelMap = new Map<string, UsageRecord[]>();
  for (const r of rows) {
    const k = `${r.provider}/${r.model}`;
    const list = modelMap.get(k);
    if (list) list.push(r);
    else modelMap.set(k, [r]);
  }
  const byModel = [...modelMap.entries()]
    .map(([, group]) => {
      const cost = sumCost(group);
      return {
        model: group[0].model,
        provider: group[0].provider,
        tokens: group.reduce<TokenCounts>((a, r) => addTokens(a, tokensOf(r)), emptyTokenCounts()),
        cost: cost.cost,
      };
    })
    .sort((a, b) => {
      const at = a.tokens.inputTokens + a.tokens.outputTokens;
      const bt = b.tokens.inputTokens + b.tokens.outputTokens;
      return bt - at;
    });

  const totalTokensAll = rows.reduce<TokenCounts>(
    (acc, r) => addTokens(acc, tokensOf(r)),
    emptyTokenCounts(),
  );
  const totalCost = sumCost(rows);

  return {
    primary: { ...primaryTokens, cost: primaryCost.cost },
    advisors,
    subagents: {
      runs: subagentActors.size,
      tokens: subagentRows.reduce<TokenCounts>(
        (a, r) => addTokens(a, tokensOf(r)),
        emptyTokenCounts(),
      ),
      cost: subagentCost.cost,
    },
    byModel,
    total: { ...totalTokensAll, cost: totalCost.cost },
    costPartial: totalCost.partial,
  };
}
