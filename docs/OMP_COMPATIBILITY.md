# OMP Compatibility

The Orchestrator is an **unofficial** desktop harness for [OhMyPi (OMP)](https://github.com/can1357/oh-my-pi).
It embeds OMP rather than reimplementing it, so it is tightly coupled to a specific upstream version.

## Tested version

| | |
|---|---|
| **OMP version** | `19.0.1` |
| **Upstream repo** | `can1357/oh-my-pi` |
| **Tag** | `v19.0.1` |
| **npm packages** | `@oh-my-pi/pi-coding-agent@19.0.1` and its workspace siblings |
| **Native addon** | `@oh-my-pi/pi-natives-darwin-arm64@19.0.1` (and `-darwin-x64` for Intel) |
| **Required runtime** | Bun `>= 1.4.4` (OMP declares `engines.bun`; the repo and CI pin `1.4.5`) |
| **Upstream licence** | MIT (Mario Zechner; Can Bölük) |

This project is caught up to upstream's latest release as of 2026-11-19. The pin stays
deliberate: a future upstream release does not move this project automatically (see
[Updating the bundled OMP](#updating-the-bundled-omp)).

**OMP 19 raised the runtime floor to Bun 1.4.4.** OMP's CLI entry — which the engine re-enters for
every helper process (see [Re-entry into the engine binary](#re-entry-into-the-engine-binary)) —
exits at start on an older Bun, so the engine must be compiled with a Bun that meets it. The repo
(`packageManager`) and both CI workflows pin `1.4.5`.

**The Claude Code client-version gate no longer needs an app update.** Anthropic gates its newest
models on the Claude Code version a client advertises, and returns HTTP 400
`claude_code_version_too_old` naming the minimum. Up to 18.1.x OMP advertised a hard-coded
version, so each time the floor rose the app listed and priced a model it could not run until a
new OMP shipped (`17.3.8` → `2.1.220`, `18.1.1` → `2.1.246`, both below a `2.1.251` floor). OMP
18.4 advertises `2.1.280` by default and, on that rejection, adopts the version Anthropic names
for the rest of the process and retries once
(`pi-ai/src/providers/claude-code-fingerprint.ts`, `adoptRequiredClaudeCodeVersion`). A real
one-prompt turn on `anthropic/claude-opus-5-5` through the engine completed normally on
2026-09-28 (measured on 18.4.2). The engine still classifies the rejection as
`model-unavailable` naming the embedded OMP (`packages/engine/src/worker/classify-error.ts`), which
now only fires if the adopted-version retry is refused too.

## Integration surface used

The Orchestrator consumes OMP through its **published npm SDK**, not by shelling out to the `omp` CLI
and not by vendoring upstream source.

### Package root — `@oh-my-pi/pi-coding-agent`

| Symbol | Used for |
|---|---|
| `createAgentSession(options)` | Builds the one `AgentSession` a worker owns. `autoTitle: true` has OMP name an unnamed session from the user's first real message; it replaced `AgentSession.maybeStartTitleGeneration`, which no longer exists |
| `AgentSession` | `prompt`, `abort`, `compact`, `dispose`, `subscribe`, `setModel`, `setThinkingLevel` (including `"auto"`), `setSessionName`, `applyAdvisorConfigs`, `setAdvisorEnabled`, `getAdvisorStats`, `getContextUsage`, `getSessionStats`, `getAvailableThinkingLevels`, `setClientBridge`, `setToolUIContext`, `setFastMode` / `isFastModeEnabled` / `isFastModeActive`, `setSlowMode` / `isSlowModeEnabled` (OpenAI/Google only, see below), `getAnthropicSlowModeLane`, `getAnthropicSlowModeLabel` |
| `SessionManager` | `create`, `open`, `list`, `listAll`, `getDefaultSessionDir`, `forkFrom`, `getBranch` |
| `Settings.init` | Per-worker settings resolution |
| `AuthStorage` / `discoverAuthStorage` | Credential reuse, sign-in, quota. Since 18.3 the store is namespaced — `keys.source` / `keys.keyless` (is a provider connected, and how), `credentials.reload` / `set` / `remove` / `listDisabled`, `oauth.login`, `usage.reports`. All access goes through `packages/omp-adapter/src/auth-compat.ts`, which also accepts the pre-18.3 flat API and throws when it recognises neither |
| `ModelRegistry` | Model catalogue, `find`, `getAll`, `reapplyModelPolicies`, `registerProvider` (tests only). `getAll()` includes non-chat runners (`kind`: embedding, rerank, image, tts, stt, video, judge, search, tiny) since 18.2; the adapter keeps only chat models |
| `AgentRegistry` | Private registry per session (defence in depth) |

### Subpath — `@oh-my-pi/pi-coding-agent/advisor/index`

Advisor discovery is **not** exported from the package root. It is reached through the package's
declared `"./*": { "import": "./src/*.ts" }` export map:

| Symbol | Used for |
|---|---|
| `discoverAdvisorConfigs(cwd, agentDir?)` | Reading the project's WATCHDOG roster exactly as the CLI would |
| `loadWatchdogConfigFile` | Reading raw config for "Save as project default" |

### Other subpaths

| Import | Used for |
|---|---|
| `@oh-my-pi/pi-coding-agent/config/registry` → `lookup(id)` | Per-session, runtime-only setting overrides (`handle.override(settings, value)`): `tools.approvalMode`, `title.icons`, `extendedContext`, `providers.anthropic.slowMode`. 18.4 removed `Settings.override(path, value)`; `packages/engine/src/worker/settings-override.ts` wraps both and reads every security-relevant override back |
| `@oh-my-pi/pi-catalog/compat/context-window` → `resolveMaxContextWindow` | The larger window a model reaches with extended context on (shown in the picker) |
| `@oh-my-pi/pi-ai` → `serviceTierFamily` | Whether a model has a slow mode (mirrors upstream's private `#slowModeTarget`) |

### Model modes

- **Fast mode** — `setFastMode` selects the family's priority tier; recorded in the session file.
- **Slow mode** — on OpenAI/Google, `setSlowMode` selects the `flex` tier (session file only). On
  direct Anthropic, upstream's `setSlowMode` persists `providers.anthropic.slowMode` to the user's
  global `config.yml`, so the worker instead overrides that setting at runtime and calls the lane's
  `accept()` / `stop("user")` exactly as upstream does. Verified: the config file is byte-for-byte
  unchanged across on/off.
- **Extended context** — the `extendedContext` setting is registry-wide and defaults to off for SDK
  hosts. The worker overrides it per session; the session's own listener rebinds the live model
  asynchronously, so the worker waits for the window to move before answering. The catalogue's
  maximum is a floor: `openai-codex/gpt-5.6-luna` lists 872K and resolved 1.0M live.
- **Auto effort** — `setThinkingLevel("auto")`; OMP picks an effort per turn and reports it in
  `thinking_level_changed` (`configured: "auto"`, `resolved: <effort>`).

## Verified upstream behaviour

These were confirmed against the real package, not inferred from docs.

### Event stream

`session.subscribe()` emits:

```
agent_start          { type }
turn_start           { type }
message_start        { type, message }
message_update       { type, assistantMessageEvent: { type, contentIndex, delta, partial }, message }
message_end          { type, message }
tool_execution_start { type, toolCallId, toolName, args }
tool_execution_update{ type, toolCallId, toolName, args, partialResult: { content[], details } }
tool_execution_end   { type, toolCallId, toolName, result: { content[], details }, isError }
turn_end             { type, message, toolResults[] }
agent_pause          { type, messages[], yielded, awaiting }
agent_end            { type, messages[] }
```

Since 18.21 a *run* opens at the first `agent_start` and closes at exactly one `agent_end`, emitted
once nothing can resume it. A model loop that stops while a background job, a child agent or queued
input can still resume the run emits `agent_pause` instead. (Before 18.21 every loop ended with its
own `agent_end` carrying `isTerminal`.) The worker treats both as "a loop stopped" for flushing and
usage, and still decides the request's fate itself with `waitForIdle()` plus its own settle check.

Mapping into product events lives in `packages/omp-adapter/src/event-mapper.ts`.

### Usage shapes

`turn_end.message.usage`:

```jsonc
{
  "input": 1000, "output": 100, "cacheRead": 0, "cacheWrite": 0, "totalTokens": 1100,
  "cost": { "input": 0.001, "output": 0.0002, "cacheRead": 0, "cacheWrite": 0, "total": 0.0012 }
}
```

The message also carries `provider`, `model`, `responseId`, and `timestamp`. `responseId` is the
de-duplication key (see [USAGE_MODEL.md](./USAGE_MODEL.md)).

`session.getContextUsage()`:

```jsonc
{
  "contextWindow": 128000, "anchored": true, "usedTokens": 1500,
  "systemPromptTokens": 4797, "systemToolsTokens": 8141,
  "systemContextTokens": 162, "skillsTokens": 1548, "messagesTokens": 0
}
```

`session.getAdvisorStats()` returns `AdvisorStats` with a `advisors: PerAdvisorStat[]` array;
each entry has `name`, `status`, `model`, `contextWindow`, `contextTokens`,
`tokens { input, output, reasoning, cacheRead, cacheWrite, total }`, `cost`, and `messages`.

### Enumerations

Taken verbatim from upstream — this project never invents values:

| Enum | Values | Source |
|---|---|---|
| `AdvisorSeverity` | `nit`, `concern`, `blocker` | `advisor/advise-tool.ts` |
| `AdvisorRuntimeStatus` | `running`, `paused`, `quota_exhausted`, `error`, `no_model` | `advisor/config.ts` |
| `MessageAttribution` | `user`, `agent` | `ai/types.ts` |
| Approval modes | `always-ask`, `write`, `yolo` | CLI + `approval-mode.md` |
| Thinking levels | **per model**, from `model.thinking.efforts` | model registry |

Thinking/effort levels are a property of the selected model. The new-session sheet renders exactly
what the chosen model reports and nothing when it reports none.

### Advisor configuration

`WATCHDOG.yml` / `WATCHDOG.yaml`, discovered by upstream's own walker with project-over-user
precedence. Per advisor: `name`, `model` (a selector that may carry a `:level` thinking suffix,
e.g. `anthropic/claude-fable-5:high`), `tools`, `instructions`, `enabled`.

### Advisor activation is two steps, not one

`applyAdvisorConfigs(advisors, sharedInstructions)` only **stores** the roster on the session; it
does not start anything. The advisor runtime is only built once `setAdvisorEnabled(true)` flips the
session's advisor toggle. The worker therefore calls `applyAdvisorConfigs` first and then calls
`setAdvisorEnabled(true)` if and only if the roster contains at least one enabled advisor. After
enabling, the worker checks `isAdvisorActive()`; if it is still `false` (for example, the
configured model is unavailable), the worker emits `advisor.failed` with a `model-unavailable`
reason instead of silently proceeding as if advisors were running.

### The advise tool drops non-blocker notes from in-progress reviews

`advise-tool.ts` gates updates raised while a review is still in progress
(`#inProgressUpdate`): a `nit` or `concern` raised mid-review returns `"Recorded."` to the advisor
but is **not delivered** to the primary session. `blocker` severity always delivers, in progress or
not. A post-turn note against an otherwise-idle primary is routed by severity
(`resolveAdvisorDeliveryChannel`): a `nit` rides the non-interrupting aside queue, which is
never flushed while idle; a `concern` is delivered as a **preserved card** — appended to context
and shown, with no turn started; only a `blocker` steers a triggered continuation turn. The
preserved delivery does emit its own `message_start` / `message_end`, which is why advisor message
counting has to key off those events rather than assume one review produces exactly one delivered
note. Because a preserved concern would otherwise wait for the user's next prompt, the worker
starts one continuation turn for it itself — see SESSION_MODEL.md §3.

Advisor reviews themselves run **asynchronously after `turn_end`**, not synchronously with the
primary turn. There is no push event for "the advisor finished reviewing" — the worker polls
`getAdvisorStats()` / advisor state on a 5-second tick and only emits `advisor.state` when it
actually changes.

### Approval and extension UI wiring

- OMP has two gates, and both read `tools.approvalMode` (default `yolo`), which the worker
  overrides per session.
  - **Client bridge.** `ClientBridge.requestPermission` is installed via
    `session.setClientBridge()` immediately after `createAgentSession` returns — the same point
    upstream's own ACP (agent-client-protocol) mode installs its bridge. OMP consults it for `bash`
    and for destructive file operations (`delete`, `move`, an `edit` that deletes or moves).
    `PERMISSION_OPTIONS` is a fixed four-option menu (allow once / always allow / reject / always
    reject); `allow_always` and `reject_always` are cached per `cacheKey`, scoped to the session.
    Since 19.0 OMP resolves `bash` **before** it asks the bridge — the approval mode, the user's
    `bash.patterns` rules and critical-command detection — and only reaches the bridge when that
    resolution says "ask". The bridge receives a second `steeringSignal`; a user steer that
    supersedes the dialog aborts it, and the worker closes the card.
  - **Tier gate.** Everything else (`write`, plain edits, eval, browser, computer, MCP, and any call
    into a `tools.restrictedFolders` folder) is gated by tool tier inside `ExtensionToolWrapper`,
    which asks `ExtensionRunner.hasUI()` and then prompts through the extension UI. It skips the
    prompt when the bridge already approved the exact arguments, so a bridged call is asked once.
- **The worker must not override `tools.approval`.** Up to 0.8.0 it set
  `{ bash, delete, move: "allow" }` there so the tier gate would not ask a second time. On OMP 19
  that user-policy `allow` is what the bash pre-resolution reads, so every shell command ran
  unprompted in "always ask". The override is gone; the user's own per-tool policies now apply
  untouched. `approval-tier.test.ts` and `interaction.test.ts` assert a shell command asks, exactly
  once, in "always ask" and in "write", and again after leaving full access.
- `setToolUIContext(uiContext, hasUI)` wires tool-level UI (the ask tool) to the host. It does
  **not** reach the extension runner: `ExtensionRunner.hasUI()` is only true after
  `extensionRunner.initialize(actions, contextActions, commandActions?, uiContext, mode)`. The
  worker initializes the runner the way OMP's print/RPC modes do (`modes/runtime-init.ts`), minus
  the command-context actions (new session, branch, switch, reload), because a worker owns exactly
  one session file.
- The tier gate prompts through `uiContext.approve({ full, compact, session?, grants? }, { signal })`
  when the host defines it, answering `"once"`, `"session"`, `"deny"` or a remembered
  grant. Without `approve` it falls back to a `select` whose option list grew from
  `["Approve", "Deny"]` to include `Approve <tool> for this session` — which the worker's old
  two-option matcher no longer recognised, so 19.0 would have shown a generic picker. The worker
  implements `approve` and renders the same `approval.request` card the bridge uses, with a
  "for this session" option when OMP offers one. Every dialog method also honours the `signal`
  OMP now passes, so an aborted or superseded prompt closes its card.
- The `ask` tool takes one HTML form since 18.18 (`{ html }`, answers in
  `details.answers[]`). Hosts with `uiContext.formDialog` render the form; the worker does not
  define it, so OMP walks the fields one at a time through `select` / `input` / `editor`. A
  multi-select field is a `select` re-shown after each toggle (`selectionMarker: "checkbox"`,
  `checkedIndices`); the worker marks the checked rows.
- `CreateAgentSessionResult.eventBus` carries the `task:subagent:lifecycle` / `task:subagent:progress`
  / `task:subagent:event` channels the worker subscribes to for subagent cards.
- Assistant messages may carry `upstreamModel`: the model a router or gateway actually served.
  When it differs from the requested model the transcript says so once per change.
- `model_usage` session entries record spend with no message of its own — prompt-cache warming
  replays (`providers.cacheWarming`, default `idle` since 18.3.5), auto-effort classification and
  other judge calls. The usage reader counts them, keyed on entry id + timestamp so a fork's copy
  dedups globally.
- `SessionManager.forkFrom(sourcePath, cwd, sessionDir)` writes the fork to disk atomically before
  returning — the caller never observes a partially-written fork file. `getBranch()` is what feeds
  resume's transcript replay.

### Re-entry into the engine binary

OMP re-launches `process.execPath` for work it wants in another process, and in the packaged app
that executable is the engine. Two shapes exist:

- hidden `__omp_worker_*` selectors (`resolveWorkerSpawnCmd`): the per-user daemon that replaced
  the per-project brokers in 19.0 (`__omp_worker_daemon` — LSP, blobs, tiny/speech models), shell
  services and PTY commands (`__omp_worker_shell_process`), the JS eval kernel, and the worker
  threads those processes start;
- plain CLI commands (`resolveCliEntryCmd`): `browser-relay`, and since 19.0 `worktree add` — with
  `worktree.clone` on (the default) the bash tool rewrites an agent's `git worktree add` into
  `<execPath> worktree add …`.

`packages/engine/src/main.ts` therefore routes **every invocation that carries arguments** other
than its own `--orchestrator-worker` to OMP's CLI, and leaves stdout alone in that role. Matching a
list of known selectors, as it did before, turns each new upstream re-entry into a second
supervisor booting in its place. `entry-dispatch.test.ts` and the packaged smoke test both run the
entry with a plain flag and expect OMP's answer.

The daemon is shared per user with any `omp` CLI on the machine: the newer build wins, an older
daemon re-execs into it, and the daemon exits a few seconds after its last client disconnects.
Subagent worker threads (`task.workerThreads`) need a CLI worker host and so stay off in an SDK
embedding: subagents run in-process, as before.

## Known compatibility limitations

1. **Process-per-session is mandatory.** Several process-global hazards make many concurrent
   top-level sessions in one process unsafe. See [ARCHITECTURE.md](./ARCHITECTURE.md#why-process-per-session).
2. **Cross-process session ownership is OMP's, and it forks rather than blocks.** Since 18.5 an
   open session holds a per-session lease; a process that cannot keep writing the original file
   (another omp process holds it, or the file changed underneath) continues the conversation in a
   new file. The supervisor still enforces single-writer for this app's own workers and refuses to
   open a session twice; the worker re-announces `session.persisted` whenever the path changes so a
   later resume opens the copy that was actually written.
3. **`Settings.init()` is a memoized process singleton** that ignores the 2nd+ caller's
   `cwd`/`agentDir`. Safe only because each worker has exactly one session.
4. **Advisor token counts are live-context, not cumulative.** `PerAdvisorStat.cost` *is* cumulative;
   `PerAdvisorStat.tokens` resets when the advisor compacts.
5. **Provider quota covers only providers with a usage endpoint.** Everything else renders
   "Usage limit not reported by provider" — never a fabricated percentage.
6. **`bun build --compile` needs `--external omp-legacy-pi-modules`.** Without it, bundling fails on
   an unresolvable dynamic import. `fastembed` and `onnxruntime-node` are also externalised.
7. **The native addon must sit beside the engine binary.** In a compiled binary the loader's final
   search path is the executable's directory; nothing is downloaded at runtime.
8. **`applyAdvisorConfigs` does not activate advisors by itself.** It only stores the roster;
   `setAdvisorEnabled(true)` is a required second call, and its effect must be checked with
   `isAdvisorActive()` rather than assumed. See
   [Advisor activation is two steps, not one](#advisor-activation-is-two-steps-not-one) above.
9. **The advise tool silently drops non-blocker in-progress notes.** Only `blocker` severity is
   guaranteed delivery mid-review; `nit`/`concern` raised while a review is in progress are
   acknowledged to the advisor but never reach the primary session. Do not rely on every advisor
   note appearing in the transcript.
10. **Advisor completion has no push signal.** Reviews run asynchronously after `turn_end`; advisor
    state and usage must be polled (this project polls every 5 seconds) rather than awaited.
11. **Generated titles are plain.** OMP 19 heads generated session titles with a "card" (a Nerd
    Font glyph or emoji plus a short code) for its terminal status line. The worker overrides
    `title.icons` to `boring` at runtime, so the sidebar and the session file get a plain title.
12. **Tool-call intent tracing is off.** OMP 19 disables it by default for SDK sessions
    (`tools.intentTracing`); subagent cards therefore show the current tool rather than an intent
    line. Left at upstream's default — it costs tokens on every tool call.
13. **Advisor cadence settings are not forwarded.** `WATCHDOG.yml` entries may now carry
    `reviewMode`, `reviewInterval`, `syncBacklog`, `maxNotesPerUpdate`, `scope` and
    `includeReasoning`. This app runs its own review rounds (SESSION_MODEL.md §3), so only
    `includeReasoning` is passed through; entries with `scope: subagent` are left out of the
    top-level roster.
14. **The `<omp-tool-view>` bundle is built here, not installed.** OMP 18.14 stopped publishing it
    in the npm package. `scripts/build-tool-views.ts` builds it from an upstream checkout at the
    pinned tag and the result is committed; `omp-pin.test.ts` fails when its stamp disagrees with
    the pin.
15. **Most calls into OMP are untyped.** Handles pass through `any` with optional chaining, so an
    upstream reshape type-checks and then no-ops. 18.3/18.4 did exactly this to `AuthStorage` and
    `Settings.override`. The tripwires are the tests that run against the real installed package:
    `auth-compat.test.ts`, `settings-override.test.ts`, `model-catalog.test.ts`,
    `approval-tier.test.ts`, `interaction.test.ts`, `entry-dispatch.test.ts`. On 19.0 two more
    reshapes type-checked cleanly and were caught only by those tests and by reading upstream:
    the approval change above, and `maybeStartTitleGeneration` disappearing (auto-titling would
    have silently stopped).

## Updating the bundled OMP

Version bumps are deliberate, never floating.

1. Bump the pin in `packages/engine/package.json` and `packages/omp-adapter/package.json`, and
   `OMP_VERSION` in `scripts/build-engine.ts` (`packages/engine/test/omp-pin.test.ts` fails if they
   disagree).
2. `bun install`
3. Re-vendor **both** native addons in the same commit — the loader requires the addon to export a
   version-matched symbol, so a mismatch fails at runtime, not build time.
4. Rebuild the tool-view bundle from an upstream checkout at the new tag
   (`bun scripts/build-tool-views.ts <checkout>`, limitation 14) and commit it.
5. Check `engines.bun` in the new `@oh-my-pi/pi-coding-agent`; when it rises, move
   `packageManager` and `BUN_VERSION` in both workflows with it.
6. `bun run typecheck && bun test` — the concurrency and usage suites, plus the real-package tests
   listed under limitation 15, are the tripwires. Typecheck alone proves little.
7. `bun run build:engine` and run the packaged smoke test (`scripts/smoke-packaged.ts`).
8. Re-verify the shapes in [Verified upstream behaviour](#verified-upstream-behaviour); the adapter
   reads several fields defensively but the usage keys are load-bearing. Grep upstream for
   `resolveCliEntryCmd(` and `resolveWorkerSpawnCmd(` — every new caller is a new way the engine
   binary gets re-entered.
9. Update this document's version table and note any behaviour change.
