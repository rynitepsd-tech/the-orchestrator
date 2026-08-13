# The Orchestrator

A native macOS desktop harness for running several [OhMyPi (OMP)](https://github.com/can1357/oh-my-pi)
coding-agent sessions side by side, choosing models and advisors per session, and seeing exactly
which models consume your usage.

> **Unofficial.** The Orchestrator is not affiliated with, endorsed by, or supported by the OhMyPi
> project or its authors. It is an independent third-party desktop interface that embeds the
> published OMP SDK. Do not report problems with The Orchestrator to the OhMyPi maintainers.

## What it is

The Orchestrator is a session-oriented desktop host. It contains no model clients, no tool
implementations, no session format, and no advisor engine of its own — all of that is OMP's. The
project exists to expose OMP well on the desktop:

- run several top-level sessions concurrently, each in its own isolated worker process;
- pick the primary model, effort level, and advisor roster per session at creation time;
- attribute token usage to the actor that spent it, so "which model is consuming my usage" has a
  concrete answer rather than a single aggregate number.

Switching the visible session in the sidebar is a pure UI change. It never pauses, aborts, or
disposes anything: session lifetime is tied to a worker process, not to what React is rendering.

## Screenshots

None are committed yet. This section is a placeholder; screenshots of the session view, the
new-session sheet, and the usage inspector will be added here.

## Features

**Concurrency**

- One worker process per top-level session, so a fatal error in one session contains to that
  session instead of the app.
- Background sessions keep streaming while you look at another one; a native notification fires
  when a background session finishes or an advisor raises a blocker.

**Navigation**

- Project/session sidebar, grouped by project, with git branch, live run state (thinking,
  responding, running tool, waiting, interrupted, error), unread markers, and session search.
- Command palette (`⌘K` or `⌘⇧P`) covering new session, abort, compact, restart engine, panel
  toggles, and jump-to-session.
- Native macOS menus and keyboard shortcuts; notifications through the system notification centre.
- Session presets, model favourites and recents, pinned projects, and local session archiving —
  all Orchestrator-local preferences; OMP's own config is never written by this app.

**Approvals**

- Gated tools (bash, edit, delete, move) stop and ask, with inline approval cards offering Allow
  once / Always allow / Reject / Always reject, routed back to the right session even with several
  prompts pending at once.
- Per-session approval policy — `always-ask`, `write` (file edits auto-allowed, bash still prompts),
  or `yolo` — set at session creation, enforced worker-side.
- Extension confirm / select / input / editor / notification requests render as native UI; requests
  that only make sense in a terminal surface an explicit "unsupported interaction" card instead of
  hanging or auto-confirming.

**Transcript**

- Native rendering of assistant text, reasoning, tool calls, tool output, and edit diffs with
  per-file diffstat — not a terminal emulator.
- Advisor cards rendered inline with upstream's own severity levels: `nit`, `concern`, `blocker`.
- Slash-command completion in the composer, sourced from OMP's own command registry (builtins,
  skills, extensions, MCP prompts, file commands).

**Sessions**

- **Fork** — branch an existing session (live or discovered) into a new one with its history
  copied and lineage recorded, using upstream's own `forkFrom`.
- **Resume** — the sidebar lists previously persisted sessions; resuming replays their transcript
  into a fresh worker.
- **Changes** and **Files** panels — working-tree git status and diff, and a file browser scoped to
  the project, both read live through the engine.
- **MCP** status per session (server name, connection state, tool count) with reconnect, and an
  **engine diagnostics** view (per-worker PID and memory) under Settings.

**Usage**

- Per-actor attribution: primary agent, each named advisor, and subagents as a group.
- A context meter (what fits in the window now) kept visually and conceptually separate from
  cumulative session usage.
- Breakdown by input / output / cache read / cache write, and a by-model table.
- Cost is shown only when OMP reports it; a partial total says so instead of implying zero.
- Provider quota is read only from the provider's own usage endpoint. Providers without one render
  "Usage limit not reported by provider" — never a fabricated 0%.
- A global usage centre (⌘U) backed by a persistent, engine-wide index that survives restarts and
  never double-counts across sessions, forks, or reindexes.

**Resilience**

- The Rust shell reaps the engine process and reports its exit explicitly. Every affected session is
  marked interrupted, transcripts already on screen are preserved, and "Restart engine" relaunches
  and rediscovers persisted OMP sessions.
- A crashed worker is removed from routing with an actionable "resume" error; its transcript is
  preserved and other sessions are unaffected.
- The supervisor enforces single-writer access to OMP session files, which have no cross-process
  lock, and refuses to open the same session twice.

See [docs/USAGE_MODEL.md](docs/USAGE_MODEL.md) for the attribution and de-duplication rules.

## Requirements

- macOS on Apple Silicon. Intel (x64) is supported by the build script via `--target=x64` but has
  **not** been built or tested.
- Nothing else. OMP is bundled: the engine ships as a single compiled executable with the OMP native
  addon beside it, and nothing is downloaded at runtime. You do not need Bun installed, you do not
  need OMP installed, and normal use requires no terminal.

Provider sign-in runs from the app: Settings → Providers triggers OMP's own OAuth flow and opens the
browser URL the engine reports. The engine never sees the resulting secret; it is written straight
into OMP's own credential store, which the app then reuses. (Disconnecting a provider still requires
running `omp logout` in a terminal — sign-out is intentionally not exposed in the GUI.)

Windows and Linux are not supported.

## Installation

1. Download `The Orchestrator_0.2.0_aarch64.dmg` from the GitHub Releases page.
2. Open the disk image and drag **The Orchestrator.app** to `/Applications`.
3. Builds are ad-hoc signed (the maintainer has no paid Apple Developer account) and are therefore
   not notarised. On first launch macOS will refuse to open the app. Open
   **System Settings → Privacy & Security**, find the message about The Orchestrator, and choose
   **Open Anyway**, then confirm in the dialog that follows.

Do not disable Gatekeeper. The "Open Anyway" path grants an exception for this one application and
leaves the rest of the system protected.

## Development

Prerequisites:

- Bun 1.3.14 or newer (OMP declares `engines.bun >= 1.3.14`)
- Rust, stable toolchain
- Xcode command line tools

```bash
bun install            # install workspace dependencies
bun run build:engine   # compile the single-file engine + place the OMP native addon beside it
bun run dev            # run the desktop app against the local engine (sets ORCHESTRATOR_ENGINE_ENTRY itself)
bun test               # 67 tests across 8 files: usage de-duplication, concurrency, adapter, protocol
bun run check          # quality gate: biome check + typecheck + bun test
```

`bun run dev` works standalone — it sets `ORCHESTRATOR_ENGINE_ENTRY` to the local engine source
itself, so there is no separate "point the app at the engine" step.

Packaging and verification:

```bash
bun run release:check                 # check + build:engine + app build + packaged smoke, end to end
cd apps/desktop && bunx tauri build   # produces the .app and .dmg, if run standalone
bun run scripts/smoke-packaged.ts     # packaged smoke test: 24 checks
bun run validate:live                 # live validation against real providers (primary, advisor,
                                       # multi-advisor, subagent, resume, concurrent, fork)
```

Notes on the build:

- `bun build --compile` requires `--external omp-legacy-pi-modules` (an unresolvable dynamic import
  otherwise fails the bundle); `fastembed` and `onnxruntime-node` are externalised too.
- `pi_natives.darwin-arm64.node` must sit in the **same directory** as the engine binary — the
  addon loader's final search path is the executable's own directory.
- Signing is ad-hoc (`codesign --sign -`). Setting `MACOS_SIGN_IDENTITY` swaps in a Developer ID
  identity with no other change. Future notarisation will need entitlements including
  `com.apple.security.cs.disable-library-validation`, which is mandatory: the app `dlopen`s a
  `.node` built under a different Team ID, and without that entitlement the kernel refuses to map it.

The concurrency suite drives a local mock provider that speaks the OpenAI SSE wire format, so
running the tests spends no API credits.

## Architecture

```
React 19 + TypeScript UI
        ↕ typed NDJSON protocol
Tauri 2 native shell (Rust) — windows, menus, notifications, IPC
        ↕ stdin / stdout
Engine supervisor (Bun) — catalogue + routing by session id
        ↕ same protocol, scoped to one session
Session worker × N — exactly one OMP AgentSession each
        ↓
OhMyPi SDK — providers, tools, advisors, subagents
```

Process-per-session is deliberate. The preferred design — many `AgentSession`s in one process behind
a private registry — was abandoned after inspecting upstream source revealed four hazards an embedder
cannot fix from outside: subagents always register into `AgentRegistry.global()`; `AsyncJobManager`
is a first-session-only process singleton, so later sessions silently lose `bash --async` and
parallel `task`; `AgentLifecycleManager.global().dispose()` reaps across sessions; and
`Settings.init()` is memoized and ignores later callers' `cwd`/`agentDir`. Giving each session its
own process makes every session "first" and every process-global private.

The frontend cannot tell which topology is in use — the supervisor speaks the same protocol either
way. Full reasoning, the protocol frames, the persistence model, and the security boundary are in
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Relationship to OhMyPi

- Pinned to OMP `17.3.1` (`@oh-my-pi/pi-coding-agent@17.3.1` and its workspace siblings), consumed
  through the **published npm SDK** — not by shelling out to the `omp` CLI and not by vendoring
  upstream source.
- Upstream is `can1357/oh-my-pi`, MIT licensed, by Mario Zechner and Can Bölük.
- Version bumps are deliberate, never floating. The upgrade procedure and the exact upstream symbols,
  event shapes, and enumerations this project depends on are documented in
  [docs/OMP_COMPATIBILITY.md](docs/OMP_COMPATIBILITY.md).

Models, providers, tools, approval semantics, advisors, and session storage all behave according to
**your** OMP configuration. The Orchestrator reads `WATCHDOG.yml`/`WATCHDOG.yaml` with upstream's own
walker, offers exactly the thinking levels the selected model reports, and writes sessions where OMP
puts them (`~/.omp/agent/sessions/...`). It does not override your settings or maintain a competing
session format. Orchestrator-only UI metadata lives in
`~/Library/Application Support/The Orchestrator/`.

## Privacy

- Local-first. No accounts, no cloud backend, no analytics, and no telemetry added by this project.
- Credentials stay in OMP's own store and never leave the engine; the frontend receives sanitised
  metadata only.
- Redaction is applied at the protocol boundary and in the logger, so secrets reach neither the UI
  nor the log files.
- The webview has a restrictive CSP and a narrow Tauri capability set; it cannot touch the
  filesystem or spawn processes directly.

## Current limitations

This is version 0.2.0. The following are not implemented in this build:

- **Intel (x64) is untested.** The build script supports it; no Intel build has been produced or run.
- Windows and Linux are not supported and are not planned.
- **No notarization.** Builds are ad-hoc signed; see [Installation](#installation).
- **Same-session CLI + GUI concurrent writes are unsupported.** The single-writer guarantee is
  enforced only within this app's own process; running `omp` on a session this app currently has
  open risks corruption (sequential handoff between the two is fine — see
  [docs/SESSION_MODEL.md](docs/SESSION_MODEL.md)).
- **Extension UI bridge is terminal-only for custom components.** Standard interaction types
  (confirm, select, input, editor, notify) render natively; an extension's fully custom component
  surfaces an explicit "unsupported interaction" card rather than drawing arbitrary UI.

Each unimplemented protocol request returns an explicit error or an empty result rather than a silent
no-op.

Accepted costs of process-per-session: roughly 320 MB RSS per live session packaged (see
[docs/PERFORMANCE.md](docs/PERFORMANCE.md) for the full measured breakdown), and MCP servers and
LSP pools are per-session rather than shared — which is why both are opt-in per session.

## Contributing

Issues and pull requests are welcome. Before opening a pull request:

1. Read [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — the layer responsibilities are enforced, and
   in particular the UI must not learn OMP internals and the adapter must not leak upstream types
   upward.
2. Run `bun run check` (biome check + typecheck + `bun test`).
3. If the change touches packaging or the engine, run `bun run build:engine` and
   `bun run scripts/smoke-packaged.ts`, or the combined `bun run release:check`.
4. Do not add telemetry, analytics, or any network call that is not an OMP provider request.

Changes that bump the OMP pin must follow the procedure in
[docs/OMP_COMPATIBILITY.md](docs/OMP_COMPATIBILITY.md#updating-the-bundled-omp), including
re-vendoring both native addons in the same commit.

## Licence

MIT. See `LICENSE`.

The Orchestrator bundles OhMyPi and other third-party software under their own licences; OMP itself
is MIT. Attributions and full licence texts are collected in
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
