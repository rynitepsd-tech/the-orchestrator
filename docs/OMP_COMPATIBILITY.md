# OMP Compatibility

The Orchestrator is an **unofficial** desktop harness for [OhMyPi (OMP)](https://github.com/can1357/oh-my-pi).
It embeds OMP rather than reimplementing it, so it is tightly coupled to a specific upstream version.

## Tested version

| | |
|---|---|
| **OMP version** | `18.1.1` |
| **Upstream repo** | `can1357/oh-my-pi` |
| **Tag** | `v18.1.1` |
| **npm packages** | `@oh-my-pi/pi-coding-agent@18.1.1` and its workspace siblings |
| **Native addon** | `@oh-my-pi/pi-natives-darwin-arm64@18.1.1` (and `-darwin-x64` for Intel) |
| **Required runtime** | Bun `>= 1.3.14` (OMP declares `engines.bun`) |
| **Upstream licence** | MIT (Mario Zechner; Can Bölük) |

This project is caught up to upstream's latest release. The pin stays deliberate: a future
upstream release does not move this project automatically (see
[Updating the bundled OMP](#updating-the-bundled-omp)).

**A client-version gate survives this bump.** OMP lists models from each provider's live endpoint
whether or not the pinned client can run them. `anthropic/claude-fable-5-1` is listed and priced,
and still fails at inference: `17.3.8` advertised Claude Code `2.1.220` and `18.1.1` advertises
`2.1.246`, while Anthropic requires `2.1.251 or newer` — so the HTTP 400
`claude_code_version_too_old` persists, measured on this pin, not inferred. Clearing it needs an
upstream release that advertises a high enough client version; nothing in this repo can or should
forge one. The engine reports the rejection as `model-unavailable` naming the embedded OMP
(`packages/engine/src/worker/classify-error.ts`) rather than relaying the provider's advice to
update an unrelated product.

`18.1.0` did fix sampling parameter errors with newer Anthropic models, which is a separate issue
from the version gate.

## Integration surface used

The Orchestrator consumes OMP through its **published npm SDK**, not by shelling out to the `omp` CLI
and not by vendoring upstream source.

### Package root — `@oh-my-pi/pi-coding-agent`

| Symbol | Used for |
|---|---|
| `createAgentSession(options)` | Builds the one `AgentSession` a worker owns |
| `AgentSession` | `prompt`, `abort`, `compact`, `dispose`, `subscribe`, `setModel`, `setThinkingLevel`, `setSessionName`, `applyAdvisorConfigs`, `setAdvisorEnabled`, `getAdvisorStats`, `getContextUsage`, `getSessionStats`, `getAvailableThinkingLevels`, `setClientBridge`, `setToolUIContext` |
| `SessionManager` | `create`, `open`, `list`, `listAll`, `getDefaultSessionDir`, `forkFrom`, `getBranch` |
| `Settings.init` | Per-worker settings resolution |
| `AuthStorage` / `discoverAuthStorage` | Credential reuse and `fetchUsageReports` |
| `ModelRegistry` | Model catalogue, `find`, `getAll`, `registerProvider` (tests only) |
| `AgentRegistry` | Private registry per session (defence in depth) |

### Subpath — `@oh-my-pi/pi-coding-agent/advisor/index`

Advisor discovery is **not** exported from the package root. It is reached through the package's
declared `"./*": { "import": "./src/*.ts" }` export map:

| Symbol | Used for |
|---|---|
| `discoverAdvisorConfigs(cwd, agentDir?)` | Reading the project's WATCHDOG roster exactly as the CLI would |
| `loadWatchdogConfigFile` | Reading raw config for "Save as project default" |

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
agent_end            { type, messages[], isTerminal }
```

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
not. A `concern` (or lower) raised as an **end-of-turn** note against an otherwise-idle primary is
delivered as a preserved card, and — unlike the dropped in-progress case — that delivery does emit
its own `message_start` / `message_end`, which is why advisor message counting has to key off those
events rather than assume one review produces exactly one delivered note.

Advisor reviews themselves run **asynchronously after `turn_end`**, not synchronously with the
primary turn. There is no push event for "the advisor finished reviewing" — the worker polls
`getAdvisorStats()` / advisor state on a 5-second tick and only emits `advisor.state` when it
actually changes.

### Approval and extension UI wiring

- `ClientBridge.requestPermission` is installed via `session.setClientBridge()` immediately after
  `createAgentSession` returns — the same point upstream's own ACP (agent-client-protocol) mode
  installs its bridge. `PERMISSION_OPTIONS` is a fixed four-option menu (allow once / always allow
  / reject / always reject); `allow_always` and `reject_always` are cached per `cacheKey`, scoped to
  the session, not global.
- `setToolUIContext(uiContext, hasUI)` — called with the `ExtensionUIContext` built from
  `CreateAgentSessionResult` — is what wires extension and ask-tool UI requests to the host instead
  of a terminal.
- `CreateAgentSessionResult.eventBus` carries the `task:subagent:lifecycle` / `task:subagent:progress`
  / `task:subagent:event` channels the worker subscribes to for subagent cards.
- `SessionManager.forkFrom(sourcePath, cwd, sessionDir)` writes the fork to disk atomically before
  returning — the caller never observes a partially-written fork file. `getBranch()` is what feeds
  resume's transcript replay.

## Known compatibility limitations

1. **Process-per-session is mandatory.** Several process-global hazards make many concurrent
   top-level sessions in one process unsafe. See [ARCHITECTURE.md](./ARCHITECTURE.md#why-process-per-session).
2. **No cross-process session lock.** OMP session `.jsonl` files have no file lock; two writers lose
   data silently. The supervisor enforces single-writer itself and refuses to open a session twice.
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

## Updating the bundled OMP

Version bumps are deliberate, never floating.

1. Bump the pin in `package.json`, `packages/*/package.json`, and `OMP_VERSION` in
   `scripts/build-engine.ts`.
2. `bun install`
3. Re-vendor **both** native addons in the same commit — the loader requires the addon to export a
   version-matched symbol, so a mismatch fails at runtime, not build time.
4. `bun run typecheck && bun test` — the concurrency and usage suites are the tripwires.
5. `bun run build:engine` and run the packaged smoke test (`scripts/smoke-packaged.ts`).
6. Re-verify the shapes in [Verified upstream behaviour](#verified-upstream-behaviour); the adapter
   reads several fields defensively but the usage keys are load-bearing.
7. Update this document's version table and note any behaviour change.
