# Changelog

## 0.5.1

- **OMP 17.3.4** ships inside this update: monorepo edit-rejection fix,
  subagent completion stall fix, MCP Streamable-HTTP — and mupdf is gone,
  closing the AGPL exposure.
- **Permission modes.** Every session's composer has a Manual / Auto edits /
  Full access switch, enforced worker-side through OMP's tool-tier gate — so
  Manual now genuinely gates write/eval/browser/computer, not just bash.
  Modes persist per session, changes are recorded in the transcript, and
  Full access asks for confirmation.
- **Security hardening.** Provider sign-in works again (opener permissions
  were missing); all file reads from the UI are confined to open projects'
  symlink-resolved roots; the engine rejects unknown request frames;
  SECURITY.md now tells the truth.
- **Redaction overhaul** — fails closed on depth, redacts events and
  lifecycle frames, catches env-style tokens/URL basic-auth/Stripe/npm/
  OAuth-JSON/PGP, and can no longer be stalled by giant unclosed PEM blocks
  (or flip boolean flags to truthy strings).
- **Turn integrity.** Steering or queueing mid-turn no longer fires a false
  "✓ Done"; double-applied events can't duplicate messages or markers.
- Composer clears when switching sessions; auto-compaction and provider
  retries announce themselves; workers tear down MCP/LSP children on
  shutdown (with SIGKILL escalation); usage history survives transient I/O
  failures; agents stop emitting LaTeX (and the common forms render anyway).
- Requires macOS 14.5+ (the native addon always did; the installer now says
  so). CI: clippy is blocking and releases gate on both typechecks.

## 0.5.0

- **Advisor failures explain themselves and heal.** The real cause (model,
  error text) now reaches the transcript — the app was silently dropping
  OMP's notice events — and a stopped advisor is rebuilt on your next
  message instead of staying dead for the session.
- **Turns condense completely.** Advisor notes stay visible while the agent
  acts on them, then fold into the "Worked for …" line with everything else
  (the line counts them). One line per turn, answer right below, duration in
  a full-width "✓ Done in …" divider.
- **Final answers address you.** Sessions carry a standing instruction:
  weigh advisories, but the last message each turn must be a standalone
  answer to the user — never a reply to the reviewer.
- **Status dots mean something.** Working is an accent-green wave, finished
  is solid blue; the gray-forever look is gone.
- **Quiet scrollbars.** Invisible at rest, faint while hovered — never the
  native bright thumb.
- **Tables stop crushing.** Markdown table columns keep words whole; wide
  tables scroll instead of squeezing to single characters.
- Usage Breakdown numbers right-align; the breadcrumb title survives a
  cramped bar (the live status truncates or hides first).

## 0.4.5

- **Traffic lights sit inside the bar.** The macOS window controls are
  padded down and in, left-aligned with the search box and centred on the
  logo row — like every other Mac app.
- **Panel toggles are real icons.** The sidebar/inspector toggles swap text
  glyphs for stroke icons, so they sit level with the wordmark.
- **Links are blue again** — a dedicated link colour, separate from the
  forest-green accent chrome.
- The redundant folder button left the file preview header; "Open in
  folder" lives in the Open dropdown.

## 0.4.4

- **Agents see your real PATH.** Finder-launched apps get macOS's minimal
  PATH, so agent tools couldn't find Homebrew or user CLIs (chromium, node,
  gh — the reason "Commit, Push & PR" could silently skip the PR). The
  launcher now appends the standard install locations that exist on disk.
- **Workers can no longer escape the project folder.** Worker processes run
  with the project as their working directory, and resuming a session whose
  recorded cwd went stale falls back to the project — not "/".
- **Mislinked file citations resolve themselves.** A cited bare filename
  that isn't at the project root is located by name inside the project and
  the preview opens at the real path, instead of "File not found on disk."
- **Top bar, three ways.** The bar now mirrors the app's three columns: the
  stretches above the sidebar and inspector share their darker ground with
  aligned seams; the breadcrumb stays left in the middle section and the
  chips right-align with it. When cramped it sheds the effort level, the
  word "Context", and the usage chip. "The" is the bold half of the logo now.
- **The plan docks on the composer** — the todo strip sits on top of the
  message bar at half its width, fused to the card's top edge.

## 0.4.3

- **T3-style top bar.** Taller and borderless, blending into the page: the
  logo reads "The **Orchestrator**", followed by a folder › session
  breadcrumb with live activity. The OMP version moved to Settings; the
  review inbox moved to its own tab at the bottom of the sidebar (with its
  badge). Preset, advisors, context, and usage stay on the right.
- **PDFs preview inline** in the file pane, rendered by the webview itself.
- **Sidebar polish.** Search sits above "+ New Session", and the button is
  now input-shaped with a green outline instead of a solid fill. Hiding the
  sidebar (⌘1) no longer collapses the layout.
- Interrupted sessions offer their Resume button in a banner above the
  transcript.

## 0.4.2

- **File links preview in the app.** Clicking a hyperlinked file (inline code
  refs, markdown links, or tool-card paths) opens it in a new "File" tab in
  the right sidebar — line numbers, the cited line highlighted and scrolled
  into view. Top-right buttons open the file in VS Code, reveal it in Finder,
  or hand it to the default app. Files outside the project still open
  externally.
- **Preset pickers tell the whole truth.** "OMP default" is gone from the
  home-screen picker; it lists your presets plus "＋ New preset…", which opens
  the full editor (model, effort, fast mode, advisors) and makes the new
  preset the default. A caption under the composer says which advisors the
  session will start with. The in-session picker shows each preset's model
  and clarifies that advisors don't change mid-session.
- **Deeper accent.** The periwinkle accent is now a deep indigo in both
  themes.
- **Links look like links** — file references are accent-coloured before you
  hover, not after.
- **The right sidebar starts closed.** Open it with ⌘2, the Usage chip, or by
  clicking any file link.

## 0.4.1

- **Presets run the composer.** The composer chip now shows the PRESET the
  session runs with (your default preset for new sessions); picking one
  applies its model, effort, and fast mode live, and "＋ New preset…" saves
  the current setup under a name. Set the default preset in Settings →
  Presets ("Make default") or on the home screen.
- **Settings and Usage moved to the bottom of the sidebar**, T3-style; the
  titlebar gear is gone.
- **Projects look like folders.** Folder icons instead of dropdown chevrons,
  real folder names instead of ALL CAPS, and right-click → "Rename project"
  for a display name of your choosing.
- **No more bold.** Every font weight stepped down — titles and names sit a
  notch above body text instead of shouting.
- **"+ New Session" opens the home screen** (the same launch view you get on
  startup); the full advisor sheet is still one click away from there.
- **Closed sessions stay closed.** The bottom section is now "Closed
  sessions"; single clicks do nothing, double-click arms a row and shows a
  Reopen button. No more accidentally spinning up a worker while browsing
  history.
- **Session usage panel survives restarts** — it now pulls the persisted
  breakdown from the usage index instead of sitting empty until the next
  turn.
- Fast mode wears a proper icon instead of an emoji, everywhere.

## 0.4.0

- **T3-style composer.** A floating rounded card with the session's
  pre-flight contract along the bottom: attach, model picker and effort
  picker (switchable mid-session), fast-mode toggle, and a circular send
  that becomes stop while the agent runs.
- **Session dots that mean something.** Yellow blinking dot = the session
  needs your input (stops blinking once you're looking at it), a quiet
  three-dot wave = working, solid blue = finished since you last looked
  (clears on click), red = failed.
- **Commit, Push & PR in one click** from the Changes panel: branches off the
  default branch when needed, commits everything, pushes, and opens a PR via
  gh — one confirm, then a link to the PR. Degrades gracefully without gh.
- **Review inbox.** A titlebar inbox (with badge) flattens everything waiting
  on you across sessions: approvals answerable right there, finished sessions
  to open or mark reviewed, and failures.
- **Rewind.** Hover a message of yours and click ↺ to rewind the conversation
  to before it (OMP tree navigation, same session file). The message text
  returns to the composer for editing. Conversation-only — files on disk are
  not changed, and rewind is offered only while the session is at rest.
- **Live plan strip.** When the agent keeps a todo list, a pinned strip shows
  "3/7" and the task in flight, expandable to the full phased checklist; the
  sidebar row shows the fraction too. Restored on resume.
- **Updates land on the latest version.** Installing an update now re-checks
  the feed at click time, so stacked releases never require two manual
  updates.

- **Near-black theme.** The session view and sidebars dropped to T3-style
  near-black; cards and bubbles pop harder against both.
- **Drag reorder actually works now.** Tauri's native drag-drop layer was
  swallowing HTML5 drag events in the webview (`dragDropEnabled`), so project
  and session dragging never fired. Disabled it; dragging works.
- **A real home screen.** With no session selected: "What should we build in
  <project>?" over a big composer. Your default preset and last-worked folder
  are pre-selected and changeable inline; Enter creates the session and sends
  the first message. The preset choice persists as your default.
- **Usage, rebuilt T3-style.** Big raw-token-cost headline ("* if billed at
  full API rate"), per-provider share bars, a daily cost/tokens area chart,
  a stat row (processed / cached / uncached / output / estimated cache
  savings), and a Model/Day breakdown table. Session, project, advisor, and
  quota sections remain below.
- **Attach images and files.** + button, paste a screenshot, or drop files
  onto the composer. Images go to the model as real image input (resized and
  capped via OMP's own loader); other files are passed by path for the agent
  to read. Attachment chips render on your message.
- **Clickable files and links.** File paths in responses (inline code,
  markdown links) and in tool cards open the file with one click, routed
  through the engine; bare URLs in prose open in your browser.

## 0.3.10

- **Roomier prose.** Paragraphs, lists, and headings in responses get real
  breathing room, and transcript items sit a little further apart.
- **Deeper backgrounds.** The session view is slightly darker and the
  sidebar/inspector darker still, so the surface hierarchy reads better
  (both themes).

## 0.3.9

- **Live work is one tidy line, not a wall of cards.** While the agent works,
  thinking and tool calls gather behind a single status line ("Thinking…",
  "Running grep") with a small preview of the latest reasoning underneath.
  Click to expand the full step list; each step still opens for its command
  and output. When the answer lands it settles into the usual "Worked for …"
  line.
- **Drag sessions to reorder them** within a project group — resume rows too —
  with a drop line showing where the row will land. The order is remembered
  across relaunches.
- **New sessions start at the top** of their project group.

## 0.3.8

- **Fast-mode toggle lives beside Send.** The ⚡ button sits in the composer
  now; hovering explains that it speeds up responses but uses your provider
  usage significantly faster.
- **One click opens a paused session.** Click anywhere on a previous-session
  row to open it — no separate Resume button to find.
- Titlebar icons enlarged again.

## 0.3.7

- **You can tell when it's done.** Every completed turn ends with a "✓ Done"
  marker in the transcript — or "✓ Turn finished — advisors are still
  reviewing and may add notes" when a reviewer hasn't weighed in yet. The
  session header likewise shows "Advisors reviewing…" instead of a premature
  "Finished".
- **Turn condensing, all the way.** A finished turn is now ONE expandable
  "Worked" line: intermediate narration, thinking, and tool batches all fold
  in; only the final answer stays out. If the agent resumes after an advisor
  blocker, the new work streams below — and folds too once the next answer
  lands.
- **Usage numbers unglued.** Token and cost columns had zero spacing between
  them ("190.5M$168.85"); columns now keep a readable gap.
- **Collapsed projects keep your active session visible**, so folding the
  project you're working in never hides where you are.

## 0.3.6

- **Fast mode** (OpenAI / Anthropic priority tier), wired through OMP's own
  service-tier support: a ⚡ Fast chip in the session header toggles it live,
  New Session has a fast-mode checkbox, and presets can launch with it on.
  Models with no priority tier say so instead of pretending.
- **Drag projects to reorder them.** Grab a project header in the sidebar and
  drop it where you want; the order persists. Projects you never drag keep
  pinned-first alphabetical order.

## 0.3.5

- **Bigger type across the app** — every text size up 2px for readability.
- **Context shows immediately on resume.** A resumed session reports its
  context-window consumption with the replayed transcript, so the titlebar
  chip and Usage meter are accurate before you type anything — no more
  discovering a near-full context after sending a message.

## 0.3.4

- **Fix messages appearing twice.** The app showed your message optimistically
  AND rendered the worker's echo of it as a second bubble. The echo now
  reconciles into the original bubble.
- **Open sessions survive relaunch in place.** Sessions you did not explicitly
  close stay under their project group after a restart, with one-click resume.
  Only "Close session" (or "Stop and close") moves one to Previous sessions.
- **Whole turns condense like Codex.** Once the answer arrives, everything
  that produced it — thinking, tool calls, subagents — collapses into a single
  expandable "Worked for Ns · N steps" line before the answer. Work in
  progress, advisor notes, and pending approvals stay visible.

## 0.3.3

- Update checks no longer leave a 4-hour blind spot: the app rechecks a few
  minutes after launch, hourly, and when the window regains focus, so a new
  release is offered within minutes of publishing.

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
