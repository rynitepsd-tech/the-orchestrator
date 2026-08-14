/**
 * Engine-wide state.
 *
 * Owns the read-only catalogue (models, providers, quotas, session discovery)
 * in the supervisor process, and delegates every live session to a dedicated
 * worker process via {@link WorkerSupervisor}.
 *
 * This is why `visibleSessionId !== runningSessionIds` is a normal state:
 * session lifetime is tied to a worker process, not to what the UI is showing.
 * Switching sessions in the sidebar never pauses, disposes, or aborts anything.
 */
import {
  discoverAdvisors,
  discoverSessions,
  fetchProviderQuotas,
  forkSessionFile,
  listModels,
  listProviders,
  newModelRegistry,
  ompAgentDir,
  openAuthStorage,
  readSessionFileUsage,
} from "@orchestrator/omp-adapter";
import type {
  AdvisorConfig,
  DiscoveredSession,
  ModelInfo,
  ProductEvent,
  ProviderInfo,
  ProviderQuota,
  SessionLaunchConfig,
  SessionSummary,
  UsageBreakdown,
} from "@orchestrator/protocol";
import { logger } from "./logging";
import { UsageIndex } from "./usage-index";
import { type WorkerSpawnEnv, WorkerSupervisor } from "./worker/supervisor";

export interface RuntimeManagerOptions {
  agentDir?: string;
  emit: (event: ProductEvent) => void;
  /** Test hook: disable MCP/LSP in workers and auto-approve tools. */
  testMode?: boolean;
  /** Test hook: provider registrations injected into each worker. */
  workerEnv?: WorkerSpawnEnv;
}

export class RuntimeManager {
  readonly #opts: RuntimeManagerOptions;
  readonly #usageIndex = new UsageIndex();
  readonly #agentDir: string;
  #supervisor!: WorkerSupervisor;

  #authStorage: unknown;
  #modelRegistry: unknown;
  #modelsCache: ModelInfo[] | null = null;

  constructor(opts: RuntimeManagerOptions) {
    this.#opts = opts;
    this.#agentDir = opts.agentDir ?? ompAgentDir();
  }

  get agentDir(): string {
    return this.#agentDir;
  }

  async init(): Promise<void> {
    // The supervisor process only READS OMP state (catalogue, session list).
    // It never creates an AgentSession, so process-global initializers such as
    // the memoized Settings singleton are never engaged here.
    this.#authStorage = await openAuthStorage(this.#agentDir);
    this.#modelRegistry = newModelRegistry(this.#authStorage as never);
    void (this.#modelRegistry as any)?.refreshInBackground?.();

    this.#supervisor = new WorkerSupervisor({
      agentDir: this.#agentDir,
      testMode: this.#opts.testMode,
      env: this.#opts.workerEnv ?? envTestProviders(),
      emit: (e) => this.#onSessionEvent(e),
    });

    // Non-blocking: the persisted usage index loads off the startup path.
    setTimeout(() => {
      try {
        this.#usageIndex.load();
      } catch {
        /* index rebuilds via reindex */
      }
    }, 0);
  }

  // -------------------------------------------------------------------------
  // Catalogue (read-only, supervisor process)
  // -------------------------------------------------------------------------

  async models(refresh = false): Promise<ModelInfo[]> {
    if (refresh) {
      this.#modelsCache = null;
      try {
        await (this.#modelRegistry as any)?.refresh?.();
      } catch {
        /* keep last-known-good catalogue rather than emptying the picker */
      }
    }
    if (!this.#modelsCache) {
      this.#modelsCache = listModels(this.#modelRegistry as never, this.#authStorage as never);
    }
    return this.#modelsCache;
  }

  async providers(): Promise<ProviderInfo[]> {
    return listProviders(await this.models(), this.#authStorage as never);
  }

  /**
   * Provider subscription/quota.
   *
   * Only what OMP itself reports. Providers without a usage endpoint come back
   * with `unavailableReason` so the UI says so plainly instead of showing 0%.
   */
  async quotas(): Promise<ProviderQuota[]> {
    const raw = await fetchProviderQuotas(this.#authStorage as never);
    const now = new Date().toISOString();
    const out: ProviderQuota[] = [];

    for (const r of raw as any[]) {
      const windows: ProviderQuota["windows"] = [];
      const candidates = Array.isArray(r?.limits)
        ? r.limits
        : Array.isArray(r?.windows)
          ? r.windows
          : [];
      for (const w of candidates) {
        // OMP's UsageLimit nests quantities under `amount` and the reset
        // timestamp under `window` (pi-ai usage.ts). Read those first; the
        // flat fallbacks keep older/foreign report shapes working.
        const amount = (w?.amount ?? {}) as Record<string, unknown>;
        const used = numOrUndef(amount.used ?? w?.used ?? w?.utilization ?? w?.consumed);
        const limit = numOrUndef(amount.limit ?? w?.limit ?? w?.max ?? w?.total);

        // Fraction precedence mirrors pi-ai's resolveUsedFraction: explicit
        // fraction > used/limit > percent-unit used > inverted remaining.
        // A fraction above 1 is genuine overage — never rescale it.
        let fraction = numOrUndef(amount.usedFraction);
        if (fraction === undefined && used !== undefined && limit) fraction = used / limit;
        if (fraction === undefined && amount.unit === "percent" && used !== undefined) {
          fraction = used / 100;
        }
        if (fraction === undefined) {
          const remaining = numOrUndef(amount.remainingFraction);
          if (remaining !== undefined) fraction = Math.max(0, 1 - remaining);
        }
        if (fraction === undefined) {
          // Legacy flat shapes reported percent as 0..100.
          let legacy = numOrUndef(w?.fraction ?? w?.percent);
          if (legacy !== undefined && legacy > 1) legacy = legacy / 100;
          fraction = legacy;
        }

        const resetsMs = numOrUndef(w?.window?.resetsAt ?? w?.resetsAt);
        windows.push({
          label: String(w?.label ?? w?.window?.label ?? w?.name ?? "usage"),
          fraction,
          used,
          limit,
          resetsAt: resetsMs !== undefined ? new Date(resetsMs).toISOString() : undefined,
        });
      }
      const fetchedMs = numOrUndef(r?.fetchedAt);
      out.push({
        provider: String(r?.provider ?? r?.name ?? "unknown"),
        accountLabel: r?.accountLabel ? String(r.accountLabel) : undefined,
        windows,
        fetchedAt: fetchedMs !== undefined ? new Date(fetchedMs).toISOString() : now,
        unavailableReason:
          windows.length === 0 ? "Usage limit not reported by provider" : undefined,
      });
    }
    return out;
  }

  // -------------------------------------------------------------------------
  // Discovery
  // -------------------------------------------------------------------------

  async discoverSessions(projectPath?: string): Promise<DiscoveredSession[]> {
    const found = await discoverSessions(projectPath);
    const open = this.#supervisor.openSessionPaths();
    for (const s of found) s.openInThisApp = open.has(s.path);
    return found;
  }

  async projectAdvisors(projectPath: string): Promise<AdvisorConfig[]> {
    return discoverAdvisors(projectPath, this.#agentDir);
  }

  // -------------------------------------------------------------------------
  // Provider onboarding
  // -------------------------------------------------------------------------

  /**
   * OAuth sign-in through OMP's own flow (AuthStorage.login, pi-ai).
   *
   * The engine never opens a browser: `onAuth` surfaces the authorization URL
   * as a lifecycle event and the host opens it. Secrets never transit the
   * protocol — the loopback callback completes inside OMP's storage.
   *
   * Providers without a programmatic flow reject with an actionable message.
   */
  async login(
    provider: string,
    emitLifecycle: (e: {
      type: "engine.auth";
      provider: string;
      status: "browser" | "progress" | "prompt" | "done" | "failed";
      url?: string;
      message?: string;
    }) => void,
  ): Promise<{ ok: boolean; message?: string; requiresBrowser?: string }> {
    const auth: any = this.#authStorage;
    if (typeof auth?.login !== "function") {
      throw Object.assign(
        new Error(
          "This OMP build does not expose a programmatic sign-in flow. Run `omp` once in a terminal; The Orchestrator reuses those credentials.",
        ),
        { kind: "auth" },
      );
    }
    try {
      const identity = await auth.login(provider, {
        onAuth: (info: { url?: string; launchUrl?: string; instructions?: string }) => {
          emitLifecycle({
            type: "engine.auth",
            provider,
            status: "browser",
            url: String(info?.launchUrl ?? info?.url ?? ""),
            message: info?.instructions ? String(info.instructions) : undefined,
          });
        },
        onProgress: (message: string) => {
          emitLifecycle({
            type: "engine.auth",
            provider,
            status: "progress",
            message: String(message),
          });
        },
        // Manual code entry is not bridged in this build; surface it honestly
        // instead of hanging on a prompt nobody can see.
        onPrompt: async () => {
          emitLifecycle({
            type: "engine.auth",
            provider,
            status: "failed",
            message:
              "This provider's flow needs manual code entry, which the GUI does not support yet. Run `omp` in a terminal instead.",
          });
          throw new Error("Manual code entry is not supported in the GUI sign-in flow.");
        },
      });
      // Fresh credentials change what the catalogue considers available.
      this.#modelsCache = null;
      try {
        await (this.#modelRegistry as any)?.refresh?.();
      } catch {
        /* catalogue refresh is best-effort */
      }
      emitLifecycle({ type: "engine.auth", provider, status: "done" });
      return {
        ok: true,
        message: identity
          ? `Connected as ${String(identity?.label ?? identity?.email ?? provider)}`
          : "Connected.",
      };
    } catch (e) {
      const message = String((e as Error)?.message ?? e);
      emitLifecycle({ type: "engine.auth", provider, status: "failed", message });
      throw Object.assign(new Error(`Sign-in with ${provider} failed: ${message}`), {
        kind: "auth",
      });
    }
  }

  // -------------------------------------------------------------------------
  // Sessions (delegated to worker processes)
  // -------------------------------------------------------------------------

  create(config: SessionLaunchConfig): Promise<SessionSummary> {
    return this.#supervisor.create(config);
  }

  list(): SessionSummary[] {
    return this.#supervisor.list();
  }

  has(sessionId: string): boolean {
    return this.#supervisor.has(sessionId);
  }

  activeCount(): number {
    return this.#supervisor.activeCount();
  }

  /** Forward a session-scoped request to the owning worker. */
  route<T = unknown>(sessionId: string, type: string, payload: unknown): Promise<T> {
    return this.#supervisor.route<T>(sessionId, type, payload);
  }

  async close(sessionId: string, dispose: boolean): Promise<void> {
    // Deliberately does NOT clear the session's rows from the usage index:
    // closing a session is a UI action; the tokens were still spent.
    await this.#supervisor.close(sessionId, dispose);
  }

  async shutdown(): Promise<void> {
    await this.#supervisor?.shutdown();
    this.#usageIndex.flush();
  }

  // -------------------------------------------------------------------------
  // Usage
  // -------------------------------------------------------------------------

  /**
   * Mirror worker usage into the engine-wide index.
   *
   * Workers emit full breakdowns; the index keeps raw records so the Usage
   * centre can filter and re-aggregate without asking every worker again.
   */
  #onSessionEvent(e: ProductEvent): void {
    if (e.type === "session.persisted") {
      this.#supervisor.noteSessionPersisted(e.sessionId, e.ompSessionPath, e.ompSessionId);
    }
    if (e.type === "session.state") {
      this.#supervisor.noteRunState(e.sessionId, e.runState);
    }
    if (e.type === "session.finished") {
      this.#supervisor.noteRunState(e.sessionId, e.runState);
    }
    if (e.type === "usage.records") {
      // Mirror worker records into the persistent engine-wide index.
      this.#usageIndex.ingest(e.records);
    }
    this.#opts.emit(e);
  }

  usageIndex(): UsageIndex {
    return this.#usageIndex;
  }

  /**
   * Fork a session file with upstream semantics and open the fork as a new
   * live session in its own worker. The source is only read, never mutated.
   */
  async fork(opts: {
    sourcePath: string;
    projectPath: string;
    title?: string;
    model?: string;
    thinkingLevel?: string;
    advisors?: SessionLaunchConfig["advisors"];
  }): Promise<SessionSummary> {
    const forked = await forkSessionFile(
      opts.sourcePath,
      opts.projectPath,
      this.#agentDir,
      opts.title,
    );
    if (!forked.path) {
      throw Object.assign(new Error("Fork produced no session file."), {
        kind: "session-corruption",
      });
    }
    return this.create({
      projectPath: opts.projectPath,
      title: opts.title,
      model: opts.model,
      thinkingLevel: opts.thinkingLevel,
      advisors: opts.advisors ?? [],
      resumeSessionPath: forked.path,
    });
  }

  /**
   * Rebuild the usage index from OMP's persisted session files. Authoritative
   * (`omp-session` source outranks live counters); global responseId identity
   * makes re-running this idempotent and fork-safe.
   */
  async reindexUsage(): Promise<{ indexed: number; durationMs: number }> {
    const startedAt = Date.now();
    let indexed = 0;
    const sessions = await discoverSessions(undefined);
    for (const s of sessions) {
      const usage = await readSessionFileUsage(s.path);
      if (!usage) continue;
      indexed += this.#usageIndex.ingest(usage.records);
    }
    const durationMs = Date.now() - startedAt;
    logger.info("usage-index", `reindexed ${sessions.length} sessions`, { indexed, durationMs });
    return { indexed, durationMs };
  }

  async sessionUsage(sessionId: string): Promise<UsageBreakdown> {
    const res = await this.route<{ breakdown: UsageBreakdown }>(sessionId, "usage.session", {
      sessionId,
    });
    return res.breakdown;
  }

  workerStats(): ReturnType<WorkerSupervisor["workerStats"]> {
    return this.#supervisor.workerStats();
  }

  supervisor(): WorkerSupervisor {
    return this.#supervisor;
  }
}

function numOrUndef(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

/**
 * Test-only provider injection.
 *
 * Lets the PACKAGED smoke test drive a real session against a local mock
 * provider, so packaging can be verified end to end without spending API
 * credit. Ignored unless the variable is present, so it is inert in normal use.
 */
function envTestProviders(): { testProviders?: WorkerSpawnEnv["testProviders"] } | undefined {
  const raw = process.env.ORCHESTRATOR_TEST_PROVIDERS;
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? { testProviders: parsed } : undefined;
  } catch {
    return undefined;
  }
}
