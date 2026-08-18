# Security

This document describes what The Orchestrator does and does not protect, where
credentials live, what is redacted, and how to report a vulnerability. It
assumes familiarity with [ARCHITECTURE.md](./ARCHITECTURE.md) — in particular
that the app is a Tauri 2 shell around a supervisor process that spawns one OMP
worker process per session.

The Orchestrator is an unofficial harness. It is version 0.2.0, macOS only
(Apple Silicon builds; the x64 target exists in the build script but has not
been built or tested), and ad-hoc signed.

## Threat model, stated plainly

**This application hosts a coding agent that has real shell and filesystem
access to whatever project directory you point it at.** When you start a
session, OMP can read files, write files, and execute shell commands in that
directory and anywhere else the process can reach with your user's privileges.
It runs as you. It is not a sandbox, and it is not a preview.

The consequences follow directly:

- A prompt-injected instruction inside a file, a dependency, a web page fetched
  by the agent, or an MCP tool result can cause the agent to attempt commands
  you did not ask for.
- A model mistake — not malice — is enough to delete or rewrite work.
- Anything readable by your user account is readable by an agent session,
  including files outside the project directory.

What this project *can* meaningfully defend is narrower: it keeps credentials
out of the frontend and out of the logs, it keeps the webview powerless, and it
preserves upstream OMP's approval semantics rather than weakening them. It does
not and cannot make an unsandboxed shell safe. Use it on projects under version
control, with a clean working tree you can diff against.

## Credential ownership

OMP owns credentials. This project adds no credential store of its own.

- Provider credentials live in OMP's own storage under its agent directory
  (`~/.omp/agent` unless overridden). The engine opens that store through the
  SDK (`discoverAuthStorage`) and passes the resulting `authStorage` handle
  into `createAgentSession`. Writes go exclusively through OMP's own APIs
  (`login`, `logout`, `set`) — the app never touches the store's files or
  schema itself.
- The app never copies, re-encrypts, mirrors, or exports API keys. There is no
  keychain entry, no config file, and no database owned by The Orchestrator that
  contains a secret.
- Settings → Providers runs OMP's own login flows (`AuthStorage.login`). For
  OAuth subscription sign-ins the engine emits `engine.auth` lifecycle events
  carrying the browser URL, the host opens it in the system browser, and OMP's
  loopback callback writes the credential straight into its own store — the
  secret never transits the app. When a flow asks a question (an API key, a
  paste-code fallback), the question is bridged to the UI and the typed answer
  is relayed through one request back into OMP's flow, which validates and
  stores it. Answers ride requests, which are never logged; every logged or
  event-emitted string still passes the redaction layer, and the app persists
  no secret of its own.
- Disconnecting a provider calls OMP's own credential removal
  (`AuthStorage.logout`). The store is shared with the CLI, so the GUI warns
  that signing out here signs out `omp` too; env-var-supplied credentials are
  not stored and are reported as still configured rather than removed.
- The frontend receives only sanitised provider metadata — provider name,
  whether it is authenticated, and a credential *origin* label such as which
  mechanism supplied it. Never the value.

Uninstalling The Orchestrator does not touch `~/.omp`, and the app never moves
or rewrites OMP's data.

## Redaction

Redaction lives in `packages/protocol/src/redact.ts` and is applied in two
independent places, so a bug in one does not expose secrets through the other:

1. **At the protocol boundary.** Every outbound frame is passed through
   `redactValue` before it is written to stdout (`packages/engine/src/server.ts`,
   `packages/engine/src/worker/main.ts`). Tool arguments are deep-redacted and
   tool output is passed through `sanitizeOutput`, which redacts and then
   truncates (256 KB for a completed result, 32 KB per streaming delta) —
   see `packages/omp-adapter/src/event-mapper.ts`.
2. **In the logger.** `packages/engine/src/logging.ts` redacts every structured
   log record before it reaches stderr or the log file, including records
   produced by `console.*` calls from transitive dependencies, which are
   rebound to the logger by `protectStdout()`.

What is matched:

| Class | Examples |
| --- | --- |
| Sensitive key names (value replaced wholesale) | `api_key`, `apikey`, `secret`, `password`, `token`, `access_token`, `refresh_token`, `id_token`, `bearer`, `authorization`, `auth`, `cookie`, `session_key`, `private_key`, `client_secret`, `credential(s)`, and `*_`-prefixed variants |
| Authorization headers | `Bearer …`, `Basic …`, `Token …` |
| Vendor key shapes | `sk-…`, `sk-ant-…`, `ghp_…`, `gho_…`, `github_pat_…`, `xoxb/xoxp/xoxa/xoxr/xoxs-…`, `AKIA…`, `AIza…` |
| JWTs | three base64url segments beginning `eyJ` |
| PEM private keys | `-----BEGIN … PRIVATE KEY-----` through `-----END … PRIVATE KEY-----` |
| Free-text assignments | `api_key=…`, `token: …`, `secret=…`, `password: …`, `authorization=…`, quoted or bare |

Environment maps are handled separately: variable *names* are kept visible for
debugging, and values are redacted when the name matches the sensitive-key
pattern or contains `KEY`, `TOKEN`, `SECRET`, or `PASSWORD`.

Redaction is pattern-based and therefore best-effort. A credential with no
recognisable shape, under an innocuous key, in free-form tool output, can
survive it. Treat log files as sensitive regardless.

## The Tauri boundary

The webview is treated as untrusted rendering surface, not as a privileged
client.

- **CSP** (`apps/desktop/src-tauri/tauri.conf.json`):
  `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline';
  img-src 'self' data: asset: http://asset.localhost; font-src 'self';
  connect-src 'self' ipc: http://ipc.localhost`.
  No remote script origin, no remote style origin, and no outbound `connect-src`
  beyond the local IPC channel — the frontend cannot call a network endpoint of
  its own.
- **`assetProtocol` is disabled** (`"enable": false`), so there is no
  filesystem-backed asset URL scheme for the webview to walk.
- **Capabilities are an explicit allowlist**
  (`apps/desktop/src-tauri/capabilities/default.json`), scoped to the `main`
  window: core window controls, dialogs, notifications, the opener plugin
  (http/https URLs and reveal-in-Finder only), the updater, and restart. There
  is no `fs` plugin, no `shell` plugin, and no `http` plugin in the allowlist.

Be honest about what this boundary is: the webview cannot touch the filesystem
or spawn processes **through Tauri plugins**, but it holds the engine's stdin
via the `engine_send` command and can send any protocol frame. `isEngineRequest`
validates the envelope and rejects unknown request types; payloads are validated
per-handler, not by a central schema. The blast radius of a compromised webview
is therefore the engine request surface itself. That surface is deliberately
constrained: all project/file read requests (`project.readFile`,
`project.files`, `project.diff`, `project.changes`, `project.ship`, `file.read`)
are confined to the symlink-resolved roots of projects with a live session —
the engine rejects everything else, so the webview cannot use the pipe as an
arbitrary file reader. `path.open` launches the OS default app on an existing
path and returns no file contents. `macOSPrivateApi` is enabled for window
appearance (transparent titlebar), not for capability.

## Approvals

Upstream OMP approval semantics are preserved, and the app now bridges them into
the GUI rather than only inheriting whatever your terminal OMP config allows.
`autoApprove` defaults to `false` in production; the only place it can be true
is the supervisor's test mode (`packages/engine/src/worker/supervisor.ts`,
`autoApprove: this.#testMode && config.approvalMode !== "always-ask"`), reached
only under `ORCHESTRATOR_TEST_MODE=1`. Sessions are created with `hasUI: true`.
**The absence of a UI response is never treated as consent** — a tool call
awaiting approval simply stays blocked until it is answered or the turn is
aborted.

Two gates cover the tool set, and both are wired:

1. **Upstream's ACP permission gate** (in `@oh-my-pi/pi-coding-agent`,
   `src/session/acp-permission-gate.ts`) intercepts `bash`, `edit`, `delete`,
   and `move` and routes them through each worker's
   `ClientBridge.requestPermission` into an `approval.request` event — the
   inline card with Allow once / Always allow / Reject / Always reject.
   `allow_always` / `reject_always` are cached per session so identical
   requests do not re-prompt.
2. **OMP's tool-tier gate** covers everything else (`write`, `eval`,
   `browser`, `computer`, MCP tools…) by tier. The worker binds it to the
   session's approval mode with a runtime, non-persisted
   `settings.override("tools.approvalMode", …)` at boot and on every mode
   change — without that override the tier gate reads the user's global
   config, which defaults to yolo. `bash`/`delete`/`move` carry per-tool
   tier allows so the ACP gate remains their single prompter; `edit` stays
   tier-gated because the ACP gate only prompts for destructive edit ops.

Per-session **approval mode** — `always-ask` (Manual), `write` (Auto-accept
edits), or `yolo` (Full access) — is set from the composer, enforced
worker-side, and every change is recorded in the session transcript. A switch
to Full access requires an explicit confirmation dialog in the UI, and the
worker announces it with a warning notice.

Aborting a session **cancels any pending approval prompt** for it rather than
leaving it stuck waiting forever with no way to resolve it from the UI.

Practically, this means: if your OMP configuration approves a class of tool
calls without prompting (outside this project's own gate), The Orchestrator
still won't override that; where the gate does prompt, there is now a window in
the GUI to answer it, and until you do, the tool call does not run. Review your
OMP approval settings before running sessions here, and prefer projects where
an unreviewed command is recoverable.

## Extension UI bridge

Extensions that want to draw UI (OMP's ask-tool style select / confirm / input
/ editor / notify requests) are bridged into native cards via an
`ExtensionUIContext` the worker passes through `createAgentSession`'s
`setToolUIContext`, sourced from `CreateAgentSessionResult.eventBus`. The same
rule as approvals applies: the bridge never auto-confirms a request and never
lets one hang silently. TUI-only methods are explicit no-ops, and a fully
custom component that has no native equivalent surfaces an explicit
"unsupported interaction" card rather than attempting to render arbitrary
extension-authored UI or pretending the request succeeded.

## Shell is not sandboxed

OMP shell commands are executed directly. There is no container, no seatbelt
profile, no syscall filter, no path jail, and no allowlist of binaries applied
by this project. A command that would work in your terminal works here, with the
same reach and the same permissions. Do not read anything in this document as
implying containment.

## Network

This project adds no network behaviour of its own:

- No telemetry.
- No analytics.
- No crash reporting.
- No cloud backend, no accounts, no sign-up, no licence check.
- The auto-updater checks the GitHub release feed
  (`releases/latest/download/latest.json`) and downloads updates from that
  release only; every artifact is minisign-verified against the public key
  pinned in `tauri.conf.json` before install. The engine binary and the OMP
  native addon are shipped inside the bundle, never fetched separately.

The only other outbound traffic is OMP's own: calls to the model providers you
have configured, any MCP servers your OMP configuration starts, and web search
or fetch if the agent uses those tools. Provider quota figures come from
`authStorage.fetchUsageReports()` only; see [USAGE_MODEL.md](./USAGE_MODEL.md).

## Local data

| Path | Contents | Owner |
| --- | --- | --- |
| `~/Library/Application Support/The Orchestrator/logs/engine.log` | Structured JSON engine log, redacted, rotated at 5 MB to `engine.log.1` (one generation kept) | this app |
| `~/Library/Application Support/The Orchestrator/usage/records.jsonl` | The global usage index: per-response token/cost records keyed by provider `responseId`, project, provider, model, and actor. No prompts, no completions, no secrets — counts only. | this app |
| `~/.omp` (agent dir `~/.omp/agent`) | OMP credentials, settings, session transcripts | OMP |

The log level defaults to `info` and is set by `ORCHESTRATOR_LOG_LEVEL`. Log
records go to stderr and to the file; stdout is reserved for the protocol
channel and is protected against stray `console.log` output from dependencies.
Raising the level to `debug` increases the volume of tool arguments and output
written to disk — still redacted, but a larger surface. Delete the log directory
freely; nothing depends on it.

Session state itself is OMP's. The app reads and resumes OMP session files in
place and never relocates them.

## Signing status

Release builds are ad-hoc signed (`codesign --sign -`) because the maintainer
has no paid Apple Developer account. The artifacts are therefore not notarised,
and Gatekeeper will treat them accordingly. Setting `MACOS_SIGN_IDENTITY` swaps
in a Developer ID identity with no other change to the build.

Future notarisation will require entitlements including
`com.apple.security.cs.disable-library-validation`. This is mandatory rather
than convenient: the app `dlopen`s `pi_natives.darwin-arm64.node`, a native
addon signed under a different Team ID, and without that entitlement the kernel
refuses to map it. Anyone hardening a fork should understand that this
deliberately relaxes library validation for the whole process.

If you did not build the app yourself, verify what you are running:

```sh
codesign -dvv "/Applications/The Orchestrator.app"
spctl --assess --type execute -vv "/Applications/The Orchestrator.app"
```

## Reporting a vulnerability

Please report suspected vulnerabilities privately, through a GitHub private
security advisory on this project's repository (Security → Advisories → Report a
vulnerability). Do not open a public issue for anything exploitable, and do not
include real credentials or unredacted logs in a report.

A useful report includes the app version, the macOS version and architecture,
the OMP SDK version shown in the About window, and the smallest reproduction you
can manage. Expect a best-effort response from a single maintainer; there is no
service-level agreement and no bounty.

Issues in OMP itself belong upstream at
[can1357/oh-my-pi](https://github.com/can1357/oh-my-pi). If you are unsure which
side a problem is on, report it here and it will be forwarded.
