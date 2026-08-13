/**
 * Application state.
 *
 * The central rule: React state is a VIEW of engine state, never the runtime
 * itself. Unmounting a session's components must not stop its agent — so
 * transcripts live here, keyed by session id, and are updated by engine events
 * regardless of which session the user is looking at.
 */
import { create } from "zustand";
import type {
  AdvisorConfig,
  AdvisorSeverity,
  AdvisorState,
  ContextUsage,
  DiscoveredSession,
  EngineErrorPayload,
  EngineStage,
  ModelInfo,
  ProductEvent,
  ProjectInfo,
  ProviderInfo,
  ProviderQuota,
  RunState,
  SessionSummary,
  ToolDetail,
  UsageBreakdown,
} from "@orchestrator/protocol";

// ---------------------------------------------------------------------------
// Transcript items — the renderable form of the event stream
// ---------------------------------------------------------------------------

export type TranscriptItem =
  | { kind: "user"; id: string; text: string }
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
    }
  | {
      kind: "subagent";
      id: string;
      subagentId: string;
      label: string;
      model?: string;
      state: "running" | "done" | "error";
      toolCalls: number;
      durationMs?: number;
    }
  | { kind: "system"; id: string; text: string; tone: "info" | "warn" | "error" };

export interface SessionView {
  summary: SessionSummary;
  transcript: TranscriptItem[];
  usage?: UsageBreakdown;
  context?: ContextUsage;
  advisors: AdvisorConfig[];
  advisorStates: Record<string, AdvisorState>;
  error?: EngineErrorPayload;
}

export type InspectorTab = "changes" | "files" | "usage";

interface AppState {
  // engine
  engineStage: EngineStage | "offline";
  engineMessage?: string;
  engineError?: EngineErrorPayload;
  engineInfo?: { ompVersion: string; engineVersion: string; arch: string; protocolVersion: number };

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

  // ui
  inspectorTab: InspectorTab;
  inspectorOpen: boolean;
  sidebarOpen: boolean;
  paletteOpen: boolean;
  newSessionOpen: boolean;
  settingsOpen: boolean;

  // actions
  setEngineStage(stage: EngineStage | "offline", message?: string): void;
  setEngineError(e?: EngineErrorPayload): void;
  setEngineInfo(i: AppState["engineInfo"]): void;
  setCatalogue(models: ModelInfo[], providers: ProviderInfo[]): void;
  setQuotas(q: ProviderQuota[]): void;
  addProject(p: ProjectInfo): void;
  setDiscovered(d: DiscoveredSession[]): void;
  addSession(s: SessionSummary, advisors: AdvisorConfig[]): void;
  removeSession(id: string): void;
  select(id: string): void;
  apply(e: ProductEvent): void;
  setInspectorTab(t: InspectorTab): void;
  toggleInspector(): void;
  toggleSidebar(): void;
  setPalette(open: boolean): void;
  setNewSession(open: boolean): void;
  setSettings(open: boolean): void;
  /** Mark every session interrupted after the engine dies. */
  markAllInterrupted(reason: string): void;
}

let itemSeq = 0;
const nextId = () => `i${++itemSeq}`;

export const useStore = create<AppState>((set, get) => ({
  engineStage: "starting",
  models: [],
  providers: [],
  quotas: [],
  projects: [],
  discovered: [],
  sessions: {},
  order: [],
  inspectorTab: "usage",
  inspectorOpen: true,
  sidebarOpen: true,
  paletteOpen: false,
  newSessionOpen: false,
  settingsOpen: false,

  setEngineStage: (engineStage, engineMessage) => set({ engineStage, engineMessage }),
  setEngineError: (engineError) => set({ engineError }),
  setEngineInfo: (engineInfo) => set({ engineInfo }),
  setCatalogue: (models, providers) => set({ models, providers }),
  setQuotas: (quotas) => set({ quotas }),

  addProject: (p) =>
    set((s) =>
      s.projects.some((x) => x.projectId === p.projectId)
        ? s
        : { projects: [...s.projects, p] },
    ),

  setDiscovered: (discovered) => set({ discovered }),

  addSession: (summary, advisors) =>
    set((s) => ({
      sessions: {
        ...s.sessions,
        [summary.sessionId]: {
          summary,
          transcript: [],
          advisors,
          advisorStates: {},
        },
      },
      order: [...s.order, summary.sessionId],
      visibleSessionId: summary.sessionId,
    })),

  removeSession: (id) =>
    set((s) => {
      const sessions = { ...s.sessions };
      delete sessions[id];
      const order = s.order.filter((x) => x !== id);
      return {
        sessions,
        order,
        visibleSessionId: s.visibleSessionId === id ? order[order.length - 1] : s.visibleSessionId,
      };
    }),

  select: (id) =>
    set((s) => {
      const v = s.sessions[id];
      if (!v) return { visibleSessionId: id };
      // Selecting a session clears its unread flag. It does NOT touch the
      // engine — background runs continue untouched.
      return {
        visibleSessionId: id,
        sessions: { ...s.sessions, [id]: { ...v, summary: { ...v.summary, unread: false } } },
      };
    }),

  setInspectorTab: (inspectorTab) => set({ inspectorTab }),
  toggleInspector: () => set((s) => ({ inspectorOpen: !s.inspectorOpen })),
  toggleSidebar: () => set((s) => ({ sidebarOpen: !s.sidebarOpen })),
  setPalette: (paletteOpen) => set({ paletteOpen }),
  setNewSession: (newSessionOpen) => set({ newSessionOpen }),
  setSettings: (settingsOpen) => set({ settingsOpen }),

  markAllInterrupted: (reason) =>
    set((s) => {
      const sessions: Record<string, SessionView> = {};
      for (const [id, v] of Object.entries(s.sessions)) {
        sessions[id] = {
          ...v,
          summary: { ...v.summary, runState: "interrupted" as RunState },
          transcript: [
            ...v.transcript,
            { kind: "system", id: nextId(), text: reason, tone: "error" },
          ],
        };
      }
      return { sessions };
    }),

  apply: (e) => {
    const state = get();
    const view = state.sessions[e.sessionId];
    if (!view) return;

    const next = reduce(view, e, state.visibleSessionId === e.sessionId);
    if (next === view) return;
    set({ sessions: { ...state.sessions, [e.sessionId]: next } });
  },
}));

// ---------------------------------------------------------------------------
// Event reducer
// ---------------------------------------------------------------------------

function reduce(v: SessionView, e: ProductEvent, visible: boolean): SessionView {
  const t = v.transcript;

  switch (e.type) {
    case "session.state":
      return {
        ...v,
        summary: { ...v.summary, runState: e.runState, lastActivityAt: new Date().toISOString() },
      };

    case "session.title":
      return { ...v, summary: { ...v.summary, title: e.title } };

    case "user.message":
      return { ...v, transcript: [...t, { kind: "user", id: e.messageId, text: e.text }] };

    case "assistant.text":
    case "assistant.thinking": {
      const isText = e.type === "assistant.text";
      const last = t[t.length - 1];
      // Append into the streaming assistant bubble when it is the tail.
      if (last?.kind === "assistant" && last.id === e.messageId) {
        const updated: TranscriptItem = {
          ...last,
          text: isText ? last.text + e.delta : last.text,
          thinking: isText ? last.thinking : last.thinking + e.delta,
        };
        return { ...v, transcript: [...t.slice(0, -1), updated] };
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
      const idx = t.findIndex((x) => x.kind === "assistant" && x.id === e.messageId);
      if (idx < 0) {
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
            id: e.callId,
            callId: e.callId,
            name: e.toolName,
            args: e.args,
            output: "",
            state: "running",
          },
        ],
      };

    case "tool.update": {
      const idx = t.findIndex((x) => x.kind === "tool" && x.callId === e.callId);
      if (idx < 0) return v;
      const copy = [...t];
      const cur = copy[idx] as Extract<TranscriptItem, { kind: "tool" }>;
      copy[idx] = { ...cur, output: cur.output + (e.outputDelta ?? "") };
      return { ...v, transcript: copy };
    }

    case "tool.end": {
      const idx = t.findIndex((x) => x.kind === "tool" && x.callId === e.callId);
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
            model: e.model,
            state: "running",
            toolCalls: 0,
          },
        ],
      };

    case "subagent.update":
    case "subagent.end": {
      const idx = t.findIndex((x) => x.kind === "subagent" && x.subagentId === e.subagentId);
      if (idx < 0) return v;
      const copy = [...t];
      const cur = copy[idx] as Extract<TranscriptItem, { kind: "subagent" }>;
      copy[idx] =
        e.type === "subagent.end"
          ? { ...cur, state: e.ok ? "done" : "error", toolCalls: e.toolCalls, durationMs: e.durationMs }
          : { ...cur, toolCalls: e.toolCalls };
      return { ...v, transcript: copy };
    }

    case "usage.update":
      return { ...v, usage: e.breakdown };

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
            tone: "info",
          },
        ],
      };

    case "session.compacted":
      return {
        ...v,
        transcript: [...t, { kind: "system", id: nextId(), text: "Context compacted", tone: "info" }],
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
        transcript: [...t, { kind: "system", id: nextId(), text: e.error.message, tone: "error" }],
      };

    case "session.finished":
      return {
        ...v,
        summary: {
          ...v.summary,
          runState: e.runState,
          // Unread only matters for a session the user is not looking at.
          unread: !visible,
        },
      };

    default:
      return v;
  }
}

/** Format a token count compactly: 84_213 -> "84.2k". */
export function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

export function fmtCost(n?: number): string | null {
  if (typeof n !== "number" || !Number.isFinite(n)) return null;
  return n < 0.01 && n > 0 ? "<$0.01" : `$${n.toFixed(2)}`;
}
