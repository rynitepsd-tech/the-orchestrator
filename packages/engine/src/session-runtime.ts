/**
 * One running session.
 *
 * A SessionRuntime owns an isolated OMP AgentSession plus everything derived
 * from it: run state, usage, advisors, and the event stream the UI consumes.
 *
 * Critically, a SessionRuntime's lifetime is independent of whether the UI is
 * looking at it. Switching the visible session in the sidebar changes nothing
 * here — that is what makes concurrent background execution work.
 */
import {
  advisorUsageFromStats,
  contextUsageOf,
  createIsolatedSession,
  EventMapper,
  normalizeAdvisor,
  primaryUsageFromTurn,
  toOmpAdvisor,
  type IsolatedSession,
} from "@orchestrator/omp-adapter";
import {
  isActiveRunState,
  type AdvisorConfig,
  type AdvisorState,
  type ApprovalMode,
  type ContextUsage,
  type EngineErrorPayload,
  type ProductEvent,
  type RunState,
  type SessionSummary,
} from "@orchestrator/protocol";
import { UsageAccumulator } from "@orchestrator/usage";

export interface SessionRuntimeInit {
  sessionId: string;
  projectId: string;
  projectPath: string;
  title: string;
  agentDir: string;
  authStorage: unknown;
  modelRegistry: unknown;
  model?: unknown;
  modelKey?: string;
  thinkingLevel?: string;
  advisors: AdvisorConfig[];
  approvalMode?: ApprovalMode;
  resumeSessionPath?: string;
  autoApprove?: boolean;
  enableMCP?: boolean;
  enableLsp?: boolean;
  emit: (event: ProductEvent) => void;
}

/** Upstream advisor status -> product advisor state. */
function mapAdvisorState(status: string | undefined, enabled: boolean): AdvisorState {
  if (!enabled) return "disabled";
  switch (status) {
    case "running":
      return "reviewing";
    case "paused":
      return "paused";
    case "quota_exhausted":
      return "quota-exhausted";
    case "no_model":
      return "no-model";
    case "error":
      return "failed";
    default:
      return "idle";
  }
}

export class SessionRuntime {
  readonly sessionId: string;
  readonly projectId: string;
  readonly projectPath: string;

  #title: string;
  #runState: RunState = "idle";
  #activity?: string;
  #error?: EngineErrorPayload;
  #unread = false;
  #lastActivityAt = new Date().toISOString();
  #disposed = false;

  #iso!: IsolatedSession;
  #mapper!: EventMapper;
  #unsubscribe?: () => void;

  readonly #usage = new UsageAccumulator();
  readonly #init: SessionRuntimeInit;
  readonly #advisors = new Map<string, AdvisorConfig>();
  #advisorStates = new Map<string, AdvisorState>();

  /** Coalescing buffers so streaming does not flood the UI with tiny frames. */
  readonly #textBuf = new Map<string, string>();
  readonly #thinkBuf = new Map<string, string>();
  #flushTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(init: SessionRuntimeInit) {
    this.#init = init;
    this.sessionId = init.sessionId;
    this.projectId = init.projectId;
    this.projectPath = init.projectPath;
    this.#title = init.title;
    for (const a of init.advisors) this.#advisors.set(a.id, a);
  }

  async start(): Promise<void> {
    this.#iso = await createIsolatedSession({
      sessionId: this.sessionId,
      cwd: this.#init.projectPath,
      agentDir: this.#init.agentDir,
      authStorage: this.#init.authStorage as never,
      modelRegistry: this.#init.modelRegistry as never,
      model: this.#init.model,
      thinkingLevel: this.#init.thinkingLevel,
      resumeSessionPath: this.#init.resumeSessionPath,
      autoApprove: this.#init.autoApprove,
      enableMCP: this.#init.enableMCP,
      enableLsp: this.#init.enableLsp,
      hasUI: true,
    });

    this.#mapper = new EventMapper({
      sessionId: this.sessionId,
      onRunState: (state, activity) => this.#setRunState(state, activity),
    });

    await this.applyAdvisors([...this.#advisors.values()]);

    this.#unsubscribe = this.#iso.session.subscribe((ev: unknown) => this.#onOmpEvent(ev));

    const file = (this.#iso.session as any).sessionFile;
    if (file) {
      this.#emit({
        type: "session.persisted",
        sessionId: this.sessionId,
        ompSessionPath: String(file),
        ompSessionId: String((this.#iso.session as any).sessionId ?? ""),
      });
    }
  }

  // -------------------------------------------------------------------------
  // Event plumbing
  // -------------------------------------------------------------------------

  #onOmpEvent(ev: any): void {
    for (const out of this.#mapper.map(ev)) {
      // Coalesce high-frequency deltas; forward everything else immediately.
      if (out.type === "assistant.text") {
        this.#textBuf.set(out.messageId, (this.#textBuf.get(out.messageId) ?? "") + out.delta);
        this.#scheduleFlush();
        continue;
      }
      if (out.type === "assistant.thinking") {
        this.#thinkBuf.set(out.messageId, (this.#thinkBuf.get(out.messageId) ?? "") + out.delta);
        this.#scheduleFlush();
        continue;
      }
      this.#flushDeltas();
      this.#emit(out);
    }

    // Usage is authoritative on turn_end.
    if (ev?.type === "turn_end" && ev.message) {
      const rec = primaryUsageFromTurn(
        { sessionId: this.sessionId, projectId: this.projectId },
        ev.message,
        "live-event",
      );
      if (rec && this.#usage.ingest(rec)) this.#emitUsage();
      this.#refreshAdvisorUsage();
      this.#emitContext();
    }

    if (ev?.type === "agent_end") {
      this.#flushDeltas();
      this.#refreshAdvisorUsage();
      this.#emitUsage();
      this.#emitContext();
      this.#unread = true;
    }
  }

  #scheduleFlush(): void {
    if (this.#flushTimer) return;
    // ~30fps: fast enough to feel live, slow enough to keep React calm.
    this.#flushTimer = setTimeout(() => this.#flushDeltas(), 33);
  }

  #flushDeltas(): void {
    if (this.#flushTimer) {
      clearTimeout(this.#flushTimer);
      this.#flushTimer = null;
    }
    for (const [messageId, delta] of this.#textBuf) {
      if (delta) this.#emit({ type: "assistant.text", sessionId: this.sessionId, messageId, delta });
    }
    this.#textBuf.clear();
    for (const [messageId, delta] of this.#thinkBuf) {
      if (delta)
        this.#emit({ type: "assistant.thinking", sessionId: this.sessionId, messageId, delta });
    }
    this.#thinkBuf.clear();
  }

  #emit(e: ProductEvent): void {
    this.#lastActivityAt = new Date().toISOString();
    this.#init.emit(e);
  }

  #setRunState(state: RunState, activity?: string): void {
    if (this.#runState === state && this.#activity === activity) return;
    this.#runState = state;
    this.#activity = activity;
    this.#init.emit({ type: "session.state", sessionId: this.sessionId, runState: state, activity });
  }

  #emitUsage(): void {
    this.#init.emit({
      type: "usage.update",
      sessionId: this.sessionId,
      breakdown: this.#usage.breakdown(this.sessionId),
    });
  }

  #emitContext(): void {
    const ctx = contextUsageOf(this.#iso.session);
    if (ctx) this.#init.emit({ type: "context.update", sessionId: this.sessionId, context: ctx });
  }

  /**
   * Pull cumulative advisor stats and re-emit advisor state.
   *
   * Snapshots replace prior records under the accumulator's key rules, so
   * polling repeatedly cannot inflate advisor totals.
   */
  #refreshAdvisorUsage(): void {
    const s: any = this.#iso.session;
    let stats: any;
    try {
      stats = s.getAdvisorStats?.();
    } catch {
      return;
    }
    if (!stats) return;

    const records = advisorUsageFromStats(
      { sessionId: this.sessionId, projectId: this.projectId },
      stats,
    );
    if (this.#usage.ingestMany(records)) this.#emitUsage();

    for (const per of stats.advisors ?? []) {
      const name = String(per?.name ?? "");
      if (!name) continue;
      const id = `advisor:${name}`;
      const cfg = this.#advisors.get(id);
      const state = mapAdvisorState(per?.status, cfg?.enabled !== false);
      if (this.#advisorStates.get(id) === state) continue;
      this.#advisorStates.set(id, state);
      this.#init.emit({
        type: "advisor.state",
        sessionId: this.sessionId,
        advisorId: id,
        advisorName: name,
        state,
        model: per?.model?.id ? String(per.model.id) : cfg?.model,
      });

      // An advisor hitting its own quota must not make the whole session look
      // dead — the primary keeps running.
      if (state === "quota-exhausted" || state === "failed" || state === "no-model") {
        this.#init.emit({
          type: "advisor.failed",
          sessionId: this.sessionId,
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
            model: per?.model?.id ? String(per.model.id) : cfg?.model,
          },
          primaryUnaffected: isActiveRunState(this.#runState) || this.#runState === "idle",
        });
      }
    }
  }

  // -------------------------------------------------------------------------
  // Commands
  // -------------------------------------------------------------------------

  /**
   * Send a prompt.
   *
   * A prompt arriving mid-stream is mapped onto upstream semantics rather than
   * racing: `steer` injects into the running turn, `queue` defers it.
   */
  async prompt(text: string, whenBusy: "steer" | "queue" | "reject" = "steer"): Promise<
    "started" | "steered" | "queued"
  > {
    const s: any = this.#iso.session;
    const busy = Boolean(s.isStreaming) || isActiveRunState(this.#runState);

    if (busy) {
      if (whenBusy === "reject") throw new Error("Session is busy");
      if (whenBusy === "steer" && typeof s.steer === "function") {
        await s.steer(text);
        return "steered";
      }
      if (typeof s.queueDeferredMessage === "function") {
        s.queueDeferredMessage(text);
        return "queued";
      }
      if (typeof s.followUp === "function") {
        await s.followUp(text);
        return "steered";
      }
    }

    this.#unread = false;
    this.#setRunState("queued");
    // Deliberately not awaited: the caller gets an ack immediately and the run
    // continues in the background while the user switches sessions.
    void s
      .prompt(text)
      .catch((e: unknown) => this.#onPromptError(e))
      .finally(() => {
        this.#flushDeltas();
        if (isActiveRunState(this.#runState)) this.#setRunState("completed");
      });
    return "started";
  }

  #onPromptError(e: unknown): void {
    const msg = String((e as Error)?.message ?? e);
    const aborted = /abort/i.test(msg);
    this.#error = aborted
      ? undefined
      : { kind: classifyError(msg), message: humanizeError(msg), detail: msg, retryable: true };
    this.#setRunState(aborted ? "interrupted" : "error");
    if (this.#error) {
      this.#init.emit({ type: "session.failed", sessionId: this.sessionId, error: this.#error });
    }
    this.#init.emit({
      type: "session.finished",
      sessionId: this.sessionId,
      runState: aborted ? "interrupted" : "error",
    });
  }

  async abort(): Promise<boolean> {
    const s: any = this.#iso.session;
    if (typeof s.abort !== "function") return false;
    this.#setRunState("stopping");
    await s.abort();
    this.#setRunState("interrupted");
    return true;
  }

  async compact(): Promise<boolean> {
    const s: any = this.#iso.session;
    if (typeof s.compact !== "function") return false;
    await s.compact();
    this.#init.emit({
      type: "session.compacted",
      sessionId: this.sessionId,
      at: new Date().toISOString(),
    });
    this.#emitContext();
    return true;
  }

  async setModel(modelKey: string, thinkingLevel?: string): Promise<boolean> {
    const s: any = this.#iso.session;
    const [provider, ...rest] = modelKey.split("/");
    const id = rest.join("/");
    const model = (this.#init.modelRegistry as any)?.find?.(provider, id);
    if (!model) return false;
    if (typeof s.setModel !== "function") return false;
    await s.setModel(model);
    if (thinkingLevel && typeof s.setThinkingLevel === "function") {
      await s.setThinkingLevel(thinkingLevel);
    }
    this.#init.emit({
      type: "session.model",
      sessionId: this.sessionId,
      model: modelKey,
      thinkingLevel,
      automatic: false,
    });
    return true;
  }

  /**
   * Apply advisor configuration for THIS session only.
   *
   * Routed through OMP's own `applyAdvisorConfigs`, so no WATCHDOG.yml or
   * global config is rewritten. Making a change permanent is a separate,
   * explicit action in the UI.
   */
  async applyAdvisors(advisors: AdvisorConfig[]): Promise<AdvisorConfig[]> {
    this.#advisors.clear();
    for (const a of advisors) this.#advisors.set(a.id, a);

    const s: any = this.#iso.session;
    if (typeof s.applyAdvisorConfigs === "function") {
      try {
        await s.applyAdvisorConfigs(advisors.filter((a) => a.enabled).map(toOmpAdvisor));
      } catch (e) {
        this.#init.emit({
          type: "session.failed",
          sessionId: this.sessionId,
          error: {
            kind: "configuration",
            message: "Advisor configuration could not be applied.",
            detail: String((e as Error)?.message ?? e),
          },
        });
      }
    }

    for (const a of advisors) {
      const state: AdvisorState = a.enabled ? "idle" : "disabled";
      this.#advisorStates.set(a.id, state);
      this.#init.emit({
        type: "advisor.state",
        sessionId: this.sessionId,
        advisorId: a.id,
        advisorName: a.name,
        state,
        model: a.model,
      });
    }
    return [...this.#advisors.values()];
  }

  async setAdvisorEnabled(advisorId: string, enabled: boolean): Promise<void> {
    const cfg = this.#advisors.get(advisorId);
    if (!cfg) return;
    cfg.enabled = enabled;
    const s: any = this.#iso.session;
    if (typeof s.setAdvisorEnabled === "function") {
      try {
        await s.setAdvisorEnabled(cfg.name, enabled);
      } catch {
        /* fall through to a full re-apply */
        await this.applyAdvisors([...this.#advisors.values()]);
      }
    }
    this.#advisorStates.set(advisorId, enabled ? "idle" : "disabled");
    this.#init.emit({
      type: "advisor.state",
      sessionId: this.sessionId,
      advisorId,
      advisorName: cfg.name,
      state: enabled ? "idle" : "disabled",
      model: cfg.model,
    });
  }

  setTitle(title: string): void {
    this.#title = title;
    const s: any = this.#iso.session;
    try {
      s.setSessionName?.(title);
    } catch {
      /* title is cosmetic; never fail the session over it */
    }
    this.#init.emit({ type: "session.title", sessionId: this.sessionId, title });
  }

  markRead(): void {
    this.#unread = false;
  }

  // -------------------------------------------------------------------------
  // Accessors
  // -------------------------------------------------------------------------

  get advisors(): AdvisorConfig[] {
    return [...this.#advisors.values()];
  }

  get runState(): RunState {
    return this.#runState;
  }

  get disposed(): boolean {
    return this.#disposed;
  }

  get ompSessionPath(): string | undefined {
    const f = (this.#iso?.session as any)?.sessionFile;
    return f ? String(f) : undefined;
  }

  usageBreakdown() {
    return this.#usage.breakdown(this.sessionId);
  }

  /** Raw records, so the global usage index can mirror them without re-deriving. */
  usageRecords() {
    return this.#usage.recordsFor(this.sessionId);
  }

  contextUsage(): ContextUsage | null {
    return this.#iso ? contextUsageOf(this.#iso.session) : null;
  }

  summary(): SessionSummary {
    const s: any = this.#iso?.session;
    return {
      sessionId: this.sessionId,
      projectId: this.projectId,
      projectPath: this.projectPath,
      title: this.#title,
      runState: this.#runState,
      model: this.#init.modelKey,
      thinkingLevel: this.#init.thinkingLevel,
      advisorCount: [...this.#advisors.values()].filter((a) => a.enabled).length,
      ompSessionPath: this.ompSessionPath,
      ompSessionId: s?.sessionId ? String(s.sessionId) : undefined,
      messageCount: Array.isArray(s?.messages) ? s.messages.length : 0,
      lastActivityAt: this.#lastActivityAt,
      unread: this.#unread,
      error: this.#error,
    };
  }

  async dispose(): Promise<void> {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#flushDeltas();
    try {
      this.#unsubscribe?.();
    } catch {
      /* already gone */
    }
    try {
      await this.#iso?.session?.dispose();
    } catch {
      /* best effort */
    }
  }
}

// ---------------------------------------------------------------------------
// Error classification
// ---------------------------------------------------------------------------

export function classifyError(msg: string): EngineErrorPayload["kind"] {
  const m = msg.toLowerCase();
  if (/quota|rate.?limit|usage limit|429/.test(m)) return "provider-quota";
  if (/unauthor|forbidden|invalid.*key|401|403|credential/.test(m)) return "auth";
  if (/model.*(not found|unavailable)|no such model/.test(m)) return "model-unavailable";
  if (/context length|too many tokens|context window/.test(m)) return "configuration";
  if (/enoent|permission denied|eacces/.test(m)) return "filesystem-permission";
  if (/mcp/.test(m)) return "mcp";
  if (/extension/.test(m)) return "extension";
  return "unknown";
}

export function humanizeError(msg: string): string {
  switch (classifyError(msg)) {
    case "provider-quota":
      return "The provider reported a usage limit. Retry later or switch models.";
    case "auth":
      return "The provider rejected the credentials for this model.";
    case "model-unavailable":
      return "That model is not available with the current configuration.";
    case "filesystem-permission":
      return "A file operation was denied by the filesystem.";
    default:
      return msg.length > 200 ? `${msg.slice(0, 200)}…` : msg;
  }
}
