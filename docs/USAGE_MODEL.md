# Usage model

Usage is a first-class feature, so it gets a first-class correctness story. The guiding rule:

> **If usage cannot be measured authoritatively, say so. Never manufacture precision.**

## The problem

The same tokens are observable through three different channels:

1. **live streaming events** while a turn runs,
2. the **persisted OMP session `.jsonl`** once the turn settles,
3. a **later reindex** of that same file.

Naively summing them triple-counts. Worse, OMP reports usage on a streaming message
*cumulatively* — `0 → partial → final` — so even within one channel, adding every observation
inflates the total.

## The two rules

**R1 — Identity.** Every observation carries a deterministic `key` derived from upstream message
identity. Records sharing a key describe the *same* tokens and **replace** one another. They are
never summed.

```
key = `${sessionId} ${actorId} ${messageId}`
```

For primary usage, `messageId` is the provider's own `responseId`, which is stable across live and
persisted observations of the same response.

**R2 — Authority.** When two records share a key, the more authoritative source wins:

```
omp-session  (2)   >   advisor-log / subagent-log  (1)   >   live-event  (0)
```

A lower-authority record never overwrites a higher one, so a straggling live event cannot clobber
reconciled persisted data.

Implementation: `packages/usage/src/accumulator.ts`.

## Sources per dimension

| Dimension | Source | Notes |
|---|---|---|
| **Primary tokens** | `turn_end.message.usage` | `{input, output, cacheRead, cacheWrite, totalTokens, cost{…}}`, keyed by `responseId` |
| **Primary cost** | `usage.cost.total` | Computed by OMP. Absent ≠ zero |
| **Advisor tokens & cost** | the advisor's own `__advisor.<name>.jsonl` transcript | One record per provider response, keyed by `responseId` |
| **Subagent** | the subagent's own `<Agent>.jsonl` transcript, plus live `task:subagent:event` | Keyed by `responseId` |
| **Context window** | `session.getContextUsage()` | `usedTokens` / `contextWindow` |
| **Provider quota** | `authStorage.fetchUsageReports()` | Only providers with a usage endpoint |

### Advisor caveat

`session.getAdvisorStats()` reports a **cumulative** snapshot per advisor: `PerAdvisorStat.cost` is
durable and survives resume, while `PerAdvisorStat.tokens` is live-context only and resets when the
advisor compacts. That snapshot drives the per-session Inspector panel, and *only* that — the
engine-wide index rejects it (`isSupersededSnapshot`), because a per-session total would **sum** on
top of the itemized rows read from the advisor's transcript instead of replacing them.

### Nested transcripts

Advisors and subagents write their own transcripts one directory level *below* the session file:

```
<agent-dir>/sessions/<project>/<session>.jsonl          ← the primary agent
<agent-dir>/sessions/<project>/<session>/Scout.jsonl    ← a subagent
<agent-dir>/sessions/<project>/<session>/__advisor.reviewer.jsonl
```

OMP's own `listAllSessions()` globs exactly one level, so every session-level consumer is blind to
them — and their tokens are **not** folded into the parent: a parent transcript's `toolResult` rows
carry no `usage` at all. A setup that runs its primary agent on one provider and its advisors on
another therefore saw the second provider almost entirely missing from the usage centre.

`discoverNestedTranscripts()` enumerates them, and they are read through the same
`readSessionFileUsage()` with an actor attribution that files the rows under the **parent** session.
Identity is still the provider `responseId`, so this is additive, not double counting: measured on a
real environment, 219 nested transcripts share **zero** response ids with the 1,768 top-level files.

### What is deliberately *not* summed

- Cumulative advisor snapshots are **not** added to the itemized advisor rows read from the
  advisor's own transcript — they describe the same tokens through a per-session total instead of
  per-response identity, so only the itemized rows reach the engine-wide index.
- `getSessionStats()` is **not** added to per-response records. It measures the same scope through a
  different window (it is not cumulative and *drops* after compaction), so it is used as a
  reconciliation cross-check only.
- `reasoningTokens` is a **subset of output**, never a separate addend.
- `totalTokens` is not assumed to equal `input + output + cacheRead + cacheWrite`; providers may
  include orchestration overhead.

## Three different things called "usage"

The UI keeps these visually and semantically distinct, because conflating them is the most common
way usage displays lie:

| Concept | Meaning | Where shown |
|---|---|---|
| **Token usage** | Cumulative tokens consumed. Only grows. | Session usage table |
| **Context usage** | How full the model's window is *right now*. Falls after compaction. | Context meter |
| **Provider quota** | Subscription/plan limits. | Provider limits section |

## Cost honesty

- Cost appears only when OMP computed it.
- If some records report cost and others do not, the total is flagged `costPartial` and the UI says
  *"Cost is partial — some models did not report it."*
- Cost is never estimated from token counts and a price table of our own.

## Provider quota honesty

- Only what OMP's `fetchUsageReports()` returns is displayed.
- A provider with no usage endpoint renders **"Usage limit not reported by provider"** — never `0%`.
- Quota percentages are never inferred from token volume.
- Reports are cached upstream (with jitter, and last-good served on failure), so a timestamp can be
  hours old; treat it as a report, not a live gauge.

## Reconciliation pipeline

```
OMP live events
      │
      ▼
Live usage accumulator  ──►  UI (immediate)
      │
   turn settles
      ▼
Persisted OMP usage  ──► same keys, higher authority ──► replaces
      │
      ▼
Normalised usage index
```

On restart the index is rebuilt from persisted data. Because keys are deterministic, rebuilding
produces exactly the same totals — it does not accumulate on top of what was already counted.

## Global usage index

R1/R2 describe how records within a single session's ledger are kept honest. There is also a
second, engine-wide layer above that, because "which model is consuming my usage" is a
cross-session question:

- A persistent `UsageIndex` lives at
  `~/Library/Application Support/The Orchestrator/usage/records.jsonl`, outside any OMP directory.
  Every worker emits `usage.records` events into it as sessions run, and the `usage.query` request
  filters the accumulated records by time range, project, provider, model, and actor for the usage
  centre (⌘U).
- **Identity is global, not per-session.** A record that carries a provider `responseId` dedups
  against *every other record with that id anywhere in the index* — not just within its own
  session. This is what R1 already established for a single session's ledger; the global index
  applies the same rule at engine scope.
- That global rule is what makes **fork** and **reindex** safe rather than a source of double
  counting: a forked session's copied history shares `responseId`s with its source, so counting
  both the source and the fork does not double the tokens they share. Observing the same response
  once live and once later via reindex likewise collapses to one record, not two.
- **Provider retries are not deduplicated away** — a retry gets a fresh `responseId` from the
  provider, so it accumulates as genuinely new usage, which is correct: a retried call really did
  spend tokens.
- **Cumulative advisor snapshots are not in this index at all.** They are a per-session total, not a
  set of individually-keyed responses, so they cannot dedup against the itemized advisor rows the
  reindex reads — they would sum on top of them. `UsageIndex` rejects `source: "advisor-log"` on
  every path (live ingest, load, and the flush merge that re-reads the file), so neither a running
  worker nor a file written by an older build can reintroduce them. The per-session Inspector still
  shows them, straight from the worker's own accumulator.
- **`usage.reindex`** parses OMP's own session `.jsonl` files directly — the top-level session files
  *and* the advisor/subagent transcripts nested beneath them — and treats them as the authoritative
  `"omp-session"` source, the same authority ranking as R2, at the top. Reindexing is idempotent:
  running it twice does not change the totals, because record identity is deterministic. Measured on
  a real environment: **1,768 session files plus 219 nested transcripts into 28,658 records in
  1.2 s**, with totals byte-identical across three consecutive passes. See
  [PERFORMANCE.md](./PERFORMANCE.md) for the full measurement.

## Tests

`packages/usage/test/accumulator.test.ts` encodes the acceptance scenario:

| Actor | Input | Output |
|---|---|---|
| Primary | 10,000 | 2,000 |
| Advisor A | 3,000 | 1,000 |
| Advisor B | 4,000 | 1,000 |
| Subagent | 5,000 | 2,000 |
| **Total** | **22,000** | **6,000** |

Verified: totals are exactly 22k/6k/28k; they are **unchanged** after a simulated restart and a
double reindex; cumulative live updates replace rather than sum; persisted data is not clobbered by
a late live event; usage never crosses sessions; and partial cost coverage is flagged rather than
silently presented as complete.
