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
| **Advisor tokens & cost** | `session.getAdvisorStats().advisors[]` | Cumulative snapshot per named advisor; each poll **replaces** |
| **Subagent** | task tool result usage | Keyed by tool call id |
| **Context window** | `session.getContextUsage()` | `usedTokens` / `contextWindow` |
| **Provider quota** | `authStorage.fetchUsageReports()` | Only providers with a usage endpoint |

### Advisor caveat

`PerAdvisorStat.cost` **is** cumulative and survives resume. `PerAdvisorStat.tokens` is
**live-context only** and resets when the advisor compacts. Advisor rows therefore show cost as the
durable number; token counts are a current-window figure.

### What is deliberately *not* summed

- Subagent transcripts are **not** added on top of the primary ledger where OMP already folds task
  `toolResult` usage into it — doing both double-counts every blocking subagent turn.
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
