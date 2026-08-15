/**
 * Session worker — exactly ONE AgentSession per process.
 *
 * Why a process per session
 * -------------------------
 * The preferred design was many sessions in one process, isolated by a private
 * AgentRegistry. Upstream inspection of OMP 17.3.1 showed four hazards an
 * embedder cannot fix from outside, so that design is unsafe in the envelope
 * this product needs (subagents, async bash, MCP, extensions):
 *
 *  1. `buildSubagentSessionOptions` never threads `agentRegistry`, so every
 *     subagent registers into `AgentRegistry.global()`. Session A's subagents
 *     become visible to session B. A private registry does NOT prevent this.
 *  2. `AsyncJobManager` is a process singleton created only for the FIRST
 *     session; sessions 2..N silently lose `bash --async` and parallel `task`.
 *  3. `AgentLifecycleManager.global().dispose()` runs on ANY main-kind session
 *     dispose, releasing other sessions' parked subagents.
 *  4. `Settings.init()` is memoized and ignores the 2nd+ caller's cwd/agentDir,
 *     so per-session settings silently collapse onto the first session's.
 *
 * One session per process eliminates all four by construction: every process's
 * session is "first", every global is private, and a fatal error contains to
 * one session instead of taking down the app.
 *
 * The frontend cannot tell the difference — the supervisor speaks the same
 * protocol either way. That is what the adapter boundary bought us.
 */
import {
  advisorUsageFromStats,
  contextUsageOf,
  EventMapper,
  primaryUsageFromTurn,
  replayEventsFromEntries,
  subagentUsageFromMessage,
  toOmpAdvisor,
} from "@orchestrator/omp-adapter";
import {
  type AdvisorConfig,
  type ApprovalMode,
  type EngineErrorPayload,
  type ErrorKind,
  encodeFrame,
  FrameDecoder,
  PROTOCOL_VERSION,
  type ProductEvent,
  type RunState,
  redactValue,
  type UsageRecord,
} from "@orchestrator/protocol";
import { UsageAccumulator } from "@orchestrator/usage";

// ---------------------------------------------------------------------------
// Worker boot contract
// ---------------------------------------------------------------------------

interface WorkerBoot {
  sessionId: string;
  projectId: string;
  projectPath: string;
  agentDir: string;
  title: string;
  model?: string;
  thinkingLevel?: string;
  advisors: AdvisorConfig[];
  resumeSessionPath?: string;
  approvalMode?: ApprovalMode;
  fastMode?: boolean;
  enableMCP: boolean;
  enableLsp: boolean;
  autoApprove: boolean;
  /** Provider registrations injected by tests (mock provider). */
  testProviders?: Array<{ name: string; baseUrl: string; apiKey: string; modelIds: string[] }>;
}

const out = (o: unknown) => process.stdout.write(encodeFrame(redactValue(o)));
const err = (m: string, extra?: Record<string, unknown>) =>
  process.stderr.write(
    `${JSON.stringify({ ts: new Date().toISOString(), level: "error", subsystem: "worker", message: m, ...extra })}\n`,
  );

// stdout is protocol-only.
for (const k of ["log", "info", "warn", "error", "debug"] as const) {
  console[k] = (...args: unknown[]) =>
    process.stderr.write(
      `${args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" ")}\n`,
    );
}

const boot: WorkerBoot = JSON.parse(process.env.ORCHESTRATOR_WORKER_BOOT ?? "{}");
if (!boot.sessionId) {
  err("missing ORCHESTRATOR_WORKER_BOOT");
  process.exit(2);
}

const startedAtMs = Date.now();

/**
 * Transcript replay buffer. Everything emitted is also kept here (bounded) so
 * the host can rebuild a session view after a webview reload or dropped frames
 * without re-reading OMP's session file. Coalesced deltas land here already
 * merged, which keeps replay compact.
 */
const HISTORY_CAP = 20_000;
const history: ProductEvent[] = [];
let historyBase = 0; // local sequence of history[0]

const emit = (event: ProductEvent) => {
  history.push(event);
  if (history.length > HISTORY_CAP) {
    history.splice(0, history.length - HISTORY_CAP);
    historyBase += 1;
  }
  out({ protocolVersion: PROTOCOL_VERSION, sequence: ++seq, sessionId: boot.sessionId, event });
};
let seq = 0;

/** Map an upstream failure onto the product error taxonomy — never a raw stack. */
function classifyError(e: unknown): EngineErrorPayload {
  const msg = String((e as Error)?.message ?? e);
  const lower = msg.toLowerCase();
  let kind: ErrorKind = "unknown";
  if (/abort/.test(lower)) kind = "unknown";
  else if (/(unauthorized|401|invalid api key|authentication|credential)/.test(lower))
    kind = "auth";
  else if (/(rate.?limit|quota|429|usage limit|overloaded)/.test(lower)) kind = "provider-quota";
  else if (/(model .*not (found|available)|no such model|unknown model)/.test(lower))
    kind = "model-unavailable";
  else if (/(enoent|eacces|eperm|permission denied)/.test(lower)) kind = "filesystem-permission";
  else if (/mcp/.test(lower)) kind = "mcp";
  return {
    kind,
    message: msg.slice(0, 300),
    detail: msg.length > 300 ? msg.slice(0, 4000) : undefined,
    retryable: kind === "provider-quota",
  };
}

// ---------------------------------------------------------------------------
// Build the single session
// ---------------------------------------------------------------------------

const usage = new UsageAccumulator();
const usageCtx = { sessionId: boot.sessionId, projectId: boot.projectId };
let ompSessionId = "";
let runState: RunState = "idle";
let stateBeforeWaiting: RunState = "idle";
const advisors = new Map<string, AdvisorConfig>();
for (const a of boot.advisors ?? []) advisors.set(a.id, a);
let approvalMode: ApprovalMode = boot.approvalMode ?? "always-ask";

function setRunState(s: RunState, activity?: string): void {
  if (runState === s) return;
  // Once a turn is being aborted, ordinary activity transitions must not walk
  // it back to "completed" — the abort outcome is authoritative.
  if ((runState === "stopping" || runState === "interrupted") && s === "completed") return;
  runState = s;
  emit({ type: "session.state", sessionId: boot.sessionId, runState: s, activity });
}

const OMP = await import("@oh-my-pi/pi-coding-agent");

const authStorage = await OMP.discoverAuthStorage(boot.agentDir);
const modelRegistry = new OMP.ModelRegistry(authStorage as never);

for (const p of boot.testProviders ?? []) {
  modelRegistry.registerProvider(p.name, {
    baseUrl: p.baseUrl,
    apiKey: p.apiKey,
    api: "openai-completions" as never,
    models: p.modelIds.map((id) => ({
      id,
      name: id,
      api: "openai-completions",
      baseUrl: p.baseUrl,
      reasoning: false,
      input: ["text"],
      supportsTools: true,
      cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 128_000,
      maxTokens: 8_192,
    })) as never,
  } as never);
}

function resolveModel(key?: string): unknown {
  if (!key) return undefined;
  const i = key.indexOf("/");
  if (i < 0) return undefined;
  try {
    return modelRegistry.find(key.slice(0, i), key.slice(i + 1));
  } catch {
    return undefined;
  }
}

// An explicitly requested model that cannot be resolved must fail loudly at
// creation — silently falling back to OMP's default would violate the
// "no silent model change" product rule.
const bootModel = resolveModel(boot.model);
if (boot.model && !bootModel) {
  err(`model not available: ${boot.model}`, { kind: "model-unavailable" });
  process.exit(3);
}

const sessionManager = boot.resumeSessionPath
  ? await OMP.SessionManager.open(boot.resumeSessionPath)
  : OMP.SessionManager.create(
      boot.projectPath,
      OMP.SessionManager.getDefaultSessionDir(boot.projectPath, boot.agentDir),
    );

// `Settings.init` is a memoized process singleton. One session per process
// makes that harmless, and it is the only initializer exported publicly.
const settings = await OMP.Settings.init({ cwd: boot.projectPath, agentDir: boot.agentDir });

const created = await OMP.createAgentSession({
  cwd: boot.projectPath, // always explicit; never setProjectDir/process.chdir
  agentDir: boot.agentDir,
  authStorage: authStorage as never,
  modelRegistry,
  model: bootModel as never,
  thinkingLevel: boot.thinkingLevel as never,
  sessionManager,
  settings,
  // Defence in depth even at one session per process.
  agentRegistry: new OMP.AgentRegistry(),
  enableMCP: boot.enableMCP,
  enableLsp: boot.enableLsp,
  // A missing UI must never imply consent; approvals bridge to the host.
  autoApprove: boot.autoApprove,
  hasUI: true,
} as never);
const session = created.session;
const mcpManager: any = (created as any).mcpManager;
// The session's own bus — subagent lifecycle/progress/event channels are
// published here (task/types.ts upstream). Process isolation means it is
// already scoped to exactly this session.
const eventBus: any = (created as any).eventBus;
ompSessionId = String((session as any).sessionId ?? "");

// ---------------------------------------------------------------------------
// Interaction bridges (approvals + extension UI)
// ---------------------------------------------------------------------------

interface PendingInteraction<T> {
  resolve: (v: T) => void;
}

const pendingApprovals = new Map<
  string,
  PendingInteraction<{ optionId: string } | { cancelled: true }>
>();
const pendingUi = new Map<string, PendingInteraction<{ value: unknown; cancelled: boolean }>>();
let interactionCounter = 0;
// Globally unique across workers — several sessions can hold prompts at once
// and the host must never confuse two pending interactions.
const interactionId = (prefix: string) =>
  `${prefix}-${boot.sessionId.slice(0, 8)}-${++interactionCounter}`;

function enterWaiting(): void {
  if (runState !== "waiting") {
    stateBeforeWaiting = runState;
    setRunState("waiting");
  }
}

function leaveWaiting(): void {
  if (runState === "waiting" && pendingApprovals.size === 0 && pendingUi.size === 0) {
    // The turn is still running; restore the pre-prompt activity state.
    setRunState(stateBeforeWaiting === "waiting" ? "tool" : stateBeforeWaiting);
  }
}

/**
 * Approval policy applied on top of upstream's ClientBridge permission gate.
 * The gate covers bash / edit / delete / move (see acp-permission-gate.ts).
 *
 *  - "always-ask": every gated call prompts the host.
 *  - "write":      file edits auto-allow; bash still prompts.
 *  - "yolo":       everything the gate covers auto-allows. Explicit user
 *                  choice — never a silent default.
 */
function policyAllows(toolName: string): boolean {
  if (approvalMode === "yolo") return true;
  if (approvalMode === "write") return toolName !== "bash";
  return false;
}

const clientBridge = {
  capabilities: { requestPermission: true },
  requestPermission: async (
    toolCall: { toolCallId: string; toolName: string; title: string; rawInput?: unknown },
    options: Array<{ optionId: string; name: string; kind: string }>,
    signal?: AbortSignal,
  ): Promise<
    { outcome: "cancelled" } | { outcome: "selected"; optionId: string; kind?: string }
  > => {
    if (policyAllows(toolCall.toolName)) {
      return { outcome: "selected", optionId: "allow_once", kind: "allow_once" };
    }
    const approvalId = interactionId("appr");
    const detail =
      toolCall.toolName === "bash" && toolCall.rawInput && typeof toolCall.rawInput === "object"
        ? String((toolCall.rawInput as Record<string, unknown>).command ?? "")
        : undefined;

    emit({
      type: "approval.request",
      sessionId: boot.sessionId,
      approvalId,
      toolName: toolCall.toolName,
      summary: toolCall.title,
      detail,
      options: options.map((o) => ({
        id: o.optionId,
        label: o.name,
        kind:
          o.kind === "allow_once" ? "allow" : o.kind === "allow_always" ? "allow-always" : "deny",
      })),
    });
    enterWaiting();

    const result = await new Promise<{ optionId: string } | { cancelled: true }>((resolve) => {
      pendingApprovals.set(approvalId, { resolve });
      signal?.addEventListener(
        "abort",
        () => {
          if (pendingApprovals.delete(approvalId)) resolve({ cancelled: true });
        },
        { once: true },
      );
    });

    emit({
      type: "approval.resolved",
      sessionId: boot.sessionId,
      approvalId,
      optionId: "cancelled" in result ? "cancelled" : result.optionId,
    });
    leaveWaiting();

    if ("cancelled" in result) return { outcome: "cancelled" };
    const kind = options.find((o) => o.optionId === result.optionId)?.kind;
    return { outcome: "selected", optionId: result.optionId, kind };
  },
};
(session as any).setClientBridge?.(clientBridge);

/**
 * Extension/tool UI bridge. Implements the subset of upstream
 * ExtensionUIContext a non-terminal host can honour; everything else is a
 * deliberate no-op or an explicit "unsupported" card — never a hang, never a
 * silent auto-confirm.
 */
function requestUi<T>(
  ui: Extract<ProductEvent, { type: "extension.ui.request" }>["ui"],
  extensionName: string,
  fallback: T,
  map: (r: { value: unknown; cancelled: boolean }) => T,
): Promise<T> {
  const requestId = interactionId("ui");
  emit({ type: "extension.ui.request", sessionId: boot.sessionId, requestId, extensionName, ui });
  enterWaiting();
  return new Promise<T>((resolve) => {
    pendingUi.set(requestId, {
      resolve: (r) => {
        leaveWaiting();
        try {
          resolve(map(r));
        } catch {
          resolve(fallback);
        }
      },
    });
  });
}

const uiContext: any = {
  // Dialog timeouts should not start while the request is queued behind
  // another session's dialog in the host.
  timeoutStartsOnPresentation: true,

  select: (title: string, options: Array<{ label?: string; value?: string } | string>) =>
    requestUi(
      {
        kind: "select",
        title,
        options: (options ?? []).map((o, i) =>
          typeof o === "string"
            ? { id: o, label: o }
            : { id: String(o.value ?? o.label ?? i), label: String(o.label ?? o.value ?? i) },
        ),
        multi: false,
      },
      "extension",
      undefined,
      (r) => (r.cancelled ? undefined : (r.value as string)),
    ),

  confirm: (title: string, message: string) =>
    requestUi({ kind: "confirm", title, message }, "extension", false, (r) =>
      r.cancelled ? false : Boolean(r.value),
    ),

  input: (title: string, placeholder?: string) =>
    requestUi({ kind: "input", title, placeholder }, "extension", undefined, (r) =>
      r.cancelled ? undefined : String(r.value ?? ""),
    ),

  editor: (title: string, prefill?: string) =>
    requestUi({ kind: "editor", title, initial: prefill ?? "" }, "extension", undefined, (r) =>
      r.cancelled ? undefined : String(r.value ?? ""),
    ),

  notify: (message: string, type?: "info" | "warning" | "error") => {
    emit({
      type: "extension.ui.request",
      sessionId: boot.sessionId,
      requestId: interactionId("ui"),
      extensionName: "extension",
      ui: { kind: "notification", level: type === "warning" ? "warn" : (type ?? "info"), message },
    });
  },

  setStatus: (_key: string, text: string | undefined) => {
    if (text) emit({ type: "session.state", sessionId: boot.sessionId, runState, activity: text });
  },
  setWorkingMessage: (message?: string) => {
    if (message)
      emit({ type: "session.state", sessionId: boot.sessionId, runState, activity: message });
  },

  // Terminal-specific surface a desktop webview cannot honour. Explicit no-ops
  // (never throws) so extensions keep working minus their TUI chrome.
  onTerminalInput: () => () => {},
  setWidget: () => {},
  setFooter: () => {},
  setHeader: () => {},
  setTitle: () => {},
  setEditorText: () => {},
  pasteToEditor: () => {},
  getEditorText: () => "",
  addAutocompleteProvider: () => {},
  setEditorComponent: () => {},
  getToolsExpanded: () => true,
  setToolsExpanded: () => {},
  theme: undefined,
  getAllThemes: async () => [],
  getTheme: async () => undefined,
  setTheme: async () => ({ success: false, error: "Themes are managed by The Orchestrator." }),

  custom: async () => {
    // A custom TUI component cannot be rendered in the desktop host. Surface an
    // explicit unsupported card instead of hanging or auto-confirming.
    return requestUi(
      {
        kind: "unsupported",
        description:
          "This extension requested a custom terminal component that The Orchestrator cannot display.",
      },
      "extension",
      undefined,
      () => undefined,
    );
  },
};
(created as any).setToolUIContext?.(uiContext, true);

// ---------------------------------------------------------------------------
// Event stream
// ---------------------------------------------------------------------------

const mapper = new EventMapper({ sessionId: boot.sessionId, onRunState: setRunState });

// --- streaming coalescing -------------------------------------------------
const textBuf = new Map<string, string>();
const thinkBuf = new Map<string, string>();
let flushTimer: ReturnType<typeof setTimeout> | null = null;

function flush(): void {
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  for (const [messageId, delta] of textBuf) {
    if (delta) emit({ type: "assistant.text", sessionId: boot.sessionId, messageId, delta });
  }
  textBuf.clear();
  for (const [messageId, delta] of thinkBuf) {
    if (delta) emit({ type: "assistant.thinking", sessionId: boot.sessionId, messageId, delta });
  }
  thinkBuf.clear();
}

function scheduleFlush(): void {
  if (!flushTimer) flushTimer = setTimeout(flush, 33); // ~30fps
}

function emitUsage(): void {
  emit({
    type: "usage.update",
    sessionId: boot.sessionId,
    breakdown: usage.breakdown(boot.sessionId),
  });
}

/** Forward raw records upward so the engine-wide usage index can persist them. */
function shareRecords(records: UsageRecord[]): void {
  if (!records.length) return;
  const stamped = records.map((r) => ({ ...r, ompSessionId: ompSessionId || undefined }));
  emit({ type: "usage.records", sessionId: boot.sessionId, records: stamped });
}

function ingestAndShare(records: UsageRecord[]): void {
  const fresh = records.filter((r) => usage.ingest(r));
  if (fresh.length) {
    shareRecords(fresh);
    emitUsage();
  }
}

function emitContext(): void {
  const ctx = contextUsageOf(session);
  if (ctx) emit({ type: "context.update", sessionId: boot.sessionId, context: ctx });
}

function emitFastMode(): void {
  const s: any = session;
  emit({
    type: "session.fastMode",
    sessionId: boot.sessionId,
    enabled: Boolean(s.isFastModeEnabled?.()),
    active: Boolean(s.isFastModeActive?.()),
  });
}

let persistedEmitted = false;
function checkPersisted(): void {
  if (persistedEmitted) return;
  const sessionFile = (session as any).sessionFile ?? (sessionManager as any).getSessionFile?.();
  if (sessionFile) {
    persistedEmitted = true;
    ompSessionId = String((session as any).sessionId ?? ompSessionId);
    emit({
      type: "session.persisted",
      sessionId: boot.sessionId,
      ompSessionPath: String(sessionFile),
      ompSessionId,
    });
  }
}

/**
 * Refresh advisor usage and state.
 *
 * `PerAdvisorStat.cost` is cumulative (restored on resume from advisor
 * transcripts), but `PerAdvisorStat.tokens` is live-context only and resets
 * when the advisor compacts. Snapshots therefore REPLACE prior records rather
 * than adding to them.
 */
const lastAdvisorState = new Map<string, string>();

function refreshAdvisors(): void {
  let stats: any;
  try {
    stats = (session as any).getAdvisorStats?.();
  } catch {
    return;
  }
  if (!stats) return;

  ingestAndShare(advisorUsageFromStats(usageCtx, stats));

  for (const per of stats.advisors ?? []) {
    const name = String(per?.name ?? "");
    if (!name) continue;
    const id = `advisor:${name}`;
    const cfg = advisors.get(id);
    const state =
      cfg?.enabled === false
        ? "disabled"
        : per?.status === "running"
          ? "reviewing"
          : per?.status === "paused"
            ? "paused"
            : per?.status === "quota_exhausted"
              ? "quota-exhausted"
              : per?.status === "no_model"
                ? "no-model"
                : per?.status === "error"
                  ? "failed"
                  : "idle";

    // Polled on a timer while advisors review asynchronously; only state
    // CHANGES are emitted so the transcript is not spammed with idle ticks.
    if (lastAdvisorState.get(id) === state) continue;
    lastAdvisorState.set(id, state);

    emit({
      type: "advisor.state",
      sessionId: boot.sessionId,
      advisorId: id,
      advisorName: name,
      state,
      model: per?.model?.id ? String(per.model.id) : cfg?.model,
    });

    // An advisor's own quota failure must not make the session look dead.
    if (state === "quota-exhausted" || state === "failed" || state === "no-model") {
      emit({
        type: "advisor.failed",
        sessionId: boot.sessionId,
        advisorId: id,
        advisorName: name,
        error: {
          kind: state === "quota-exhausted" ? "provider-quota" : "model-unavailable",
          message:
            state === "quota-exhausted"
              ? `${name} advisor paused: usage limit reached for its configured model.`
              : state === "no-model"
                ? `${name} advisor has no resolvable model.`
                : `${name} advisor stopped after repeated failures.`,
          retryable: state === "quota-exhausted",
        },
        primaryUnaffected: true,
      });
    }
  }
}

session.subscribe((ev: any) => {
  for (const o of mapper.map(ev)) {
    if (o.type === "assistant.text") {
      textBuf.set(o.messageId, (textBuf.get(o.messageId) ?? "") + o.delta);
      scheduleFlush();
      continue;
    }
    if (o.type === "assistant.thinking") {
      thinkBuf.set(o.messageId, (thinkBuf.get(o.messageId) ?? "") + o.delta);
      scheduleFlush();
      continue;
    }
    flush();
    emit(o);
  }

  if (ev?.type === "turn_end" && ev.message) {
    const rec = primaryUsageFromTurn(usageCtx, ev.message, "live-event");
    if (rec) ingestAndShare([rec]);
    refreshAdvisors();
    emitContext();
    checkPersisted();
  }
  if (ev?.type === "agent_end") {
    flush();
    refreshAdvisors();
    emitUsage();
    emitContext();
    checkPersisted();
  }
});

// Advisors review ASYNCHRONOUSLY after turns settle, so their usage and
// state changes cannot be captured from turn events alone. Poll while any
// advisor is configured; refreshAdvisors only emits on change.
setInterval(() => {
  if (advisors.size > 0 || (session as any).isAdvisorActive?.()) refreshAdvisors();
}, 5_000).unref?.();

// ---------------------------------------------------------------------------
// Subagent channels (see task/types.ts upstream)
// ---------------------------------------------------------------------------

const subagentToolCalls = new Map<string, number>();
const subagentStartMs = new Map<string, number>();

if (eventBus) {
  eventBus.on("task:subagent:lifecycle", (data: any) => {
    const id = String(data?.id ?? "");
    if (!id) return;
    if (data.status === "started") {
      subagentStartMs.set(id, Date.now());
      subagentToolCalls.set(id, 0);
      emit({
        type: "subagent.start",
        sessionId: boot.sessionId,
        subagentId: id,
        label: String(data.description ?? data.agent ?? "Subagent"),
        agent: data.agent ? String(data.agent) : undefined,
        agentSource: data.agentSource ? String(data.agentSource) : undefined,
        parentToolCallId: data.parentToolCallId ? String(data.parentToolCallId) : undefined,
        startedAt: new Date().toISOString(),
      });
    } else {
      emit({
        type: "subagent.end",
        sessionId: boot.sessionId,
        subagentId: id,
        ok: data.status === "completed",
        durationMs: Date.now() - (subagentStartMs.get(id) ?? Date.now()),
        toolCalls: subagentToolCalls.get(id) ?? 0,
        error:
          data.status === "failed"
            ? "Subagent failed."
            : data.status === "aborted"
              ? "Subagent aborted."
              : undefined,
      });
    }
  });

  eventBus.on("task:subagent:progress", (data: any) => {
    const p = data?.progress;
    if (!p?.id) return;
    subagentToolCalls.set(String(p.id), Number(p.toolCount ?? 0));
    emit({
      type: "subagent.update",
      sessionId: boot.sessionId,
      subagentId: String(p.id),
      toolCalls: Number(p.toolCount ?? 0),
      activity: p.lastIntent ? String(p.lastIntent) : undefined,
      currentTool: p.currentTool ? String(p.currentTool) : undefined,
      tokens: Number.isFinite(p.tokens) ? Number(p.tokens) : undefined,
      cost: Number.isFinite(p.cost) ? Number(p.cost) : undefined,
      contextTokens: Number.isFinite(p.contextTokens) ? Number(p.contextTokens) : undefined,
      contextWindow: Number.isFinite(p.contextWindow) ? Number(p.contextWindow) : undefined,
    });
  });

  // Raw per-subagent event stream: the authoritative source for subagent usage
  // attribution (full token splits per provider response).
  eventBus.on("task:subagent:event", (data: any) => {
    const id = String(data?.id ?? "");
    const ev = data?.event;
    if (!id || !ev) return;
    if ((ev.type === "message_end" || ev.type === "turn_end") && ev.message?.usage) {
      const rec = subagentUsageFromMessage(usageCtx, id, ev.message);
      if (rec) ingestAndShare([rec]);
    }
  });
}

// ---------------------------------------------------------------------------
// Advisors
// ---------------------------------------------------------------------------

async function applyAdvisors(list: AdvisorConfig[]): Promise<AdvisorConfig[]> {
  advisors.clear();
  for (const a of list) advisors.set(a.id, a);
  const s: any = session;
  if (typeof s.applyAdvisorConfigs === "function") {
    const enabled = list.filter((a) => a.enabled);
    await s.applyAdvisorConfigs(enabled.map(toOmpAdvisor), undefined);
    // applyAdvisorConfigs only STORES the roster; the runtime builds when the
    // session-level advisor toggle flips on (session-advisors.ts upstream).
    // Enabling with an empty roster would start OMP's default advisor, so the
    // toggle tracks whether this session actually has enabled advisors.
    s.setAdvisorEnabled?.(enabled.length > 0);
    if (enabled.length > 0 && !s.isAdvisorActive?.()) {
      // The toggle was flipped but no runtime came up — usually the advisor
      // model could not resolve. Say so instead of showing idle advisors.
      for (const a of enabled) {
        emit({
          type: "advisor.failed",
          sessionId: boot.sessionId,
          advisorId: a.id,
          advisorName: a.name,
          error: {
            kind: "model-unavailable",
            message: `${a.name} advisor could not start — its model${a.model ? ` (${a.model})` : ""} did not resolve.`,
          },
          primaryUnaffected: true,
        });
      }
    }
  } else if (list.some((a) => a.enabled)) {
    // Never show advisors as configured when the runtime cannot actually run
    // them — that would be a silent lie about what is reviewing the session.
    err("applyAdvisorConfigs missing upstream; advisors not started", { kind: "configuration" });
    for (const a of list) {
      emit({
        type: "advisor.failed",
        sessionId: boot.sessionId,
        advisorId: a.id,
        advisorName: a.name,
        error: {
          kind: "configuration",
          message: "This OMP build does not support session advisors.",
        },
        primaryUnaffected: true,
      });
    }
    return list;
  }
  for (const a of list) {
    emit({
      type: "advisor.state",
      sessionId: boot.sessionId,
      advisorId: a.id,
      advisorName: a.name,
      state: a.enabled ? "idle" : "disabled",
      model: a.model,
    });
  }
  return list;
}

if (advisors.size) await applyAdvisors([...advisors.values()]);

// Fast mode (provider priority tier): apply the launch preference, then report
// the actual state — resumed sessions restore their persisted tier, so the UI
// chip must reflect the session, not assume "off".
if (boot.fastMode) (session as any).setFastMode?.(true);
emitFastMode();

// Resume/fork: seed the replay buffer with the persisted conversation so the
// host can render the history that predates this process. Seeded directly
// (not emitted) — the UI pulls it with session.transcript after creation.
if (boot.resumeSessionPath) {
  try {
    const entries = (sessionManager as any).getBranch?.() ?? [];
    for (const ev of replayEventsFromEntries(boot.sessionId, entries)) history.push(ev);
  } catch (e) {
    err(`resume replay failed: ${String(e)}`);
  }
  // The resumed session already holds the whole conversation, so its context
  // consumption is known NOW — surface it with the replayed transcript instead
  // of leaving the meter blank until the next turn runs.
  const ctx = contextUsageOf(session);
  if (ctx) history.push({ type: "context.update", sessionId: boot.sessionId, context: ctx });
}

checkPersisted();

// Ready handshake for the supervisor.
out({
  protocolVersion: PROTOCOL_VERSION,
  workerReady: true,
  sessionId: boot.sessionId,
  pid: process.pid,
});

// ---------------------------------------------------------------------------
// Command loop
// ---------------------------------------------------------------------------

async function handle(req: any): Promise<unknown> {
  const s: any = session;
  switch (req.type) {
    case "session.prompt": {
      const busy = Boolean(s.isStreaming);
      // Upstream throws AgentBusyError if prompt() is called mid-stream with
      // no streamingBehavior, so the behaviour is always explicit.
      const behavior = req.payload.whenBusy === "queue" ? "followUp" : "steer";
      if (busy && req.payload.whenBusy === "reject") throw new Error("Session is busy");

      // Attachments: images become real ImageContent the model can see
      // (loadImageInput handles resize/size caps/format quirks); other files
      // are referenced by path so the agent reads them with its own tools.
      let promptText = String(req.payload.text);
      const images: Array<{ type: "image"; data: string; mimeType: string }> = [];
      const atts = Array.isArray(req.payload.attachments) ? req.payload.attachments : [];
      for (const a of atts) {
        if (a?.kind === "image" && a.path) {
          try {
            const { loadImageInput } = await import(
              "@oh-my-pi/pi-coding-agent/utils/image-loading"
            );
            const loaded = await loadImageInput({
              path: String(a.path),
              cwd: boot.projectPath,
              autoResize: true,
            });
            if (loaded) {
              images.push({ type: "image", data: loaded.data, mimeType: loaded.mimeType });
              continue;
            }
          } catch (e) {
            err("image attachment failed to load", { path: a.path, error: String(e) });
          }
          promptText += `\n\n[Attached image could not be loaded: ${a.path}]`;
        } else if (a?.path) {
          promptText += `\n\nAttached file: ${a.path}`;
        }
      }

      setRunState("queued");
      // The turn runs in the background: the host gets an immediate ack so the
      // user can switch sessions while this one keeps working.
      void (async () => {
        // `finished` must be emitted exactly once, with the state that
        // actually occurred — an aborted turn must never report "completed".
        let outcome: Extract<RunState, "completed" | "interrupted" | "error"> = "completed";
        try {
          await s.prompt(promptText, {
            streamingBehavior: behavior,
            images: images.length ? images : undefined,
          });
          // abort() resolves the prompt rather than rejecting it, so trust the
          // run state the abort handler recorded.
          if (runState === "interrupted" || runState === "stopping") outcome = "interrupted";
        } catch (e) {
          const msg = String((e as Error)?.message ?? e);
          outcome = /abort/i.test(msg) ? "interrupted" : "error";
          if (outcome === "error") {
            emit({ type: "session.failed", sessionId: boot.sessionId, error: classifyError(e) });
          }
        } finally {
          flush();
          setRunState(outcome);
          emit({ type: "session.finished", sessionId: boot.sessionId, runState: outcome });
          checkPersisted();
        }
      })();
      return {
        accepted: true,
        mode: busy ? (behavior === "steer" ? "steered" : "queued") : "started",
      };
    }

    case "session.abort":
      setRunState("stopping");
      // Cancel any prompts blocked on user input, or the abort would hang
      // behind a dialog nobody can answer any more.
      for (const [id, p] of pendingApprovals) {
        pendingApprovals.delete(id);
        p.resolve({ cancelled: true });
      }
      for (const [id, p] of pendingUi) {
        pendingUi.delete(id);
        p.resolve({ value: undefined, cancelled: true });
      }
      await s.abort?.();
      setRunState("interrupted");
      return { aborted: true };

    case "session.compact":
      await s.compact?.();
      emit({ type: "session.compacted", sessionId: boot.sessionId, at: new Date().toISOString() });
      emitContext();
      return { ok: true };

    case "session.setFastMode": {
      // setFastMode returns false when the model has no service-tier family.
      const ok = Boolean(s.setFastMode?.(Boolean(req.payload.enabled)));
      emitFastMode();
      return {
        ok,
        enabled: Boolean(s.isFastModeEnabled?.()),
        active: Boolean(s.isFastModeActive?.()),
      };
    }

    case "session.setModel": {
      const m = resolveModel(String(req.payload.model));
      if (!m) return { ok: false, model: String(req.payload.model) };
      await s.setModel?.(m);
      if (req.payload.thinkingLevel) await s.setThinkingLevel?.(req.payload.thinkingLevel);
      emit({
        type: "session.model",
        sessionId: boot.sessionId,
        model: String(req.payload.model),
        thinkingLevel: req.payload.thinkingLevel,
        automatic: false,
      });
      return { ok: true, model: String(req.payload.model) };
    }

    case "session.setTitle":
      try {
        s.setSessionName?.(String(req.payload.title));
      } catch {
        /* cosmetic */
      }
      emit({ type: "session.title", sessionId: boot.sessionId, title: String(req.payload.title) });
      return { ok: true };

    case "session.setApprovalMode": {
      const mode = String(req.payload.mode) as ApprovalMode;
      if (!["always-ask", "write", "yolo"].includes(mode)) return { ok: false };
      approvalMode = mode;
      return { ok: true };
    }

    case "session.transcript": {
      const since = Number(req.payload?.sinceSequence ?? 0);
      const start = Math.max(0, since - historyBase);
      return { events: history.slice(start), sequence: historyBase + history.length };
    }

    case "session.advisors.set":
      return { advisors: await applyAdvisors(req.payload.advisors ?? []) };

    case "session.advisors.get":
      return { advisors: [...advisors.values()] };

    case "approval.respond": {
      const p = pendingApprovals.get(String(req.payload.approvalId));
      if (!p) return { ok: false };
      pendingApprovals.delete(String(req.payload.approvalId));
      p.resolve({ optionId: String(req.payload.optionId) });
      return { ok: true };
    }

    case "extension.ui.respond": {
      const p = pendingUi.get(String(req.payload.requestId));
      if (!p) return { ok: false };
      pendingUi.delete(String(req.payload.requestId));
      p.resolve({ value: req.payload.value, cancelled: Boolean(req.payload.cancelled) });
      return { ok: true };
    }

    case "slash.list": {
      try {
        const mod: any = await import(
          "@oh-my-pi/pi-coding-agent/slash-commands/available-commands"
        );
        const cmds = await mod.buildAvailableSlashCommands(session as never);
        return {
          commands: (cmds ?? []).map((c: any) => ({
            name: String(c.name),
            description: c.description ? String(c.description) : undefined,
            source: String(c.source ?? "builtin"),
          })),
        };
      } catch (e) {
        err(`slash discovery failed: ${String(e)}`);
        return { commands: [] };
      }
    }

    case "mcp.status": {
      if (!mcpManager) return { servers: [] };
      const names: string[] = mcpManager.getAllServerNames?.() ?? [];
      return {
        servers: names.map((name) => {
          let toolCount: number | undefined;
          try {
            const conn = mcpManager.getConnection?.(name);
            toolCount = conn?.tools?.length ?? conn?.getTools?.()?.length;
          } catch {
            /* status only */
          }
          return {
            name,
            status: mcpManager.getConnectionStatus?.(name) ?? "disconnected",
            source: mcpManager.getSource?.(name),
            toolCount,
          };
        }),
      };
    }

    case "mcp.reconnect": {
      if (!mcpManager?.reconnectServer) return { ok: false };
      try {
        await mcpManager.reconnectServer(String(req.payload.server));
        return { ok: true, status: mcpManager.getConnectionStatus?.(String(req.payload.server)) };
      } catch (e) {
        throw Object.assign(new Error(`Reconnect failed: ${String((e as Error)?.message ?? e)}`), {
          kind: "mcp",
        });
      }
    }

    case "usage.session":
      return { breakdown: usage.breakdown(boot.sessionId) };

    case "session.thinkingLevels":
      return { levels: s.getAvailableThinkingLevels?.() ?? [] };

    case "worker.ping":
      return {
        pid: process.pid,
        rssBytes: process.memoryUsage().rss,
        uptimeMs: Date.now() - startedAtMs,
        runState,
        pendingInteractions: pendingApprovals.size + pendingUi.size,
      };

    case "worker.shutdown":
      queueMicrotask(async () => {
        try {
          await session.dispose();
        } finally {
          process.exit(0);
        }
      });
      return { stopping: true };

    default:
      throw new Error(`worker cannot handle ${req.type}`);
  }
}

const decoder = new FrameDecoder();
const td = new TextDecoder();
const reader = Bun.stdin.stream().getReader();

process.on("uncaughtException", (e) => err(`uncaught: ${e?.message}`, { stack: e?.stack }));
process.on("unhandledRejection", (e) => err(`unhandled rejection: ${String(e)}`));

while (true) {
  const { done, value } = await reader.read();
  if (done) break;
  const { frames, errors } = decoder.push(td.decode(value, { stream: true }));
  for (const msg of errors) err(`frame decode: ${msg}`);
  for (const f of frames) {
    const req = f as any;
    try {
      const result = await handle(req);
      out({ protocolVersion: PROTOCOL_VERSION, requestId: req.requestId, ok: true, result });
    } catch (e) {
      const classified = classifyError(e);
      out({
        protocolVersion: PROTOCOL_VERSION,
        requestId: req.requestId,
        ok: false,
        error: (e as { kind?: string })?.kind
          ? { ...classified, kind: (e as any).kind }
          : classified,
      });
    }
  }
}

await session.dispose().catch(() => {});
process.exit(0);
