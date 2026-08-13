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
    // Resolved from the installed package, not hardcoded, so a bundled
    // upgrade cannot silently disagree with what the About window claims.
    const pkg = require("@oh-my-pi/pi-coding-agent/package.json");
    return String(pkg.version ?? "unknown");
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
      credentialSource = (auth as any).getCredentialOrigin?.(name);
    } catch {
      credentialSource = undefined;
    }
    out.push({
      name,
      authenticated: list[0]?.authenticated ?? configured.includes(name),
      credentialSource: credentialSource ? String(credentialSource) : undefined,
      modelCount: list.length,
    });
  }
  out.sort((a, b) => {
    if (a.authenticated !== b.authenticated) return a.authenticated ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
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

  return (raw ?? []).map((s) => ({
    ompSessionId: String(s.id ?? ""),
    path: String(s.path ?? ""),
    cwd: String(s.cwd ?? ""),
    title: String(s.title ?? "").trim() || "Untitled session",
    created: toIso(s.created),
    modified: toIso(s.modified),
    messageCount: Number(s.messageCount ?? 0),
    sizeBytes: Number(s.size ?? 0),
    parentSessionPath: s.parentSessionPath ? String(s.parentSessionPath) : undefined,
    openInThisApp: false,
  }));
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

/**
 * Load the raw WATCHDOG config for a project, for "Save as project default".
 *
 * Returns null when upstream cannot provide it, so the UI can disable the
 * action rather than silently writing a file it does not understand.
 */
export async function loadWatchdogConfig(cwd: string): Promise<unknown | null> {
  try {
    const m = await import("@oh-my-pi/pi-coding-agent/advisor/index");
    const load = (m as any).loadWatchdogConfigFile;
    return typeof load === "function" ? await load(cwd) : null;
  } catch {
    return null;
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
  const abs = resolve(cwd, file);
  // The preview stays inside the project; a crafted "../../" path must not
  // read arbitrary files through the engine.
  if (!abs.startsWith(resolve(cwd) + "/") && abs !== resolve(cwd)) {
    return { file, content: "", binary: false, truncated: false };
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
