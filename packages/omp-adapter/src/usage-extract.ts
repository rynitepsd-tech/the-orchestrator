/**
 * Extract normalized usage records from OMP.
 *
 * Three authoritative upstream sources, each with a different shape and a
 * different natural identity. Getting the identity right is what prevents
 * double counting.
 *
 * 1. PRIMARY — `turn_end.message.usage`
 *      { input, output, cacheRead, cacheWrite, totalTokens,
 *        cost: { input, output, cacheRead, cacheWrite, total } }
 *      alongside `provider`, `model`, `responseId`, `timestamp`.
 *      Identity: the provider `responseId`. One assistant response = one
 *      record, regardless of how many times we observe it.
 *
 * 2. ADVISORS — `session.getAdvisorStats().advisors: PerAdvisorStat[]`
 *      { name, status, model, contextWindow, contextTokens,
 *        tokens: { input, output, reasoning, cacheRead, cacheWrite, total },
 *        cost, messages, sessionId }
 *      These are CUMULATIVE snapshots per advisor, not per-message deltas.
 *      Identity: the advisor name. Each poll REPLACES the previous snapshot,
 *      which is exactly the accumulator's replacement semantics.
 *
 * 3. SUBAGENTS — the subagent's own assistant messages, observed on the
 *      `task:subagent:event` bus channel, carry the same `usage` shape as the
 *      primary path. Identity: the provider `responseId`, exactly like primary.
 *
 * Because advisor and subagent totals are reported separately from the primary
 * message usage, summing all three actor types does not double count.
 *
 * Persisted session files carry the same message shape; session-usage-reader
 * builds its records through the same helpers with source "omp-session".
 */

import type { ContextUsage, UsageRecord, UsageSource } from "@orchestrator/protocol";
import { reportedCost, usageKey } from "@orchestrator/usage";

interface ExtractContext {
  sessionId: string;
  projectId: string;
}

/** The fields of OMP's message `usage` object that records are built from. */
interface OmpUsage {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  cost?: { total?: number };
}

function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

/**
 * Message identity ladder: the provider's own response id (stable across live
 * and persisted observations of the same response), else the provider
 * timestamp, else the caller's fallback.
 */
export function usageMessageId(message: any, fallback = "unknown"): string {
  return (
    (typeof message?.responseId === "string" && message.responseId) ||
    (typeof message?.timestamp === "number" && `ts:${message.timestamp}`) ||
    fallback
  );
}

export interface UsageRecordAttribution {
  sessionId: string;
  projectId: string;
  actorType: UsageRecord["actorType"];
  actorId: string;
  actorName?: string;
  messageId: string;
  source: UsageSource;
  ompSessionId?: string;
}

/**
 * Build one usage record from an OMP assistant message carrying `usage`.
 *
 * Returns null when the message carries no usage (e.g. a synthetic message),
 * so callers never fabricate a zero-token record. Cost goes through
 * `reportedCost`, so an unpriced zero on a response that spent tokens is
 * stored as unknown, not free.
 */
export function usageRecordFromMessage(
  message: any,
  r: UsageRecordAttribution,
): UsageRecord | null {
  const u: OmpUsage | undefined = message?.usage;
  if (!u) return null;
  const record: UsageRecord = {
    key: usageKey({ sessionId: r.sessionId, actorId: r.actorId, messageId: r.messageId }),
    sessionId: r.sessionId,
    projectId: r.projectId,
    actorType: r.actorType,
    actorId: r.actorId,
    ...(r.actorName ? { actorName: r.actorName } : {}),
    provider: String(message.provider ?? "unknown"),
    model: String(message.model ?? "unknown"),
    inputTokens: num(u.input),
    outputTokens: num(u.output),
    cacheReadTokens: num(u.cacheRead),
    cacheWriteTokens: num(u.cacheWrite),
    cost: u.cost?.total,
    completedAt:
      typeof message.timestamp === "number" ? new Date(message.timestamp).toISOString() : undefined,
    source: r.source,
    ...(r.ompSessionId ? { ompSessionId: r.ompSessionId } : {}),
  };
  record.cost = reportedCost(record);
  return record;
}

/** Build the primary-agent usage record for a completed turn. */
export function primaryUsageFromTurn(
  ctx: ExtractContext,
  message: any,
  source: UsageSource = "live-event",
): UsageRecord | null {
  return usageRecordFromMessage(message, {
    ...ctx,
    actorType: "primary",
    actorId: "primary",
    messageId: usageMessageId(message),
    source,
  });
}

/**
 * Convert an `AdvisorStats` snapshot into one record per named advisor.
 *
 * Snapshots are cumulative, so each call produces records that REPLACE the
 * previous ones under the accumulator's key rules rather than adding to them.
 */
export function advisorUsageFromStats(ctx: ExtractContext, stats: any): UsageRecord[] {
  const perAdvisor: any[] = Array.isArray(stats?.advisors) ? stats.advisors : [];
  const out: UsageRecord[] = [];

  for (const a of perAdvisor) {
    const name = String(a?.name ?? "advisor");
    const t = a?.tokens ?? {};
    const input = num(t.input);
    const output = num(t.output);
    const cacheRead = num(t.cacheRead);
    const cacheWrite = num(t.cacheWrite);
    // Skip advisors that have not consumed anything; a configured-but-silent
    // advisor should not appear as a zero row in the usage table.
    if (input + output + cacheRead + cacheWrite === 0) continue;

    const actorId = `advisor:${name}`;
    out.push({
      // Cumulative snapshot -> one stable key per advisor per session.
      key: usageKey({ sessionId: ctx.sessionId, actorId, messageId: "cumulative" }),
      sessionId: ctx.sessionId,
      projectId: ctx.projectId,
      actorType: "advisor",
      actorId,
      actorName: name,
      provider: String(a?.model?.provider ?? "unknown"),
      model: String(a?.model?.id ?? a?.model?.name ?? "unknown"),
      inputTokens: input,
      outputTokens: output,
      cacheReadTokens: cacheRead,
      cacheWriteTokens: cacheWrite,
      cost: typeof a?.cost === "number" && Number.isFinite(a.cost) ? a.cost : undefined,
      source: "advisor-log",
    });
  }
  return out;
}

/**
 * Build a subagent usage record from one of the subagent's own assistant
 * messages. Identity is the provider responseId, exactly like the primary
 * path, so repeated observation of the same response collapses to one record
 * and each distinct provider response accumulates — authoritative attribution
 * with full token splits, better than the task tool's summary totals.
 */
export function subagentUsageFromMessage(
  ctx: ExtractContext,
  subagentId: string,
  message: any,
): UsageRecord | null {
  return usageRecordFromMessage(message, {
    ...ctx,
    actorType: "subagent",
    actorId: `subagent:${subagentId}`,
    messageId: usageMessageId(message),
    source: "subagent-log",
  });
}

/**
 * Read context-window consumption from a live session.
 *
 * Distinct from cumulative usage: compaction lowers this while billed tokens
 * keep rising. Returns null when upstream cannot report it, so the UI shows
 * nothing rather than a fabricated percentage.
 */
export function contextUsageOf(session: any): ContextUsage | null {
  try {
    const raw = session?.getContextUsage?.();
    if (!raw) return null;
    // Measured shape (pinned OMP version):
    //   { contextWindow, anchored, usedTokens, systemPromptTokens,
    //     systemToolsTokens, systemContextTokens, skillsTokens, messagesTokens }
    // The `tokens`/`total` fallbacks cover getSessionStats().contextUsage,
    // which reports the same numbers under different names.
    const used = num(raw.usedTokens ?? raw.tokens ?? raw.total);
    const max = num(raw.contextWindow ?? raw.max ?? raw.limit);
    if (max <= 0) return null;
    return { usedTokens: used, maxTokens: max, fraction: Math.min(1, used / max) };
  } catch {
    return null;
  }
}
