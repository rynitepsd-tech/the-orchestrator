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
  listModels,
  listProviders,
  newModelRegistry,
  ompAgentDir,
  openAuthStorage,
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
import { UsageAccumulator } from "@orchestrator/usage";
import { WorkerSupervisor, type WorkerSpawnEnv } from "./worker/supervisor";

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
  readonly #globalUsage = new UsageAccumulator();
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
      env: this.#opts.workerEnv,
      emit: (e) => this.#onSessionEvent(e),
    });
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
      const candidates = Array.isArray(r?.windows) ? r.windows : Array.isArray(r?.limits) ? r.limits : [];
      for (const w of candidates) {
        const used = numOrUndef(w?.used ?? w?.utilization ?? w?.consumed);
        const limit = numOrUndef(w?.limit ?? w?.max ?? w?.total);
        let fraction = numOrUndef(w?.fraction ?? w?.percent);
        if (fraction !== undefined && fraction > 1) fraction = fraction / 100;
        if (fraction === undefined && used !== undefined && limit) fraction = used / limit;
        windows.push({
          label: String(w?.label ?? w?.name ?? w?.window ?? "usage"),
          fraction,
          used,
          limit,
          resetsAt: w?.resetsAt ? String(w.resetsAt) : undefined,
        });
      }
      out.push({
        provider: String(r?.provider ?? r?.name ?? "unknown"),
        accountLabel: r?.accountLabel ? String(r.accountLabel) : undefined,
        windows,
        fetchedAt: r?.fetchedAt ? String(r.fetchedAt) : now,
        unavailableReason: windows.length === 0 ? "Usage limit not reported by provider" : undefined,
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
    this.#globalUsage.clearSession(sessionId);
    await this.#supervisor.close(sessionId, dispose);
  }

  async shutdown(): Promise<void> {
    await this.#supervisor?.shutdown();
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
    this.#opts.emit(e);
  }

  globalUsage(): UsageAccumulator {
    return this.#globalUsage;
  }

  async sessionUsage(sessionId: string): Promise<UsageBreakdown> {
    const res = await this.route<{ breakdown: UsageBreakdown }>(sessionId, "usage.session", {
      sessionId,
    });
    return res.breakdown;
  }
}

function numOrUndef(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}
