/**
 * Discovery of the user's existing OMP environment.
 *
 * The product rule: The Orchestrator and the OMP CLI are two interfaces over
 * ONE environment. Everything here reads what OMP already owns — credentials,
 * models, sessions, advisors, MCP, skills — and never creates a competing store.
 */
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { basename, resolve } from "node:path";
import { promisify } from "node:util";
// Same exact version as pi-coding-agent's own pi-ai dependency (both pinned),
// so this resolves to the one shared registry instance.
import { getProviderDefinition } from "@oh-my-pi/pi-ai";
import * as OMP from "@oh-my-pi/pi-coding-agent";
import {
  type AuthStorage,
  discoverAuthStorage,
  ModelRegistry,
  SessionManager,
  Settings,
} from "@oh-my-pi/pi-coding-agent";
import {
  type AdvisorConfig,
  type DiscoveredSession,
  fromOmpAdvisorSelector,
  type GitChanges,
  type GitDiff,
  type ModelInfo,
  type ProjectInfo,
  type ProviderInfo,
} from "@orchestrator/protocol";

const exec = promisify(execFile);

/** OMP's agent directory (~/.omp/agent unless overridden). */
export function ompAgentDir(): string {
  return (OMP as any).getAgentDir();
}

/** The version of the OMP SDK actually loaded at runtime. */
export function ompVersion(): string {
  try {
    // OMP exports its own VERSION constant — the only lookup that survives
    // bundling into the compiled engine binary (package.json isn't in the
    // exports map, so requiring it throws and reported "unknown" forever).
    const v = (OMP as any).VERSION;
    return v ? String(v) : "unknown";
  } catch {
    return "unknown";
  }
}

export async function openAuthStorage(agentDir = ompAgentDir()): Promise<AuthStorage> {
  return discoverAuthStorage(agentDir);
}

// ---------------------------------------------------------------------------
// Models & providers
// ---------------------------------------------------------------------------

/**
 * Normalize OMP's model catalogue.
 *
 * `thinking` is taken verbatim from the model, never invented — the new-session
 * sheet must only offer effort levels the selected model actually supports.
 */
export function listModels(registry: ModelRegistry, auth: AuthStorage): ModelInfo[] {
  const all = registry.getAll() as any[];
  const authCache = new Map<string, boolean>();

  const isAuthed = (provider: string): boolean => {
    const hit = authCache.get(provider);
    if (hit !== undefined) return hit;
    let ok = false;
    try {
      ok = Boolean((auth as any).hasAuth?.(provider) ?? (auth as any).has?.(provider));
    } catch {
      ok = false;
    }
    authCache.set(provider, ok);
    return ok;
  };

  return all.map((m) => ({
    key: `${m.provider}/${m.id}`,
    id: String(m.id),
    name: String(m.name ?? m.id),
    provider: String(m.provider),
    api: m.api ? String(m.api) : undefined,
    reasoning: Boolean(m.reasoning),
    contextWindow: Number(m.contextWindow ?? 0),
    maxTokens: Number(m.maxTokens ?? 0),
    thinking:
      m.thinking && Array.isArray(m.thinking.efforts)
        ? { mode: String(m.thinking.mode ?? "effort"), efforts: m.thinking.efforts.map(String) }
        : undefined,
    input: Array.isArray(m.input) ? m.input.map(String) : ["text"],
    cost: m.cost
      ? {
          input: Number(m.cost.input ?? 0),
          output: Number(m.cost.output ?? 0),
          cacheRead: Number(m.cost.cacheRead ?? 0),
          cacheWrite: Number(m.cost.cacheWrite ?? 0),
        }
      : undefined,
    authenticated: isAuthed(String(m.provider)),
  }));
}

/**
 * How a provider connects.
 *
 * "subscription": a real OAuth token flow (login + refreshToken in OMP's
 * registry) — sign in with an existing plan (Claude Pro/Max, ChatGPT,
 * Copilot, Gemini…), billed to the subscription, no API key involved.
 * "interactive": has a login flow, but it is key-based — OMP opens the
 * provider's key console and prompts for a pasted key (per-token billing).
 * "api-key": no login flow at all; a pasted key is stored directly.
 */
export function providerConnectKind(name: string): "subscription" | "interactive" | "api-key" {
  try {
    const def = (
      getProviderDefinition as (
        id: string,
      ) => { login?: unknown; refreshToken?: unknown } | undefined
    )(name);
    if (typeof def?.login !== "function") return "api-key";
    return typeof def.refreshToken === "function" ? "subscription" : "interactive";
  } catch {
    return "api-key";
  }
}

/** Group the catalogue into providers, reporting real authentication state. */
export function listProviders(models: ModelInfo[], auth: AuthStorage): ProviderInfo[] {
  const byProvider = new Map<string, ModelInfo[]>();
  for (const m of models) {
    const list = byProvider.get(m.provider);
    if (list) list.push(m);
    else byProvider.set(m.provider, [m]);
  }

  let configured: string[] = [];
  try {
    configured = ((auth as any).list?.() ?? []).map(String);
  } catch {
    configured = [];
  }

  const out: ProviderInfo[] = [];
  for (const [name, list] of byProvider) {
    let credentialSource: string | undefined;
    try {
      // Returns { kind, envVar? } — naive String() rendered "[object Object]".
      const origin = (auth as any).getCredentialOrigin?.(name);
      credentialSource =
        origin && typeof origin === "object"
          ? [origin.kind, origin.envVar && `(${origin.envVar})`].filter(Boolean).join(" ")
          : origin
            ? String(origin)
            : undefined;
    } catch {
      credentialSource = undefined;
    }
    out.push({
      name,
      authenticated: list[0]?.authenticated ?? configured.includes(name),
      credentialSource: credentialSource || undefined,
      modelCount: list.length,
      connect: providerConnectKind(name),
    });
  }
  out.sort((a, b) => {
    if (a.authenticated !== b.authenticated) return a.authenticated ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  return out;
}

/**
 * Whether a provider has usable credentials RIGHT NOW, with the disable cause
 * when it does not.
 *
 * This is the auth gate's source of truth. The 2026-08-25 billing incident:
 * OMP tombstones an OAuth credential whose refresh fails, then keeps sending
 * the stale access token — which Anthropic accepts but bills to the org's
 * prepaid API credits instead of the subscription. Sessions must therefore be
 * refused while a provider's only credential is a tombstone. A provider that
 * authenticates via API key or env var is deliberately usable — per-token
 * billing the user explicitly configured is not a failure mode.
 *
 * The storage is reloaded from SQLite before answering. Credential state
 * changes in OTHER processes — a worker tombstoning the credential when its
 * refresh fails, or `omp login` restoring it — and `hasAuth` alone serves a
 * possibly-stale in-memory view. `reload()` is one equality-guarded SQLite
 * read; gate call sites are human-frequency, so the cost is irrelevant and
 * the answer must be current in both directions.
 */
export async function providerAuthHealth(
  auth: AuthStorage,
  provider: string,
): Promise<{ usable: boolean; disabledCause?: string }> {
  const a = auth as any;
  const usable = (): boolean => {
    try {
      return Boolean(a.hasAuth?.(provider) ?? a.has?.(provider));
    } catch {
      return false;
    }
  };
  try {
    await a.reload?.();
  } catch {
    /* corrupt store: answer from the in-memory view rather than exploding */
  }
  if (usable()) return { usable: true };
  let disabledCause: string | undefined;
  try {
    const tombstones = await a.listDisabledCredentials?.(provider);
    const cause = Array.isArray(tombstones) ? tombstones[0]?.cause : undefined;
    disabledCause = cause ? String(cause) : undefined;
  } catch {
    disabledCause = undefined;
  }
  return { usable: false, disabledCause };
}

/** Disable causes for every provider with a tombstoned credential. */
export async function listDisabledProviderCauses(auth: AuthStorage): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  try {
    const tombstones = await (auth as any).listDisabledCredentials?.();
    for (const t of Array.isArray(tombstones) ? tombstones : []) {
      if (t?.provider && t?.cause && !out.has(String(t.provider))) {
        out.set(String(t.provider), String(t.cause));
      }
    }
  } catch {
    /* no tombstone API in this OMP build: nothing to report */
  }
  return out;
}

/**
 * Provider subscription/quota, strictly from OMP's own reporting.
 *
 * Never inferred from token volume. When a provider does not report limits the
 * caller surfaces "not reported by provider" rather than a guess.
 */
export async function fetchProviderQuotas(auth: AuthStorage): Promise<unknown[]> {
  const fn = (auth as any).fetchUsageReports;
  if (typeof fn !== "function") return [];
  try {
    const reports = await fn.call(auth);
    return Array.isArray(reports) ? reports : reports ? [reports] : [];
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

/**
 * List persisted OMP sessions.
 *
 * With no `projectPath`, lists across every project so the sidebar can group
 * by project on first launch.
 */
export async function discoverSessions(projectPath?: string): Promise<DiscoveredSession[]> {
  const raw: any[] = projectPath
    ? await (SessionManager as any).list(projectPath)
    : await (SessionManager as any).listAll();

  const cwdExists = new Map<string, boolean>();
  const checkCwd = (cwd: string): boolean => {
    const hit = cwdExists.get(cwd);
    if (hit !== undefined) return hit;
    const ok = Boolean(cwd) && existsSync(cwd);
    cwdExists.set(cwd, ok);
    return ok;
  };

  return (raw ?? []).map((s) => {
    const cwd = String(s.cwd ?? "");
    return {
      ompSessionId: String(s.id ?? ""),
      path: String(s.path ?? ""),
      cwd,
      title: String(s.title ?? "").trim() || "Untitled session",
      created: toIso(s.created),
      modified: toIso(s.modified),
      messageCount: Number(s.messageCount ?? 0),
      sizeBytes: Number(s.size ?? 0),
      parentSessionPath: s.parentSessionPath ? String(s.parentSessionPath) : undefined,
      openInThisApp: false,
      // A session whose project folder is gone (deleted checkout, temp dir)
      // cannot be resumed; the UI hides it rather than offering a dead Resume.
      cwdMissing: !checkCwd(cwd) || undefined,
    };
  });
}

/**
 * Re-home every persisted session recorded under `fromCwd` to `toCwd`.
 *
 * Used when a project folder was moved or renamed on disk: the sessions'
 * recorded cwd points at a path that no longer exists, which makes them
 * unresumable (and previously made them vanish from the sidebar entirely —
 * indistinguishable from data loss). Relocation goes through OMP's own
 * `SessionManager.moveTo`, which moves the session file and artifacts and
 * rewrites the header cwd, so the CLI and this app stay in agreement.
 *
 * `skipSessionPaths` must contain the session files currently open in this
 * app: OMP session files have no lock and two writers silently lose data.
 */
export async function relocateProjectSessions(
  fromCwd: string,
  toCwd: string,
  skipSessionPaths: ReadonlySet<string> = new Set(),
): Promise<{ moved: Array<{ from: string; to: string }>; skipped: string[]; errors: string[] }> {
  const from = resolve(fromCwd);
  const to = resolve(toCwd);
  const moved: Array<{ from: string; to: string }> = [];
  const skipped: string[] = [];
  const errors: string[] = [];

  const all: any[] = (await (SessionManager as any).listAll()) ?? [];
  const targets = all.filter((s) => s?.cwd && resolve(String(s.cwd)) === from && s?.path);

  for (const s of targets) {
    const path = String(s.path);
    if (skipSessionPaths.has(path)) {
      skipped.push(path);
      continue;
    }
    try {
      // initialCwd anchors the manager at the GONE recorded cwd — open()
      // falls back to the launch cwd for a missing recorded cwd, which would
      // make moveTo a no-op when it equals the destination. Same pattern as
      // OMP's own moved-project re-rooting.
      const mgr = await (SessionManager as any).open(path, undefined, undefined, {
        initialCwd: from,
        suppressBreadcrumb: true,
      });
      await mgr.moveTo(to);
      moved.push({ from: path, to: String(mgr.getSessionFile() ?? path) });
    } catch (e) {
      errors.push(`${path}: ${(e as Error).message}`);
    }
  }
  return { moved, skipped, errors };
}

function toIso(v: unknown): string | undefined {
  if (!v) return undefined;
  if (v instanceof Date) return v.toISOString();
  if (typeof v === "number") return new Date(v).toISOString();
  if (typeof v === "string") {
    const d = new Date(v);
    return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Projects
// ---------------------------------------------------------------------------

/** Stable project id derived from the canonical path. */
export function projectIdFor(path: string): string {
  return resolve(path);
}

export async function inspectProject(path: string): Promise<ProjectInfo> {
  const abs = resolve(path);
  return {
    projectId: projectIdFor(abs),
    path: abs,
    name: basename(abs) || abs,
    git: await gitInfo(abs),
  };
}

/**
 * Lightweight git detection. Read-only by design — this app never mutates git
 * state; the agent does that through OMP's own tools when asked.
 */
export async function gitInfo(
  cwd: string,
): Promise<{ branch?: string; dirty: boolean; detached?: boolean } | undefined> {
  if (!existsSync(cwd)) return undefined;
  try {
    const { stdout: inside } = await exec("git", ["rev-parse", "--is-inside-work-tree"], {
      cwd,
      timeout: 3000,
    });
    if (inside.trim() !== "true") return undefined;
  } catch {
    return undefined;
  }

  let branch: string | undefined;
  let detached = false;
  try {
    const { stdout } = await exec("git", ["symbolic-ref", "--short", "-q", "HEAD"], {
      cwd,
      timeout: 3000,
    });
    branch = stdout.trim() || undefined;
  } catch {
    detached = true;
    try {
      const { stdout } = await exec("git", ["rev-parse", "--short", "HEAD"], {
        cwd,
        timeout: 3000,
      });
      branch = stdout.trim() || undefined;
    } catch {
      branch = undefined;
    }
  }

  let dirty = false;
  try {
    const { stdout } = await exec("git", ["status", "--porcelain"], { cwd, timeout: 5000 });
    dirty = stdout.trim().length > 0;
  } catch {
    dirty = false;
  }

  return { branch, dirty, detached: detached || undefined };
}

/**
 * Working-tree changes for the Changes panel. Read-only.
 *
 * Uses `-z` porcelain so paths with spaces/unicode round-trip exactly. Rename
 * entries carry two NUL-separated paths (new, then old).
 */
export async function gitChanges(cwd: string): Promise<GitChanges> {
  const info = await gitInfo(cwd);
  const files: GitChanges["files"] = [];
  try {
    const { stdout } = await exec("git", ["status", "--porcelain=v1", "-z"], {
      cwd,
      timeout: 5000,
      maxBuffer: 8 * 1024 * 1024,
    });
    const parts = stdout.split("\0");
    for (let i = 0; i < parts.length; i++) {
      const entry = parts[i];
      if (entry.length < 4) continue;
      const code = entry.slice(0, 2);
      const path = entry.slice(3);
      if (!path) continue;
      let status: string;
      let renamedFrom: string | undefined;
      if (code === "??") status = "?";
      else if (code.includes("R") || code.includes("C")) {
        status = "R";
        // In -z format the ORIGINAL path follows as its own NUL-separated field.
        renamedFrom = parts[i + 1] || undefined;
        i += 1;
      } else if (code.includes("D")) status = "D";
      else if (code.includes("A")) status = "A";
      else if (code.includes("U")) status = "U";
      else status = "M";
      files.push({ path, status, renamedFrom });
    }
  } catch {
    /* not a repo, or git missing: empty list with whatever gitInfo saw */
  }
  return { branch: info?.branch, detached: info?.detached, files };
}

const DIFF_TRANSPORT_LIMIT = 512 * 1024;

/** Unified diff (or untracked-file preview) for one file. Read-only. */
export async function gitDiff(cwd: string, path: string): Promise<GitDiff> {
  const count = (diff: string, prefix: string): number =>
    diff.split("\n").filter((l) => l.startsWith(prefix) && !l.startsWith(prefix.repeat(3))).length;

  for (const args of [
    ["diff", "--no-color", "--", path],
    ["diff", "--no-color", "--staged", "--", path],
  ]) {
    try {
      const { stdout } = await exec("git", args, {
        cwd,
        timeout: 5000,
        maxBuffer: 8 * 1024 * 1024,
      });
      if (!stdout.trim()) continue;
      if (/^Binary files /m.test(stdout)) {
        return { file: path, diff: "", binary: true, additions: 0, deletions: 0 };
      }
      const truncated = stdout.length > DIFF_TRANSPORT_LIMIT;
      return {
        file: path,
        diff: truncated ? stdout.slice(0, DIFF_TRANSPORT_LIMIT) : stdout,
        binary: false,
        truncated: truncated || undefined,
        additions: count(stdout, "+"),
        deletions: count(stdout, "-"),
      };
    } catch {
      /* try next */
    }
  }

  // Untracked file: show a bounded content preview instead of an empty diff.
  try {
    const abs = resolve(cwd, path);
    const file = Bun.file(abs);
    if (await file.exists()) {
      const size = file.size;
      if (size > 2 * 1024 * 1024) {
        return {
          file: path,
          diff: "",
          binary: false,
          truncated: true,
          additions: 0,
          deletions: 0,
          untracked: true,
        };
      }
      const text = await file.text();
      if (text.includes("\0")) {
        return { file: path, diff: "", binary: true, additions: 0, deletions: 0, untracked: true };
      }
      const truncated = text.length > DIFF_TRANSPORT_LIMIT;
      return {
        file: path,
        diff: truncated ? text.slice(0, DIFF_TRANSPORT_LIMIT) : text,
        binary: false,
        truncated: truncated || undefined,
        additions: text.split("\n").length,
        deletions: 0,
        untracked: true,
      };
    }
  } catch {
    /* fall through */
  }
  return { file: path, diff: "", binary: false, additions: 0, deletions: 0 };
}

// ---------------------------------------------------------------------------
// Slash commands (project-level discovery, no live session required)
// ---------------------------------------------------------------------------

/**
 * File-based slash commands visible for a project. The live per-session list
 * (builtins, skills, extensions, MCP prompts) comes from the session worker's
 * `slash.list`; this is the cheap superset the project environment can show
 * before any session exists.
 */
export async function discoverSlashCommandsIn(cwd: string): Promise<string[]> {
  try {
    const discover = (OMP as any).discoverSlashCommands;
    if (typeof discover !== "function") return [];
    const cmds = await discover(cwd);
    return (Array.isArray(cmds) ? cmds : []).map((c: any) => String(c.name)).filter(Boolean);
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Advisors
// ---------------------------------------------------------------------------

/**
 * Discover the advisor roster OMP would use for a project.
 *
 * Reads through OMP's own WATCHDOG discovery so the GUI shows exactly the
 * advisors the CLI would run, including precedence between project and user
 * configuration.
 */
export async function discoverAdvisors(cwd: string, agentDir: string): Promise<AdvisorConfig[]> {
  try {
    // Advisor discovery is not on the package root; it lives on the `advisor`
    // subpath, which the package exports explicitly via its `./*` mapping.
    // Using upstream's own walker means the GUI shows exactly the roster the
    // CLI would run, including project-over-user precedence.
    const advisorModule = await import("@oh-my-pi/pi-coding-agent/advisor/index");
    const discover = (advisorModule as any).discoverAdvisorConfigs;
    if (typeof discover !== "function") return [];

    // discoverAdvisorConfigs(cwd, agentDir?) -> { advisors, sharedInstructions }
    const res = await discover(cwd, agentDir);
    const list: any[] = Array.isArray(res) ? res : (res?.advisors ?? []);
    return list.map((a, i) => normalizeAdvisor(a, i, "project"));
  } catch {
    // A malformed WATCHDOG file must never break opening a project; upstream
    // logs and skips, and so do we.
    return [];
  }
}

/** Convert an upstream `AdvisorConfig` into the product shape. */
export function normalizeAdvisor(
  a: any,
  index: number,
  origin: AdvisorConfig["origin"],
): AdvisorConfig {
  const name = String(a?.name ?? `Advisor ${index + 1}`);
  const { model, thinkingLevel } = fromOmpAdvisorSelector(
    typeof a?.model === "string" ? a.model : undefined,
  );
  return {
    id: `advisor:${name}`,
    name,
    enabled: a?.enabled !== false,
    model,
    thinkingLevel,
    tools: Array.isArray(a?.tools) ? a.tools.map(String) : undefined,
    instructions: typeof a?.instructions === "string" ? a.instructions : undefined,
    origin,
  };
}

/** Convert the product shape back into what OMP's advisor runtime expects. */
export function toOmpAdvisor(a: AdvisorConfig): Record<string, unknown> {
  const selector = a.model
    ? a.thinkingLevel
      ? `${a.model}:${a.thinkingLevel}`
      : a.model
    : undefined;
  return {
    name: a.name,
    ...(selector ? { model: selector } : {}),
    ...(a.tools ? { tools: a.tools } : {}),
    ...(a.instructions ? { instructions: a.instructions } : {}),
    enabled: a.enabled,
  };
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

export async function loadSettings(cwd: string, agentDir: string): Promise<Settings> {
  return Settings.init({ cwd, agentDir });
}

export function newModelRegistry(auth: AuthStorage): ModelRegistry {
  return new ModelRegistry(auth as any);
}

// ---------------------------------------------------------------------------
// Project files (read-only, gitignore-aware)
// ---------------------------------------------------------------------------

/**
 * List project files for the Files panel. Uses git's index+untracked walk so
 * .gitignore is respected and node_modules never floods the panel; non-git
 * folders get a bounded filesystem walk instead.
 */
export async function listProjectFiles(
  cwd: string,
  query?: string,
  limit = 2_000,
): Promise<{ files: string[]; truncated: boolean }> {
  let files: string[] = [];
  try {
    const { stdout } = await exec("git", ["ls-files", "-co", "--exclude-standard", "-z"], {
      cwd,
      timeout: 10_000,
      maxBuffer: 32 * 1024 * 1024,
    });
    files = stdout.split("\0").filter(Boolean);
  } catch {
    // Not a git repo: shallow bounded walk, skipping dot/dependency dirs.
    try {
      const glob = new Bun.Glob("**/*");
      for await (const f of glob.scan({ cwd, onlyFiles: true, dot: false })) {
        if (/(^|\/)(node_modules|target|dist|build|\.git)\//.test(f)) continue;
        files.push(f);
        if (files.length >= limit * 2) break;
      }
    } catch {
      files = [];
    }
  }
  if (query) {
    const q = query.toLowerCase();
    files = files.filter((f) => f.toLowerCase().includes(q));
  }
  files.sort();
  const truncated = files.length > limit;
  return { files: truncated ? files.slice(0, limit) : files, truncated };
}

const FILE_PREVIEW_LIMIT = 512 * 1024;

/** Bounded read-only preview of one project file. */
export async function readProjectFile(
  cwd: string,
  file: string,
): Promise<{ file: string; content: string; binary: boolean; truncated: boolean }> {
  const empty = { file, content: "", binary: false, truncated: false };
  // Containment is checked on REAL paths: lexical prefix checks pass through
  // symlinks, and the caller-supplied cwd itself must resolve cleanly. The
  // engine additionally requires cwd to be an open project's root.
  const abs = resolve(cwd, file);
  let rootReal: string;
  try {
    const { realpathSync } = await import("node:fs");
    rootReal = realpathSync(resolve(cwd));
    if (!existsSync(abs)) return empty;
    const absReal = realpathSync(abs);
    if (absReal !== rootReal && !absReal.startsWith(`${rootReal}/`)) return empty;
  } catch {
    return empty;
  }
  try {
    const f = Bun.file(abs);
    if (!(await f.exists())) return { file, content: "", binary: false, truncated: false };
    if (f.size > 4 * 1024 * 1024) return { file, content: "", binary: false, truncated: true };
    const text = await f.text();
    if (text.includes("\0")) return { file, content: "", binary: true, truncated: false };
    const truncated = text.length > FILE_PREVIEW_LIMIT;
    return {
      file,
      content: truncated ? text.slice(0, FILE_PREVIEW_LIMIT) : text,
      binary: false,
      truncated,
    };
  } catch {
    return { file, content: "", binary: false, truncated: false };
  }
}
