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
  toOmpAdvisor,
} from "@orchestrator/omp-adapter";
import {
  encodeFrame,
  FrameDecoder,
  PROTOCOL_VERSION,
  redactValue,
  type AdvisorConfig,
  type ProductEvent,
  type RunState,
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
  enableMCP: boolean;
  enableLsp: boolean;
  autoApprove: boolean;
  /** Provider registrations injected by tests (mock provider). */
  testProviders?: Array<{ name: string; baseUrl: string; apiKey: string; modelIds: string[] }>;
}

const out = (o: unknown) => process.stdout.write(encodeFrame(redactValue(o)));
const err = (m: string, extra?: Record<string, unknown>) =>
  process.stderr.write(`${JSON.stringify({ ts: new Date().toISOString(), level: "error", subsystem: "worker", message: m, ...extra })}\n`);

// stdout is protocol-only.
for (const k of ["log", "info", "warn", "error", "debug"] as const) {
  console[k] = (...args: unknown[]) =>
    process.stderr.write(`${args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" ")}\n`);
}

const boot: WorkerBoot = JSON.parse(process.env.ORCHESTRATOR_WORKER_BOOT ?? "{}");
if (!boot.sessionId) {
  err("missing ORCHESTRATOR_WORKER_BOOT");
  process.exit(2);
}

const emit = (event: ProductEvent) =>
  out({ protocolVersion: PROTOCOL_VERSION, sequence: ++seq, sessionId: boot.sessionId, event });
let seq = 0;

// ---------------------------------------------------------------------------
// Build the single session
// ---------------------------------------------------------------------------

const usage = new UsageAccumulator();
const usageCtx = { sessionId: boot.sessionId, projectId: boot.projectId };
let runState: RunState = "idle";
const advisors = new Map<string, AdvisorConfig>();
for (const a of boot.advisors ?? []) advisors.set(a.id, a);

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

const sessionManager = boot.resumeSessionPath
  ? await OMP.SessionManager.open(boot.resumeSessionPath)
  : OMP.SessionManager.create(
      boot.projectPath,
      OMP.SessionManager.getDefaultSessionDir(boot.projectPath, boot.agentDir),
    );

// `Settings.init` is a memoized process singleton. One session per process
// makes that harmless, and it is the only initializer exported publicly.
const settings = await OMP.Settings.init({ cwd: boot.projectPath, agentDir: boot.agentDir });

const { session } = await OMP.createAgentSession({
  cwd: boot.projectPath, // always explicit; never setProjectDir/process.chdir
  agentDir: boot.agentDir,
  authStorage: authStorage as never,
  modelRegistry,
  model: resolveModel(boot.model) as never,
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
});

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
  emit({ type: "usage.update", sessionId: boot.sessionId, breakdown: usage.breakdown(boot.sessionId) });
}

function emitContext(): void {
  const ctx = contextUsageOf(session);
  if (ctx) emit({ type: "context.update", sessionId: boot.sessionId, context: ctx });
}

/**
 * Refresh advisor usage and state.
 *
 * `PerAdvisorStat.cost` is cumulative (restored on resume from advisor
 * transcripts), but `PerAdvisorStat.tokens` is live-context only and resets
 * when the advisor compacts. Snapshots therefore REPLACE prior records rather
 * than adding to them.
 */
function refreshAdvisors(): void {
  let stats: any;
  try {
    stats = (session as any).getAdvisorStats?.();
  } catch {
    return;
  }
  if (!stats) return;

  if (usage.ingestMany(advisorUsageFromStats(usageCtx, stats))) emitUsage();

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
    if (rec && usage.ingest(rec)) emitUsage();
    refreshAdvisors();
    emitContext();
  }
  if (ev?.type === "agent_end") {
    flush();
    refreshAdvisors();
    emitUsage();
    emitContext();
  }
});

async function applyAdvisors(list: AdvisorConfig[]): Promise<AdvisorConfig[]> {
  advisors.clear();
  for (const a of list) advisors.set(a.id, a);
  const s: any = session;
  if (typeof s.applyAdvisorConfigs === "function") {
    await s.applyAdvisorConfigs(list.filter((a) => a.enabled).map(toOmpAdvisor));
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

const sessionFile = (session as any).sessionFile;
if (sessionFile) {
  emit({
    type: "session.persisted",
    sessionId: boot.sessionId,
    ompSessionPath: String(sessionFile),
    ompSessionId: String((session as any).sessionId ?? ""),
  });
}

// Ready handshake for the supervisor.
out({ protocolVersion: PROTOCOL_VERSION, workerReady: true, sessionId: boot.sessionId });

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

      setRunState("queued");
      // The turn runs in the background: the host gets an immediate ack so the
      // user can switch sessions while this one keeps working.
      void (async () => {
        // `finished` must be emitted exactly once, with the state that
        // actually occurred — an aborted turn must never report "completed".
        let outcome: Extract<RunState, "completed" | "interrupted" | "error"> = "completed";
        try {
          await s.prompt(String(req.payload.text), { streamingBehavior: behavior });
          // abort() resolves the prompt rather than rejecting it, so trust the
          // run state the abort handler recorded.
          if (runState === "interrupted" || runState === "stopping") outcome = "interrupted";
        } catch (e) {
          const msg = String((e as Error)?.message ?? e);
          outcome = /abort/i.test(msg) ? "interrupted" : "error";
          if (outcome === "error") {
            emit({
              type: "session.failed",
              sessionId: boot.sessionId,
              error: { kind: "unknown", message: msg.slice(0, 300), detail: msg },
            });
          }
        } finally {
          flush();
          setRunState(outcome);
          emit({ type: "session.finished", sessionId: boot.sessionId, runState: outcome });
        }
      })();
      return { accepted: true, mode: busy ? (behavior === "steer" ? "steered" : "queued") : "started" };
    }

    case "session.abort":
      setRunState("stopping");
      await s.abort?.();
      setRunState("interrupted");
      return { aborted: true };

    case "session.compact":
      await s.compact?.();
      emit({ type: "session.compacted", sessionId: boot.sessionId, at: new Date().toISOString() });
      emitContext();
      return { ok: true };

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

    case "session.advisors.set":
      return { advisors: await applyAdvisors(req.payload.advisors ?? []) };

    case "session.advisors.get":
      return { advisors: [...advisors.values()] };

    case "usage.session":
      return { breakdown: usage.breakdown(boot.sessionId) };

    case "session.thinkingLevels":
      return { levels: s.getAvailableThinkingLevels?.() ?? [] };

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
  const { frames } = decoder.push(td.decode(value, { stream: true }));
  for (const f of frames) {
    const req = f as any;
    try {
      const result = await handle(req);
      out({ protocolVersion: PROTOCOL_VERSION, requestId: req.requestId, ok: true, result });
    } catch (e) {
      out({
        protocolVersion: PROTOCOL_VERSION,
        requestId: req.requestId,
        ok: false,
        error: { kind: "unknown", message: String((e as Error)?.message ?? e) },
      });
    }
  }
}

await session.dispose().catch(() => {});
process.exit(0);
