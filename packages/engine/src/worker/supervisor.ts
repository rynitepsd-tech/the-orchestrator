/**
 * Worker supervisor.
 *
 * Replaces the in-process RuntimeManager session store: each session is now a
 * child process running exactly one AgentSession (see worker/main.ts for the
 * upstream evidence that forced this).
 *
 * The host protocol is unchanged. Sessions are still addressed by
 * Orchestrator session id; the supervisor routes each request to the owning
 * worker and forwards worker events upward verbatim.
 */
import { randomUUID } from "node:crypto";
import { existsSync, realpathSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { projectIdFor } from "@orchestrator/omp-adapter";
import {
  encodeFrame,
  FrameDecoder,
  PROTOCOL_VERSION,
  type ProductEvent,
  type SessionLaunchConfig,
  type SessionSummary,
} from "@orchestrator/protocol";
import { logger } from "../logging";

export interface WorkerSpawnEnv {
  /** Extra provider registrations for tests. */
  testProviders?: Array<{ name: string; baseUrl: string; apiKey: string; modelIds: string[] }>;
}

interface PendingRequest {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
}

const STDERR_RING_SIZE = 40;

class Worker {
  readonly sessionId: string;
  readonly summary: SessionSummary;
  readonly startedAtMs = Date.now();
  readonly #proc: Bun.Subprocess<"pipe", "pipe", "pipe">;
  readonly #decoder = new FrameDecoder();
  readonly #pending = new Map<string, PendingRequest>();
  /** Last worker stderr lines, for actionable create/crash errors. */
  readonly stderrTail: string[] = [];
  #ready = false;
  #exited = false;
  /** Set when the worker announced session.hibernated — its exit is deliberate. */
  hibernated = false;
  pid: number | undefined;

  constructor(
    sessionId: string,
    summary: SessionSummary,
    proc: Bun.Subprocess<"pipe", "pipe", "pipe">,
    onEvent: (e: ProductEvent) => void,
    onExit: (code: number | null) => void,
  ) {
    this.sessionId = sessionId;
    this.summary = summary;
    this.#proc = proc;
    this.pid = proc.pid;

    void this.#pumpStdout(onEvent);
    void this.#pumpStderr();
    void this.#proc.exited.then((code) => {
      this.#exited = true;
      // Fail every in-flight request rather than leaving the host hanging.
      for (const [, p] of this.#pending) {
        p.reject(new Error("The session engine exited unexpectedly."));
      }
      this.#pending.clear();
      onExit(code);
    });
  }

  get ready(): boolean {
    return this.#ready;
  }
  get exited(): boolean {
    return this.#exited;
  }

  async #pumpStdout(onEvent: (e: ProductEvent) => void): Promise<void> {
    const td = new TextDecoder();
    const reader = this.#proc.stdout.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const { frames, errors } = this.#decoder.push(td.decode(value, { stream: true }));
      for (const msg of errors) {
        logger.warn("worker-protocol", msg.slice(0, 500), { sessionId: this.sessionId });
      }
      for (const f of frames) {
        const frame = f as any;
        if (frame.workerReady) {
          this.#ready = true;
          if (typeof frame.pid === "number") this.pid = frame.pid;
          continue;
        }
        if (frame.requestId) {
          const p = this.#pending.get(frame.requestId);
          if (p) {
            this.#pending.delete(frame.requestId);
            if (frame.ok) p.resolve(frame.result);
            else
              p.reject(
                Object.assign(new Error(frame.error?.message ?? "worker error"), frame.error),
              );
          }
          continue;
        }
        if (frame.event) {
          const event = frame.event as ProductEvent;
          // Ownership check: a worker may only speak for its own session.
          // Anything else is a bug (or a compromised child) and must not be
          // routed to another session's UI.
          if ((event as { sessionId?: string }).sessionId !== this.sessionId) {
            logger.warn("supervisor", "dropped event with foreign sessionId", {
              sessionId: this.sessionId,
              claimed: (event as { sessionId?: string }).sessionId,
              type: (event as { type?: string }).type,
            });
            continue;
          }
          onEvent(event);
        }
      }
    }
  }

  async #pumpStderr(): Promise<void> {
    const td = new TextDecoder();
    const reader = this.#proc.stderr.getReader();
    let carry = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      carry += td.decode(value, { stream: true });
      let idx: number;
      while ((idx = carry.indexOf("\n")) >= 0) {
        const line = carry.slice(0, idx).trim();
        carry = carry.slice(idx + 1);
        if (!line) continue;
        this.stderrTail.push(line.slice(0, 2000));
        if (this.stderrTail.length > STDERR_RING_SIZE) this.stderrTail.shift();
        // info, not debug: worker boot failures must be visible in a default
        // log level or they are undiagnosable in the field.
        logger.info("worker-stderr", line.slice(0, 2000), { sessionId: this.sessionId });
      }
    }
  }

  request<T = unknown>(type: string, payload: unknown, timeoutMs = 120_000): Promise<T> {
    if (this.#exited) return Promise.reject(new Error("The session engine is not running."));
    const requestId = randomUUID();
    const frame = encodeFrame({ protocolVersion: PROTOCOL_VERSION, requestId, type, payload });

    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(requestId);
        reject(new Error(`Session request ${type} timed out.`));
      }, timeoutMs);

      this.#pending.set(requestId, {
        resolve: (v) => {
          clearTimeout(timer);
          resolve(v as T);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });

      this.#proc.stdin.write(frame);
      this.#proc.stdin.flush?.();
    });
  }

  async shutdown(): Promise<void> {
    if (this.#exited) return;
    try {
      await this.request("worker.shutdown", {}, 8_000);
    } catch {
      /* fall through to kill */
    }
    // Give it a beat to exit cleanly, then insist: SIGTERM (the worker's
    // handler disposes MCP/LSP children), and SIGKILL if even that hangs.
    const raced = await Promise.race([
      this.#proc.exited,
      new Promise((r) => setTimeout(() => r("timeout"), 5_000)),
    ]);
    if (raced === "timeout") {
      this.#proc.kill();
      const raced2 = await Promise.race([
        this.#proc.exited,
        new Promise((r) => setTimeout(() => r("timeout"), 4_000)),
      ]);
      if (raced2 === "timeout") this.#proc.kill(9);
    }
  }
}

/** Locate the worker entrypoint for both compiled and development layouts. */
function workerCommand(): string[] {
  // Compiled: the same binary re-execs itself with a worker selector, because
  // a bun --compile bundle has no separate file to point at.
  if (process.env.ORCHESTRATOR_COMPILED === "1") {
    return [process.execPath, "--orchestrator-worker"];
  }
  // Development: run the worker source with the current Bun.
  // fileURLToPath, not new URL().pathname — the latter percent-encodes spaces
  // and any user with a space in their path would get "Module not found".
  const here = dirname(fileURLToPath(import.meta.url));
  return [process.execPath, join(here, "main.ts")];
}

/**
 * Canonical form of a session-file path for identity checks. APFS is
 * case-insensitive: …/Sessions/a.jsonl and …/sessions/a.jsonl are the same
 * file and different strings, so a raw compare is not a single-writer guard.
 */
function canonicalSessionPath(p: string): string {
  try {
    return realpathSync(p).toLowerCase();
  } catch {
    return p.toLowerCase();
  }
}

export class WorkerSupervisor {
  readonly #workers = new Map<string, Worker>();
  /**
   * Workers whose close was requested but whose process has not yet exited.
   * They still hold the session file open — the single-writer guard and
   * openSessionPaths must keep seeing them, or close-then-immediately-reopen
   * puts two writers on one .jsonl.
   */
  readonly #closing = new Map<string, Worker>();
  /** Summaries of sessions whose worker exited, kept for diagnostics/restart. */
  readonly #closed = new Map<string, SessionSummary>();
  readonly #emit: (e: ProductEvent) => void;
  readonly #agentDir: string;
  readonly #env: WorkerSpawnEnv;
  readonly #testMode: boolean;

  constructor(opts: {
    agentDir: string;
    emit: (e: ProductEvent) => void;
    env?: WorkerSpawnEnv;
    testMode?: boolean;
  }) {
    this.#agentDir = opts.agentDir;
    this.#emit = opts.emit;
    this.#env = opts.env ?? {};
    this.#testMode = opts.testMode ?? false;
  }

  async create(config: SessionLaunchConfig): Promise<SessionSummary> {
    const projectPath = config.projectPath;
    if (!existsSync(projectPath) || !statSync(projectPath).isDirectory()) {
      throw Object.assign(new Error(`Project folder not found: ${projectPath}`), {
        kind: "filesystem-permission",
      });
    }

    // Single-writer guarantee: OMP session .jsonl files have NO file lock, and
    // two writers silently lose data. Refuse to open one twice — including
    // while a just-closed worker is still draining (it holds the file until
    // its process actually exits).
    if (config.resumeSessionPath) {
      const wanted = canonicalSessionPath(config.resumeSessionPath);
      for (const w of [...this.#workers.values(), ...this.#closing.values()]) {
        const held = w.summary.ompSessionPath;
        if (held && canonicalSessionPath(held) === wanted) {
          throw Object.assign(
            new Error(
              this.#closing.has(w.sessionId)
                ? "That session is still closing — try again in a moment."
                : "That session is already open in The Orchestrator.",
            ),
            { kind: "session-corruption" },
          );
        }
      }
    }

    const sessionId = randomUUID();
    const summary: SessionSummary = {
      sessionId,
      projectId: projectIdFor(projectPath),
      projectPath,
      title: config.title?.trim() || "New session",
      runState: "starting",
      model: config.model,
      thinkingLevel: config.thinkingLevel,
      advisorCount: (config.advisors ?? []).filter((a) => a.enabled).length,
      messageCount: 0,
      unread: false,
    };

    const boot = {
      sessionId,
      projectId: summary.projectId,
      projectPath,
      agentDir: this.#agentDir,
      title: summary.title,
      // Only a launch config that actually carried a title counts as
      // user-titled — the "New session" placeholder must not suppress
      // auto-titling from the first prompt.
      userTitled: Boolean(config.title?.trim()),
      model: config.model,
      thinkingLevel: config.thinkingLevel,
      advisors: config.advisors ?? [],
      resumeSessionPath: config.resumeSessionPath,
      approvalMode: config.approvalMode,
      fastMode: config.fastMode,
      // MCP and LSP are per-process and always on in normal operation; test
      // mode keeps them off so unit tests don't spawn language servers.
      enableMCP: !this.#testMode,
      enableLsp: !this.#testMode,
      // Tests auto-approve by default so the mock provider can run tools
      // unattended — EXCEPT when a test explicitly exercises the approval
      // bridge by asking for "always-ask". Production is never auto-approve.
      autoApprove: this.#testMode && config.approvalMode !== "always-ask",
      testProviders: this.#env.testProviders,
    };

    const cmd = workerCommand();
    const proc = Bun.spawn(cmd, {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      // Anchor the worker in the project: any OMP fallback to process.cwd()
      // then lands inside the project instead of "/" (Finder-launched apps).
      cwd: projectPath,
      env: {
        ...process.env,
        ORCHESTRATOR_WORKER_BOOT: JSON.stringify(boot),
        // Terminal breadcrumb files are keyed by terminal id and would clobber
        // each other across workers; clearing these makes getTerminalId() null.
        ZELLIJ_PANE_ID: undefined,
        TMUX_PANE: undefined,
        KITTY_WINDOW_ID: undefined,
        WEZTERM_PANE: undefined,
        TERM_SESSION_ID: undefined,
        WT_SESSION: undefined,
      } as Record<string, string | undefined>,
    }) as Bun.Subprocess<"pipe", "pipe", "pipe">;

    const worker = new Worker(
      sessionId,
      summary,
      proc,
      (e) => {
        // Worker-side renames (auto-title from the first prompt, /rename,
        // extensions) must reach the summary too, or sessions.list would
        // keep resurrecting the stale launch title.
        if (e.type === "session.title") summary.title = e.title;
        // Track the session's real model (boot announcement for resumed
        // sessions, upstream fallbacks, explicit switches) — the engine's
        // provider auth gate reads it at prompt time.
        if (e.type === "session.model") {
          summary.model = e.model;
          if (e.thinkingLevel) summary.thinkingLevel = e.thinkingLevel;
        }
        // A self-parked worker is about to exit ON PURPOSE; its exit must not
        // be reported as a crash.
        if (e.type === "session.hibernated") {
          worker.hibernated = true;
          summary.runState = "hibernated";
        }
        this.#emit(e);
      },
      (code) => this.#onWorkerExit(sessionId, code),
    );
    this.#workers.set(sessionId, worker);

    // Wait for the worker's ready handshake so failures surface at create time.
    const deadline = Date.now() + 60_000;
    while (!worker.ready && !worker.exited && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 20));
    }
    if (worker.exited) {
      this.#workers.delete(sessionId);
      throw this.#createFailure(worker);
    }
    if (!worker.ready) {
      await worker.shutdown();
      this.#workers.delete(sessionId);
      throw Object.assign(new Error("The session engine did not become ready in time."), {
        kind: "engine",
      });
    }

    summary.runState = "idle";
    return summary;
  }

  /** Build an actionable error from a worker that died during boot. */
  #createFailure(worker: Worker): Error {
    // The worker writes structured JSON error lines; surface the last message.
    let message = "The session engine failed to start.";
    let kind = "engine";
    for (let i = worker.stderrTail.length - 1; i >= 0; i--) {
      try {
        const parsed = JSON.parse(worker.stderrTail[i]);
        if (parsed?.message) {
          message = `The session engine failed to start: ${parsed.message}`;
          if (typeof parsed.kind === "string") kind = parsed.kind;
          break;
        }
      } catch {
        /* non-JSON stderr line */
      }
    }
    return Object.assign(new Error(message), {
      kind,
      detail: worker.stderrTail.slice(-10).join("\n"),
    });
  }

  /** Remember a closed session's summary, bounded so a long run can't leak. */
  #noteClosed(sessionId: string, summary: SessionSummary): void {
    this.#closed.set(sessionId, summary);
    if (this.#closed.size > 200) {
      const oldest = this.#closed.keys().next().value;
      if (oldest !== undefined) this.#closed.delete(oldest);
    }
  }

  #onWorkerExit(sessionId: string, code: number | null): void {
    const w = this.#workers.get(sessionId);
    if (!w) return;
    // Remove the dead worker so it cannot swallow future routing, but keep the
    // summary for diagnostics and so the UI can offer resume.
    this.#workers.delete(sessionId);
    if (w.hibernated) {
      // Deliberate self-park, already announced as session.hibernated — a
      // clean close, not a failure.
      w.summary.runState = "hibernated";
      this.#noteClosed(sessionId, w.summary);
      logger.info("supervisor", `session worker hibernated`, { sessionId });
      return;
    }
    w.summary.runState = "interrupted";
    this.#noteClosed(sessionId, w.summary);
    logger.warn("supervisor", `session worker exited`, { sessionId, code });
    // Never report an in-flight run as still running once its process died.
    this.#emit({
      type: "session.failed",
      sessionId,
      error: {
        kind: "engine",
        message: "This session's engine stopped unexpectedly. Its transcript is preserved.",
        detail: `worker exit code ${code ?? "signal"}\n${w.stderrTail.slice(-5).join("\n")}`,
        retryable: true,
      },
    });
    this.#emit({ type: "session.finished", sessionId, runState: "interrupted" });
  }

  get(sessionId: string): Worker {
    const w = this.#workers.get(sessionId);
    if (!w) {
      const closed = this.#closed.get(sessionId);
      throw Object.assign(
        new Error(
          closed
            ? "This session's engine has stopped. Resume the session to continue."
            : `Unknown session: ${sessionId}`,
        ),
        { kind: "engine", retryable: Boolean(closed) },
      );
    }
    return w;
  }

  has(sessionId: string): boolean {
    return this.#workers.has(sessionId);
  }

  list(): SessionSummary[] {
    return [...this.#workers.values()].map((w) => w.summary);
  }

  /** Live worker process stats for diagnostics. Cheap ping per worker. */
  async workerStats(): Promise<
    Array<{
      sessionId: string;
      title: string;
      pid?: number;
      runState: string;
      rssBytes?: number;
      uptimeMs?: number;
    }>
  > {
    const rows = await Promise.all(
      [...this.#workers.values()].map(async (w) => {
        let rssBytes: number | undefined;
        let uptimeMs: number | undefined = Date.now() - w.startedAtMs;
        try {
          const ping = await w.request<{ rssBytes?: number; uptimeMs?: number }>(
            "worker.ping",
            {},
            3_000,
          );
          rssBytes = ping.rssBytes;
          uptimeMs = ping.uptimeMs ?? uptimeMs;
        } catch {
          /* a busy worker that misses a ping still gets listed */
        }
        return {
          sessionId: w.sessionId,
          title: w.summary.title,
          pid: w.pid,
          runState: w.summary.runState,
          rssBytes,
          uptimeMs,
        };
      }),
    );
    return rows;
  }

  openSessionPaths(): Set<string> {
    // Closing workers still hold their file open; listing them as open keeps
    // the sidebar from offering a resume that the single-writer guard (and
    // the file itself) cannot yet honour.
    return new Set(
      [...this.#workers.values(), ...this.#closing.values()]
        .map((w) => w.summary.ompSessionPath)
        .filter(Boolean) as string[],
    );
  }

  activeCount(): number {
    return [...this.#workers.values()].filter((w) => {
      const s = w.summary.runState;
      return s !== "idle" && s !== "completed" && s !== "interrupted" && s !== "error";
    }).length;
  }

  /** Route a session-scoped request to its worker. */
  async route<T = unknown>(sessionId: string, type: string, payload: unknown): Promise<T> {
    return this.get(sessionId).request<T>(type, payload);
  }

  /**
   * `_dispose` is accepted for wire compatibility but a close ALWAYS disposes:
   * a non-disposing close would leave a live writer on the session file with
   * no owner in the registry — exactly the two-writer hazard this guards.
   */
  async close(sessionId: string, _dispose: boolean): Promise<void> {
    const w = this.#workers.get(sessionId);
    if (!w) return;
    this.#workers.delete(sessionId);
    // Registered as closing BEFORE shutdown starts: until the process exits it
    // is still a live writer on its session file, and the guards must see it.
    this.#closing.set(sessionId, w);
    this.#noteClosed(sessionId, w.summary);
    try {
      await w.shutdown();
    } finally {
      this.#closing.delete(sessionId);
    }
  }

  /** Parallel shutdown; no worker may be orphaned past the kill deadline. */
  async shutdown(): Promise<void> {
    const all = [...this.#workers.values()];
    this.#workers.clear();
    await Promise.allSettled(all.map((w) => w.shutdown()));
  }

  /** Track the persisted path a worker reports, for single-writer enforcement. */
  noteSessionPersisted(sessionId: string, path: string, ompSessionId: string): void {
    const w = this.#workers.get(sessionId);
    if (!w) return;
    w.summary.ompSessionPath = path;
    w.summary.ompSessionId = ompSessionId;
  }

  noteRunState(sessionId: string, runState: SessionSummary["runState"]): void {
    const w = this.#workers.get(sessionId);
    if (w) w.summary.runState = runState;
  }
}
