/**
 * Owns every live session in the engine process.
 *
 * The manager is the reason `visibleSessionId !== runningSessionIds` is a
 * normal, supported state: it keeps runtimes alive independently of the UI's
 * selection, so switching sessions in the sidebar never pauses, disposes, or
 * aborts anything.
 */
import { randomUUID } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import {
  discoverAdvisors,
  discoverSessions,
  fetchProviderQuotas,
  listModels,
  listProviders,
  newModelRegistry,
  ompAgentDir,
  openAuthStorage,
  projectIdFor,
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
} from "@orchestrator/protocol";
import { UsageAccumulator } from "@orchestrator/usage";
import { SessionRuntime } from "./session-runtime";

export interface RuntimeManagerOptions {
  agentDir?: string;
  emit: (event: ProductEvent) => void;
  /** Test hook: skip MCP/LSP startup and auto-approve tools. */
  testMode?: boolean;
  /** Test hook: inject a prepared model registry instead of discovering one. */
  modelRegistryOverride?: unknown;
}

export class RuntimeManager {
  readonly #sessions = new Map<string, SessionRuntime>();
  readonly #opts: RuntimeManagerOptions;
  readonly #globalUsage = new UsageAccumulator();

  #authStorage: unknown;
  #modelRegistry: unknown;
  #agentDir: string;
  #modelsCache: ModelInfo[] | null = null;

  constructor(opts: RuntimeManagerOptions) {
    this.#opts = opts;
    this.#agentDir = opts.agentDir ?? ompAgentDir();
  }

  get agentDir(): string {
    return this.#agentDir;
  }

  async init(): Promise<void> {
    if (this.#opts.modelRegistryOverride) {
      this.#modelRegistry = this.#opts.modelRegistryOverride;
      // Upstream requires options.authStorage to be the SAME instance as
      // modelRegistry.authStorage, so adopt the registry's rather than opening
      // a second one.
      this.#authStorage =
        (this.#modelRegistry as any).authStorage ?? (await openAuthStorage(this.#agentDir));
    } else {
      this.#authStorage = await openAuthStorage(this.#agentDir);
      this.#modelRegistry = newModelRegistry(this.#authStorage as never);
    }
    // Warm the catalogue in the background; never block opening a conversation.
    void (this.#modelRegistry as any)?.refreshInBackground?.();
  }

  // -------------------------------------------------------------------------
  // Catalogue
  // -------------------------------------------------------------------------

  async models(refresh = false): Promise<ModelInfo[]> {
    if (refresh) {
      this.#modelsCache = null;
      try {
        await (this.#modelRegistry as any)?.refresh?.();
      } catch {
        /* keep last-known-good catalogue */
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
   * Only reports what OMP itself exposes. Providers that report nothing come
   * back with `unavailableReason` so the UI can say so plainly instead of
   * inventing a percentage.
   */
  async quotas(): Promise<ProviderQuota[]> {
    const raw = await fetchProviderQuotas(this.#authStorage as never);
    const now = new Date().toISOString();
    const out: ProviderQuota[] = [];

    for (const r of raw as any[]) {
      const provider = String(r?.provider ?? r?.name ?? "unknown");
      const windows: ProviderQuota["windows"] = [];
      const candidates = Array.isArray(r?.windows)
        ? r.windows
        : Array.isArray(r?.limits)
          ? r.limits
          : [];
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
        provider,
        accountLabel: r?.accountLabel ? String(r.accountLabel) : undefined,
        windows,
        fetchedAt: now,
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
    const openPaths = new Set(
      [...this.#sessions.values()].map((s) => s.ompSessionPath).filter(Boolean) as string[],
    );
    for (const s of found) s.openInThisApp = openPaths.has(s.path);
    return found;
  }

  async projectAdvisors(projectPath: string): Promise<AdvisorConfig[]> {
    return discoverAdvisors(projectPath, this.#agentDir);
  }

  // -------------------------------------------------------------------------
  // Session lifecycle
  // -------------------------------------------------------------------------

  async create(config: SessionLaunchConfig): Promise<SessionSummary> {
    const projectPath = config.projectPath;
    if (!existsSync(projectPath) || !statSync(projectPath).isDirectory()) {
      throw Object.assign(new Error(`Project folder not found: ${projectPath}`), {
        kind: "filesystem-permission",
      });
    }

    // Refuse to open the same persisted OMP session twice. Upstream gives no
    // cross-process lock, so concurrent writers risk corrupting the transcript.
    if (config.resumeSessionPath) {
      const clash = [...this.#sessions.values()].find(
        (s) => s.ompSessionPath === config.resumeSessionPath,
      );
      if (clash) {
        throw Object.assign(
          new Error("That session is already open in The Orchestrator."),
          { kind: "session-corruption" },
        );
      }
    }

    const sessionId = randomUUID();
    const model = config.model ? this.#resolveModel(config.model) : undefined;

    const runtime = new SessionRuntime({
      sessionId,
      projectId: projectIdFor(projectPath),
      projectPath,
      title: config.title?.trim() || "New session",
      agentDir: this.#agentDir,
      authStorage: this.#authStorage,
      modelRegistry: this.#modelRegistry,
      model,
      modelKey: config.model,
      thinkingLevel: config.thinkingLevel,
      advisors: config.advisors ?? [],
      approvalMode: config.approvalMode,
      resumeSessionPath: config.resumeSessionPath,
      autoApprove: this.#opts.testMode === true,
      enableMCP: this.#opts.testMode ? false : true,
      enableLsp: this.#opts.testMode ? false : true,
      emit: (e) => this.#onSessionEvent(e),
    });

    await runtime.start();
    this.#sessions.set(sessionId, runtime);
    return runtime.summary();
  }

  #resolveModel(modelKey: string): unknown {
    const idx = modelKey.indexOf("/");
    if (idx < 0) return undefined;
    const provider = modelKey.slice(0, idx);
    const id = modelKey.slice(idx + 1);
    try {
      return (this.#modelRegistry as any)?.find?.(provider, id);
    } catch {
      return undefined;
    }
  }

  #onSessionEvent(e: ProductEvent): void {
    // Mirror per-session usage into the global index for the Usage centre.
    if (e.type === "usage.update") {
      const rt = this.#sessions.get(e.sessionId);
      if (rt) this.#globalUsage.ingestMany(rt.usageRecords?.() ?? []);
    }
    this.#opts.emit(e);
  }

  get(sessionId: string): SessionRuntime {
    const s = this.#sessions.get(sessionId);
    if (!s) throw new Error(`Unknown session: ${sessionId}`);
    return s;
  }

  has(sessionId: string): boolean {
    return this.#sessions.has(sessionId);
  }

  list(): SessionSummary[] {
    return [...this.#sessions.values()].map((s) => s.summary());
  }

  /** Sessions currently doing work — used for the quit confirmation. */
  activeCount(): number {
    return [...this.#sessions.values()].filter((s) => {
      const st = s.runState;
      return st !== "idle" && st !== "completed" && st !== "interrupted" && st !== "error";
    }).length;
  }

  async close(sessionId: string, dispose: boolean): Promise<void> {
    const s = this.#sessions.get(sessionId);
    if (!s) return;
    this.#sessions.delete(sessionId);
    if (dispose) await s.dispose();
  }

  /** Ordered shutdown: stop accepting work, then dispose every runtime. */
  async shutdown(): Promise<void> {
    const all = [...this.#sessions.values()];
    this.#sessions.clear();
    await Promise.allSettled(all.map((s) => s.dispose()));
  }

  globalUsage(): UsageAccumulator {
    return this.#globalUsage;
  }
}

function numOrUndef(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}
