/**
 * Normalized product events.
 *
 * The adapter maps upstream OMP events onto these. The UI subscribes only to
 * these, so an upstream event rename is a one-file change in the adapter.
 *
 * Upstream (verified against OMP 17.3.1 session.subscribe):
 *   agent_start, turn_start, message_start, message_update, message_end,
 *   tool_execution_start, tool_execution_update, tool_execution_end,
 *   turn_end, agent_end
 */
import type {
  AdvisorSeverity,
  AdvisorState,
  ContextUsage,
  EngineErrorPayload,
  RunState,
  SessionId,
  UsageBreakdown,
} from "./domain";

export interface EventBase {
  sessionId: SessionId;
}

// --- lifecycle -------------------------------------------------------------

export interface SessionStateChanged extends EventBase {
  type: "session.state";
  runState: RunState;
  /** Short activity label, e.g. "Editing session.ts". */
  activity?: string;
}

export interface SessionTitleChanged extends EventBase {
  type: "session.title";
  title: string;
}

// --- assistant output ------------------------------------------------------

export interface AssistantTextDelta extends EventBase {
  type: "assistant.text";
  messageId: string;
  /** Coalesced text chunk, not necessarily a single upstream delta. */
  delta: string;
}

export interface AssistantThinkingDelta extends EventBase {
  type: "assistant.thinking";
  messageId: string;
  delta: string;
}

export interface AssistantMessageComplete extends EventBase {
  type: "assistant.message.end";
  messageId: string;
  /** Final rendered text, authoritative over accumulated deltas. */
  text: string;
  thinking?: string;
  model?: string;
}

export interface UserMessageAdded extends EventBase {
  type: "user.message";
  messageId: string;
  text: string;
  attachments?: Array<{ kind: "image" | "file"; name: string; path?: string }>;
}

// --- todo list -------------------------------------------------------------

export interface TodoTaskItem {
  content: string;
  status: "pending" | "in_progress" | "completed" | "abandoned" | "blocked";
  blocker?: string;
}

/** Full snapshot of the agent's todo list after every `todo` tool call. */
export interface TodoUpdated extends EventBase {
  type: "todo.update";
  phases: Array<{ name: string; tasks: TodoTaskItem[] }>;
}

// --- tools -----------------------------------------------------------------

export interface ToolStarted extends EventBase {
  type: "tool.start";
  callId: string;
  toolName: string;
  /** Redacted, display-ready arguments. */
  args: Record<string, unknown>;
  /** Set when this tool call belongs to a subagent rather than the primary. */
  parentActorId?: string;
}

export interface ToolUpdated extends EventBase {
  type: "tool.update";
  callId: string;
  /** Incremental output (e.g. streaming shell stdout). */
  outputDelta?: string;
  progress?: string;
}

export interface ToolCompleted extends EventBase {
  type: "tool.end";
  callId: string;
  ok: boolean;
  /** Truncated for transport; the UI can request the full body. */
  output?: string;
  truncated?: boolean;
  error?: string;
  durationMs?: number;
  /** Structured detail for rich rendering (diffs, match counts, etc.). */
  detail?: ToolDetail;
}

export type ToolDetail =
  | { kind: "edit"; path: string; additions: number; deletions: number; diff?: string }
  | { kind: "write"; path: string; bytes: number; created: boolean }
  | { kind: "read"; path: string; lines: number }
  | { kind: "search"; query: string; matches: number; files: number }
  | { kind: "bash"; command: string; exitCode?: number }
  | { kind: "other" };

// --- approvals -------------------------------------------------------------

export interface ApprovalRequested extends EventBase {
  type: "approval.request";
  approvalId: string;
  toolName: string;
  /** Human-readable summary of what is about to happen. */
  summary: string;
  /** e.g. the exact shell command. */
  detail?: string;
  /** Upstream risk classification when available. */
  risk?: "low" | "medium" | "high" | "critical";
  options: Array<{ id: string; label: string; kind: "allow" | "allow-always" | "deny" }>;
}

export interface ApprovalResolved extends EventBase {
  type: "approval.resolved";
  approvalId: string;
  optionId: string;
}

// --- advisors --------------------------------------------------------------

export interface AdvisorStateChanged extends EventBase {
  type: "advisor.state";
  advisorId: string;
  advisorName: string;
  state: AdvisorState;
  model?: string;
}

export interface AdvisorMessage extends EventBase {
  type: "advisor.message";
  advisorId: string;
  advisorName: string;
  severity: AdvisorSeverity;
  text: string;
  messageId: string;
  at: string;
}

export interface AdvisorFailed extends EventBase {
  type: "advisor.failed";
  advisorId: string;
  advisorName: string;
  error: EngineErrorPayload;
  /** True when the primary agent is unaffected and still running. */
  primaryUnaffected: boolean;
}

// --- subagents -------------------------------------------------------------

export interface SubagentStarted extends EventBase {
  type: "subagent.start";
  subagentId: string;
  label: string;
  /** The agent definition used, e.g. "task" or a named custom agent. */
  agent?: string;
  agentSource?: string;
  /** Task text given to the subagent. */
  task?: string;
  model?: string;
  parentToolCallId?: string;
  startedAt: string;
}

export interface SubagentUpdated extends EventBase {
  type: "subagent.update";
  subagentId: string;
  toolCalls: number;
  activity?: string;
  currentTool?: string;
  /** Cumulative billed tokens across the subagent's turns (upstream figure). */
  tokens?: number;
  cost?: number;
  contextTokens?: number;
  contextWindow?: number;
}

export interface SubagentCompleted extends EventBase {
  type: "subagent.end";
  subagentId: string;
  ok: boolean;
  durationMs: number;
  toolCalls: number;
  error?: string;
}

// --- usage / context -------------------------------------------------------

export interface UsageUpdated extends EventBase {
  type: "usage.update";
  breakdown: UsageBreakdown;
}

/**
 * Raw usage records for the engine-wide index. Workers emit these alongside
 * `usage.update` so the supervisor can persist and aggregate across sessions
 * without re-deriving from breakdowns.
 */
export interface UsageRecordsAdded extends EventBase {
  type: "usage.records";
  records: import("./domain").UsageRecord[];
}

export interface ContextChanged extends EventBase {
  type: "context.update";
  context: ContextUsage;
}

// --- session meta ----------------------------------------------------------

export interface ModelChanged extends EventBase {
  type: "session.model";
  model: string;
  thinkingLevel?: string;
  /** True when OMP chose this itself (e.g. fallback), not the user. */
  automatic: boolean;
  reason?: string;
}

export interface FastModeChanged extends EventBase {
  type: "session.fastMode";
  /** The provider family's priority tier is selected. */
  enabled: boolean;
  /** The tier is actually realized on the wire for the current model. */
  active: boolean;
}

export interface SessionCompacted extends EventBase {
  type: "session.compacted";
  freedTokens?: number;
  at: string;
}

export interface SessionFailed extends EventBase {
  type: "session.failed";
  error: EngineErrorPayload;
}

export interface SessionFinished extends EventBase {
  type: "session.finished";
  runState: Extract<RunState, "completed" | "interrupted" | "error">;
  /** Wall-clock length of the turn, when the runtime measured it. */
  durationMs?: number;
}

/**
 * An OMP runtime notice worth showing (advisor model failures, degraded
 * capabilities). Carries the REAL underlying error text — the advisor state
 * machine alone only knows "error".
 */
export interface SessionNotice extends EventBase {
  type: "session.notice";
  level: "warning" | "error";
  message: string;
  source?: string;
}

/** Emitted when the engine persists the session, so the UI can link to it. */
export interface SessionPersisted extends EventBase {
  type: "session.persisted";
  ompSessionPath: string;
  ompSessionId: string;
}

// --- extension UI bridge ---------------------------------------------------

export interface ExtensionUIRequested extends EventBase {
  type: "extension.ui.request";
  requestId: string;
  extensionName: string;
  ui:
    | { kind: "confirm"; title: string; message?: string }
    | {
        kind: "select";
        title: string;
        options: Array<{ id: string; label: string }>;
        multi: boolean;
      }
    | { kind: "input"; title: string; placeholder?: string; secret?: boolean }
    | { kind: "editor"; title: string; initial: string; language?: string }
    | { kind: "notification"; level: "info" | "warn" | "error"; message: string }
    | { kind: "unsupported"; description: string };
}

// --- union -----------------------------------------------------------------

export type ProductEvent =
  | SessionStateChanged
  | SessionTitleChanged
  | AssistantTextDelta
  | AssistantThinkingDelta
  | AssistantMessageComplete
  | UserMessageAdded
  | ToolStarted
  | ToolUpdated
  | ToolCompleted
  | ApprovalRequested
  | ApprovalResolved
  | AdvisorStateChanged
  | AdvisorMessage
  | AdvisorFailed
  | SubagentStarted
  | SubagentUpdated
  | SubagentCompleted
  | UsageUpdated
  | UsageRecordsAdded
  | ContextChanged
  | ModelChanged
  | FastModeChanged
  | SessionCompacted
  | SessionFailed
  | SessionFinished
  | SessionNotice
  | SessionPersisted
  | ExtensionUIRequested
  | TodoUpdated;

export type ProductEventType = ProductEvent["type"];

/** Compile-time exhaustiveness helper for event switches. */
export function assertNeverEvent(e: never): never {
  throw new Error(`Unhandled product event: ${JSON.stringify(e)}`);
}
