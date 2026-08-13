# OMP Compatibility

The Orchestrator is an **unofficial** desktop harness for [OhMyPi (OMP)](https://github.com/can1357/oh-my-pi).
It embeds OMP rather than reimplementing it, so it is tightly coupled to a specific upstream version.

## Tested version

| | |
|---|---|
| **OMP version** | `17.3.1` |
| **Upstream repo** | `can1357/oh-my-pi` |
| **Tag** | `v17.3.1` |
| **npm packages** | `@oh-my-pi/pi-coding-agent@17.3.1` and its workspace siblings |
| **Native addon** | `@oh-my-pi/pi-natives-darwin-arm64@17.3.1` (and `-darwin-x64` for Intel) |
| **Required runtime** | Bun `>= 1.3.14` (OMP declares `engines.bun`) |
| **Upstream licence** | MIT (Mario Zechner; Can Bölük) |

Upstream `HEAD` at the time of writing was ahead of `v17.3.1`; this project pins the tag deliberately
(see [Version pinning](#version-pinning)).

## Integration surface used

The Orchestrator consumes OMP through its **published npm SDK**, not by shelling out to the `omp` CLI
and not by vendoring upstream source.

### Package root — `@oh-my-pi/pi-coding-agent`

| Symbol | Used for |
|---|---|
| `createAgentSession(options)` | Builds the one `AgentSession` a worker owns |
| `AgentSession` | `prompt`, `abort`, `compact`, `dispose`, `subscribe`, `setModel`, `setThinkingLevel`, `setSessionName`, `applyAdvisorConfigs`, `setAdvisorEnabled`, `getAdvisorStats`, `getContextUsage`, `getSessionStats`, `getAvailableThinkingLevels` |
| `SessionManager` | `create`, `open`, `list`, `listAll`, `getDefaultSessionDir` |
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
8. **Not implemented in this build:** session fork, GUI provider sign-in, MCP status surfacing,
   slash-command completion, extension UI bridge. Each is a protocol request that currently returns
   an explicit error or empty result rather than a silent no-op.

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
