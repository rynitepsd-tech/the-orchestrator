# Performance

Measured on an Apple Silicon Mac (arm64), macOS 15, OMP 17.3.1, app version
0.2.0. Every number below was produced by `bun run scripts/stress-matrix.ts`
(dev-mode workers) or the packaged-engine probe (compiled binary inside the
built `.app`), not estimated.

## Startup

| Stage | Packaged |
|---|---|
| Engine spawn → `engine.ready` | ~365 ms |
| Worker spawn → session ready | ~470 ms |
| Model registry load (`models.list`, 4,291 models) | < 2 s (cached after first call) |

The UI shows staged progress (`starting → loading-config → loading-models →
ready`) driven by real engine lifecycle events, so nothing hides behind a
spinner.

## Memory — the process-per-session cost

Process-per-session is a deliberate correctness trade (see
[ARCHITECTURE.md](ARCHITECTURE.md)); this is its price, measured honestly:

| Process | RSS |
|---|---|
| Supervisor (packaged engine, idle) | ~300 MB |
| Worker, packaged, after one completed turn | **~320 MB** |
| Worker, dev mode (unbundled source) | ~350 MB |
| Worker after heavy streaming | ~415 MB (dev) |

Worker RSS is flat as sessions are added — 8 concurrent workers measured
351–360 MB each (dev), with no per-worker growth from neighbours. The
older docs' 150–250 MB estimate was optimistic; treat **roughly 300–470 MB
per live session**, depending on load, as the planning envelope rather than
a single number.

Practical envelope: a 16 GB machine runs 6–10 live sessions comfortably
alongside a browser and editor; a 32 GB machine does not need to think about
it. Closed sessions release their worker immediately (`sessions.close`), and
resumable state lives in OMP's session files, not in worker memory.

## Concurrency under load

Stress matrix, N = 1…8 sessions (mock provider, real OMP runtime, real
worker processes, one completed tool-running turn each):

| Sessions | Worker spawn | Supervisor round-trip | Total worker RSS |
|---|---|---|---|
| 1 | 490 ms | 0.2 ms | 350 MB |
| 4 | 499 ms | 0.4 ms | 1.41 GB |
| 8 | 502 ms | 0.3 ms | 2.83 GB |

- Spawn latency is constant (~500 ms) regardless of how many workers exist.
- Supervisor request routing stays sub-millisecond at 8 live workers.
- All 8 sessions streaming simultaneously completed with no cross-talk and no
  event loss; streaming deltas are coalesced at ~30 fps per session on the
  worker side, so UI load is bounded per session, not per token.

## Transcript rendering

- Deltas are batched by the worker (~30 fps) and appended into the last
  matching bubble; streaming text renders as plain text and swaps to the
  markdown tree only when the message completes, so re-parsing never happens
  per delta.
- The transcript renders a 300-item window with "Show earlier" paging;
  10,000-event sessions stay responsive because unmounted items are simply
  not rendered (and can be paged back in without loss).
- The worker keeps a 20,000-event replay buffer per session for reload
  recovery; replay of a full session transfers coalesced events, not raw
  deltas.

## Usage index

Reindexing **1,768 real session files plus the 219 advisor/subagent
transcripts nested beneath them → 28,658 usage records took 1.2 s**
(`usage.reindex`). The index loads off the startup path, persists as a
single JSONL snapshot with atomic writes, and re-running reindex is
idempotent (global responseId identity): three consecutive passes produced
byte-identical totals.

## Where the time is NOT spent

- Switching visible sessions is a pure React state change; no engine call is
  required (the transcript is already in the store).
- The 4,291-model picker renders 60 rows at a time with incremental scroll
  fill; typing filters in memory.
