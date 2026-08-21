/**
 * Engine-wide persistent usage index.
 *
 * Live workers stream raw usage records upward (`usage.records` events); OMP's
 * persisted session files can be reindexed as the authoritative record
 * (`source: "omp-session"`). Both funnel into one accumulator whose identity
 * rules make restarts, resumes, retries, and forks safe:
 *
 *  - Records carrying a provider responseId dedup GLOBALLY on that id. A
 *    provider response is one billable event no matter how many session files
 *    contain it — a forked transcript copies history (and its responseIds), so
 *    fork history never double-counts. Provider retries get fresh responseIds
 *    and correctly accumulate.
 *  - Cumulative snapshots (advisor stats) dedup per session+actor and REPLACE
 *    on every observation (see @orchestrator/usage R1/R2).
 *
 * Persistence: JSON-lines snapshot under the app support dir, written
 * atomically and debounced. The store is small (one line per provider
 * response), loads incrementally at startup, and never blocks the protocol.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { totalTokens, type UsageBreakdown, type UsageRecord } from "@orchestrator/protocol";
import { summarize, UsageAccumulator } from "@orchestrator/usage";
import { appSupportDir, logger } from "./logging";

/** Cumulative/synthetic message ids that are only unique within one session. */
function isSessionScopedMessageId(messageId: string): boolean {
  return (
    messageId === "cumulative" ||
    messageId === "total" ||
    messageId === "unknown" ||
    messageId.startsWith("ts:") ||
    messageId.startsWith("entry:")
  );
}

/** Rewrite a record's key to its global (cross-session) identity. */
export function globalUsageKey(r: UsageRecord): string {
  // usageKey() joins with NUL — the one character ids can never contain.
  const SEP = "\0";
  const parts = r.key.split(SEP);
  const messageId = parts.length >= 3 ? parts.slice(2).join(SEP) : r.key;
  if (!isSessionScopedMessageId(messageId)) {
    // Provider response ids are globally unique per billable response.
    // Deliberately NOT keyed by actorType: a reindex labels every file row
    // "primary" while the live path labels the same response "subagent" —
    // keying on actorType indexed that one response twice.
    return ["r", messageId].join(SEP);
  }
  if (messageId.startsWith("ts:")) {
    // No responseId, but a provider timestamp. Forks copy history verbatim
    // (same timestamps, different session ids), so a session-scoped key would
    // double-count the copied rows. The timestamp plus the token fingerprint
    // identifies one billable response well enough to dedup across forks.
    return ["t", messageId, r.model, String(r.inputTokens), String(r.outputTokens)].join(SEP);
  }
  const scope = r.ompSessionId || r.sessionId;
  return ["s", scope, r.actorId, messageId].join(SEP);
}

export class UsageIndex {
  readonly #acc = new UsageAccumulator();
  readonly #path: string;
  #dirty = false;
  #saveTimer: ReturnType<typeof setTimeout> | null = null;
  #loaded = false;

  constructor(dir = join(appSupportDir(), "usage")) {
    this.#path = join(dir, "records.jsonl");
  }

  /** Load the snapshot. Fast (one JSON.parse per line); malformed lines skip. */
  load(): number {
    if (!existsSync(this.#path)) {
      this.#loaded = true;
      return 0;
    }
    let loaded = 0;
    try {
      const text = readFileSync(this.#path, "utf8");
      // Loaded flips only AFTER a successful read: a transient read failure
      // followed by a flush must not clobber the on-disk lifetime history
      // with a near-empty accumulator.
      for (const line of text.split("\n")) {
        if (!line.trim()) continue;
        try {
          const r = JSON.parse(line) as UsageRecord;
          if (typeof r?.key === "string" && typeof r?.actorId === "string") {
            this.#acc.ingest(r);
            loaded++;
          }
        } catch {
          /* torn line from a crashed writer */
        }
      }
      this.#loaded = true;
    } catch (e) {
      logger.warn("usage-index", `failed to load usage index: ${String(e)}`);
    }
    return loaded;
  }

  /** Ingest records from a live worker or a reindex pass. Returns changed count. */
  ingest(records: UsageRecord[]): number {
    if (!this.#loaded) this.load();
    let changed = 0;
    const now = new Date().toISOString();
    for (const r of records) {
      const key = globalUsageKey(r);
      const existing = this.#acc.get(key);
      // Time-filterable even for snapshot records that carry no timestamp —
      // but a cumulative snapshot re-observed after resume (same or jittered
      // totals) must keep its ORIGINAL stamp, or Monday's advisor tokens get
      // refiled under "Today" every time the session is reopened. Only real
      // growth earns a fresh timestamp.
      let completedAt = r.completedAt ?? existing?.completedAt ?? now;
      if (!r.completedAt && existing?.completedAt && totalTokens(r) > totalTokens(existing)) {
        completedAt = now;
      }
      let globalized: UsageRecord = { ...r, key, completedAt };
      // A responseId names one billable event, not an actor. When a file
      // reindex (which labels everything "primary") meets a live record with
      // more specific attribution, keep the specific actor.
      if (existing && r.actorType === "primary" && existing.actorType !== "primary") {
        globalized = {
          ...globalized,
          actorType: existing.actorType,
          actorId: existing.actorId,
          actorName: existing.actorName,
        };
      }
      if (this.#acc.ingest(globalized)) changed++;
    }
    if (changed > 0) this.#scheduleSave();
    return changed;
  }

  records(): UsageRecord[] {
    if (!this.#loaded) this.load();
    return this.#acc.records();
  }

  breakdown(filter?: (r: UsageRecord) => boolean): UsageBreakdown {
    const rows = filter ? this.records().filter(filter) : this.records();
    return summarize(rows);
  }

  size(): number {
    return this.#acc.size();
  }

  totalTokensAll(): number {
    return this.records().reduce((n, r) => n + totalTokens(r), 0);
  }

  #scheduleSave(): void {
    this.#dirty = true;
    if (this.#saveTimer) return;
    this.#saveTimer = setTimeout(() => {
      this.#saveTimer = null;
      this.flush();
    }, 3_000);
  }

  /** Atomic snapshot write; safe against crashes mid-write. */
  flush(): void {
    if (!this.#dirty) return;
    // A flush that never loaded would rewrite the file with only this
    // process's records — refuse rather than destroy lifetime history.
    if (!this.#loaded) {
      logger.warn("usage-index", "flush skipped: index never loaded cleanly");
      return;
    }
    try {
      // Merge the on-disk file first: another instance (dev build alongside
      // the packaged app) may have flushed since we loaded, and a blind
      // rewrite would erase its records. Stored keys are already global, so
      // they ingest directly; R1/R2 make re-reading our own rows a no-op.
      try {
        const text = readFileSync(this.#path, "utf8");
        for (const line of text.split("\n")) {
          if (!line.trim()) continue;
          try {
            const r = JSON.parse(line) as UsageRecord;
            if (typeof r?.key === "string" && typeof r?.actorId === "string") this.#acc.ingest(r);
          } catch {
            /* torn line from a crashed writer */
          }
        }
      } catch {
        /* first flush: no file yet */
      }
      const dir = join(this.#path, "..");
      mkdirSync(dir, { recursive: true });
      const tmp = `${this.#path}.tmp`;
      writeFileSync(
        tmp,
        this.#acc
          .records()
          .map((r) => JSON.stringify(r))
          .join("\n") + "\n",
      );
      renameSync(tmp, this.#path);
      // Cleared only after the rename lands — a failed write stays dirty and
      // is retried by the next scheduled save instead of being lost.
      this.#dirty = false;
    } catch (e) {
      logger.warn("usage-index", `failed to persist usage index: ${String(e)}`);
    }
  }
}
