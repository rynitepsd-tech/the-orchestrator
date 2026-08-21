/**
 * Wire protocol between the native host (Tauri) and the engine sidecar.
 *
 * Transport: newline-delimited JSON over the engine's stdin/stdout.
 * stdout carries ONLY protocol frames. Diagnostics go to stderr and log files,
 * so a stray console.log can never corrupt the stream.
 */
import type {
  AdvisorConfig,
  ApprovalMode,
  DiscoveredSession,
  EngineErrorPayload,
  ModelInfo,
  ProjectEnvironment,
  ProviderInfo,
  ProviderQuota,
  SessionId,
  SessionLaunchConfig,
  SessionSummary,
  UsageBreakdown,
  UsageRecord,
} from "./domain";
import type { ProductEvent } from "./events";

// ---------------------------------------------------------------------------
// Envelopes
// ---------------------------------------------------------------------------

export interface EngineRequest<T extends RequestType = RequestType> {
  protocolVersion: number;
  requestId: string;
  type: T;
  payload: RequestPayloads[T];
}

export interface EngineResponseOk<T extends RequestType = RequestType> {
  protocolVersion: number;
  requestId: string;
  ok: true;
  result: ResponsePayloads[T];
}

export interface EngineResponseErr {
  protocolVersion: number;
  requestId: string;
  ok: false;
  error: EngineErrorPayload;
}

export type EngineResponse<T extends RequestType = RequestType> =
  | EngineResponseOk<T>
  | EngineResponseErr;

export interface EngineEventFrame {
  protocolVersion: number;
  /** Monotonic per engine process. Lets the host detect gaps after a restart. */
  sequence: number;
  sessionId?: SessionId;
  event: ProductEvent | EngineLifecycleEvent;
}

/** Engine-scoped events that are not tied to one session. */
export type EngineLifecycleEvent =
  | { type: "engine.status"; stage: EngineStage; message?: string }
  | { type: "engine.ready"; info: EngineInfo }
  | { type: "engine.error"; error: EngineErrorPayload }
  | {
      type: "engine.log";
      level: "debug" | "info" | "warn" | "error";
      subsystem: string;
      message: string;
    }
  /**
   * Provider OAuth flow progress. `url` must be opened in the user's browser
   * by the host; the engine never opens anything itself.
   *
   * `status: "prompt"` with a `promptId` is a question from OMP's login flow
   * (API key, paste-code fallback, enterprise domain). The host renders an
   * input and answers via a `providers.loginAnswer` request.
   */
  | {
      type: "engine.auth";
      provider: string;
      status: "browser" | "progress" | "prompt" | "done" | "failed";
      url?: string;
      message?: string;
      promptId?: string;
      placeholder?: string;
      allowEmpty?: boolean;
    };

export const ENGINE_STAGES = [
  "starting",
  "loading-config",
  "loading-models",
  "loading-extensions",
  "ready",
  "degraded",
  "stopping",
] as const;
export type EngineStage = (typeof ENGINE_STAGES)[number];

export interface EngineInfo {
  protocolVersion: number;
  engineVersion: string;
  /** Version of @oh-my-pi/pi-coding-agent actually loaded at runtime. */
  ompVersion: string;
  bunVersion: string;
  arch: string;
  platform: string;
  agentDir: string;
}

export type EngineFrame = EngineResponse | EngineEventFrame;

// ---------------------------------------------------------------------------
// Requests
// ---------------------------------------------------------------------------

export interface RequestPayloads {
  "engine.hello": { protocolVersion: number };
  "engine.shutdown": { force?: boolean };
  "engine.diagnostics": Record<string, never>;

  "models.list": { refresh?: boolean };
  "providers.list": Record<string, never>;
  "providers.quota": { refresh?: boolean };
  "providers.login": { provider: string; method?: string; apiKey?: string };
  "providers.loginAnswer": { promptId: string; answer?: string; cancel?: boolean };
  "providers.logout": { provider: string; accountId?: string };

  "project.open": { path: string };
  "project.environment": { path: string };
  "project.changes": { path: string };
  "project.diff": { path: string; file: string };
  "project.files": { path: string; query?: string; limit?: number };
  "project.readFile": { path: string; file: string };
  /** Open a file/folder with the OS default app (or a named app), or reveal it in Finder. */
  "path.open": { path: string; reveal?: boolean; app?: string };
  /**
   * Read a clicked file link for the inspector preview. Confined to the
   * symlink-resolved roots of OPEN projects — everything else returns
   * kind "denied". Images come back as base64.
   */
  "file.read": { path: string };
  /** Commit the working tree, push, and open a PR (branching off default). */
  "project.ship": { path: string; title: string; body?: string };
  /**
   * Persist pasted/dropped bytes (no OS path exists in the webview) to a temp
   * file the agent can read. Returns the absolute path.
   */
  "attachments.store": { name: string; base64: string };

  "sessions.discover": { projectPath?: string };
  "sessions.create": SessionLaunchConfig;
  "sessions.close": { sessionId: SessionId; dispose: boolean };
  "sessions.list": Record<string, never>;

  "session.prompt": {
    sessionId: SessionId;
    text: string;
    attachments?: Array<{ kind: "image" | "file"; path: string }>;
    /** How to handle a prompt sent while the agent is already running. */
    whenBusy?: "steer" | "queue" | "reject";
  };
  "session.abort": { sessionId: SessionId };
  "session.compact": { sessionId: SessionId };
  /** User messages that can serve as rewind targets, in conversation order. */
  "session.rewindPoints": { sessionId: SessionId };
  /**
   * Rewind the CONVERSATION to before a user message (OMP tree navigation).
   * Files on disk are untouched; the message text returns for editing.
   */
  "session.rewind": { sessionId: SessionId; entryId: string };
  /**
   * Fork a session. Either a live session (`sessionId`) or a persisted session
   * file (`sourcePath`) can be forked; the fork becomes a new live session.
   */
  "session.fork": {
    sessionId?: SessionId;
    sourcePath?: string;
    projectPath?: string;
    title?: string;
    model?: string;
    thinkingLevel?: string;
  };
  "session.setModel": { sessionId: SessionId; model: string; thinkingLevel?: string };
  "session.setFastMode": { sessionId: SessionId; enabled: boolean };
  "session.setTitle": { sessionId: SessionId; title: string };
  "session.setApprovalMode": { sessionId: SessionId; mode: ApprovalMode };
  "session.transcript": { sessionId: SessionId; sinceSequence?: number };

  "session.advisors.set": { sessionId: SessionId; advisors: AdvisorConfig[] };
  "session.advisors.get": { sessionId: SessionId };

  "approval.respond": { sessionId: SessionId; approvalId: string; optionId: string };
  "extension.ui.respond": {
    sessionId: SessionId;
    requestId: string;
    value: unknown;
    cancelled: boolean;
  };

  "slash.list": { sessionId: SessionId };

  "mcp.status": { sessionId: SessionId };
  "mcp.reconnect": { sessionId: SessionId; server: string };

  "usage.session": { sessionId: SessionId };
  "usage.query": UsageQuery;
  "usage.reindex": { full?: boolean };

  /**
   * UI preference storage, engine-side. Prefs hold presets, aliases and
   * ordering — real data — so they live in a file under Application Support
   * instead of only WKWebView localStorage, which the OS can wipe.
   */
  "prefs.load": Record<string, never>;
  "prefs.save": { prefs: unknown };
}

export interface UsageQuery {
  since?: string;
  until?: string;
  projectPath?: string;
  provider?: string;
  model?: string;
  actorType?: "primary" | "advisor" | "subagent";
}

export type RequestType = keyof RequestPayloads;

// ---------------------------------------------------------------------------
// Responses
// ---------------------------------------------------------------------------

export interface ResponsePayloads {
  "engine.hello": EngineInfo;
  "engine.shutdown": { stopping: true };
  "engine.diagnostics": {
    info: EngineInfo;
    sessions: number;
    activeSessions: number;
    logPath: string;
    warnings: string[];
    workers: Array<{
      sessionId: SessionId;
      title: string;
      pid?: number;
      runState: string;
      rssBytes?: number;
      uptimeMs?: number;
    }>;
  };

  "models.list": { models: ModelInfo[]; defaultModel?: string; roles: Record<string, string> };
  "providers.list": { providers: ProviderInfo[] };
  "providers.quota": { quotas: ProviderQuota[] };
  "providers.login": { ok: boolean; message?: string; requiresBrowser?: string };
  "providers.loginAnswer": { ok: boolean };
  "providers.logout": { ok: boolean; message?: string };

  "project.open": { project: import("./domain").ProjectInfo };
  "project.environment": ProjectEnvironment;
  "project.changes": import("./domain").GitChanges;
  "project.diff": import("./domain").GitDiff;
  "project.files": { files: string[]; truncated: boolean };
  "project.readFile": { file: string; content: string; binary: boolean; truncated: boolean };
  "path.open": { opened: boolean };
  "file.read": {
    kind: "text" | "image" | "pdf" | "binary" | "missing" | "directory" | "denied";
    content?: string;
    base64?: string;
    mime?: string;
    truncated?: boolean;
  };
  "attachments.store": { path: string };
  "session.rewindPoints": { points: Array<{ entryId: string; text: string }> };
  "session.rewind": { cancelled: boolean; editorText?: string };
  "project.ship": {
    branch: string;
    createdBranch: boolean;
    committed: boolean;
    pushed: boolean;
    prUrl?: string;
    note?: string;
  };

  "sessions.discover": { sessions: DiscoveredSession[] };
  "sessions.create": { session: SessionSummary };
  "sessions.close": { closed: true };
  "sessions.list": { sessions: SessionSummary[] };

  "session.prompt": { accepted: true; mode: "started" | "steered" | "queued" };
  "session.abort": { aborted: boolean };
  "session.compact": { ok: boolean };
  "session.fork": { session: SessionSummary };
  "session.setModel": { ok: boolean; model: string };
  /** ok=false means the current model has no fast/priority tier to toggle. */
  "session.setFastMode": { ok: boolean; enabled: boolean; active: boolean };
  "session.setTitle": { ok: boolean };
  "session.setApprovalMode": { ok: boolean };
  "session.transcript": { events: ProductEvent[]; sequence: number };

  "session.advisors.set": { advisors: AdvisorConfig[] };
  "session.advisors.get": { advisors: AdvisorConfig[] };

  "approval.respond": { ok: boolean };
  "extension.ui.respond": { ok: boolean };

  "slash.list": { commands: Array<{ name: string; description?: string; source: string }> };

  "mcp.status": {
    servers: Array<{
      name: string;
      status: "connected" | "connecting" | "disconnected";
      toolCount?: number;
      source?: string;
      error?: string;
    }>;
  };
  "mcp.reconnect": { ok: boolean; status?: string };

  "usage.session": { breakdown: UsageBreakdown };
  "usage.query": { records: UsageRecord[]; breakdown: UsageBreakdown };
  "usage.reindex": { indexed: number; durationMs: number };

  "prefs.load": { prefs?: unknown };
  "prefs.save": { ok: boolean };
}

// ---------------------------------------------------------------------------
// Framing helpers
// ---------------------------------------------------------------------------

export function encodeFrame(frame: unknown): string {
  return `${JSON.stringify(frame)}\n`;
}

/**
 * Incremental NDJSON decoder. Tolerates partial reads and rejects oversized
 * lines rather than growing without bound.
 */
export class FrameDecoder {
  #buf = "";
  readonly #maxLine: number;

  constructor(maxLineBytes = 64 * 1024 * 1024) {
    this.#maxLine = maxLineBytes;
  }

  push(chunk: string): { frames: unknown[]; errors: string[] } {
    const frames: unknown[] = [];
    const errors: string[] = [];
    this.#buf += chunk;

    let idx: number;
    while ((idx = this.#buf.indexOf("\n")) >= 0) {
      const line = this.#buf.slice(0, idx);
      this.#buf = this.#buf.slice(idx + 1);
      if (!line.trim()) continue;
      try {
        frames.push(JSON.parse(line));
      } catch (e) {
        errors.push(`malformed frame (${(e as Error).message}): ${line.slice(0, 200)}`);
      }
    }

    if (this.#buf.length > this.#maxLine) {
      errors.push(`frame exceeded ${this.#maxLine} bytes; buffer reset`);
      this.#buf = "";
    }
    return { frames, errors };
  }

  reset(): void {
    this.#buf = "";
  }
}

// ---------------------------------------------------------------------------
// Runtime validation
// ---------------------------------------------------------------------------

/**
 * Every request type, as a runtime value — the compile-time RequestType union
 * is erased at the IPC boundary, so the engine needs a real list to reject
 * unknown frames. The `satisfies` + Missing assertion keep it in lockstep
 * with RequestPayloads: adding a request without listing it here is a type
 * error.
 */
export const REQUEST_TYPES = [
  "engine.hello",
  "engine.shutdown",
  "engine.diagnostics",
  "models.list",
  "providers.list",
  "providers.quota",
  "providers.login",
  "providers.loginAnswer",
  "providers.logout",
  "project.open",
  "project.environment",
  "project.changes",
  "project.diff",
  "project.files",
  "project.readFile",
  "path.open",
  "file.read",
  "project.ship",
  "attachments.store",
  "sessions.discover",
  "sessions.create",
  "sessions.close",
  "sessions.list",
  "session.prompt",
  "session.abort",
  "session.compact",
  "session.rewindPoints",
  "session.rewind",
  "session.fork",
  "session.setModel",
  "session.setFastMode",
  "session.setTitle",
  "session.setApprovalMode",
  "session.transcript",
  "session.advisors.set",
  "session.advisors.get",
  "approval.respond",
  "extension.ui.respond",
  "slash.list",
  "mcp.status",
  "mcp.reconnect",
  "usage.session",
  "usage.query",
  "usage.reindex",
  "prefs.load",
  "prefs.save",
] as const satisfies readonly RequestType[];

type MissingRequestTypes = Exclude<RequestType, (typeof REQUEST_TYPES)[number]>;
// If this line errors, a request type was added to RequestPayloads but not
// to REQUEST_TYPES above.
const _allRequestTypesListed: MissingRequestTypes extends never ? true : never = true;
void _allRequestTypesListed;

const REQUEST_TYPE_SET: ReadonlySet<string> = new Set(REQUEST_TYPES);

export function isEngineRequest(v: unknown): v is EngineRequest {
  if (typeof v !== "object" || v === null) return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o.protocolVersion === "number" &&
    typeof o.requestId === "string" &&
    typeof o.type === "string" &&
    REQUEST_TYPE_SET.has(o.type) &&
    "payload" in o
  );
}

export function isEngineResponse(v: unknown): v is EngineResponse {
  if (typeof v !== "object" || v === null) return false;
  const o = v as Record<string, unknown>;
  return typeof o.requestId === "string" && typeof o.ok === "boolean";
}

export function isEngineEventFrame(v: unknown): v is EngineEventFrame {
  if (typeof v !== "object" || v === null) return false;
  const o = v as Record<string, unknown>;
  return typeof o.sequence === "number" && typeof o.event === "object" && o.event !== null;
}
