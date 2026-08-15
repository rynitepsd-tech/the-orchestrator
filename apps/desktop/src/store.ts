/**
 * Application state.
 *
 * The central rule: React state is a VIEW of engine state, never the runtime
 * itself. Unmounting a session's components must not stop its agent — so
 * transcripts live here, keyed by session id, and are updated by engine events
 * regardless of which session the user is looking at.
 */

import type {
  AdvisorConfig,
  AdvisorSeverity,
  AdvisorState,
  ContextUsage,
  DiscoveredSession,
  EngineErrorPayload,
  EngineStage,
  GitChanges,
  ModelInfo,
  ProductEvent,
  ProjectInfo,
  ProviderInfo,
  ProviderQuota,
  RunState,
  SessionSummary,
  ToolDetail,
  UsageBreakdown,
  UsageRecord,
} from "@orchestrator/protocol";
import { create } from "zustand";
import { loadPrefs, type Prefs, type SessionPreset, savePrefs } from "./lib/prefs";

// ---------------------------------------------------------------------------
// Transcript items — the renderable form of the event stream
// ---------------------------------------------------------------------------

export type TranscriptItem =
  | {
      kind: "user";
      id: string;
      text: string;
      attachments?: Array<{ kind: "image" | "file"; name: string; path?: string }>;
    }
  | { kind: "assistant"; id: string; text: string; thinking: string; streaming: boolean }
  | {
      kind: "tool";
      id: string;
      callId: string;
      name: string;
      args: Record<string, unknown>;
      output: string;
      state: "running" | "ok" | "error";
      error?: string;
      durationMs?: number;
      detail?: ToolDetail;
    }
  | {
      kind: "advisor";
      id: string;
      advisorId: string;
      name: string;
      severity: AdvisorSeverity;
      text: string;
      at?: string;
    }
  | {
      kind: "subagent";
      id: string;
      subagentId: string;
      label: string;
      agent?: string;
      task?: string;
      model?: string;
      state: "running" | "done" | "error";
      toolCalls: number;
      activity?: string;
      currentTool?: string;
      tokens?: number;
      cost?: number;
      durationMs?: number;
      error?: string;
    }
  | {
      kind: "approval";
      id: string;
      approvalId: string;
      toolName: string;
      summary: string;
      detail?: string;
      options: Array<{ id: string; label: string; kind: "allow" | "allow-always" | "deny" }>;
      state: "pending" | "resolved" | "cancelled";
      resolution?: string;
    }
  | {
      kind: "interaction";
      id: string;
      requestId: string;
      extensionName: string;
      ui: Extract<ProductEvent, { type: "extension.ui.request" }>["ui"];
      state: "pending" | "resolved" | "cancelled";
    }
  | { kind: "system"; id: string; text: string; tone: "info" | "warn" | "error" };

export interface SessionView {
  summary: SessionSummary;
  transcript: TranscriptItem[];
  usage?: UsageBreakdown;
  context?: ContextUsage;
  advisors: AdvisorConfig[];
  advisorStates: Record<string, AdvisorState>;
  /** Pending interactions (approvals + extension UI) awaiting the user. */
  pendingInteractions: number;
  error?: EngineErrorPayload;
  /** Set when the worker died; the session can be resumed from persistence. */
  interrupted?: boolean;
}

export type InspectorTab = "changes" | "files" | "usage";
export type MainView = "sessions" | "usage" | "settings";

export interface GlobalUsageState {
  records: UsageRecord[];
  breakdown: UsageBreakdown;
  fetchedAt: number;
}

interface AppState {
  // engine
  engineStage: EngineStage | "offline";
  engineMessage?: string;
  engineError?: EngineErrorPayload;
  engineInfo?: {
    ompVersion: string;
    engineVersion: string;
    arch: string;
    protocolVersion: number;
    agentDir?: string;
  };

  // catalogue
  models: ModelInfo[];
  providers: ProviderInfo[];
  quotas: ProviderQuota[];

  // workspace
  projects: ProjectInfo[];
  discovered: DiscoveredSession[];
  sessions: Record<string, SessionView>;
  order: string[];
  visibleSessionId?: string;
  changes: Record<string, GitChanges>; // keyed by projectId

  // global usage centre
  globalUsage?: GlobalUsageState;

  // local preferences / metadata (persisted to localStorage)
  prefs: Prefs;

  // ui
  mainView: MainView;
  inspectorTab: InspectorTab;
  inspectorOpen: boolean;
  sidebarOpen: boolean;
  paletteOpen: boolean;
  paletteMode: "commands" | "sessions";
  newSessionOpen: boolean;
  quitConfirm?: { running: number };
  /** Session id being renamed via the rename dialog (WKWebView has no prompt()). */
  renameTarget?: string;

  // updater
  updateAvailable?: { version: string; notes?: string };
  updateBusy: boolean;

  // actions
  setEngineStage(stage: EngineStage | "offline", message?: string): void;
  setEngineError(e?: EngineErrorPayload): void;
  setEngineInfo(i: AppState["engineInfo"]): void;
  setCatalogue(models: ModelInfo[], providers: ProviderInfo[]): void;
  setQuotas(q: ProviderQuota[]): void;
  addProject(p: ProjectInfo): void;
  setDiscovered(d: DiscoveredSession[]): void;
  setChanges(projectId: string, c: GitChanges): void;
  setGlobalUsage(u: GlobalUsageState): void;
  addSession(s: SessionSummary, advisors: AdvisorConfig[]): void;
  removeSession(id: string): void;
  /** Drag reorder: move one session next to another in the sidebar. */
  moveSession(dragId: string, targetId: string): void;
  select(id: string): void;
  apply(e: ProductEvent): void;
  hydrateTranscript(sessionId: string, events: ProductEvent[]): void;
  updatePrefs(patch: Partial<Prefs>): void;
  addPreset(p: SessionPreset): void;
  removePreset(name: string): void;
  setMainView(v: MainView): void;
  setInspectorTab(t: InspectorTab): void;
  toggleInspector(): void;
  toggleSidebar(): void;
  setPalette(open: boolean, mode?: "commands" | "sessions"): void;
  setNewSession(open: boolean): void;
  setQuitConfirm(q?: { running: number }): void;
  setRenameTarget(id?: string): void;
  setUpdateAvailable(u?: { version: string; notes?: string }): void;
  setUpdateBusy(busy: boolean): void;
  markAllInterrupted(reason: string): void;
}

let itemSeq = 0;
const nextId = () => `i${++itemSeq}`;

/**
 * Events can outrun the `sessions.create` response (the worker starts emitting
 * the moment it boots). Buffer them briefly and drain on addSession instead of
 * dropping them on the floor.
 */
const pendingEvents = new Map<string, ProductEvent[]>();
const PENDING_CAP = 500;

export const useStore = create<AppState>((set, get) => ({
  engineStage: "starting",
  models: [],
  providers: [],
  quotas: [],
  projects: [],
  discovered: [],
  sessions: {},
  order: [],
  changes: {},
  prefs: loadPrefs(),
  mainView: "sessions",
  inspectorTab: "usage",
  inspectorOpen: true,
  sidebarOpen: true,
  paletteOpen: false,
  paletteMode: "commands",
  newSessionOpen: false,
  updateBusy: false,

  setEngineStage: (engineStage, engineMessage) => set({ engineStage, engineMessage }),
  setEngineError: (engineError) => set({ engineError }),
  setEngineInfo: (engineInfo) => set({ engineInfo }),
  setCatalogue: (models, providers) => set({ models, providers }),
  setQuotas: (quotas) => set({ quotas }),

  addProject: (p) =>
    set((s) => {
      const prefs = {
        ...s.prefs,
        recentProjects: [p.path, ...s.prefs.recentProjects.filter((x) => x !== p.path)].slice(
          0,
          12,
        ),
      };
      savePrefs(prefs);
      return s.projects.some((x) => x.projectId === p.projectId)
        ? { prefs }
        : { projects: [...s.projects, p], prefs };
    }),

  setDiscovered: (discovered) => set({ discovered }),
  setChanges: (projectId, c) => set((s) => ({ changes: { ...s.changes, [projectId]: c } })),
  setGlobalUsage: (globalUsage) => set({ globalUsage }),

  addSession: (summary, advisors) => {
    set((s) => {
      // A resumed session arrives with its path; give it a persisted slot at
      // the end so it doesn't leapfrog rows the user has placed deliberately.
      const path = summary.ompSessionPath;
      const prefs =
        path && !s.prefs.sessionOrder.includes(path)
          ? { ...s.prefs, sessionOrder: [...s.prefs.sessionOrder, path].slice(-400) }
          : s.prefs;
      if (prefs !== s.prefs) savePrefs(prefs);
      return {
        sessions: {
          ...s.sessions,
          [summary.sessionId]: {
            summary,
            transcript: [],
            advisors,
            advisorStates: {},
            pendingInteractions: 0,
          },
        },
        // Newest first: a fresh session belongs at the top of its project group.
        order: [summary.sessionId, ...s.order],
        visibleSessionId: summary.sessionId,
        mainView: "sessions",
        prefs,
      };
    });
    // Drain any events that raced ahead of the create response.
    const buffered = pendingEvents.get(summary.sessionId);
    if (buffered) {
      pendingEvents.delete(summary.sessionId);
      for (const e of buffered) get().apply(e);
    }
  },

  removeSession: (id) =>
    set((s) => {
      const sessions = { ...s.sessions };
      delete sessions[id];
      const order = s.order.filter((x) => x !== id);
      return {
        sessions,
        order,
        // Order is newest-first, so the top row is the natural fallback.
        visibleSessionId: s.visibleSessionId === id ? order[0] : s.visibleSessionId,
      };
    }),

  moveSession: (dragId, targetId) =>
    set((s) => {
      const from = s.order.indexOf(dragId);
      const to = s.order.indexOf(targetId);
      if (from < 0 || to < 0 || from === to) return {};
      const order = [...s.order];
      order.splice(from, 1);
      // Dragging downward lands below the target, upward lands above it.
      const at = order.indexOf(targetId);
      order.splice(from < to ? at + 1 : at, 0, dragId);
      return { order };
    }),

  select: (id) =>
    set((s) => {
      const v = s.sessions[id];
      if (!v) return { visibleSessionId: id, mainView: "sessions" };
      // Selecting a session clears its unread flag. It does NOT touch the
      // engine — background runs continue untouched.
      return {
        visibleSessionId: id,
        mainView: "sessions",
        sessions: { ...s.sessions, [id]: { ...v, summary: { ...v.summary, unread: false } } },
      };
    }),

  setMainView: (mainView) => set({ mainView }),
  setInspectorTab: (inspectorTab) => set({ inspectorTab, inspectorOpen: true }),
  toggleInspector: () => set((s) => ({ inspectorOpen: !s.inspectorOpen })),
  toggleSidebar: () => set((s) => ({ sidebarOpen: !s.sidebarOpen })),
  setPalette: (paletteOpen, paletteMode) =>
    set((s) => ({ paletteOpen, paletteMode: paletteMode ?? s.paletteMode })),
  setNewSession: (newSessionOpen) => set({ newSessionOpen }),
  setQuitConfirm: (quitConfirm) => set({ quitConfirm }),
  setRenameTarget: (renameTarget) => set({ renameTarget }),
  setUpdateAvailable: (updateAvailable) => set({ updateAvailable }),
  setUpdateBusy: (updateBusy) => set({ updateBusy }),

  updatePrefs: (patch) =>
    set((s) => {
      const prefs = { ...s.prefs, ...patch };
      savePrefs(prefs);
      return { prefs };
    }),

  addPreset: (p) =>
    set((s) => {
      const prefs = {
        ...s.prefs,
        presets: [...s.prefs.presets.filter((x) => x.name !== p.name), p],
      };
      savePrefs(prefs);
      return { prefs };
    }),

  removePreset: (name) =>
    set((s) => {
      const prefs = { ...s.prefs, presets: s.prefs.presets.filter((x) => x.name !== name) };
      savePrefs(prefs);
      return { prefs };
    }),

  markAllInterrupted: (reason) =>
    set((s) => {
      const sessions: Record<string, SessionView> = {};
      for (const [id, v] of Object.entries(s.sessions)) {
        const active = !["idle", "completed", "interrupted", "error"].includes(v.summary.runState);
        sessions[id] = active
          ? {
              ...v,
              summary: { ...v.summary, runState: "interrupted" as RunState },
              interrupted: true,
              pendingInteractions: 0,
              transcript: [
                ...v.transcript,
                { kind: "system", id: nextId(), text: reason, tone: "error" },
              ],
            }
          : v;
      }
      return { sessions };
    }),

  hydrateTranscript: (sessionId, events) => {
    const state = get();
    const view = state.sessions[sessionId];
    if (!view) return;
    // Rebuild from scratch: replay the worker's authoritative history.
    let next: SessionView = { ...view, transcript: [], pendingInteractions: 0 };
    for (const e of events) next = reduce(next, e, true);
    // Replay must not resurrect long-settled prompts as pending.
    next = {
      ...next,
      pendingInteractions: next.transcript.filter(
        (i) => (i.kind === "approval" || i.kind === "interaction") && i.state === "pending",
      ).length,
    };
    set({ sessions: { ...state.sessions, [sessionId]: next } });
  },

  apply: (e) => {
    const state = get();
    const view = state.sessions[e.sessionId];
    if (!view) {
      const buf = pendingEvents.get(e.sessionId) ?? [];
      if (buf.length < PENDING_CAP) {
        buf.push(e);
        pendingEvents.set(e.sessionId, buf);
      }
      return;
    }

    const next = reduce(view, e, state.visibleSessionId === e.sessionId);

    // A session persisting for the first time is a fresh creation: claim the
    // top slot in the persisted per-project ordering (resumes already have
    // their path and keep their place).
    if (e.type === "session.persisted" && !state.prefs.sessionOrder.includes(e.ompSessionPath)) {
      const prefs = {
        ...state.prefs,
        sessionOrder: [e.ompSessionPath, ...state.prefs.sessionOrder].slice(0, 400),
      };
      savePrefs(prefs);
      set({ prefs });
    }

    if (next === view) return;
    set({ sessions: { ...state.sessions, [e.sessionId]: next } });
  },
}));

// ---------------------------------------------------------------------------
// Event reducer
// ---------------------------------------------------------------------------

/** Find the LAST transcript index matching a predicate. */
function lastIndex(t: TranscriptItem[], pred: (i: TranscriptItem) => boolean): number {
  for (let i = t.length - 1; i >= 0; i--) if (pred(t[i])) return i;
  return -1;
}

function reduce(v: SessionView, e: ProductEvent, visible: boolean): SessionView {
  const t = v.transcript;

  switch (e.type) {
    case "session.state":
      return {
        ...v,
        summary: {
          ...v.summary,
          runState: e.runState,
          activity: e.activity,
          lastActivityAt: new Date().toISOString(),
        },
      };

    case "session.title":
      return { ...v, summary: { ...v.summary, title: e.title } };

    case "user.message": {
      // The UI adds an optimistic bubble at send time (id `u<timestamp>`), and
      // the worker echoes the same message when OMP starts processing it
      // (id `<session>:u<seq>`). Reconcile the echo into the optimistic bubble
      // instead of rendering the message twice. Replay ids (`:ru<seq>`) never
      // match the optimistic pattern, so history is unaffected.
      const echoOf = lastIndex(
        t,
        (x) => x.kind === "user" && /^u\d+$/.test(x.id) && x.text === e.text,
      );
      if (echoOf >= 0) {
        const copy = [...t];
        copy[echoOf] = { ...copy[echoOf], id: e.messageId } as TranscriptItem;
        return { ...v, transcript: copy };
      }
      return {
        ...v,
        summary: { ...v.summary, messageCount: v.summary.messageCount + 1 },
        transcript: [
          ...t,
          { kind: "user", id: e.messageId, text: e.text, attachments: e.attachments },
        ],
      };
    }

    case "assistant.text":
    case "assistant.thinking": {
      const isText = e.type === "assistant.text";
      // A tool call can interleave mid-message; append into the LAST bubble
      // with this message id wherever it sits, not only at the tail —
      // otherwise one upstream message splits into duplicate bubbles.
      const idx = lastIndex(t, (x) => x.kind === "assistant" && x.id === e.messageId);
      if (idx >= 0) {
        const cur = t[idx] as Extract<TranscriptItem, { kind: "assistant" }>;
        const updated: TranscriptItem = {
          ...cur,
          text: isText ? cur.text + e.delta : cur.text,
          thinking: isText ? cur.thinking : cur.thinking + e.delta,
          streaming: true,
        };
        const copy = [...t];
        copy[idx] = updated;
        return { ...v, transcript: copy };
      }
      return {
        ...v,
        transcript: [
          ...t,
          {
            kind: "assistant",
            id: e.messageId,
            text: isText ? e.delta : "",
            thinking: isText ? "" : e.delta,
            streaming: true,
          },
        ],
      };
    }

    case "assistant.message.end": {
      const idx = lastIndex(t, (x) => x.kind === "assistant" && x.id === e.messageId);
      if (idx < 0) {
        if (!e.text && !e.thinking) return v;
        return {
          ...v,
          transcript: [
            ...t,
            {
              kind: "assistant",
              id: e.messageId,
              text: e.text,
              thinking: e.thinking ?? "",
              streaming: false,
            },
          ],
        };
      }
      const copy = [...t];
      // The final text is authoritative over accumulated deltas.
      copy[idx] = {
        kind: "assistant",
        id: e.messageId,
        text: e.text,
        thinking: e.thinking ?? (t[idx] as any).thinking ?? "",
        streaming: false,
      };
      return { ...v, transcript: copy };
    }

    case "tool.start":
      return {
        ...v,
        transcript: [
          ...t,
          {
            kind: "tool",
            id: `${e.callId}:${t.length}`,
            callId: e.callId,
            name: e.toolName,
            args: e.args,
            output: "",
            state: "running",
          },
        ],
      };

    case "tool.update": {
      const idx = lastIndex(t, (x) => x.kind === "tool" && x.callId === e.callId);
      if (idx < 0) return v;
      const copy = [...t];
      const cur = copy[idx] as Extract<TranscriptItem, { kind: "tool" }>;
      copy[idx] = { ...cur, output: cur.output + (e.outputDelta ?? "") };
      return { ...v, transcript: copy };
    }

    case "tool.end": {
      const idx = lastIndex(t, (x) => x.kind === "tool" && x.callId === e.callId);
      if (idx < 0) return v;
      const copy = [...t];
      const cur = copy[idx] as Extract<TranscriptItem, { kind: "tool" }>;
      copy[idx] = {
        ...cur,
        state: e.ok ? "ok" : "error",
        output: e.output ?? cur.output,
        error: e.error,
        durationMs: e.durationMs,
        detail: e.detail,
      };
      return { ...v, transcript: copy };
    }

    case "approval.request":
      return {
        ...v,
        pendingInteractions: v.pendingInteractions + 1,
        transcript: [
          ...t,
          {
            kind: "approval",
            id: e.approvalId,
            approvalId: e.approvalId,
            toolName: e.toolName,
            summary: e.summary,
            detail: e.detail,
            options: e.options,
            state: "pending",
          },
        ],
      };

    case "approval.resolved": {
      // Resolves an approval card OR an extension-interaction card (the UI
      // reuses this event shape to settle interactions it just answered).
      const idx = lastIndex(
        t,
        (x) =>
          (x.kind === "approval" && x.approvalId === e.approvalId) ||
          (x.kind === "interaction" && x.requestId === e.approvalId),
      );
      if (idx < 0) return v;
      const copy = [...t];
      const cur = copy[idx] as Extract<TranscriptItem, { kind: "approval" | "interaction" }>;
      if (cur.state !== "pending") return v;
      const state = e.optionId === "cancelled" ? ("cancelled" as const) : ("resolved" as const);
      copy[idx] =
        cur.kind === "approval" ? { ...cur, state, resolution: e.optionId } : { ...cur, state };
      return {
        ...v,
        pendingInteractions: Math.max(0, v.pendingInteractions - 1),
        transcript: copy,
      };
    }

    case "extension.ui.request": {
      // Notifications are informational — no response expected, not pending.
      if (e.ui.kind === "notification") {
        return {
          ...v,
          transcript: [
            ...t,
            {
              kind: "system",
              id: e.requestId,
              text: `${e.extensionName === "extension" ? "" : `${e.extensionName}: `}${e.ui.message}`,
              tone: e.ui.level === "error" ? "error" : e.ui.level === "warn" ? "warn" : "info",
            },
          ],
        };
      }
      return {
        ...v,
        pendingInteractions: v.pendingInteractions + 1,
        transcript: [
          ...t,
          {
            kind: "interaction",
            id: e.requestId,
            requestId: e.requestId,
            extensionName: e.extensionName,
            ui: e.ui,
            state: "pending",
          },
        ],
      };
    }

    case "advisor.message":
      return {
        ...v,
        transcript: [
          ...t,
          {
            kind: "advisor",
            id: e.messageId,
            advisorId: e.advisorId,
            name: e.advisorName,
            severity: e.severity,
            text: e.text,
            at: e.at,
          },
        ],
      };

    case "advisor.state":
      return { ...v, advisorStates: { ...v.advisorStates, [e.advisorId]: e.state } };

    case "advisor.failed":
      return {
        ...v,
        transcript: [
          ...t,
          {
            kind: "system",
            id: nextId(),
            text: `${e.advisorName} advisor: ${e.error.message}${
              e.primaryUnaffected ? " The primary agent is still running." : ""
            }`,
            tone: "warn",
          },
        ],
      };

    case "subagent.start":
      return {
        ...v,
        transcript: [
          ...t,
          {
            kind: "subagent",
            id: e.subagentId,
            subagentId: e.subagentId,
            label: e.label,
            agent: e.agent,
            task: e.task,
            model: e.model,
            state: "running",
            toolCalls: 0,
          },
        ],
      };

    case "subagent.update":
    case "subagent.end": {
      const idx = lastIndex(t, (x) => x.kind === "subagent" && x.subagentId === e.subagentId);
      if (idx < 0) return v;
      const copy = [...t];
      const cur = copy[idx] as Extract<TranscriptItem, { kind: "subagent" }>;
      copy[idx] =
        e.type === "subagent.end"
          ? {
              ...cur,
              state: e.ok ? "done" : "error",
              toolCalls: e.toolCalls,
              durationMs: e.durationMs,
              error: e.error,
              activity: undefined,
              currentTool: undefined,
            }
          : {
              ...cur,
              toolCalls: e.toolCalls,
              activity: e.activity,
              currentTool: e.currentTool,
              tokens: e.tokens ?? cur.tokens,
              cost: e.cost ?? cur.cost,
            };
      return { ...v, transcript: copy };
    }

    case "usage.update":
      return { ...v, usage: e.breakdown };

    case "usage.records":
      return v; // engine-side index concern; sessions render breakdowns

    case "context.update":
      return { ...v, context: e.context };

    case "session.model":
      return {
        ...v,
        summary: { ...v.summary, model: e.model, thinkingLevel: e.thinkingLevel },
        transcript: [
          ...t,
          {
            kind: "system",
            id: nextId(),
            text: e.automatic
              ? `Model changed to ${e.model}${e.reason ? ` — ${e.reason}` : ""}`
              : `Model changed to ${e.model}`,
            tone: e.automatic ? "warn" : "info",
          },
        ],
      };

    case "session.fastMode":
      return { ...v, summary: { ...v.summary, fastMode: e.enabled } };

    case "session.compacted":
      return {
        ...v,
        transcript: [
          ...t,
          { kind: "system", id: nextId(), text: "Context compacted", tone: "info" },
        ],
      };

    case "session.persisted":
      return {
        ...v,
        summary: {
          ...v.summary,
          ompSessionPath: e.ompSessionPath,
          ompSessionId: e.ompSessionId,
        },
      };

    case "session.failed":
      return {
        ...v,
        error: e.error,
        interrupted: e.error.kind === "engine" ? true : v.interrupted,
        transcript: [...t, { kind: "system", id: nextId(), text: e.error.message, tone: "error" }],
      };

    case "session.finished": {
      // A clear end-of-turn marker in the transcript, honest about advisors:
      // "done" with a reviewer still reading is not done yet.
      const reviewing = Object.values(v.advisorStates).some((st) => st === "reviewing");
      const marker: TranscriptItem | null =
        e.runState === "completed"
          ? {
              kind: "system",
              id: nextId(),
              tone: "info",
              text: reviewing
                ? "✓ Turn finished — advisors are still reviewing and may add notes"
                : "✓ Done",
            }
          : null;
      return {
        ...v,
        transcript: marker ? [...v.transcript, marker] : v.transcript,
        summary: {
          ...v.summary,
          runState: e.runState,
          activity: undefined,
          // Unread only matters for a session the user is not looking at.
          unread: !visible,
        },
      };
    }

    default:
      return v;
  }
}

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

/** Format a token count compactly: 84_213 -> "84.2k". */
export function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

/** Plain count formatting (events, files) — never the token formatter. */
export function fmtCount(n: number): string {
  return n.toLocaleString("en-US");
}

export function fmtCost(n?: number): string | null {
  if (typeof n !== "number" || !Number.isFinite(n)) return null;
  if (n < 0.01 && n > 0) return "<$0.01";
  return `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export function fmtDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const m = Math.floor(ms / 60_000);
  const s = Math.round((ms % 60_000) / 1000);
  return `${m}m ${s}s`;
}

/** Human label for a sidebar/session run state. */
export function runStateLabel(s: RunState, activity?: string): string {
  switch (s) {
    case "idle":
      return "Idle";
    case "queued":
      return "Queued";
    case "starting":
      return "Starting";
    case "thinking":
      return "Thinking";
    case "streaming":
      return "Responding";
    case "tool":
      return activity ? `Running ${activity}` : "Running tool";
    case "waiting":
      return "Needs input";
    case "stopping":
      return "Stopping";
    case "completed":
      return "Finished";
    case "interrupted":
      return "Interrupted";
    case "error":
      return "Failed";
  }
}

export function isActive(s: RunState): boolean {
  return !["idle", "completed", "interrupted", "error"].includes(s);
}

/** Short display name for a provider-qualified model key. */
export function modelBasename(model?: string): string {
  if (!model) return "OMP default";
  const slash = model.indexOf("/");
  return slash >= 0 ? model.slice(slash + 1) : model;
}
