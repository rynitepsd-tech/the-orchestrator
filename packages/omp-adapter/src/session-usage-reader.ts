/**
 * Read authoritative usage records out of a persisted OMP session file.
 *
 * Session files are append-only JSONL (see docs/SESSION_MODEL.md). Assistant
 * messages carry provider-reported usage:
 *
 *   { type: "message", message: { role: "assistant",
 *       usage: { input, output, cacheRead, cacheWrite, totalTokens,
 *                cost: { total } },
 *       provider, model, responseId, timestamp } }
 *
 * Records built here use source "omp-session" — the highest authority tier —
 * so a reindex reconciles (replaces) whatever live counters recorded.
 *
 * Identity note (fork correctness): a forked session file CONTAINS the parent's
 * history, including its responseIds. The global usage index dedups on
 * responseId across sessions, so reindexing a fork never double-counts the
 * provider activity that produced the copied history.
 */

import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import type { UsageRecord } from "@orchestrator/protocol";
import { usageKey } from "@orchestrator/usage";

export interface SessionFileUsage {
  ompSessionId: string;
  cwd: string;
  title?: string;
  records: UsageRecord[];
}

function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

export async function readSessionFileUsage(filePath: string): Promise<SessionFileUsage | null> {
  let ompSessionId = "";
  let cwd = "";
  let title: string | undefined;
  const records: UsageRecord[] = [];

  const rl = createInterface({
    input: createReadStream(filePath, { encoding: "utf8" }),
    crlfDelay: Number.POSITIVE_INFINITY,
  });

  try {
    for await (const line of rl) {
      if (!line.trim()) continue;
      let entry: any;
      try {
        entry = JSON.parse(line);
      } catch {
        continue; // a torn final line from a crashed writer is expected, not fatal
      }

      if (entry?.type === "session") {
        ompSessionId = String(entry.id ?? "");
        cwd = String(entry.cwd ?? "");
        continue;
      }
      if (entry?.type === "title" && typeof entry.title === "string" && entry.title.trim()) {
        title = entry.title.trim();
        continue;
      }
      if (entry?.type !== "message") continue;
      const msg = entry.message;
      if (msg?.role !== "assistant" || !msg.usage) continue;

      const u = msg.usage;
      const messageId =
        (typeof msg.responseId === "string" && msg.responseId) ||
        (typeof msg.timestamp === "number" && `ts:${msg.timestamp}`) ||
        `entry:${String(entry.id ?? records.length)}`;

      records.push({
        key: usageKey({ sessionId: ompSessionId || filePath, actorId: "primary", messageId }),
        sessionId: ompSessionId || filePath,
        projectId: cwd,
        actorType: "primary",
        actorId: "primary",
        provider: String(msg.provider ?? "unknown"),
        model: String(msg.model ?? "unknown"),
        inputTokens: num(u.input),
        outputTokens: num(u.output),
        cacheReadTokens: num(u.cacheRead),
        cacheWriteTokens: num(u.cacheWrite),
        cost:
          typeof u.cost?.total === "number" && Number.isFinite(u.cost.total)
            ? u.cost.total
            : undefined,
        completedAt:
          typeof msg.timestamp === "number" ? new Date(msg.timestamp).toISOString() : undefined,
        source: "omp-session",
        ompSessionId: ompSessionId || undefined,
      });
    }
  } catch {
    return null; // unreadable file: skip rather than fail the whole reindex
  }

  if (!ompSessionId && records.length === 0) return null;
  return { ompSessionId, cwd, title, records };
}
