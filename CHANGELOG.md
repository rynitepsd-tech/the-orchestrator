# Changelog

## 0.5.12

- **Sessions name themselves.** A new session launched without an explicit
  title now gets one generated from its first prompt (the way Codex and
  Claude apps do), replacing "New session" in the sidebar a moment after the
  first message. Naming runs through OMP's own title pipeline — greetings and
  low-signal prompts stay unnamed until a real prompt arrives, an explicit
  title typed in the New Session sheet is always respected, and renaming at
  any time still works (renames now also propagate to the supervisor's
  session list instead of going stale).
- **1-hour prompt-cache retention.** The engine now asks OMP for long cache
  retention (`PI_CACHE_RETENTION=long` unless the user already set it), so
  Anthropic requests use the 1-hour cache TTL instead of the default 5
  minutes — interactive sessions with pauses between messages stop re-reading
  the whole conversation at full price after a short idle. OMP gates it per
  provider/model; providers without long retention are unaffected.
- **Turn timestamps.** Each "✓ Turn finished" marker now says how long ago
  the turn landed ("· 12 min ago", hover for the absolute time), ticking
  every minute — handy for judging whether the prompt cache is still warm.
  Live turns only; replayed history has no markers to mis-stamp.
- **Session usage columns line up.** The inspector's usage sections (Session
  usage, Breakdown, By model) are separate tables that each auto-sized their
  own columns; shared fixed widths now keep tokens-over-tokens and
  cost-over-cost aligned across sections.
- **Usage page provider rows line up.** The hero's per-provider list reused
  the Settings panel's `.provider-row` class, whose flex-row rule crushed the
  name/bar/hint stack onto one line with costs at ragged positions. Scoped
  override restores the intended block layout with costs on a common right
  edge.
- **By project caps at 20.** The usage page's "By project" list now shows the
  top 20 with a "Top 20 of N projects shown" note, matching "By session"
  instead of growing unboundedly next to it.

## 0.5.11

- **Mid-turn messages say whether the agent has seen them.** A prompt sent
  while a turn is running (steer or ⌘Enter follow-up) now shows a small
  "Unread" label right under the bubble, flipping to "✓ Read" the moment OMP
  actually injects the message into the conversation — the signal is the
  worker's echo of the message, not a timer, so the label is truthful.
  Ordinary turn-starting messages and replayed history are unaffected.

## 0.5.10

- **Dropping a file can no longer take over the app.** Tauri's native
  drag-drop interception is off (so composers get real HTML5 drop events),
  which left WKWebView's default in charge everywhere else: dropping e.g. a
  JPEG anywhere outside a composer navigated the entire window to the image,
  with no way back short of quitting. A window-level guard now neutralises
  the default; component drop targets still receive their files.
- **The home screen takes attachments.** The launch composer now has the same
  attach button, drag-and-drop, and paste-an-image support as the in-session
  composer, and dropped files ride along with the first message. Attachments
  alone are a valid first message.
- The in-session preset picker's tooltip no longer claims advisors don't
  change on preset switch (they do, since 0.5.9).

## 0.5.9

- **Resumed sessions keep their advisors.** Resuming a session relaunched it
  with a hardcoded empty advisor list — only the remembered preset's model and
  fast mode were re-applied — so every resume silently ran with zero
  reviewers. The remembered preset's advisors now ride along in the boot
  config, so reviewers come back with the session.
- **Switching presets mid-session applies its advisors.** The composer's
  preset picker only changed the model and fast mode; the preset's reviewer
  roster is now pushed to the running worker too (session.advisors.set), so
  reviewers start/stop to match the chosen preset — an advisor-less preset
  stops them.
- **Preset advisors survive the New Session sheet.** WATCHDOG discovery
  resolves asynchronously and could overwrite advisors the user had just
  applied from a preset (or edited by hand) with the project's list — usually
  empty. A session-level advisor choice now wins over late discovery results.
- **New sessions appear at the top of their project.** A brand-new session
  persists its OMP path before the create response returns, so the sidebar
  mistook it for a resume and appended it to the bottom of the project group.
  New (and forked) sessions now claim the top slot; resumed sessions keep
  their place as before.
- **Engine respawn loop fixed.** OMP's daemon broker (and its other hidden
  worker re-entries: LSP mux, tiny title model, …) re-execs
  `process.execPath` — which in a packaged build is the orchestrator engine
  binary. The engine didn't recognize those selectors, booted a supervisor in
  the broker's place, died on its closed stdin, and OMP respawned it every
  ~10 seconds per live session, forever ("stdin closed; shutting down" flood
  in engine.log). `__omp_worker_*` argv now routes to OMP's own CLI dispatch.
  The same fix covers `browser-relay`, the one plain CLI command OMP
  daemonizes under that broker — this is what "shared browser daemon and
  browser-relay broker are unavailable" errors from browser-using tasks were
  about. (Authenticated captures additionally need OMP's browser extension
  connected to the relay.)

## 0.5.8

- **Disconnect from the GUI.** Connected providers now have a Disconnect
  button that removes the stored credential through OMP's own
  `AuthStorage.logout` — with a confirmation first, because the credential
  store is shared with the `omp` CLI and signing out here signs the CLI out
  too. Credentials supplied by environment variables are not stored, so
  disconnecting reports them as still configured instead of pretending they
  are gone. docs/SECURITY.md updated to describe the current credential
  posture (prompt bridging, GUI disconnect) instead of the pre-0.5.6 one.

## 0.5.7

- **Subscriptions lead the Providers panel.** The Orchestrator runs on plans
  you already pay for, so real OAuth sign-ins (Claude Pro/Max, ChatGPT/Codex,
  GitHub Copilot, Gemini, Cursor…) now sit in their own "Subscriptions"
  section up top with a primary Sign in button — "no API billing" says why.
  Key-based providers are grouped separately under "API-key providers" and
  labelled by what actually happens: "Get API key…" for flows that open the
  provider's key console and ask for a pasted key (which previously read as
  a confusing surprise), "Add API key…" for direct storage. Classification
  comes from OMP's own registry (login + refreshToken ⇒ subscription).
- **The paste-code fallback explains itself.** During a subscription sign-in
  the input that appears alongside the browser hand-off now says it's only a
  fallback for when the browser can't hand the code back — not a request for
  an API key.

## 0.5.6

- **API-key providers can finally be connected from the GUI.** Most of the
  catalogue (and the entire top of the alphabetical list — aiand, aimlapi,
  alibaba-\*) authenticates with an API key, not OAuth, and every Connect
  click on those failed with a misleading "manual code entry" error. The
  engine now bridges OMP's login questions to the app: when a flow asks for
  an API key, a paste-code fallback, or GitHub Copilot's enterprise domain,
  an input appears right in the Providers panel and the answer flows back
  into OMP's own login (validation included). Providers with no login flow
  at all get an "Add API key…" button that stores the key through OMP's
  credential store.
- **Honest Connect buttons.** Providers are labelled by how they actually
  connect — sign-in flow vs. pasted API key — and sign-in-capable providers
  sort first in the "Not connected" list.

## 0.5.5

- **Connecting a provider works again for first-time users.** OMP 17.3.4
  changed its OAuth hand-off in two ways the GUI mishandled: the sign-in event
  now leads with a localhost "launch" URL, which the https-only browser gate
  silently refused to open, and the major providers (Anthropic, OpenAI Codex,
  Google) gained a paste-the-code fallback prompt, which the engine answered by
  throwing — so every Connect click errored with "manual code entry is not
  supported" while no browser ever appeared. The engine now opens the real
  https authorize URL, answers optional prompts with their default (GitHub
  Copilot's enterprise-domain question), parks the paste-code fallback so the
  browser callback completes the flow, and fails fast with an actionable
  message only when a flow truly has no local callback.
- **Fixed runaway memory during first-run setup.** OMP retries a rejected
  manual-code prompt in an unthrottled loop; the engine's throwing prompt
  handler sent that loop spinning, flooding the event pipe with identical
  frames until the process ballooned (reported at 90 GB). The prompt handler
  no longer rejects, and the login path now collapses identical consecutive
  lifecycle frames as defense in depth.
- **Sign-in guidance is now visible where you clicked.** Device-code
  instructions ("Enter code: XXXX-XXXX") and browser hand-off notices appear
  in the Providers panel — including inside first-run setup, where the global
  error banner used to hide behind the modal. Refusing to open a non-https
  sign-in URL is now said out loud instead of failing silently.

## 0.5.4

- **"Advisors reviewing" can no longer get stuck.** OMP reports a healthy
  advisor's runtime as "running" forever — it never meant "reviewing right
  now". The engine now opens a review window when a turn actually ends and
  closes it via OMP's real drain signal (`waitForAdvisorCatchup`, the same
  10-minute mechanism OMP's own print mode uses), so "Advisors reviewing…"
  resolves to "✓ Turn finished" the moment reviews drain — including after
  advisor-triggered continuation turns.
- **Multi-answer turns keep every real answer.** An advisor-driven turn can
  produce several substantive reports separated by review notes; previously
  only the literal last message survived condensing, which could leave a
  trailing bookkeeping remark as "the" answer while the real reports folded
  into the "Worked" line. Substantive answers (multi-paragraph or long) now
  stay visible — matching OMP's own never-hide-assistant-text semantics —
  while one-line narration still condenses.
- Fixed a React hook-order violation in the tool card that could crash the
  transcript when a non-native tool's render path changed mid-lifecycle.

## 0.5.3

- **"Turn finished" waits for the advisors.** The end-of-turn marker stays a
  pulsing "Advisors reviewing…" line until the last reviewer settles, then
  becomes "✓ Turn finished in X" — no more "finished" next to "still
  reviewing". The sidebar, command palette, and inbox agree: a session under
  review shows working dots and "Advisors reviewing", and only files as
  Finished when review is done.
- **Watch the agent work, Fable-style.** Nothing condenses mid-turn anymore:
  the live timeline streams expanded — narration between compact activity
  rows ("Ran 6 commands, read 2 files, edited store.ts +12 -1", expandable
  to the full cards), thinking previews that show each thought's first line
  instead of identical "Thought process" rows, and collapsible advisor notes
  (blockers open by default). When the turn actually finishes, it all folds
  into one Codex-style "Worked for X" line — real wall time, expandable —
  followed by the answer and a clickable edited-files row with diffstats.
- **The real final answer stays visible.** Advisor-triggered follow-up work
  no longer swallows the answer that preceded it: turn boundaries are now
  structural, so each finished run keeps its own answer out in the open
  instead of folding a 55-minute report into the thinking dump of the next
  segment.

## 0.5.2

- **Every tool renders properly.** OMP's own `<omp-tool-view>` component now
  draws the ~35 tools that used to show as plain text — todo, task, hub,
  lsp, eval, browser, github, memory, fetch, web_search, and a real card
  for MCP/unknown tools. Bundled with the app and auto-synced to the OMP
  release; bash/edit/write/read/search keep their native cards.
- **Permission mode at launch.** The Manual / Auto edits / Full access
  switch is on the new-session composer too — sessions are born with the
  chosen mode enforced from the first tool call.
- **Ship is branch-safe** — a clean-but-ahead default branch no longer gets
  pushed to directly; shippable work always moves to a new branch first.
- **Updater edge cases** — "no update available" is authoritative (never
  reinstalls a stale pending release), the restart prompt counts running
  sessions at prompt time, and signature-verification failures surface even
  during silent background checks.
- Phantom duplicate tool cards from replay races are gone; the About/
  diagnostics OMP version is real instead of "unknown"; provider credential
  origins are readable; the watchdog config editor reads the actual
  WATCHDOG.yml.

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
