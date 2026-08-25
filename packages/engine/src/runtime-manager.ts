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
  listDisabledProviderCauses,
  listModels,
  listProviders,
  newModelRegistry,
  ompAgentDir,
  openAuthStorage,
  providerAuthHealth,
  readSessionFileUsage,
  relocateProjectSessions,
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
import { type AuthLifecycleEvent, createLoginController, type LoginController } from "./auth-login";
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
    const out = listProviders(await this.models(), this.#authStorage as never);
    // Attach tombstone causes so an auto-disabled sign-in (expired OAuth
    // grant) reads as "sign-in expired" in the UI, not "never connected".
    try {
      const causes = await listDisabledProviderCauses(this.#authStorage as never);
      for (const p of out) {
        if (!p.authenticated && causes.has(p.name)) p.disabledCause = causes.get(p.name);
      }
    } catch {
      /* tombstones are advisory; the list itself must never fail over them */
    }
    return out;
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

  /**
   * Re-home persisted sessions after their project folder moved on disk.
   * Sessions with a live worker are skipped — the single-writer rule that
   * guards resume applies to relocation too.
   */
  async relocateSessions(
    fromCwd: string,
    toCwd: string,
  ): Promise<{ moved: Array<{ from: string; to: string }>; skipped: string[]; errors: string[] }> {
    return relocateProjectSessions(fromCwd, toCwd, this.#supervisor.openSessionPaths());
  }

  async projectAdvisors(projectPath: string): Promise<AdvisorConfig[]> {
    return discoverAdvisors(projectPath, this.#agentDir);
  }

  // -------------------------------------------------------------------------
  // Provider onboarding
  // -------------------------------------------------------------------------

  /** Login controllers with outstanding UI prompts, keyed by promptId. */
  readonly #loginControllers = new Map<string, LoginController>();

  /**
   * Sign-in through OMP's own flow (AuthStorage.login, pi-ai).
   *
   * The engine never opens a browser: `onAuth` surfaces the authorization URL
   * as a lifecycle event and the host opens it. Questions from the flow (API
   * keys, paste-code fallback) are bridged to the UI as "prompt" lifecycle
   * events and answered via {@link answerLoginPrompt}. Secrets never transit
   * logs — prompt answers ride requests, which are not logged.
   *
   * `apiKey` short-circuits the flow for providers with no login at all:
   * the key is stored directly through OMP's credential store, the same shape
   * `AuthStorage.login` itself stores for key-returning flows.
   */
  async login(
    provider: string,
    emitLifecycle: (e: AuthLifecycleEvent) => void,
    apiKey?: string,
  ): Promise<{ ok: boolean; message?: string; requiresBrowser?: string }> {
    const auth: any = this.#authStorage;
    try {
      if (apiKey !== undefined) {
        const key = apiKey.trim();
        if (!key) {
          throw Object.assign(new Error("The API key is empty."), { kind: "auth" });
        }
        if (typeof auth?.set !== "function") {
          throw Object.assign(new Error("This OMP build does not expose credential storage."), {
            kind: "auth",
          });
        }
        await auth.set(provider, { type: "api_key", key, source: "login" });
        await this.#afterCredentialChange();
        emitLifecycle({ type: "engine.auth", provider, status: "done" });
        return { ok: true, message: "API key saved." };
      }

      if (typeof auth?.login !== "function") {
        throw Object.assign(
          new Error(
            "This OMP build does not expose a programmatic sign-in flow. Run `omp` once in a terminal; The Orchestrator reuses those credentials.",
          ),
          { kind: "auth" },
        );
      }

      const controller = createLoginController(provider, (e) => {
        if (e.status === "prompt" && e.promptId) {
          this.#loginControllers.set(e.promptId, controller);
        }
        emitLifecycle(e);
      });
      try {
        const loginPromise: Promise<any> = auth.login(provider, controller.ctrl);
        // When `failure` wins the race, OMP's own rejection is a wrapped
        // cancellation — observe it so it never surfaces as unhandled.
        loginPromise.catch(() => {});
        const identity = await Promise.race([loginPromise, controller.failure]);
        await this.#afterCredentialChange();
        emitLifecycle({ type: "engine.auth", provider, status: "done" });
        return {
          ok: true,
          message: identity
            ? `Connected as ${String(identity?.label ?? identity?.email ?? provider)}`
            : "Connected.",
        };
      } finally {
        for (const [id, c] of this.#loginControllers) {
          if (c === controller) this.#loginControllers.delete(id);
        }
      }
    } catch (e) {
      const message = String((e as Error)?.message ?? e);
      emitLifecycle({ type: "engine.auth", provider, status: "failed", message });
      throw Object.assign(new Error(`Sign-in with ${provider} failed: ${message}`), {
        kind: "auth",
      });
    }
  }

  /** Deliver a UI answer to a login prompt. False when the prompt is stale. */
  answerLoginPrompt(promptId: string, answer: string | undefined, cancel: boolean): boolean {
    const controller = this.#loginControllers.get(promptId);
    if (!controller) return false;
    this.#loginControllers.delete(promptId);
    return controller.answerPrompt(promptId, answer, cancel);
  }

  /**
   * Remove a provider's stored credentials through OMP's own store.
   *
   * The store is shared with the CLI, so this signs out `omp` too — the UI
   * says so before asking. Credentials supplied by environment variables are
   * not stored and survive removal; the message reports that honestly instead
   * of pretending the provider is gone.
   */
  async logout(provider: string): Promise<{ ok: boolean; message?: string }> {
    const auth: any = this.#authStorage;
    const remove = auth?.logout ?? auth?.remove;
    if (typeof remove !== "function") {
      throw Object.assign(
        new Error(
          "This OMP build does not expose credential removal. Run `omp logout` in a terminal.",
        ),
        { kind: "auth" },
      );
    }
    await remove.call(auth, provider);
    await this.#afterCredentialChange();
    const still = (await this.providers()).find((p) => p.name === provider);
    return {
      ok: true,
      message: still?.authenticated
        ? `Stored credentials removed, but ${provider} is still configured via ${still.credentialSource ?? "the environment"}.`
        : `Disconnected ${provider}.`,
    };
  }

  /** Fresh credentials change what the catalogue considers available. */
  async #afterCredentialChange(): Promise<void> {
    this.#modelsCache = null;
    try {
      await (this.#modelRegistry as any)?.refresh?.();
    } catch {
      /* catalogue refresh is best-effort */
    }
  }

  // -------------------------------------------------------------------------
  // Sessions (delegated to worker processes)
  // -------------------------------------------------------------------------

  /**
   * The provider auth gate.
   *
   * Refuses any action that would run inference through a provider with no
   * usable credentials. This exists because a dead OAuth grant does NOT mean
   * requests fail: OMP falls back to the stale access token, and Anthropic
   * has been observed accepting it while silently billing the org's prepaid
   * API credits instead of the subscription (2026-08-25 incident). Failing
   * loudly here is the only place the product can make that impossible.
   *
   * Providers authenticated via API key or env var pass: explicit per-token
   * billing the user set up themselves is allowed. Test-double providers
   * registered through workerEnv are exempt — their keys live only in the
   * worker's registry, which this storage cannot see.
   */
  async assertProvidersUsable(modelKeys: Array<string | undefined>, action: string): Promise<void> {
    const testProviders =
      this.#opts.workerEnv?.testProviders ?? envTestProviders()?.testProviders ?? [];
    const exempt = new Set(testProviders.map((p) => p.name));
    const providers = new Set<string>();
    for (const key of modelKeys) {
      if (!key) continue;
      const i = key.indexOf("/");
      // A bare model id carries no provider to check; the worker's own
      // resolution decides, and the prompt-time gate re-checks with the
      // resolved key it announces at boot.
      if (i <= 0) continue;
      const provider = key.slice(0, i);
      if (!exempt.has(provider)) providers.add(provider);
    }
    for (const provider of providers) {
      const health = await providerAuthHealth(this.#authStorage as never, provider);
      if (health.usable) continue;
      const expired = /expired|refresh|revoked/i.test(health.disabledCause ?? "");
      throw Object.assign(
        new Error(
          `${
            expired
              ? `Your ${provider} sign-in has expired.`
              : `${provider} has no usable credentials.`
          } ${action} is blocked so requests cannot silently bill API credits. ` +
            `Reconnect ${provider} in Settings → Providers (or \`omp login ${provider}\`), then try again.`,
        ),
        {
          kind: "auth",
          provider,
          ...(health.disabledCause ? { detail: health.disabledCause } : {}),
        },
      );
    }
  }

  /** Prompt-time gate for a live session, keyed off its announced model. */
  async assertSessionProvidersUsable(sessionId: string): Promise<void> {
    const s = this.list().find((x) => x.sessionId === sessionId);
    await this.assertProvidersUsable([s?.model], "Sending this message");
  }

  async create(config: SessionLaunchConfig): Promise<SessionSummary> {
    await this.assertProvidersUsable(
      [config.model, ...(config.advisors ?? []).filter((a) => a.enabled).map((a) => a.model)],
      "Starting this session",
    );
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
    // Flush BEFORE worker teardown: if the host loses patience and kills the
    // process mid-shutdown, the debounced usage records must already be on
    // disk — they are the one thing here that cannot be rebuilt.
    this.#usageIndex.flush();
    await this.#supervisor?.shutdown();
    // Workers may have shared final records while they drained.
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
      // Reconcile this one session against its persisted file: upgrades the
      // live counters to omp-session authority without waiting for a manual
      // reindex. Single-file streaming read; failures never affect the turn.
      const s = this.list().find((x) => x.sessionId === e.sessionId);
      if (s?.ompSessionPath) {
        const path = s.ompSessionPath;
        const title = s.title;
        void readSessionFileUsage(path)
          .then((usage) => {
            if (!usage) return;
            const records = usage.records.map((r) => ({
              ...r,
              sessionTitle: usage.title ?? title,
            }));
            this.#usageIndex.ingest(records);
          })
          .catch(() => {});
      }
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
      // Carry the parsed title so "By session" can show a name, not an id.
      const records = usage.title
        ? usage.records.map((r) => ({ ...r, sessionTitle: usage.title }))
        : usage.records;
      indexed += this.#usageIndex.ingest(records);
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
 * credit. An env var that registers an arbitrary provider endpoint is an
 * exfiltration channel if anything persistent (e.g. a prompt-injected agent
 * running launchctl setenv) can set it — so the Tauri shell scrubs it from
 * the engine's environment at spawn. Only direct spawns (tests, the packaged
 * smoke script) can reach this hook.
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
