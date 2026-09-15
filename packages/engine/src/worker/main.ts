/**
 * Session worker — exactly ONE AgentSession per process.
 *
 * Why a process per session
 * -------------------------
 * The preferred design was many sessions in one process, isolated by a private
 * AgentRegistry. Upstream inspection of OMP (the version pinned in
 * packages/engine/package.json, enforced by test/omp-pin.test.ts) showed four hazards an
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
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import type { CustomToolContext, SessionEntry } from "@oh-my-pi/pi-coding-agent";
import {
  advisorUsageFromStats,
  contextUsageOf,
  EventMapper,
  isInsideRoot,
  primaryUsageFromTurn,
  realParentPath,
  replayEventsFromEntries,
  subagentUsageFromMessage,
  toOmpAdvisor,
} from "@orchestrator/omp-adapter";
import {
  type AdvisorConfig,
  type ApprovalMode,
  encodeFrame,
  FrameDecoder,
  PROTOCOL_VERSION,
  type ProductEvent,
  type RunState,
  redactValue,
  type UsageRecord,
} from "@orchestrator/protocol";
import { UsageAccumulator, usageKey } from "@orchestrator/usage";
import { classifyError } from "./classify-error";
import { EvidenceTracker } from "./evidence";
import type { AnswerSubmission, ReviewOwner, StoredTask } from "./finalization";
import { ANSWER_ENTRY_TYPE, TASK_ENTRY_TYPE, TaskFinalizer } from "./finalization";
import type { TestProvider } from "./supervisor";

// ---------------------------------------------------------------------------
// Worker boot contract
// ---------------------------------------------------------------------------

interface WorkerBoot {
  sessionId: string;
  projectId: string;
  projectPath: string;
  agentDir: string;
  title: string;
  /** True when the launch config carried an explicit user-chosen title. */
  userTitled?: boolean;
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
  testProviders?: TestProvider[];
}

const out = (o: unknown) => process.stdout.write(encodeFrame(redactValue(o)));
const err = (m: string, extra?: Record<string, unknown>) =>
  process.stderr.write(
    `${JSON.stringify({ ts: new Date().toISOString(), level: "error", subsystem: "worker", message: m, ...extra })}\n`,
  );

// stdout is protocol-only. Same discipline as protectStdout() in ../logging.ts;
// the worker keeps its own copy because its stderr lines are bare text, not
// structured log records — keep the two in step if either changes.
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

/**
 * Turn identity, carried on every event.
 *
 * The client used to re-derive turn boundaries from a flat item list with a
 * heuristic — the single most rewritten piece of UI in the changelog. The
 * worker KNOWS the structure (it sees the prompt start and the turn end), so
 * it stamps a stable turnId instead and the client renders a given structure.
 */
let turnCounter = 0;
let currentTurnId: string | undefined;
let finalizer: TaskFinalizer | undefined;
let ownedRun = false;
let stopped = false;
let cancelReview: (() => void) | undefined;
const promptQueue: Array<{
  requestId: string;
  text: string;
  images: Array<{ type: "image"; data: string; mimeType: string }>;
}> = [];
const preexistingJobs = new Set<string>();
const pendingSubagents = new Set<string>();
interface ReviewerIdentity extends ReviewOwner {
  advisorId: string;
  advisorName: string;
}
const reviewOwners = new Map<string, ReviewerIdentity>();
const activeReviewNames = new Set<string>();
let activeReviewOwner: ReviewOwner | undefined;
let unownedReviewNote = false;
const beginTurn = (): string => {
  currentTurnId = `t${++turnCounter}`;
  return currentTurnId;
};
// Execution IDs change for each primary run; request IDs survive revisions.

const emit = (event: ProductEvent) => {
  const reviewer =
    event.type === "advisor.message" ? reviewOwners.get(event.advisorName) : undefined;
  const stamped = {
    ...event,
    ...(event.type !== "advisor.message" && currentTurnId ? { turnId: currentTurnId } : {}),
    ...(event.type !== "advisor.message" && finalizer?.currentId
      ? { userTurnId: finalizer.currentId }
      : {}),
    ...(reviewer
      ? {
          userTurnId: reviewer.requestId,
          advisorId: reviewer.advisorId,
          advisorName: reviewer.advisorName,
        }
      : {}),
    ...(event.type === "task.updated" ? { userTurnId: event.task.requestId } : {}),
  };
  history.push(stamped);
  if (history.length > HISTORY_CAP) {
    history.splice(0, history.length - HISTORY_CAP);
    historyBase += 1;
  }
  out({
    protocolVersion: PROTOCOL_VERSION,
    sequence: ++seq,
    sessionId: boot.sessionId,
    event: stamped,
  });
  if (event.type === "advisor.message") {
    if (reviewer) {
      finalizer?.finding(
        {
          id: event.messageId,
          advisorName: reviewer.advisorName,
          severity: event.severity,
          text: event.text,
        },
        reviewer,
      );
    } else {
      unownedReviewNote = true;
      emit({
        type: "session.notice",
        sessionId: boot.sessionId,
        level: "warning",
        source: "advisor",
        message: `An advisor note has no recorded review owner. It remains visible but cannot certify a task: ${event.text}`,
      });
    }
  }
  if (
    finalizer?.currentId &&
    (event.type === "tool.start" || event.type === "tool.update" || event.type === "tool.end")
  ) {
    void evidenceTracker.observe(stamped, finalizer.currentId).catch((error) => {
      err(`evidence observation failed: ${String(error)}`);
    });
  }
};
let seq = 0;

/**
 * Crash containment, registered BEFORE any top-level await so boot failures
 * are covered too. A crashed subscribe callback or timer must never leave the
 * UI with a spinner that has nothing behind it: the session is declared
 * failed and the turn settled, loudly, instead of "thinking" forever.
 */
function settleCrash(origin: string, e: unknown): void {
  err(`${origin}: ${String((e as Error)?.message ?? e)}`, {
    stack: (e as Error)?.stack,
  });
  try {
    stopped = true;
    promptQueue.length = 0;
    finalizer?.fail(`Worker failure: ${String((e as Error)?.message ?? e)}`);
    // Only a session that LOOKS busy needs settling — an idle session's
    // background hiccup is a log line, not a failure banner.
    const active = !["idle", "completed", "interrupted", "error"].includes(runState);
    if (!active) return;
    emit({ type: "session.failed", sessionId: boot.sessionId, error: classifyError(e) });
    setRunState("interrupted");
    emit({ type: "session.finished", sessionId: boot.sessionId, runState: "interrupted" });
  } catch {
    /* emitting must never crash the crash handler (incl. pre-boot TDZ) */
  }
}
process.on("uncaughtException", (e) => settleCrash("uncaught", e));
process.on("unhandledRejection", (e) => settleCrash("unhandled rejection", e));

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

// Idle-hibernation clock (see maybeHibernate below). Declared with the rest
// of the session state so every code path may stamp it without TDZ hazards.
const IDLE_HIBERNATE_MS = (() => {
  const raw = Number(process.env.ORCHESTRATOR_IDLE_HIBERNATE_MS);
  return Number.isFinite(raw) && raw >= 0 ? raw : 30 * 60_000;
})();
let lastActivityMs = Date.now();
let hibernating = false;

function setRunState(s: RunState, activity?: string): void {
  // Any state transition is activity — the idle-hibernation clock restarts.
  // (Called only after boot completes, so the late `let` is initialized.)
  lastActivityMs = Date.now();
  if (runState === s) return;
  // Once a turn is being aborted, ordinary activity transitions must not walk
  // it back to "completed" — the abort outcome is authoritative.
  if ((runState === "stopping" || runState === "interrupted") && s === "completed") return;
  runState = s;
  emit({ type: "session.state", sessionId: boot.sessionId, runState: s, activity });
}

const OMP = await import("@oh-my-pi/pi-coding-agent");
const reviewStatusSchema = OMP.z.enum(["pending", "passed", "incomplete", "not-required"]);
const storedTaskSchema = OMP.z.object({
  task: OMP.z.object({
    requestId: OMP.z.string(),
    prompt: OMP.z.string(),
    phase: OMP.z.enum([
      "working",
      "reviewing",
      "revising",
      "finalizing",
      "complete",
      "blocked",
      "interrupted",
      "error",
    ]),
    revision: OMP.z.number().int().nonnegative(),
    reviewStatus: reviewStatusSchema,
    reviewDetail: OMP.z.string().optional(),
    findings: OMP.z.array(
      OMP.z.object({
        id: OMP.z.string(),
        advisorName: OMP.z.string(),
        severity: OMP.z.enum(["nit", "concern", "blocker", "unknown"]),
        text: OMP.z.string(),
        revision: OMP.z.number().int().nonnegative(),
        resolution: OMP.z.enum(["pending", "accepted", "rejected", "unresolved"]),
        rationale: OMP.z.string().optional(),
      }),
    ),
    evidence: OMP.z.array(
      OMP.z.object({
        id: OMP.z.string(),
        requestId: OMP.z.string(),
        callId: OMP.z.string(),
        kind: OMP.z.enum(["command", "browser"]),
        label: OMP.z.string(),
        status: OMP.z.enum(["passed", "failed", "observed", "unknown"]),
        exitCode: OMP.z.number().optional(),
        output: OMP.z.string().optional(),
        artifactPaths: OMP.z.array(OMP.z.string()).optional(),
        startedAt: OMP.z.string(),
        finishedAt: OMP.z.string(),
        revision: OMP.z.string().optional(),
        stale: OMP.z.boolean(),
        detail: OMP.z.string().optional(),
      }),
    ),
    answer: OMP.z
      .object({
        id: OMP.z.string(),
        requestId: OMP.z.string(),
        messageId: OMP.z.string(),
        text: OMP.z.string(),
        at: OMP.z.string(),
        revision: OMP.z.number().int().nonnegative(),
        reviewStatus: reviewStatusSchema,
      })
      .optional(),
    startedAt: OMP.z.string(),
    updatedAt: OMP.z.string(),
    completedAt: OMP.z.string().optional(),
  }),
  candidate: OMP.z
    .object({
      text: OMP.z.string(),
      messageId: OMP.z.string(),
      revision: OMP.z.number().int().nonnegative(),
    })
    .optional(),
});
const reviewOwnerSchema = OMP.z.object({
  sdkName: OMP.z.string(),
  requestId: OMP.z.string(),
  revision: OMP.z.number().int().nonnegative(),
  advisorId: OMP.z.string(),
  advisorName: OMP.z.string(),
});

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
  ? // initialCwd anchors the fallback: if the session file's recorded cwd no
    // longer exists, tools must land in the project — not the worker's own
    // process.cwd(), which is "/" for a Finder-launched app.
    await OMP.SessionManager.open(boot.resumeSessionPath, undefined, undefined, {
      initialCwd: boot.projectPath,
    })
  : OMP.SessionManager.create(
      boot.projectPath,
      OMP.SessionManager.getDefaultSessionDir(boot.projectPath, boot.agentDir),
    );

const evidenceTracker = new EvidenceTracker(boot.projectPath);
finalizer = new TaskFinalizer({
  persist(record) {
    sessionManager.appendCustomEntry(TASK_ENTRY_TYPE, record);
    sessionManager.flushSync();
  },
  updated(task) {
    emit({ type: "task.updated", sessionId: boot.sessionId, task });
  },
  notice(message) {
    emit({ type: "session.notice", sessionId: boot.sessionId, level: "warning", message });
  },
  stage(text, requestId, revision) {
    startReviewRound(requestId, revision, text);
    return sessionManager.appendCustomMessageEntry(
      ANSWER_ENTRY_TYPE,
      text,
      false,
      { requestId, revision },
      "agent",
    );
  },
  reviewRequired() {
    return [...advisors.values()].some((advisor) => advisor.enabled);
  },
  async review(owner) {
    if (![...advisors.values()].some((advisor) => advisor.enabled)) return true;
    if (typeof session.waitForAdvisorCatchup !== "function") return false;
    if (
      activeReviewOwner?.requestId !== owner.requestId ||
      activeReviewOwner.revision !== owner.revision ||
      unownedReviewNote
    )
      return false;
    setAdvisorReview(true);
    refreshAdvisors();
    const cancelled = Promise.withResolvers<boolean>();
    cancelReview = () => cancelled.resolve(false);
    try {
      const caughtUp = await Promise.race([
        session.waitForAdvisorCatchup(ADVISOR_CATCHUP_MS),
        cancelled.promise,
      ]);
      sweepAdvisorCards();
      const stats = session.getAdvisorStats();
      const configured = [...advisors.values()].filter((advisor) => advisor.enabled).length;
      const current = stats.advisors.filter((advisor) => activeReviewNames.has(advisor.name));
      const overview = session
        .getAdvisorStatusOverview()
        .advisors.filter((advisor) => activeReviewNames.has(advisor.name));
      return (
        caughtUp === true &&
        !unownedReviewNote &&
        current.length === configured &&
        current.every(
          (advisor) => !["error", "quota_exhausted", "no_model", "paused"].includes(advisor.status),
        ) &&
        overview.length === configured &&
        overview.every((advisor) => advisor.yielded)
      );
    } finally {
      cancelReview = undefined;
      setAdvisorReview(false);
      refreshAdvisors();
    }
  },
  async settleWork() {
    const deadline = Date.now() + ADVISOR_CATCHUP_MS;
    while (!stopped && Date.now() < deadline) {
      const snapshot = session.getAsyncJobSnapshot();
      const pending = snapshot?.running.some((job) => !preexistingJobs.has(job.id));
      if (
        !pending &&
        pendingSubagents.size === 0 &&
        !snapshot?.delivery.queued &&
        !snapshot?.delivery.delivering &&
        !session.isStreaming
      )
        return true;
      const delay = Promise.withResolvers<void>();
      setTimeout(delay.resolve, 100);
      await delay.promise;
    }
    return false;
  },
  async revise(instruction) {
    if (stopped) throw new Error("Stopped work cannot restart automatically.");
    beginTurn();
    await session.sendCustomMessage(
      {
        customType: "orchestrator.finalize",
        content: `Active harness requestId: ${finalizer!.currentId}.\n${instruction}`,
        display: false,
        attribution: "agent",
        details: { requestId: finalizer!.currentId },
      },
      { triggerTurn: true },
    );
    await session.waitForIdle();
  },
  evidence(requestId) {
    return evidenceTracker.refresh(requestId);
  },
});

// `Settings.init` is a memoized process singleton. One session per process
// makes that harmless, and it is the only initializer exported publicly.
const settings = await OMP.Settings.init({ cwd: boot.projectPath, agentDir: boot.agentDir });

/**
 * The ACP bridge only gates {bash, edit, delete, move}; every other tool
 * (write, eval, browser, computer, MCP…) is gated by OMP's TIER system,
 * which reads `tools.approvalMode` — a setting that defaults to yolo and
 * that nothing here set before. Overriding it (runtime-only, never
 * persisted; one session per process makes the singleton per-session) is
 * what makes the session's approval mode actually mean something.
 *
 * bash/delete/move get per-tool "allow" at the tier so the ACP bridge stays
 * their single prompter (no double-ask). `edit` is deliberately NOT
 * excepted: the ACP bridge only prompts for destructive edit ops, so plain
 * content edits must fall through to the tier gate in always-ask.
 */
function applyApprovalSettings(mode: ApprovalMode): void {
  const st: any = settings;
  if (typeof st.override !== "function") return;
  try {
    st.override("tools.approvalMode", mode);
    st.override("tools.approval", { bash: "allow", delete: "allow", move: "allow" });
  } catch (e) {
    err(`approval settings override failed: ${String(e)}`);
  }
}
applyApprovalSettings(approvalMode);

const created = await OMP.createAgentSession({
  cwd: boot.projectPath, // always explicit; never setProjectDir/process.chdir
  agentDir: boot.agentDir,
  authStorage: authStorage as never,
  modelRegistry,
  model: bootModel as never,
  thinkingLevel: boot.thinkingLevel as never,
  sessionManager,
  settings,
  customTools: [
    {
      name: "submit_answer",
      label: "Stage user answer",
      loadMode: "essential",
      description:
        "Explicitly stage the complete user-facing answer for the active harness request. Does not publish until required work and advisor review settle. Use the requestId supplied by the harness. Supply finding IDs, their reviewed revision, and concrete disposition rationales; never replace an answer with a reply to a reviewer.",
      parameters: OMP.z.object({
        requestId: OMP.z.string(),
        text: OMP.z.string(),
        dispositions: OMP.z.array(
          OMP.z.object({
            findingId: OMP.z.string(),
            revision: OMP.z.number().int().nonnegative(),
            resolution: OMP.z.enum(["accepted", "rejected", "unresolved"]),
            rationale: OMP.z.string(),
          }),
        ),
      }),
      async execute(
        _callId: string,
        input: AnswerSubmission,
        _onUpdate: unknown,
        context: CustomToolContext,
        signal?: AbortSignal,
      ) {
        if (signal?.aborted || stopped) throw new Error("Stopped work cannot submit an answer.");
        if (context.sessionManager.getSessionId() !== sessionManager.getSessionId()) {
          throw new Error("Only the primary session may stage the user-facing answer.");
        }
        const jobs = session.getAsyncJobSnapshot();
        if (
          pendingSubagents.size ||
          jobs?.running.some((job) => !preexistingJobs.has(job.id)) ||
          jobs?.delivery.queued ||
          jobs?.delivery.delivering
        ) {
          throw new Error(
            "Required finite work or its result delivery remains pending. Wait for it, inspect the results, then submit the answer.",
          );
        }
        const revision = finalizer!.submit(input);
        return {
          content: [
            {
              type: "text",
              text: `Candidate revision ${revision} staged, not published. Finish the current run without repeating the answer; the harness will review it and request any necessary revision.`,
            },
          ],
          details: { requestId: input.requestId, revision },
        };
      },
    },
  ],
  // Defence in depth even at one session per process.
  agentRegistry: new OMP.AgentRegistry(),
  enableMCP: boot.enableMCP,
  enableLsp: boot.enableLsp,
  // A missing UI must never imply consent; approvals bridge to the host.
  autoApprove: boot.autoApprove,
  hasUI: true,
  // Only an explicit primary-authored submission may become the canonical answer.
  appendSystemPrompt:
    "Advisor agents may interject visible review notes as <advisory> messages. " +
    "You own the user-facing answer; assess reviewer findings separately, with explicit " +
    "accepted/rejected/unresolved dispositions and concrete rationales. At completion, " +
    "call submit_answer with the current harness requestId and a complete standalone " +
    "answer addressed to the user, not the reviewer. Ordinary assistant messages are " +
    "progress, not publication. Never claim completion with required finite work pending.\n" +
    "The UI renders GitHub-flavored markdown only — no LaTeX or math delimiters. Write " +
    "status labels and emphasis as plain markdown (e.g. **P0 — ship-blocking**), never " +
    "\\textcolor or $…$.\n" +
    "Answer style — the user reads your answers in a chat transcript, so optimize for " +
    "readability over density:\n" +
    "- Lead with the conclusion in one or two plain sentences before any detail.\n" +
    "- Write complete sentences, not fragment chains or arrow notation (A → B → fails).\n" +
    "- Cite a file/line at most once per point, at the end of the sentence or in " +
    "parentheses — never weave several citations through one sentence.\n" +
    "- Use inline code only for identifiers the reader must recognize exactly, not for " +
    "every technical noun. A paragraph should never be mostly code spans.\n" +
    "- Use bold sparingly — a handful of times per answer, for the takeaways that " +
    "matter most. Bold on every other phrase highlights nothing.\n" +
    "- Prefer short paragraphs; use headers only in long answers, and lists only when " +
    "enumerating more than three parallel items.",
} as never);
const session = created.session;
// The host owns all revision starts. Preserve advisor cards instead of allowing
// upstream blocker notes to launch hidden primary turns after Stop/publication.
session.prepareForHeadlessAdvisorDrain();

/**
 * Probe optional upstream capabilities ONCE, loudly, at boot. These are the
 * seams that break silently on an OMP minor bump: an `(s as any).compact?.()`
 * that no longer exists would report success and write a transcript marker
 * for something that never happened. Probing here turns that into a visible
 * log line at startup and an honest error at call time.
 */
const sessionCaps = {
  compact: typeof (session as any).compact === "function",
  abort: typeof (session as any).abort === "function",
  setModel: typeof (session as any).setModel === "function",
  navigateTree: typeof (session as any).navigateTree === "function",
  titleGeneration: typeof (session as any).maybeStartTitleGeneration === "function",
} as const;
for (const [name, ok] of Object.entries(sessionCaps)) {
  if (!ok) err(`upstream capability missing: session.${name}`, { kind: "configuration" });
}
function requireCap(name: keyof typeof sessionCaps, what: string): void {
  if (!sessionCaps[name]) {
    throw Object.assign(new Error(`This OMP build does not support ${what}.`), {
      kind: "configuration",
    });
  }
}

const mcpManager: any = (created as any).mcpManager;
// The session's own bus — subagent lifecycle/progress/event channels are
// published here (task/types.ts upstream). Process isolation means it is
// already scoped to exactly this session.
const eventBus: any = (created as any).eventBus;
ompSessionId = String((session as any).sessionId ?? "");

// Announce the session's ACTUAL model. A resumed session boots with no model
// in its launch config (the session header decides), so without this the
// engine-side summary — and the provider auth gate that reads it at prompt
// time — would never learn which provider this session bills against.
{
  const bootedModel: any = (session as any).model;
  if (bootedModel?.provider && bootedModel?.id) {
    emit({
      type: "session.model",
      sessionId: boot.sessionId,
      model: `${bootedModel.provider}/${bootedModel.id}`,
      automatic: true,
      reason: "boot",
    });
  }
}

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
 *  - "write":      content edits (edit/write) auto-allow; bash, delete and
 *                  move still prompt — same destructive effect as `bash rm`,
 *                  same gate.
 *  - "yolo":       everything the gate covers auto-allows. Explicit user
 *                  choice — never a silent default.
 *
 * Path scoping cuts across all modes: a mutating tool whose target resolves
 * outside the project folder ALWAYS prompts, even in yolo. That is the
 * prompt-injection guardrail — "yolo" means everything inside the project,
 * not ~/.ssh.
 */
const PATHY_INPUT_KEYS = [
  "path",
  "file_path",
  "filePath",
  "old_path",
  "new_path",
  "oldPath",
  "newPath",
  "source",
  "destination",
] as const;

const projectRootReal = (() => {
  try {
    return realpathSync(boot.projectPath);
  } catch {
    return boot.projectPath;
  }
})();

/** Target paths in a tool call that resolve outside the project folder. */
function pathsOutsideProject(rawInput: unknown): string[] {
  if (!rawInput || typeof rawInput !== "object") return [];
  const out: string[] = [];
  for (const k of PATHY_INPUT_KEYS) {
    const v = (rawInput as Record<string, unknown>)[k];
    if (typeof v !== "string" || !v) continue;
    // Symlink-resolve the nearest existing ancestor so a link inside the
    // project cannot smuggle a write outside it.
    const real = realParentPath(resolve(boot.projectPath, v));
    if (!isInsideRoot(real, projectRootReal)) out.push(v);
  }
  return out;
}

function policyAllows(toolCall: { toolName: string; rawInput?: unknown }): boolean {
  if (approvalMode === "always-ask") return false;
  if (toolCall.toolName !== "bash" && pathsOutsideProject(toolCall.rawInput).length > 0) {
    return false;
  }
  if (approvalMode === "yolo") return true;
  return toolCall.toolName === "edit" || toolCall.toolName === "write";
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
    if (policyAllows(toolCall)) {
      return { outcome: "selected", optionId: "allow_once", kind: "allow_once" };
    }
    const approvalId = interactionId("appr");
    const escaped = toolCall.toolName === "bash" ? [] : pathsOutsideProject(toolCall.rawInput);
    const detail =
      toolCall.toolName === "bash" && toolCall.rawInput && typeof toolCall.rawInput === "object"
        ? String((toolCall.rawInput as Record<string, unknown>).command ?? "")
        : escaped.length > 0
          ? // Say WHY this is asking even in a permissive mode.
            `Outside the project folder: ${escaped.join(", ")}`
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

const mapper = new EventMapper({
  sessionId: boot.sessionId,
  onRunState: setRunState,
  sourceEntryId(message) {
    const leaf = sessionManager.getLeafEntry();
    return leaf?.type === "message" && leaf.message === message ? leaf.id : undefined;
  },
});

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

let advisorReviewInFlight = false;
const ADVISOR_CATCHUP_MS = 10 * 60_000;

/**
 * Open/close the review window, announcing every transition.
 *
 * The host cannot derive this from `advisor.state`: those are per-advisor and
 * only emitted on change, so the window's opening is invisible until some
 * advisor's runtime status happens to flip. This flag is the truth.
 */
function setAdvisorReview(active: boolean): void {
  if (advisorReviewInFlight === active) return;
  advisorReviewInFlight = active;
  emit({ type: "advisor.review", sessionId: boot.sessionId, active });
}

function refreshAdvisors(): void {
  let stats: any;
  try {
    stats = (session as any).getAdvisorStats?.();
  } catch {
    return;
  }
  if (!stats) return;

  const records = advisorUsageFromStats(usageCtx, stats);
  for (const record of records) {
    const sdkName = record.actorName ?? "";
    const reviewer = reviewOwners.get(sdkName);
    if (!reviewer) continue;
    record.actorId = `advisor:${reviewer.advisorId}`;
    record.actorName = reviewer.advisorName;
    // Each round owns a separate cumulative stream; grouping still uses the
    // stable configured advisor, so resets neither lose tokens nor add UI rows.
    record.key = usageKey({
      sessionId: usageCtx.sessionId,
      actorId: record.actorId,
      messageId: `cumulative:${sdkName}`,
    });
  }
  ingestAndShare(records);

  for (const per of stats.advisors ?? []) {
    const sdkName = String(per?.name ?? "");
    if (!activeReviewNames.has(sdkName)) continue;
    const reviewer = reviewOwners.get(sdkName);
    if (!reviewer) continue;
    const name = reviewer.advisorName;
    const id = reviewer.advisorId;
    const cfg = advisors.get(id);
    // Fault states win outright. Otherwise the REVIEW WINDOW decides, not
    // `status === "running"`: an advisor that was just handed the turn can
    // still report its pre-review status for a beat (or not be enumerated at
    // all on cold spin-up), which used to publish a bogus "idle" mid-review.
    const state =
      cfg?.enabled === false
        ? "disabled"
        : per?.status === "paused"
          ? "paused"
          : per?.status === "quota_exhausted"
            ? "quota-exhausted"
            : per?.status === "no_model"
              ? "no-model"
              : per?.status === "error"
                ? "failed"
                : advisorReviewInFlight
                  ? "reviewing"
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
          // The store prefixes "<name> advisor:", so no name here.
          message:
            state === "quota-exhausted"
              ? "Paused — usage limit reached for its configured model."
              : state === "no-model"
                ? "No resolvable model."
                : "Stopped after repeated failures — it will retry on your next message.",
          retryable: state === "quota-exhausted",
        },
        primaryUnaffected: true,
      });
    }
  }
}

// --- advisor cards delivered without events ----------------------------------
// OMP surfaces advisor advisories two ways. Idle ("preserved") cards arrive as
// message_start/message_end events the mapper handles. Mid-turn ("steered")
// cards — the normal path for blocker-driven revision cascades in the pinned
// OMP version — are appended straight into agent state with NO event at all. If
// they never reach the transcript, the fold that collapses superseded drafts
// has no advisor note to key on, and every revision renders as a full
// duplicate answer. Sweep agent state before mapping each event and surface
// unseen cards ourselves; a content key dedupes against the event path (and
// against compaction rewrites, which can replay old cards at new indices).
const surfacedAdvisorCards = new Set<string>();
let advisorCardsSeen = ((session as any)?.agent?.state?.messages ?? []).length;
function advisorCardKey(m: any): string {
  const c = typeof m?.content === "string" ? m.content : JSON.stringify(m?.content ?? "");
  return `${m?.timestamp ?? ""}:${c}`;
}
function isAdvisorCardMessage(m: any): boolean {
  return m?.role === "custom" && m?.customType === "advisor";
}
function sweepAdvisorCards(): void {
  const msgs: any[] = (session as any)?.agent?.state?.messages;
  if (!Array.isArray(msgs)) return;
  if (advisorCardsSeen > msgs.length) advisorCardsSeen = msgs.length; // compaction shrank history
  if (msgs.length === advisorCardsSeen) return;
  const fresh = msgs.slice(advisorCardsSeen);
  advisorCardsSeen = msgs.length;
  for (const m of fresh) {
    if (!isAdvisorCardMessage(m)) continue;
    const key = advisorCardKey(m);
    if (surfacedAdvisorCards.has(key)) continue;
    surfacedAdvisorCards.add(key);
    // emit() records the normalized finding with the active candidate revision.
    for (const o of mapper.mapAdvisorCard(m)) {
      flush();
      emit(o);
    }
  }
}

// --- dev-server preview ------------------------------------------------------
// Tool output announcing a local server (Vite's "Local: http://localhost:5173/",
// Next's "ready on http://localhost:3000", …) surfaces a preview pane in the
// UI. Normalized to a bare origin — path noise from curls to deep routes must
// not churn the pane — and re-emitted only on change. Requires an explicit
// port: "localhost" in prose without one is chatter, not a server.
const PREVIEW_URL_RE = /(https?):\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1?\]):(\d{2,5})/i;
let lastPreviewUrl: string | undefined;
function scanForPreviewUrl(text: string | undefined): void {
  if (!text?.includes("://")) return;
  const m = PREVIEW_URL_RE.exec(text);
  if (!m) return;
  const url = `${m[1].toLowerCase()}://localhost:${m[2]}/`;
  if (url === lastPreviewUrl) return;
  lastPreviewUrl = url;
  emit({ type: "session.preview", sessionId: boot.sessionId, url });
}

session.subscribe((ev: any) => {
  if (ev?.type === "agent_start") {
    session.prepareForHeadlessAdvisorDrain();
    if (stopped || finalizer?.current?.answer) {
      session.clearQueue({ forInterrupt: true });
      void session.abort({ reason: OMP.USER_INTERRUPT_LABEL });
      return;
    }
    if (!currentTurnId) beginTurn();
  }
  // Surface silently-steered advisor cards before this event's own items, so
  // a note lands ahead of the revision it triggered (see sweepAdvisorCards).
  sweepAdvisorCards();
  // The event path and the sweep must not both render the same card.
  if (
    (ev?.type === "message_end" || ev?.type === "message_start") &&
    isAdvisorCardMessage(ev.message)
  ) {
    const key = advisorCardKey(ev.message);
    if (ev.type === "message_start") return; // end carries the render
    if (surfacedAdvisorCards.has(key)) return;
    surfacedAdvisorCards.add(key);
  }
  for (const o of mapper.map(ev)) {
    if (
      o.type === "tool.start" &&
      o.toolName !== "submit_answer" &&
      finalizer?.invalidateCandidate()
    ) {
      session.setAdvisorEnabled(false);
    }
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
    if (o.type === "tool.update") scanForPreviewUrl(o.outputDelta);
    else if (o.type === "tool.end") scanForPreviewUrl(o.output);
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
// Idle hibernation
//
// A parked session holds ~350MB with nothing to do, and nothing else ever
// reclaims it — fifteen open sessions is 6GB. After a long idle the worker
// parks itself: it announces session.hibernated (the UI keeps the transcript
// and resumes from the persisted file on the next prompt) and exits cleanly.
// ---------------------------------------------------------------------------

/**
 * Dispose the session, then exit. The deadline guarantees we exit even if
 * dispose hangs on a wedged MCP server — an orphaned worker at ~350MB holding
 * the session file open is worse than a bounded exit.
 */
async function disposeAndExit(): Promise<void> {
  if (ownedRun) {
    stopped = true;
    promptQueue.length = 0;
    finalizer?.stop("Worker exited before finalization. Resume explicitly.");
  }
  setTimeout(() => process.exit(0), 3_000).unref?.();
  try {
    await session.dispose();
  } catch {
    /* exiting anyway */
  }
  process.exit(0);
}

function maybeHibernate(): void {
  if (hibernating || IDLE_HIBERNATE_MS === 0) return;
  if (ownedRun || promptQueue.length || pendingSubagents.size) return;
  const parked =
    (runState === "idle" || runState === "completed") &&
    pendingApprovals.size === 0 &&
    pendingUi.size === 0 &&
    !advisorReviewInFlight;
  if (!parked || Date.now() - lastActivityMs < IDLE_HIBERNATE_MS) return;
  // Never hibernate a session that has nothing on disk to resume from.
  const sessionFile = (session as any).sessionFile ?? (sessionManager as any).getSessionFile?.();
  if (!sessionFile) return;
  hibernating = true;
  emit({
    type: "session.hibernated",
    sessionId: boot.sessionId,
    ompSessionPath: String(sessionFile),
  });
  void disposeAndExit();
}
setInterval(maybeHibernate, 60_000).unref?.();

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
      pendingSubagents.add(id);
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
      pendingSubagents.delete(id);
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
  refreshAdvisors();
  session.setAdvisorEnabled(false);
  advisors.clear();
  for (const advisor of list) {
    advisors.set(advisor.id, advisor);
    emit({
      type: "advisor.state",
      sessionId: boot.sessionId,
      advisorId: advisor.id,
      advisorName: advisor.name,
      state: advisor.enabled ? "idle" : "disabled",
      model: advisor.model,
    });
  }
  return list;
}

/**
 * OMP notes carry their configured advisor name, but no request/revision.
 * A unique SDK roster per immutable review round turns that supported source
 * name into a durable ownership key. Old callbacks retain their OLD key even
 * when cancellation races delivery; they can never target the next request.
 */
function startReviewRound(requestId: string, revision: number, candidate?: string): void {
  refreshAdvisors();
  session.setAdvisorEnabled(false);
  activeReviewNames.clear();
  activeReviewOwner = { requestId, revision };
  unownedReviewNote = false;
  const enabled = [...advisors.values()].filter((advisor) => advisor.enabled);
  const configs = enabled.map((advisor) => {
    const sdkName = `review-${crypto.randomUUID()}`;
    const identity: ReviewerIdentity = {
      requestId,
      revision,
      advisorId: advisor.id,
      advisorName: advisor.name,
    };
    reviewOwners.set(sdkName, identity);
    activeReviewNames.add(sdkName);
    sessionManager.appendCustomEntry("orchestrator.review-owner", { sdkName, ...identity });
    return { ...toOmpAdvisor(advisor), name: sdkName };
  });
  const task = finalizer!.records.get(requestId)?.task;
  session.applyAdvisorConfigs(
    configs as never,
    [
      `Review only request ${requestId}, candidate revision ${revision}. Your findings remain owned by this snapshot even if later primary work appears.`,
      `Original request and intent updates:\n${task?.prompt ?? ""}`,
      candidate === undefined
        ? "This is the working revision; no answer has been submitted yet."
        : `The complete primary-authored candidate under review:\n${candidate}`,
      `Prior findings and primary dispositions:\n${JSON.stringify(task?.findings ?? [])}`,
    ].join("\n\n"),
  );
  session.setAdvisorEnabled(enabled.length > 0);
  session.prepareForHeadlessAdvisorDrain();
  sessionManager.flushSync();
}

if (advisors.size) await applyAdvisors([...advisors.values()]);

// OMP names sessions asynchronously — auto-title from the first prompt,
// /rename, extension renames. Forward every change as a session.title event
// so the sidebar updates live and the supervisor's summary stays current.
(sessionManager as any).onSessionNameChanged?.(() => {
  const name = (sessionManager as any).getSessionName?.();
  if (name) emit({ type: "session.title", sessionId: boot.sessionId, title: String(name) });
});

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
    restoreTasks(entries);
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
function restoreTasks(entries: SessionEntry[]): void {
  reviewOwners.clear();
  const records: StoredTask[] = [];
  for (const entry of entries) {
    if (entry.type === "custom" && entry.customType === TASK_ENTRY_TYPE) {
      records.push(storedTaskSchema.parse(entry.data));
    } else if (entry.type === "custom" && entry.customType === "orchestrator.review-owner") {
      const { sdkName, ...identity } = reviewOwnerSchema.parse(entry.data);
      reviewOwners.set(sdkName, identity);
    }
  }
  finalizer!.restore(records);
  for (const record of finalizer!.records.values()) evidenceTracker.restore(record.task.evidence);
}

/** The queue belongs to user requests, not OMP's same-request follow-up queue. */
async function runQueuedPrompts(): Promise<void> {
  if (ownedRun || stopped) return;
  ownedRun = true;
  try {
    while (promptQueue.length && !stopped) {
      const prompt = promptQueue.shift()!;
      finalizer!.activate(prompt.requestId);
      preexistingJobs.clear();
      for (const job of session.getAsyncJobSnapshot()?.running ?? []) preexistingJobs.add(job.id);
      beginTurn();
      setRunState("queued");
      const startedAt = Date.now();
      let outcome: Extract<RunState, "completed" | "interrupted" | "error"> = "completed";
      try {
        startReviewRound(prompt.requestId, 0);
        if (stopped) break;
        await session.sendCustomMessage(
          {
            customType: "orchestrator.request",
            content: `Active harness requestId: ${prompt.requestId}. Preserve this ID across revisions. At completion call submit_answer with a complete user-facing answer and explicit review dispositions.`,
            display: false,
            attribution: "agent",
            details: { requestId: prompt.requestId },
          },
          { triggerTurn: false },
        );
        if (stopped) break;
        await session.prompt(prompt.text, {
          images: prompt.images.length ? prompt.images : undefined,
        });
        await session.waitForIdle();
        if (!stopped) await finalizer!.finalize();
        if (stopped || finalizer!.current?.phase === "interrupted") outcome = "interrupted";
      } catch (error) {
        outcome = stopped || /abort/i.test(String(error)) ? "interrupted" : "error";
        if (outcome === "error") {
          finalizer!.fail(String((error as Error)?.message ?? error));
          emit({ type: "session.failed", sessionId: boot.sessionId, error: classifyError(error) });
        } else finalizer!.stop();
      } finally {
        flush();
        if (stopped) outcome = "interrupted";
        setRunState(outcome);
        emit({
          type: "session.finished",
          sessionId: boot.sessionId,
          runState: outcome,
          durationMs: Date.now() - startedAt,
        });
        currentTurnId = undefined;
        checkPersisted();
      }
    }
  } finally {
    ownedRun = false;
  }
}

async function handle(req: any): Promise<unknown> {
  const s: any = session;
  // Any host request is activity — the hibernation clock restarts.
  lastActivityMs = Date.now();
  switch (req.type) {
    case "session.prompt": {
      const busy = ownedRun || Boolean(s.isStreaming);
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

      // Auto-title: name the session from its first real prompt (the way
      // Codex and Claude do). OMP gates this itself — already-named sessions,
      // greetings/low-signal input, and PI_NO_TITLE all skip — and applies
      // the result via setSessionName("auto"), which a later user rename
      // overrides. An explicit title from the launch sheet is respected.
      // Never in test mode: the online title model resolves to a REAL
      // provider, and its in-flight request racing shutdown flaked the
      // packaged smoke test's 15s exit window.
      if (!boot.userTitled && process.env.ORCHESTRATOR_TEST_MODE !== "1") {
        try {
          (session as any).maybeStartTitleGeneration?.(String(req.payload.text));
        } catch {
          /* titling must never block or break the prompt */
        }
      }

      const nowBusy = ownedRun || Boolean(s.isStreaming);
      if (nowBusy && req.payload.whenBusy === "reject") throw new Error("Session is busy");
      if (nowBusy && req.payload.whenBusy !== "queue") {
        if (stopped)
          throw new Error(
            "The stopped run is still settling. Start a new request after it settles.",
          );
        finalizer!.steer(promptText);
        session.setAdvisorEnabled(false);
        void s
          .prompt(promptText, {
            streamingBehavior: "steer",
            images: images.length ? images : undefined,
          })
          .catch((error: unknown) => {
            finalizer!.fail(String(error));
            emit({
              type: "session.failed",
              sessionId: boot.sessionId,
              error: classifyError(error),
            });
          });
        return { accepted: true, mode: "steered" };
      }
      if (stopped && nowBusy) throw new Error("The stopped run is still settling.");
      const requestId = finalizer!.create(promptText);
      promptQueue.push({ requestId, text: promptText, images });
      if (!nowBusy) stopped = false;
      void runQueuedPrompts().catch((error) => settleCrash("request queue", error));
      return { accepted: true, mode: nowBusy ? "queued" : "started" };
    }

    case "session.abort": {
      requireCap("abort", "aborting a running turn");
      stopped = true;
      promptQueue.length = 0;
      finalizer!.stop();
      cancelReview?.();
      session.clearQueue({ forInterrupt: true });
      session.setAdvisorEnabled(false);
      const ownerId = session.getAgentId();
      if (ownerId) session.asyncJobManager?.cancelAll({ ownerId }, OMP.USER_INTERRUPT_LABEL);
      session.prepareForHeadlessAdvisorDrain();
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
      await session.abort({ reason: OMP.USER_INTERRUPT_LABEL });
      setRunState("interrupted");
      return { aborted: true };
    }

    case "session.task.retryReview": {
      if (ownedRun || session.isStreaming)
        throw new Error("Wait for the current run to settle before retrying review.");
      ownedRun = true;
      stopped = false;
      const requestId = String(req.payload.requestId);
      try {
        const retry = finalizer!.retry(requestId);
        void retry
          .catch((error) => {
            finalizer!.fail(String(error));
            emit({
              type: "session.failed",
              sessionId: boot.sessionId,
              error: classifyError(error),
            });
          })
          .finally(() => {
            ownedRun = false;
            currentTurnId = undefined;
            setRunState(stopped ? "interrupted" : "completed");
            emit({
              type: "session.finished",
              sessionId: boot.sessionId,
              runState: stopped ? "interrupted" : "completed",
            });
            if (!stopped)
              void runQueuedPrompts().catch((error) => settleCrash("request queue", error));
          });
      } catch (error) {
        ownedRun = false;
        throw error;
      }
      return { accepted: true };
    }

    case "session.evidence.refresh":
      return { evidence: await finalizer!.refreshEvidence(String(req.payload.requestId)) };

    case "session.compact":
      requireCap("compact", "compaction");
      await s.compact();
      emit({ type: "session.compacted", sessionId: boot.sessionId, at: new Date().toISOString() });
      emitContext();
      return { ok: true };

    case "session.rewindPoints": {
      const points = (s.getUserMessagesForBranching?.() ?? []) as Array<{
        entryId: string;
        text: string;
      }>;
      return {
        points: points.map((p) => ({ entryId: String(p.entryId), text: String(p.text ?? "") })),
      };
    }

    case "session.rewind": {
      requireCap("navigateTree", "rewinding the conversation");
      if (ownedRun || s.isStreaming) throw new Error("Stop the run before rewinding.");
      // navigateTree stays in the SAME session file and hands the target
      // message's text back for editing. Conversation-only: files on disk
      // keep whatever state the agent left them in.
      const res = await s.navigateTree(String(req.payload.entryId), { summarize: false });
      if (res?.cancelled) return { cancelled: true };
      // The replay buffer describes a conversation that no longer exists —
      // rebuild it from the now-current branch so the host can rehydrate.
      history.length = 0;
      historyBase = 0;
      try {
        const entries = (sessionManager as any).getBranch?.() ?? [];
        for (const ev of replayEventsFromEntries(boot.sessionId, entries)) history.push(ev);
        restoreTasks(entries);
      } catch (e) {
        err(`post-rewind replay failed: ${String(e)}`);
      }
      const ctx = contextUsageOf(session);
      if (ctx) history.push({ type: "context.update", sessionId: boot.sessionId, context: ctx });
      return {
        cancelled: false,
        editorText: String(res?.editorText ?? res?.selectedText ?? "") || undefined,
      };
    }

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
      requireCap("setModel", "changing the model on a live session");
      const m = resolveModel(String(req.payload.model));
      if (!m) return { ok: false, model: String(req.payload.model) };
      await s.setModel(m);
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
      applyApprovalSettings(mode);
      // A mode change is a real security state change — it goes in the
      // transcript, loudest for the mode that stops asking.
      emit({
        type: "session.notice",
        sessionId: boot.sessionId,
        level: mode === "yolo" ? "warning" : "info",
        message:
          mode === "yolo"
            ? "Approval mode set to Full access — tools run without prompts inside the project; anything outside it still asks."
            : mode === "write"
              ? "Approval mode set to Auto-accept edits — content edits run without prompts; commands, deletes and renames still ask."
              : "Approval mode set to Manual — every gated tool asks first.",
        source: "approval",
      });
      return { ok: true };
    }

    case "session.transcript": {
      const since = Number(req.payload?.sinceSequence ?? 0);
      const start = Math.max(0, since - historyBase);
      return { events: history.slice(start), sequence: historyBase + history.length };
    }

    case "session.advisors.set":
      if (ownedRun) throw new Error("Wait for the task to settle before changing its reviewers.");
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

// Crash handlers are registered at the top of this file, before boot awaits.

// A supervisor kill() lands here as SIGTERM. Dispose the session so MCP/LSP
// child processes are torn down with us instead of being orphaned.
process.on("SIGTERM", () => {
  void disposeAndExit();
});

// Requests run CONCURRENTLY: responses correlate by requestId, and awaiting
// each handler serially meant a stalled MCP reconnect queued session.abort
// and approval answers behind it — Stop did nothing exactly when needed.
function dispatch(req: any): void {
  void (async () => {
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
  })();
}

while (true) {
  const { done, value } = await reader.read();
  if (done) break;
  const { frames, errors } = decoder.push(td.decode(value, { stream: true }));
  for (const msg of errors) err(`frame decode: ${msg}`);
  for (const f of frames) dispatch(f);
}

// stdin EOF: the supervisor went away.
await disposeAndExit();
