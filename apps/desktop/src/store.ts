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
  ApprovalMode,
  ContextUsage,
  DiscoveredSession,
  EngineErrorPayload,
  EngineStage,
  GitChanges,
  ModelInfo,
  OmpToolResult,
  ProductEvent,
  ProjectInfo,
  ProviderInfo,
  ProviderQuota,
  RunState,
  SessionSummary,
  TodoTaskItem,
  ToolDetail,
  UsageBreakdown,
  UsageRecord,
} from "@orchestrator/protocol";
import { create } from "zustand";
import { loadPrefs, type Prefs, type SessionPreset, savePrefs } from "./lib/prefs";

// ---------------------------------------------------------------------------
// Transcript items — the renderable form of the event stream
// ---------------------------------------------------------------------------

export type TranscriptItem = TranscriptItemBase & {
  /**
   * Stable turn identity stamped by the worker (see protocol EventBase).
   * The transcript keys its work groups by this, so a group's identity no
   * longer shifts when the render window slides. Absent on old replays.
   */
  turnId?: string;
};

type TranscriptItemBase =
  | {
      kind: "user";
      id: string;
      text: string;
      attachments?: Array<{ kind: "image" | "file"; name: string; path?: string }>;
      /**
       * Pickup status for messages sent into a RUNNING turn (steer/queue):
       * "unread" until OMP actually injects the message into the conversation
       * (the worker echo), then "read". Absent on ordinary turn-starting
       * messages and on replayed history.
       */
      pickup?: "unread" | "read";
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
      /** Raw OMP result for the <omp-tool-view> renderer. */
      ompResult?: OmpToolResult;
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
  | { kind: "system"; id: string; text: string; tone: "info" | "warn" | "error" }
  | {
      /**
       * End-of-turn marker. `pending` while advisors are still reviewing —
       * the turn is only announced as finished once they're done. Also the
       * boundary the transcript condenses work groups at.
       */
      kind: "turn-end";
      id: string;
      durationMs?: number;
      pending: boolean;
      /**
       * When the turn finished (ISO). Stamped at event receipt — live events
       * only; replayed history builds no turn-end markers, so a stale stamp
       * can't masquerade as recent.
       */
      at?: string;
    };

export interface SessionView {
  summary: SessionSummary;
  transcript: TranscriptItem[];
  usage?: UsageBreakdown;
  context?: ContextUsage;
  advisors: AdvisorConfig[];
  advisorStates: Record<string, AdvisorState>;
  /** Pending interactions (approvals + extension UI) awaiting the user. */
  pendingInteractions: number;
  /** The agent's live todo list (full snapshot from the todo tool). */
  todoPhases?: Array<{ name: string; tasks: TodoTaskItem[] }>;
  /** Name of the preset this session runs with (client-side bookkeeping). */
  presetName?: string;
  /** Approval mode the session runs with; undefined = always-ask. */
  approvalMode?: ApprovalMode;
  error?: EngineErrorPayload;
  /** Set when the worker died; the session can be resumed from persistence. */
  interrupted?: boolean;
}

/**
 * A half-typed prompt (and its attachments) parked while the user works in
 * another session. Keyed by session id, in-memory only — surviving a switch
 * is the point; surviving a relaunch is not (stale drafts resurrecting days
 * later would be worse than the blank composer).
 */
export interface ComposerDraft {
  text: string;
  attachments: Array<{ kind: "image" | "file"; name: string; path: string }>;
}

export type InspectorTab = "changes" | "files" | "usage" | "preview";

/** A file opened for preview in the inspector, from a clicked file link. */
export interface FilePreview {
  /** Absolute (or ~-prefixed) path of the file. */
  path: string;
  /** Project root, used for the breadcrumb display when the file is inside it. */
  projectPath?: string;
  /** 1-based line to highlight and scroll to. */
  line?: number;
}
export type MainView = "sessions" | "usage" | "settings" | "inbox";

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
  /** Live sign-in guidance from the engine (device codes, browser hand-off). */
  authNotice?: string;
  /** A question from the engine's login flow awaiting a typed answer. */
  authPrompt?: {
    promptId: string;
    provider: string;
    message: string;
    placeholder?: string;
    allowEmpty?: boolean;
  };
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
  /** Parked composer drafts, keyed by session id (see ComposerDraft). */
  drafts: Record<string, ComposerDraft>;

  // global usage centre
  globalUsage?: GlobalUsageState;

  // local preferences / metadata (persisted to localStorage)
  prefs: Prefs;

  // ui
  mainView: MainView;
  inspectorTab: InspectorTab;
  inspectorOpen: boolean;
  /** File shown in the inspector's preview tab (set by clicking a file link). */
  filePreview?: FilePreview;
  sidebarOpen: boolean;
  paletteOpen: boolean;
  paletteMode: "commands" | "sessions";
  newSessionOpen: boolean;
  quitConfirm?: { running: number };
  /** Session id being renamed via the rename dialog (WKWebView has no prompt()). */
  renameTarget?: string;
  /** Project path being renamed (display alias only). */
  renameProjectTarget?: string;
  /** Text handed to the composer (e.g. a rewound message returned for editing). */
  composerPrefill?: { sessionId: string; text: string };

  // updater
  updateAvailable?: { version: string; notes?: string };
  updateBusy: boolean;

  // actions
  setEngineStage(stage: EngineStage | "offline", message?: string): void;
  setEngineError(e?: EngineErrorPayload): void;
  setAuthNotice(notice?: string): void;
  setAuthPrompt(prompt?: AppState["authPrompt"]): void;
  setEngineInfo(i: AppState["engineInfo"]): void;
  setCatalogue(models: ModelInfo[], providers: ProviderInfo[]): void;
  setQuotas(q: ProviderQuota[]): void;
  addProject(p: ProjectInfo): void;
  setDiscovered(d: DiscoveredSession[]): void;
  setChanges(projectId: string, c: GitChanges): void;
  setGlobalUsage(u: GlobalUsageState): void;
  addSession(s: SessionSummary, advisors: AdvisorConfig[], opts?: { resumed?: boolean }): void;
  removeSession(id: string): void;
  /** Drag reorder: move one session next to another in the sidebar. */
  moveSession(dragId: string, targetId: string): void;
  select(id: string): void;
  /** Clear a session's unread flag without navigating to it. */
  markRead(id: string): void;
  apply(e: ProductEvent): void;
  hydrateTranscript(sessionId: string, events: ProductEvent[]): void;
  updatePrefs(patch: Partial<Prefs>): void;
  addPreset(p: SessionPreset): void;
  removePreset(name: string): void;
  setMainView(v: MainView): void;
  setInspectorTab(t: InspectorTab): void;
  toggleInspector(): void;
  /** Open a file in the inspector preview pane (opens the inspector if closed). */
  openFilePreview(p: FilePreview): void;
  closeFilePreview(): void;
  toggleSidebar(): void;
  setPalette(open: boolean, mode?: "commands" | "sessions"): void;
  setNewSession(open: boolean): void;
  setQuitConfirm(q?: { running: number }): void;
  setRenameTarget(id?: string): void;
  setRenameProjectTarget(path?: string): void;
  setComposerPrefill(p?: { sessionId: string; text: string }): void;
  /** Show the no-session home screen. */
  goHome(): void;
  /** Record which preset a session runs with (persisted by session path). */
  setSessionPreset(id: string, presetName?: string): void;
  /** Replace a session's advisor roster after the worker confirmed it. */
  setSessionAdvisors(id: string, advisors: AdvisorConfig[]): void;
  /** Record a session's approval mode (persisted by session path). */
  setSessionApproval(id: string, mode: ApprovalMode): void;
  /** Seed a session's usage breakdown fetched from the engine index. */
  setSessionUsage(id: string, breakdown: UsageBreakdown): void;
  setUpdateAvailable(u?: { version: string; notes?: string }): void;
  setUpdateBusy(busy: boolean): void;
  markAllInterrupted(reason: string): void;
  /** Roll back an optimistic transcript item (e.g. a send that failed). */
  removeTranscriptItem(sessionId: string, itemId: string): void;
  /** Park or update a session's composer draft; empty drafts are dropped. */
  setDraft(sessionId: string, draft: ComposerDraft): void;
  clearDraft(sessionId: string): void;
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
  drafts: {},
  prefs: loadPrefs(),
  mainView: "sessions",
  inspectorTab: "usage",
  // Closed by default — clicking a file link or the toggle opens it.
  inspectorOpen: false,
  sidebarOpen: true,
  paletteOpen: false,
  paletteMode: "commands",
  newSessionOpen: false,
  updateBusy: false,

  setEngineStage: (engineStage, engineMessage) => set({ engineStage, engineMessage }),
  setEngineError: (engineError) => set({ engineError }),
  setAuthNotice: (authNotice) => set({ authNotice }),
  setAuthPrompt: (authPrompt) => set({ authPrompt }),
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

  addSession: (summary, advisors, opts) => {
    set((s) => {
      // Brand-new sessions persist before the create response returns, so they
      // arrive here with a path too — they claim the TOP slot of their project
      // group. Only an explicit resume of a never-ordered session goes to the
      // end, so it doesn't leapfrog rows the user has placed deliberately.
      const path = summary.ompSessionPath;
      const prefs =
        path && !s.prefs.sessionOrder.includes(path)
          ? {
              ...s.prefs,
              sessionOrder: opts?.resumed
                ? [...s.prefs.sessionOrder, path].slice(-400)
                : [path, ...s.prefs.sessionOrder].slice(0, 400),
            }
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
            // Resumed sessions remember which preset and approval mode
            // they run with.
            presetName: path ? s.prefs.sessionPresetByPath[path] : undefined,
            approvalMode: path
              ? (s.prefs.sessionApprovalByPath[path] as ApprovalMode | undefined)
              : undefined,
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
      const drafts = { ...s.drafts };
      delete drafts[id];
      return {
        sessions,
        order,
        drafts,
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

  markRead: (id) =>
    set((s) => {
      const v = s.sessions[id];
      if (!v?.summary.unread) return {};
      return {
        sessions: { ...s.sessions, [id]: { ...v, summary: { ...v.summary, unread: false } } },
      };
    }),

  setMainView: (mainView) => set({ mainView }),
  setInspectorTab: (inspectorTab) => set({ inspectorTab, inspectorOpen: true }),
  toggleInspector: () => set((s) => ({ inspectorOpen: !s.inspectorOpen })),
  openFilePreview: (filePreview) =>
    set({ filePreview, inspectorTab: "preview", inspectorOpen: true }),
  closeFilePreview: () =>
    set((s) => ({
      filePreview: undefined,
      inspectorTab: s.inspectorTab === "preview" ? "usage" : s.inspectorTab,
    })),
  toggleSidebar: () => set((s) => ({ sidebarOpen: !s.sidebarOpen })),
  setPalette: (paletteOpen, paletteMode) =>
    set((s) => ({ paletteOpen, paletteMode: paletteMode ?? s.paletteMode })),
  setNewSession: (newSessionOpen) => set({ newSessionOpen }),
  setQuitConfirm: (quitConfirm) => set({ quitConfirm }),
  setRenameTarget: (renameTarget) => set({ renameTarget }),
  setRenameProjectTarget: (renameProjectTarget) => set({ renameProjectTarget }),
  setComposerPrefill: (composerPrefill) => set({ composerPrefill }),

  goHome: () => set({ visibleSessionId: undefined, mainView: "sessions" }),

  setSessionPreset: (id, presetName) =>
    set((s) => {
      const v = s.sessions[id];
      if (!v) return {};
      // Persist by session path so the label survives relaunches.
      const path = v.summary.ompSessionPath;
      let prefs = s.prefs;
      if (path) {
        const map = { ...s.prefs.sessionPresetByPath };
        if (presetName) map[path] = presetName;
        else delete map[path];
        prefs = { ...s.prefs, sessionPresetByPath: map };
        savePrefs(prefs);
      }
      return { sessions: { ...s.sessions, [id]: { ...v, presetName } }, prefs };
    }),

  setSessionAdvisors: (id, advisors) =>
    set((s) => {
      const v = s.sessions[id];
      if (!v) return {};
      // Drop states for advisors no longer in the roster: a removed advisor
      // stuck at "reviewing" would keep the whole session looking busy
      // (advisorsReviewing scans values, not the current roster).
      const ids = new Set(advisors.map((a) => a.id));
      const advisorStates = Object.fromEntries(
        Object.entries(v.advisorStates).filter(([advisorId]) => ids.has(advisorId)),
      );
      return { sessions: { ...s.sessions, [id]: { ...v, advisors, advisorStates } } };
    }),

  setSessionApproval: (id, mode) =>
    set((s) => {
      const v = s.sessions[id];
      if (!v) return {};
      const path = v.summary.ompSessionPath;
      let prefs = s.prefs;
      if (path) {
        prefs = {
          ...s.prefs,
          sessionApprovalByPath: { ...s.prefs.sessionApprovalByPath, [path]: mode },
        };
        savePrefs(prefs);
      }
      return { sessions: { ...s.sessions, [id]: { ...v, approvalMode: mode } }, prefs };
    }),

  setSessionUsage: (id, breakdown) =>
    set((s) => {
      const v = s.sessions[id];
      // Live events are authoritative; this only fills an empty panel.
      if (!v || v.usage) return {};
      return { sessions: { ...s.sessions, [id]: { ...v, usage: breakdown } } };
    }),
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
      // Same-name saves replace IN PLACE: the default preset falls back to
      // presets[0], so filter-then-append silently changed which preset every
      // future launch used.
      const at = s.prefs.presets.findIndex((x) => x.name === p.name);
      const presets =
        at >= 0 ? s.prefs.presets.map((x, i) => (i === at ? p : x)) : [...s.prefs.presets, p];
      const prefs = { ...s.prefs, presets };
      savePrefs(prefs);
      return { prefs };
    }),

  removePreset: (name) =>
    set((s) => {
      const prefs = { ...s.prefs, presets: s.prefs.presets.filter((x) => x.name !== name) };
      savePrefs(prefs);
      return { prefs };
    }),

  setDraft: (sessionId, draft) =>
    set((s) => {
      if (!draft.text && draft.attachments.length === 0) {
        if (!s.drafts[sessionId]) return {};
        const drafts = { ...s.drafts };
        delete drafts[sessionId];
        return { drafts };
      }
      return { drafts: { ...s.drafts, [sessionId]: draft } };
    }),

  clearDraft: (sessionId) =>
    set((s) => {
      if (!s.drafts[sessionId]) return {};
      const drafts = { ...s.drafts };
      delete drafts[sessionId];
      return { drafts };
    }),

  removeTranscriptItem: (sessionId, itemId) =>
    set((s) => {
      const v = s.sessions[sessionId];
      if (!v) return {};
      const transcript = v.transcript.filter((i) => i.id !== itemId);
      if (transcript.length === v.transcript.length) return {};
      return { sessions: { ...s.sessions, [sessionId]: { ...v, transcript } } };
    }),

  markAllInterrupted: (reason) =>
    set((s) => {
      const sessions: Record<string, SessionView> = {};
      for (const [id, v] of Object.entries(s.sessions)) {
        const active = isActive(v.summary.runState);
        // A dead worker sends no more events — settle EVERYTHING still
        // spinning: pending turn-end markers, running tool cards, running
        // subagents. No tool.end will ever arrive for them.
        const needsSettle = v.transcript.some(
          (i) =>
            (i.kind === "turn-end" && i.pending) ||
            (i.kind === "tool" && i.state === "running") ||
            (i.kind === "subagent" && i.state === "running"),
        );
        const settled = needsSettle
          ? v.transcript.map((i) => {
              if (i.kind === "turn-end" && i.pending) return { ...i, pending: false };
              if (i.kind === "tool" && i.state === "running") {
                return { ...i, state: "error" as const, error: "Interrupted." };
              }
              if (i.kind === "subagent" && i.state === "running") {
                return { ...i, state: "error" as const, error: "Interrupted." };
              }
              return i;
            })
          : v.transcript;
        sessions[id] = active
          ? {
              ...v,
              summary: { ...v.summary, runState: "interrupted" as RunState },
              interrupted: true,
              pendingInteractions: 0,
              transcript: [
                ...settled,
                { kind: "system", id: nextId(), text: reason, tone: "error" },
              ],
            }
          : settled !== v.transcript
            ? { ...v, transcript: settled }
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

    // "Visible" for unread purposes means actually watched: the right session
    // AND a focused window — a finish while the app is ⌘-Tabbed away must
    // still mark unread (and notify).
    const next = reduce(view, e, state.visibleSessionId === e.sessionId && document.hasFocus());

    // A session persisting for the first time is a fresh creation: claim the
    // top slot in the persisted per-project ordering (resumes already have
    // their path and keep their place).
    if (e.type === "session.persisted") {
      let prefs = state.prefs;
      if (!prefs.sessionOrder.includes(e.ompSessionPath)) {
        prefs = {
          ...prefs,
          sessionOrder: [e.ompSessionPath, ...prefs.sessionOrder].slice(0, 400),
        };
      }
      // A preset chosen before the session had a path gets persisted now.
      if (view.presetName && prefs.sessionPresetByPath[e.ompSessionPath] !== view.presetName) {
        prefs = {
          ...prefs,
          sessionPresetByPath: {
            ...prefs.sessionPresetByPath,
            [e.ompSessionPath]: view.presetName,
          },
        };
      }
      // Same for an approval mode chosen pre-persistence.
      if (
        view.approvalMode &&
        prefs.sessionApprovalByPath[e.ompSessionPath] !== view.approvalMode
      ) {
        prefs = {
          ...prefs,
          sessionApprovalByPath: {
            ...prefs.sessionApprovalByPath,
            [e.ompSessionPath]: view.approvalMode,
          },
        };
      }
      if (prefs !== state.prefs) {
        savePrefs(prefs);
        set({ prefs });
      }
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

/**
 * Stamp the event's turnId onto items the reduction appended. Items are only
 * ever appended at the tail or updated in place (which preserves fields), so
 * "new" = "index at or past the previous length".
 */
function stampTurn(prev: SessionView, next: SessionView, e: ProductEvent): SessionView {
  const turnId = (e as { turnId?: string }).turnId;
  if (!turnId || next === prev || next.transcript === prev.transcript) return next;
  const base = prev.transcript.length;
  if (next.transcript.length <= base) return next;
  const transcript = next.transcript.map((it, i) =>
    i >= base && !it.turnId ? { ...it, turnId } : it,
  );
  return { ...next, transcript };
}

function reduce(v: SessionView, e: ProductEvent, visible: boolean): SessionView {
  return stampTurn(v, reduceInner(v, e, visible), e);
}

function reduceInner(v: SessionView, e: ProductEvent, visible: boolean): SessionView {
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
      // Hydration and the live stream can race — the same event may be
      // applied twice (rebuild included it, then the in-flight copy lands).
      // Events carry ids; applying one twice must be a no-op.
      if (t.some((x) => x.id === e.messageId)) return v;
      // The UI adds an optimistic bubble at send time (id `u<timestamp>`), and
      // the worker echoes the same message when OMP picks it up
      // (id `<session>:u<seq>`). Reconcile the echo into the optimistic bubble
      // instead of rendering the message twice. Replay ids (`:ru<seq>`) never
      // match the optimistic pattern, so history is unaffected.
      const echoOf = lastIndex(
        t,
        (x) => x.kind === "user" && /^u\d+$/.test(x.id) && x.text === e.text,
      );
      if (echoOf >= 0) {
        const copy = [...t];
        const cur = copy[echoOf] as Extract<TranscriptItem, { kind: "user" }>;
        // The echo IS the pickup: OMP injected the message into the
        // conversation, so an "unread" mid-turn send flips to "read".
        copy[echoOf] = { ...cur, id: e.messageId, pickup: cur.pickup ? "read" : undefined };
        return { ...v, transcript: copy };
      }
      return {
        ...v,
        summary: { ...v.summary, messageCount: v.summary.messageCount + 1 },
        transcript: [
          ...t,
          {
            kind: "user",
            id: e.messageId,
            text: e.text,
            attachments: e.attachments,
            // An optimistic bubble (id `u<timestamp>`) sent while a turn is
            // running has no guaranteed pickup moment — show "unread" until
            // the worker echo proves the agent saw it. "starting" is excluded:
            // that's a fresh session's first message, not a mid-turn send.
            pickup:
              /^u\d+$/.test(e.messageId) &&
              isActive(v.summary.runState) &&
              v.summary.runState !== "starting"
                ? "unread"
                : undefined,
          },
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

    case "tool.start": {
      // Idempotent by callId: hydrate/live races re-apply the same start,
      // which used to leave a phantom twin card stuck "running" forever.
      if (t.some((x) => x.kind === "tool" && x.callId === e.callId)) return v;
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
    }

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
        ompResult: e.ompResult,
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

    case "advisor.state": {
      const advisorStates = { ...v.advisorStates, [e.advisorId]: e.state };
      // The last reviewer settling (done, failed, paused…) is what actually
      // ends the turn: finalize any end-of-turn marker held back for review.
      const reviewing = Object.values(advisorStates).some((st) => st === "reviewing");
      let transcript = v.transcript;
      if (!reviewing && transcript.some((i) => i.kind === "turn-end" && i.pending)) {
        transcript = transcript.map((i) =>
          i.kind === "turn-end" && i.pending ? { ...i, pending: false } : i,
        );
      } else if (reviewing && !isActive(v.summary.runState)) {
        // A review can start a beat AFTER session.finished landed; a marker
        // already announced as finished for the current turn goes back to
        // pending (never one an earlier turn has moved past).
        const idx = lastIndex(transcript, (i) => i.kind === "turn-end");
        const cur =
          idx >= 0 ? (transcript[idx] as Extract<TranscriptItem, { kind: "turn-end" }>) : null;
        if (cur && !cur.pending && !transcript.slice(idx + 1).some((i) => i.kind === "user")) {
          const copy = [...transcript];
          copy[idx] = { ...cur, pending: true };
          transcript = copy;
        }
      }
      return { ...v, advisorStates, transcript };
    }

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

    case "todo.update":
      return { ...v, todoPhases: e.phases };

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

    case "session.hibernated":
      // The worker parked itself to reclaim memory. Transcript stays; the
      // next prompt resumes from the persisted file transparently (App).
      return {
        ...v,
        summary: {
          ...v.summary,
          runState: "hibernated",
          activity: undefined,
          ompSessionPath: e.ompSessionPath || v.summary.ompSessionPath,
        },
        transcript: [
          ...t,
          {
            kind: "system",
            id: nextId(),
            text: "Session hibernated to free memory — it wakes on your next message.",
            tone: "info",
          },
        ],
      };

    case "session.failed":
      return {
        ...v,
        error: e.error,
        interrupted: e.error.kind === "engine" ? true : v.interrupted,
        transcript: [...t, { kind: "system", id: nextId(), text: e.error.message, tone: "error" }],
      };

    case "session.notice": {
      // Runtime notices carry the REAL cause behind terse state flips (which
      // model, which error) — e.g. `Advisor "Architect" unavailable for …: 401`.
      // A tail-identical notice is a double-applied event, not news.
      const prev = t[t.length - 1];
      if (prev?.kind === "system" && prev.text === e.message) return v;
      return {
        ...v,
        transcript: [
          ...t,
          {
            kind: "system",
            id: nextId(),
            text: e.message,
            tone: e.level === "error" ? "error" : e.level === "warning" ? "warn" : "info",
          },
        ],
      };
    }

    case "session.finished": {
      // A structural end-of-turn marker: the transcript condenses the turn's
      // work at it, and it stays `pending` (not announced as finished) until
      // every advisor has stopped reviewing — "done" with a reviewer still
      // reading is not done yet.
      const reviewing = Object.values(v.advisorStates).some((st) => st === "reviewing");
      const marker: TranscriptItem | null =
        e.runState === "completed"
          ? {
              kind: "turn-end",
              id: nextId(),
              durationMs: e.durationMs,
              pending: reviewing,
              at: new Date().toISOString(),
            }
          : null;
      // Idempotence under hydrate/live races: a turn-end already at the tail
      // is the same event applied twice, not a new turn.
      const tail = v.transcript[v.transcript.length - 1];
      const isDup = marker && tail?.kind === "turn-end";
      let transcript = v.transcript;
      if (marker && !isDup) {
        // An advisor-triggered revision is the SAME user turn finishing
        // again, not a new one. Its first "finished" marker already landed
        // before the review note and the revised answer; leaving it there
        // splits the turn in two and renders both answers in full. Move the
        // marker to the tail (summing wall time) so the transcript sees one
        // turn — pre-review answer, review note, revision — and folds the
        // superseded draft. Guarded structurally: a user message after the
        // old marker means a genuinely new turn, whatever the flag says.
        const prevIdx = lastIndex(transcript, (i) => i.kind === "turn-end");
        const prev =
          prevIdx >= 0
            ? (transcript[prevIdx] as Extract<TranscriptItem, { kind: "turn-end" }>)
            : null;
        const sameTurn =
          prev !== null &&
          (e.continuation || transcript.slice(prevIdx + 1).some((i) => i.kind === "advisor")) &&
          !transcript.slice(prevIdx + 1).some((i) => i.kind === "user");
        if (sameTurn && prev) {
          transcript = transcript.filter((_, i) => i !== prevIdx);
          marker.durationMs =
            prev.durationMs !== undefined || marker.durationMs !== undefined
              ? (prev.durationMs ?? 0) + (marker.durationMs ?? 0)
              : undefined;
        }
        transcript = [...transcript, marker];
      }
      return {
        ...v,
        transcript,
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
    case "hibernated":
      return "Hibernated";
  }
}

export function isActive(s: RunState): boolean {
  return !["idle", "completed", "interrupted", "error", "hibernated"].includes(s);
}

/** True while any advisor is still reviewing — the turn isn't finished yet. */
export function advisorsReviewing(v: SessionView): boolean {
  return Object.values(v.advisorStates).some((st) => st === "reviewing");
}

/** Short display name for a provider-qualified model key. */
export function modelBasename(model?: string): string {
  if (!model) return "OMP default";
  const slash = model.indexOf("/");
  return slash >= 0 ? model.slice(slash + 1) : model;
}
