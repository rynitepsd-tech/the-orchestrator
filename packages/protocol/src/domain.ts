/**
 * Product-level domain types.
 *
 * These are deliberately NOT OMP types. The adapter normalizes upstream shapes
 * into these so the UI never imports OMP internals and upstream churn is
 * absorbed in one place.
 */

// ---------------------------------------------------------------------------
// Identity
// ---------------------------------------------------------------------------

/** Orchestrator-assigned session id. Stable across engine restarts. */
export type SessionId = string;
/** Orchestrator-assigned project id (derived from the canonical folder path). */
export type ProjectId = string;

// ---------------------------------------------------------------------------
// Run state machine
// ---------------------------------------------------------------------------

export const RUN_STATES = [
  "idle",
  "queued",
  "starting",
  "thinking",
  "streaming",
  "tool",
  "waiting",
  "stopping",
  "completed",
  "interrupted",
  "error",
] as const;
export type RunState = (typeof RUN_STATES)[number];

/** States in which the engine is actively doing work for a session. */
export const ACTIVE_RUN_STATES: readonly RunState[] = [
  "queued",
  "starting",
  "thinking",
  "streaming",
  "tool",
  "waiting",
  "stopping",
];

export function isActiveRunState(s: RunState): boolean {
  return ACTIVE_RUN_STATES.includes(s);
}

// ---------------------------------------------------------------------------
// Advisor state machine
// ---------------------------------------------------------------------------

/**
 * Advisor state.
 *
 * `reviewing`/`paused`/`failed`/`quota-exhausted`/`no-model` map 1:1 onto
 * upstream `AdvisorRuntimeStatus` ("running" | "paused" | "quota_exhausted" |
 * "error" | "no_model"). `disabled` and `idle` are host-side states for
 * advisors that are configured but have no runtime yet.
 */
export const ADVISOR_STATES = [
  "disabled",
  "idle",
  "reviewing",
  "paused",
  "quota-exhausted",
  "no-model",
  "failed",
] as const;
export type AdvisorState = (typeof ADVISOR_STATES)[number];

/**
 * Advisor severity. Upstream defines exactly "nit" | "concern" | "blocker"
 * (advisor/advise-tool.ts). `unknown` is host-side only, used when upstream
 * reports a value this build does not recognise, so a future severity degrades
 * gracefully instead of being dropped.
 */
export const ADVISOR_SEVERITIES = ["nit", "concern", "blocker", "unknown"] as const;
export type AdvisorSeverity = (typeof ADVISOR_SEVERITIES)[number];

// ---------------------------------------------------------------------------
// Models
// ---------------------------------------------------------------------------

/** Thinking config as reported per-model by OMP. Never invented by the UI. */
export interface ThinkingSupport {
  /** e.g. "effort" | "budget" | other upstream modes. */
  mode: string;
  /** Exact effort levels this model accepts, verbatim from OMP. */
  efforts: string[];
}

export interface ModelInfo {
  /** Provider-qualified key, e.g. "anthropic/claude-fable-5". Unique. */
  key: string;
  id: string;
  name: string;
  provider: string;
  api?: string;
  reasoning: boolean;
  contextWindow: number;
  maxTokens: number;
  /** Undefined when the model reports no thinking support. */
  thinking?: ThinkingSupport;
  input: string[];
  cost?: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
  };
  /** True when credentials for this provider are configured and usable. */
  authenticated: boolean;
  /** Role bindings pointing at this model, e.g. ["main", "smol"]. */
  roles?: string[];
}

export interface ProviderInfo {
  name: string;
  /** Whether OMP currently has usable credentials for this provider. */
  authenticated: boolean;
  /** How the credential was supplied, e.g. "oauth" | "api-key" | "env". */
  credentialSource?: string;
  modelCount: number;
  /** Account labels when the provider has OAuth accounts attached. */
  accounts?: Array<{ id: string; label?: string }>;
}

// ---------------------------------------------------------------------------
// Usage
// ---------------------------------------------------------------------------

export type UsageActorType = "primary" | "advisor" | "subagent";

/**
 * Where a usage number came from. Determines authority during reconciliation:
 * persisted OMP records outrank live counters.
 */
export type UsageSource = "live-event" | "omp-session" | "advisor-log" | "subagent-log";

export interface TokenCounts {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

export interface UsageRecord extends TokenCounts {
  /**
   * Deterministic identity for de-duplication. Two records with the same
   * `key` describe the SAME upstream event observed through different
   * channels and must never be summed.
   */
  key: string;

  sessionId: SessionId;
  projectId: ProjectId;

  actorType: UsageActorType;
  /** Stable actor id: "primary", advisor name, or subagent/task id. */
  actorId: string;
  /** Human label, e.g. "Architecture". */
  actorName?: string;

  provider: string;
  model: string;

  /** Only present when OMP reports cost. Never estimated by this app. */
  cost?: number;

  startedAt?: string;
  completedAt?: string;

  source: UsageSource;

  /**
   * OMP's own persisted session id, when known. The global usage index keys on
   * this (not the per-run Orchestrator session id) so usage survives restarts
   * and reconciles with reindexed session files.
   */
  ompSessionId?: string;
}

export function emptyTokenCounts(): TokenCounts {
  return { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
}

export function addTokens(a: TokenCounts, b: TokenCounts): TokenCounts {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
    cacheWriteTokens: a.cacheWriteTokens + b.cacheWriteTokens,
  };
}

export function totalTokens(t: TokenCounts): number {
  return t.inputTokens + t.outputTokens + t.cacheReadTokens + t.cacheWriteTokens;
}

/** Rolled-up usage for a session, split by actor. */
export interface UsageBreakdown {
  primary: TokenCounts & { cost?: number };
  advisors: Array<{
    actorId: string;
    actorName?: string;
    model?: string;
    tokens: TokenCounts;
    cost?: number;
  }>;
  subagents: { runs: number; tokens: TokenCounts; cost?: number };
  byModel: Array<{ model: string; provider: string; tokens: TokenCounts; cost?: number }>;
  total: TokenCounts & { cost?: number };
  /** True when at least one contributing record lacked reliable cost data. */
  costPartial: boolean;
}

/**
 * Context-window consumption. Distinct from cumulative billed tokens —
 * compaction reduces this while cumulative usage keeps rising.
 */
export interface ContextUsage {
  usedTokens: number;
  maxTokens: number;
  /** 0..1 */
  fraction: number;
}

/**
 * Provider subscription/quota, only ever populated from OMP's own provider
 * usage reporting. Never inferred from token volume.
 */
export interface ProviderQuota {
  provider: string;
  accountLabel?: string;
  windows: Array<{
    /** e.g. "5-hour", "weekly". Verbatim from upstream. */
    label: string;
    /** 0..1 when upstream reports a fraction. */
    fraction?: number;
    used?: number;
    limit?: number;
    resetsAt?: string;
  }>;
  fetchedAt: string;
  /** Set when the provider does not report quota; UI shows this, not a guess. */
  unavailableReason?: string;
}

// ---------------------------------------------------------------------------
// Session configuration
// ---------------------------------------------------------------------------

/**
 * One advisor, mirroring upstream `AdvisorConfig`
 * (name / model / tools / instructions / enabled).
 *
 * `model` is an OMP model selector and may carry a `:level` thinking suffix
 * (e.g. `x-ai/grok-code-fast:high`). This app keeps `model` and `thinkingLevel`
 * separate for the UI and joins them when handing config back to OMP.
 */
export interface AdvisorConfig {
  /** Stable id within the session. Derived from `name`. */
  id: string;
  name: string;
  enabled: boolean;
  /** Model selector without the thinking suffix. Omitted means OMP's default. */
  model?: string;
  /** Must be one of the selected model's reported efforts. */
  thinkingLevel?: string;
  /** Subset of OMP built-in tool names. Omitted uses OMP's read/grep/glob default. */
  tools?: string[];
  instructions?: string;
  /** Where this advisor definition came from. */
  origin: "project" | "user" | "session" | "builtin";
}

/** Join a model selector and thinking level into OMP's `model:level` form. */
export function toOmpAdvisorSelector(model?: string, thinkingLevel?: string): string | undefined {
  if (!model) return undefined;
  return thinkingLevel ? `${model}:${thinkingLevel}` : model;
}

/** Split OMP's `model:level` selector back into its parts. */
export function fromOmpAdvisorSelector(selector?: string): {
  model?: string;
  thinkingLevel?: string;
} {
  if (!selector) return {};
  // Provider ids contain "/" and may contain "-"; the thinking suffix is the
  // final ":"-delimited segment, and only when it is not part of a URL scheme.
  const idx = selector.lastIndexOf(":");
  if (idx <= 0) return { model: selector };
  const head = selector.slice(0, idx);
  const tail = selector.slice(idx + 1);
  if (!tail || tail.includes("/")) return { model: selector };
  return { model: head, thinkingLevel: tail };
}

export interface SessionLaunchConfig {
  projectPath: string;
  title?: string;
  /** Model key; omitted means "use OMP's configured default". */
  model?: string;
  thinkingLevel?: string;
  advisors: AdvisorConfig[];
  /** Session-local override only; never written to disk config. */
  approvalMode?: ApprovalMode;
  /** Resume an existing OMP session file instead of creating a new one. */
  resumeSessionPath?: string;
  /** Fork from an existing OMP session file. */
  forkFromSessionPath?: string;
}

export const APPROVAL_MODES = ["always-ask", "write", "yolo"] as const;
export type ApprovalMode = (typeof APPROVAL_MODES)[number];

// ---------------------------------------------------------------------------
// Session summaries
// ---------------------------------------------------------------------------

export interface SessionSummary {
  sessionId: SessionId;
  projectId: ProjectId;
  projectPath: string;
  title: string;
  runState: RunState;
  /** Short live-activity label, e.g. "Editing session.ts". */
  activity?: string;
  model?: string;
  thinkingLevel?: string;
  advisorCount: number;
  /** OMP's own session file, when persisted. */
  ompSessionPath?: string;
  ompSessionId?: string;
  messageCount: number;
  lastActivityAt?: string;
  unread: boolean;
  error?: EngineErrorPayload;
}

/** A persisted OMP session discovered on disk, not necessarily loaded. */
export interface DiscoveredSession {
  ompSessionId: string;
  path: string;
  cwd: string;
  title: string;
  created?: string;
  modified?: string;
  messageCount: number;
  sizeBytes: number;
  parentSessionPath?: string;
  /** True when this app currently has the session open in a runtime. */
  openInThisApp: boolean;
  /** Set when the session's working directory no longer exists on disk. */
  cwdMissing?: boolean;
}

export interface ProjectInfo {
  projectId: ProjectId;
  path: string;
  name: string;
  git?: { branch?: string; dirty: boolean; detached?: boolean };
  /** Discovered OMP environment for this project. */
  environment?: ProjectEnvironment;
}

/** Working-tree change list. Truthfully labelled: this is the WHOLE working
 * tree, not per-session attribution — concurrent sessions share it. */
export interface GitChanges {
  branch?: string;
  detached?: boolean;
  files: Array<{
    path: string;
    /** Porcelain status: "M" | "A" | "D" | "R" | "?" | "C" | "U". */
    status: string;
    renamedFrom?: string;
  }>;
}

export interface GitDiff {
  file: string;
  diff: string;
  binary: boolean;
  /** Set when the diff was truncated for transport. */
  truncated?: boolean;
  additions: number;
  deletions: number;
  /** For untracked files: full content preview instead of a diff. */
  untracked?: boolean;
}

export interface ProjectEnvironment {
  contextFiles: string[];
  skills: number;
  advisors: AdvisorConfig[];
  mcpServers: Array<{ name: string; status: "connected" | "failed" | "unknown"; error?: string }>;
  slashCommands: string[];
  extensions: string[];
  hasWatchdogConfig: boolean;
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export const ERROR_KINDS = [
  "engine",
  "auth",
  "model-unavailable",
  "provider-quota",
  "tool",
  "extension",
  "mcp",
  "session-corruption",
  "configuration",
  "filesystem-permission",
  "packaging-mismatch",
  "protocol",
  "unknown",
] as const;
export type ErrorKind = (typeof ERROR_KINDS)[number];

export interface EngineErrorPayload {
  kind: ErrorKind;
  /** Short, human, actionable. Never a raw stack. */
  message: string;
  /** Technical detail, shown under disclosure. Always redacted. */
  detail?: string;
  /** Actions the UI may offer. */
  retryable?: boolean;
  /** Present for provider/model failures. */
  provider?: string;
  model?: string;
}
