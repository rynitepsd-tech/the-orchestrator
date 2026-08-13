/**
 * Session isolation.
 *
 * This module owns the single most important invariant in the product:
 * several top-level OMP sessions run concurrently inside ONE engine process,
 * and nothing may leak between them.
 *
 * Upstream states the constraint directly (docs/sdk.md and the export comment
 * on `registry/agent-registry`):
 *
 *   "For multiple concurrent top-level sessions in one process, pass a private
 *    AgentRegistry to each session. The default process-global registry admits
 *    only one 'Main' identity per generation."
 *
 * Verified empirically against OMP 17.3.1: two sessions built through
 * {@link createIsolatedSession} stream simultaneously, execute real tools, and
 * show no cross-talk in events, tool output, cwd, or usage; aborting or
 * disposing one leaves the other running. See packages/engine/test/concurrency.test.ts.
 */
import {
  AgentRegistry,
  createAgentSession,
  ModelRegistry,
  SessionManager,
  Settings,
  type AgentSession,
  type AuthStorage,
} from "@oh-my-pi/pi-coding-agent";

export interface IsolatedSessionOptions {
  /** Orchestrator session id; used to derive a unique agent identity. */
  sessionId: string;
  /** Project directory. Becomes this session's cwd — never process.chdir. */
  cwd: string;
  agentDir: string;
  /** Shared across sessions on purpose: credentials are a process-wide resource. */
  authStorage: AuthStorage;
  /**
   * Shared model registry. Safe to share because it is read-mostly and its
   * mutations (provider registration) are host-controlled, not session-driven.
   * Pass a private one when a session must see different providers.
   */
  modelRegistry: ModelRegistry;
  /** Resolved OMP model object, or undefined to let OMP pick its default. */
  model?: unknown;
  thinkingLevel?: string;
  /** Persisted session file to resume, if any. */
  resumeSessionPath?: string;
  /** Session-local settings overlay. Never written back to disk. */
  settingsOverlay?: Record<string, unknown>;
  autoApprove?: boolean;
  /** Set false in tests to avoid spawning MCP servers. */
  enableMCP?: boolean;
  enableLsp?: boolean;
  /** Enables interactive tools (ask) and the extension UI bridge. */
  hasUI?: boolean;
}

export interface IsolatedSession {
  session: AgentSession;
  /** The private registry backing this session. Kept for disposal ordering. */
  agentRegistry: AgentRegistry;
  settings: Settings;
  sessionManager: SessionManager;
}

/**
 * Build a fully isolated top-level session.
 *
 * Every mutable runtime component below is per-session by construction. The
 * comment on each line records *why* it must not be shared.
 */
export async function createIsolatedSession(
  opts: IsolatedSessionOptions,
): Promise<IsolatedSession> {
  // Private registry: without this, a second top-level session collides with
  // the first on the process-global "Main" identity.
  const agentRegistry = new AgentRegistry();

  // Per-session settings so a session-local model/advisor/approval override
  // cannot mutate the user's global or project configuration.
  const settings = await Settings.init({ cwd: opts.cwd, agentDir: opts.agentDir });
  applySettingsOverlay(settings, opts.settingsOverlay);

  // Per-session session manager: resume binds to one specific file, and a
  // shared manager would let one session's persistence path bleed into another.
  const sessionManager = opts.resumeSessionPath
    ? await SessionManager.open(opts.resumeSessionPath)
    : SessionManager.create(
        opts.cwd,
        SessionManager.getDefaultSessionDir(opts.cwd, opts.agentDir),
      );

  const { session } = await createAgentSession({
    // cwd is passed per session. OMP never calls process.chdir for this, which
    // is what makes concurrent sessions in different projects safe.
    cwd: opts.cwd,
    agentDir: opts.agentDir,

    authStorage: opts.authStorage,
    modelRegistry: opts.modelRegistry,
    model: opts.model as never,
    thinkingLevel: opts.thinkingLevel as never,

    // *** ISOLATION INVARIANT ***
    agentRegistry,
    // Distinct identity per session so registry rows never collide.
    agentId: agentIdFor(opts.sessionId),

    sessionManager,
    settings,

    // Fresh bus per session; the default already creates one, but being
    // explicit documents that events must not be shared.
    // (omitted -> createAgentSession allocates a new EventBus)

    enableMCP: opts.enableMCP ?? true,
    enableLsp: opts.enableLsp ?? true,

    // Approvals are bridged to the UI. Auto-approve is opt-in and only used by
    // tests — a missing UI must never imply consent.
    autoApprove: opts.autoApprove ?? false,
    hasUI: opts.hasUI ?? false,
  });

  return { session, agentRegistry, settings, sessionManager };
}

/**
 * Derive a registry identity for a session.
 *
 * Upstream defaults top-level sessions to the literal `"Main"`; two of those in
 * one process is precisely the collision we are avoiding.
 */
export function agentIdFor(sessionId: string): string {
  return `Main-${sessionId}`;
}

/**
 * Apply a session-local overlay onto a Settings instance.
 *
 * Deliberately in-memory. OMP's Settings has methods that persist to disk;
 * this uses none of them, so "use Fable 5 for this session" can never become
 * "rewrite the user's default model".
 */
function applySettingsOverlay(settings: Settings, overlay?: Record<string, unknown>): void {
  if (!overlay) return;
  const target = settings as unknown as { config?: Record<string, unknown> };
  if (!target.config || typeof target.config !== "object") return;
  for (const [k, v] of Object.entries(overlay)) {
    target.config[k] = v;
  }
}

/**
 * Dispose a session and its private registry.
 *
 * Disposal is per-session; verified that disposing one leaves concurrent
 * sessions streaming.
 */
export async function disposeIsolatedSession(s: IsolatedSession): Promise<void> {
  try {
    await s.session.dispose();
  } finally {
    // The private registry dies with the session; nothing process-global to undo.
  }
}
