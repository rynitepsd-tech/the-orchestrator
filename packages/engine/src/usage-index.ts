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
    return ["r", r.actorType, messageId].join(SEP);
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
    this.#loaded = true;
    if (!existsSync(this.#path)) return 0;
    let loaded = 0;
    try {
      const text = readFileSync(this.#path, "utf8");
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
      const globalized: UsageRecord = {
        ...r,
        key: globalUsageKey(r),
        // Time-filterable even for snapshot records that carry no timestamp.
        completedAt: r.completedAt ?? now,
      };
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
    this.#dirty = false;
    try {
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
    } catch (e) {
      logger.warn("usage-index", `failed to persist usage index: ${String(e)}`);
    }
  }
}
