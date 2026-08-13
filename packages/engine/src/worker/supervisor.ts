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
import { existsSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  encodeFrame,
  FrameDecoder,
  PROTOCOL_VERSION,
  type ProductEvent,
  type SessionLaunchConfig,
  type SessionSummary,
} from "@orchestrator/protocol";
import { projectIdFor } from "@orchestrator/omp-adapter";
import { logger } from "../logging";

export interface WorkerSpawnEnv {
  /** Extra provider registrations for tests. */
  testProviders?: Array<{ name: string; baseUrl: string; apiKey: string; modelIds: string[] }>;
}

interface PendingRequest {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
}

class Worker {
  readonly sessionId: string;
  readonly summary: SessionSummary;
  readonly #proc: Bun.Subprocess<"pipe", "pipe", "pipe">;
  readonly #decoder = new FrameDecoder();
  readonly #pending = new Map<string, PendingRequest>();
  #ready = false;
  #exited = false;

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
      const { frames } = this.#decoder.push(td.decode(value, { stream: true }));
      for (const f of frames) {
        const frame = f as any;
        if (frame.workerReady) {
          this.#ready = true;
          continue;
        }
        if (frame.requestId) {
          const p = this.#pending.get(frame.requestId);
          if (p) {
            this.#pending.delete(frame.requestId);
            if (frame.ok) p.resolve(frame.result);
            else p.reject(Object.assign(new Error(frame.error?.message ?? "worker error"), frame.error));
          }
          continue;
        }
        if (frame.event) onEvent(frame.event as ProductEvent);
      }
    }
  }

  async #pumpStderr(): Promise<void> {
    const td = new TextDecoder();
    const reader = this.#proc.stderr.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      for (const line of td.decode(value, { stream: true }).split("\n")) {
        if (line.trim()) logger.debug("worker", line.slice(0, 2000), { sessionId: this.sessionId });
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
    // Give it a beat to exit cleanly, then insist.
    const raced = await Promise.race([
      this.#proc.exited,
      new Promise((r) => setTimeout(() => r("timeout"), 5_000)),
    ]);
    if (raced === "timeout") this.#proc.kill();
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

export class WorkerSupervisor {
  readonly #workers = new Map<string, Worker>();
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
    // two writers silently lose data. Refuse to open one twice.
    if (config.resumeSessionPath) {
      for (const w of this.#workers.values()) {
        if (w.summary.ompSessionPath === config.resumeSessionPath) {
          throw Object.assign(new Error("That session is already open in The Orchestrator."), {
            kind: "session-corruption",
          });
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
      model: config.model,
      thinkingLevel: config.thinkingLevel,
      advisors: config.advisors ?? [],
      resumeSessionPath: config.resumeSessionPath,
      // MCP and LSP are per-process now; keep them off in tests and opt-in
      // elsewhere so N sessions do not spawn N language servers unasked.
      enableMCP: this.#testMode ? false : true,
      enableLsp: this.#testMode ? false : true,
      autoApprove: this.#testMode,
      testProviders: this.#env.testProviders,
    };

    const cmd = workerCommand();
    const proc = Bun.spawn(cmd, {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
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
      (e) => this.#emit(e),
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
      throw Object.assign(new Error("The session engine failed to start."), { kind: "engine" });
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

  #onWorkerExit(sessionId: string, code: number | null): void {
    const w = this.#workers.get(sessionId);
    if (!w) return;
    // Never report an in-flight run as still running once its process died.
    w.summary.runState = "interrupted";
    logger.warn("supervisor", `session worker exited`, { sessionId, code });
    this.#emit({
      type: "session.failed",
      sessionId,
      error: {
        kind: "engine",
        message: "This session's engine stopped unexpectedly. Its transcript is preserved.",
        detail: `worker exit code ${code ?? "signal"}`,
        retryable: true,
      },
    });
    this.#emit({ type: "session.finished", sessionId, runState: "interrupted" });
  }

  get(sessionId: string): Worker {
    const w = this.#workers.get(sessionId);
    if (!w) throw new Error(`Unknown session: ${sessionId}`);
    return w;
  }

  has(sessionId: string): boolean {
    return this.#workers.has(sessionId);
  }

  list(): SessionSummary[] {
    return [...this.#workers.values()].map((w) => w.summary);
  }

  openSessionPaths(): Set<string> {
    return new Set(
      [...this.#workers.values()].map((w) => w.summary.ompSessionPath).filter(Boolean) as string[],
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

  async close(sessionId: string, dispose: boolean): Promise<void> {
    const w = this.#workers.get(sessionId);
    if (!w) return;
    this.#workers.delete(sessionId);
    if (dispose) await w.shutdown();
  }

  /** Ordered shutdown so no worker is orphaned. */
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
