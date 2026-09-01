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

/**
 * Who the rows in a transcript belong to.
 *
 * A primary session file needs none of this — it *is* the session, and its
 * rows are the primary agent's. Nested transcripts (`<session-dir>/Foo.jsonl`
 * for a subagent, `<session-dir>/__advisor.foo.jsonl` for an advisor) are
 * separate files with their own session headers, but their tokens were spent
 * on behalf of the PARENT session and must be filed under it.
 */
export interface TranscriptActor {
  actorType: UsageRecord["actorType"];
  actorId: string;
  actorName?: string;
  /** The parent session these rows are attributed to. */
  ompSessionId: string;
  /** The parent session's project, for the "By project" rollup. */
  projectId?: string;
}

function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

export async function readSessionFileUsage(
  filePath: string,
  actor?: TranscriptActor,
): Promise<SessionFileUsage | null> {
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

      // Nested transcripts get the PARENT's scope and the real actor; a
      // primary file is its own scope and its rows are the primary agent's.
      const scope = actor?.ompSessionId || ompSessionId || filePath;
      const actorId = actor?.actorId ?? "primary";
      records.push({
        key: usageKey({ sessionId: scope, actorId, messageId }),
        sessionId: scope,
        projectId: actor?.projectId ?? cwd,
        actorType: actor?.actorType ?? "primary",
        actorId,
        actorName: actor?.actorName,
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
        ompSessionId: scope || undefined,
      });
    }
  } catch {
    return null; // unreadable file: skip rather than fail the whole reindex
  }

  if (!ompSessionId && records.length === 0) return null;
  return { ompSessionId, cwd, title, records };
}
