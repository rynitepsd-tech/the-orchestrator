# Changelog

## 0.3.2

- **Approvals can't hide any more.** A pending approval pins a bar above the
  composer — tool, exact command, and the Allow/Reject buttons right there —
  until you answer. Extension prompts pin too, with a jump to their card.
  "Needs review" is now impossible to miss.
- **Tool calls are one line each.** Every command/edit/read collapses to a
  single header line (name + argument + status); click to expand output or
  diff. Failures auto-expand.
- **Provider limits actually show numbers.** The engine read usage quantities
  from the wrong level of OMP's usage reports, so every window rendered "—".
  It now mirrors OMP's own fraction resolution (explicit fraction, used/limit,
  percent, inverted remaining) and reports reset times. Limits also refresh
  after every finished turn and every 10 minutes, instead of only at launch.

## 0.3.1

Feedback round from real use.

- **Thinking collapses when the answer arrives.** Reasoning streams live while
  the model works (clipped to the latest lines), then tucks behind a "Thought
  process" dropdown so the transcript shows answers, not scratch work.
- **Transcript measure.** Messages now sit in a centred column with proper
  side padding instead of running wall to wall.
- **Sidebar project groups collapse.** Click a project header to fold its
  sessions away (state persists); "Previous sessions" folds too.
- **Effort pickers collapse after choosing**, like the model picker — and
  advisors now have effort selection everywhere (presets included), with the
  current choice always visible.
- **Preset chips read as actions** (“Name” Preset) and deleting a preset asks
  for confirmation first.
- **Provider search** in first-run setup and Settings → Providers.
- Bigger titlebar buttons.

## 0.3.0

Quality-of-life release: first-run setup, real dialogs, and self-updating.

### Setup and presets

- **First-run setup flow.** New installs get a short wizard: connect your
  providers, create a default preset (primary model + two advisors), and
  optionally a second preset. Skippable; everything it writes is local.
- **Settings → Presets.** Create, edit, rename, and delete session presets
  after setup. Presets remain one-click templates in New Session.

### Fixes

- **Dialogs are centred.** New Session (and every other dialog) opened in the
  top-left corner because the backdrop CSS class was never defined. Fixed.
- **"Add advisor", "Save as preset", and "Rename session" work.** They relied
  on `window.prompt()`, which macOS WKWebView silently ignores. All three now
  use real inputs.
- **The window can be dragged by its titlebar.** The titlebar used Electron's
  `-webkit-app-region`; Tauri needs `data-tauri-drag-region`. Double-click to
  zoom works too.
- **The model picker collapses once you pick.** It shows a compact summary row
  and expands on click, instead of a permanently open list.

### Convenience

- Sidebar and inspector are resizable by dragging their edges (widths persist).
- "+ New Session" button at the top of the sidebar; titlebar buttons for
  sidebar, inspector, and settings.
- Settings opens as an overlay instead of replacing the main view.
- Escape consistently dismisses the topmost surface; Escape in the composer
  stops a running turn; the composer refocuses when switching sessions.

### Updates

- **In-app auto-update.** The app checks the GitHub Releases feed at startup
  and every 4 hours; when a new version is published, an Update chip appears
  in the titlebar — one click downloads, verifies the minisign signature,
  installs, and offers a restart. Manual check in Settings → About. No
  telemetry: the check fetches a static JSON file.

## 0.2.0

The daily-driver release: everything between "OMP can run in a desktop app"
and "you don't need the terminal any more".

### Interactive OMP

- **Approvals.** Gated tools (bash, edit, delete, move) now stop and ask.
  Approval cards render inline with the exact command, Allow once / Always
  allow / Reject / Always reject, and route back to the right session even
  with several prompts pending at once. Sessions waiting on you show
  **Needs input** instead of fake progress. Per-session approval policy:
  always-ask, write (file edits auto-allowed), or yolo — never a silent
  default.
- **Extension prompts.** OMP extensions' confirm / select / input / editor /
  notification requests render natively. Terminal-only custom components
  surface an explicit "unsupported interaction" card instead of hanging.

### Sessions

- **Fork** — upstream `forkFrom` semantics: history preserved, new identity
  with recorded lineage, original untouched, fork immediately runnable (and
  on a different model if you want).
- **Resume** — persisted OMP sessions appear in the sidebar and resume with
  their full conversation replayed; CLI and app can hand sessions back and
  forth.
- **Crash recovery** — a dead worker interrupts only its own session, keeps
  the transcript, and offers one-click resume. Quit now confirms when
  sessions are still running.
- Sidebar as control centre: truthful run states, unread markers,
  needs-input badges, shared-working-tree warnings, context menu (rename /
  fork / abort / reveal / close), local archiving, ⌘K session switcher.

### Advisors and subagents

- Advisor notes render as severity cards (nit / concern / blocker) with
  per-advisor usage attribution — validated against live providers, two
  advisors at once, no cross-attribution.
- Session-only advisor overrides and custom advisors in the New Session
  sheet; WATCHDOG files are never written.
- Subagent cards show live progress, tool counts, tokens, and cost, with
  per-response usage attribution from the subagent's own event stream.

### Usage

- **Usage centre** (⌘U): totals, by model, by actor, by session, by project,
  time ranges, provider quota — backed by a persistent engine-wide index
  that survives restarts, dedups retries, and never double-counts fork
  history. `Reindex` rebuilds from OMP's own session files as the
  authoritative source.
- Session usage vs context window remain strictly separate numbers.

### Environment

- **Changes panel**: real git status with per-file diffs and untracked
  previews. **Files panel**: gitignore-aware listing with bounded read-only
  preview.
- **Slash completion** from the session's real command set (builtins,
  skills, extensions, MCP prompts). Command palette (⇧⌘P) with every menu
  action actually wired.
- **MCP status** per session with reconnect. **Provider sign-in** through
  OMP's own OAuth flow (browser opens; secrets never leave OMP's storage).
- Settings: theme, notification preferences, providers, MCP, engine
  diagnostics with per-worker RSS and Copy Diagnostics, About.
- Markdown rendering (safe React nodes, no HTML injection), richer tool
  cards with MCP identity, hunk-aware diff viewer, scrollback paging that
  never destroys history.

### Foundation

- Test suite grew 20 → 67 (protocol framing/redaction, event mapping,
  usage identity incl. fork/retry cases, approval round-trips, transcript
  replay, spaces-in-path, exact-once completion, worker crash containment,
  fork divergence). Packaged smoke grew 19 → 24 checks (approval, replay,
  fork inside the built .app).
- Live-model validation suite (`bun run validate:live`) covering primary /
  advisor / multi-advisor / subagent / resume / concurrent / fork against
  real providers.
- Worker stderr surfaced at info level with a diagnostic ring; worker exit
  errors are actionable; events are ownership-checked per worker.
- Measured performance published in docs/PERFORMANCE.md.

## 0.1.0

Initial technical MVP: process-per-session engine over the OMP SDK, real
streaming and tools, OMP-compatible persistence, per-actor usage
attribution, Tauri shell, packaged Apple Silicon DMG.
