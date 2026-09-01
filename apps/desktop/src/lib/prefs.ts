/**
 * Local, Orchestrator-only preferences and metadata.
 *
 * Everything here is UI-side convenience state (favourites, recents, presets,
 * archive flags). It must NEVER leak into OMP's own configuration — favouriting
 * a model in the GUI does not touch OMP model files, and archiving a session
 * hides it locally without deleting the transcript.
 */
import type { AdvisorConfig } from "@orchestrator/protocol";

export interface SessionPreset {
  name: string;
  model?: string;
  thinkingLevel?: string;
  /** Launch sessions with fast mode (provider priority tier) on. */
  fastMode?: boolean;
  advisors: AdvisorConfig[];
}

export interface NotificationPrefs {
  /** Notify when an agent finishes a turn — the only notification the app sends. */
  completion: boolean;
}

export interface Prefs {
  theme: "system" | "light" | "dark";
  favoriteModels: string[];
  recentModels: string[];
  recentProjects: string[];
  pinnedProjects: string[];
  /** OMP session paths hidden from the sidebar. Never deletes files. */
  archivedSessions: string[];
  presets: SessionPreset[];
  notifications: NotificationPrefs;
  inspectorWidth: number;
  sidebarWidth: number;
  usageRange: "today" | "7d" | "30d" | "all";
  /** First-run setup finished (or explicitly skipped). */
  setupComplete: boolean;
  /** Project paths whose sidebar group is collapsed. */
  collapsedProjects: string[];
  /** Manual sidebar ordering of project groups (drag to reorder). */
  projectOrder: string[];
  /**
   * OMP session paths that were open (not explicitly closed) in this app.
   * After a relaunch these render inside their project group with one-click
   * resume, instead of sinking into "Previous sessions".
   */
  openSessionPaths: string[];
  /**
   * Manual ordering of sessions inside their project groups (drag to
   * reorder), as OMP session paths so it survives relaunches. Sessions not
   * listed sort after listed ones; brand-new sessions (no path yet) float to
   * the top.
   */
  sessionOrder: string[];
  /** Preset the home screen launches with; undefined = OMP defaults. */
  defaultPreset?: string;
  /** Display-name overrides for project folders, keyed by project path. */
  projectAliases: Record<string, string>;
  /** Preset each session runs with, keyed by OMP session path. */
  sessionPresetByPath: Record<string, string>;
  /** Approval mode each session runs with, keyed by OMP session path. */
  sessionApprovalByPath: Record<string, string>;
}

/**
 * The containing directory, for the secondary line under a project's name.
 * Over budget it loses LEADING segments, never trailing ones: the folders
 * nearest the project are what tell one "web" or "api" from another, and a
 * tail-clipped path answers nothing. Callers keep the whole path in a title.
 */
export function projectParent(path: string, budget = 42): string {
  const clean = path.replace(/\/+$/, "");
  const cut = clean.lastIndexOf("/");
  if (cut < 1) return cut === 0 ? "/" : "";
  const dir = clean.slice(0, cut);
  if (dir.length <= budget) return dir;
  const segs = dir.split("/").filter(Boolean);
  // Grow from the tail while it fits; two segments always survive, so the line
  // never degrades into a lone ellipsis.
  let keep = Math.min(segs.length, 2);
  while (keep < segs.length && segs.slice(-(keep + 1)).join("/").length + 2 <= budget) keep += 1;
  return keep < segs.length ? `…/${segs.slice(-keep).join("/")}` : dir;
}

const KEY = "orchestrator.prefs.v1";

export const DEFAULT_PREFS: Prefs = {
  theme: "system",
  favoriteModels: [],
  recentModels: [],
  recentProjects: [],
  pinnedProjects: [],
  archivedSessions: [],
  presets: [],
  notifications: { completion: true },
  inspectorWidth: 320,
  sidebarWidth: 260,
  usageRange: "7d",
  setupComplete: false,
  collapsedProjects: [],
  projectOrder: [],
  openSessionPaths: [],
  sessionOrder: [],
  projectAliases: {},
  sessionPresetByPath: {},
  sessionApprovalByPath: {},
};

/**
 * Field-by-field validation. Prefs hold presets, aliases and ordering — real
 * data — and used to be spread over defaults unchecked, so one corrupted field
 * (`presets: "oops"`) white-screened the app on the next render. Each field
 * falls back to its default independently instead.
 */
export function sanitizePrefs(parsed: unknown): Prefs {
  const p = (parsed && typeof parsed === "object" ? parsed : {}) as Record<string, unknown>;
  const strArr = (v: unknown, dflt: string[]): string[] =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : dflt;
  const strMap = (v: unknown): Record<string, string> => {
    if (!v || typeof v !== "object" || Array.isArray(v)) return {};
    const out: Record<string, string> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      if (typeof val === "string") out[k] = val;
    }
    return out;
  };
  const num = (v: unknown, dflt: number): number =>
    typeof v === "number" && Number.isFinite(v) ? v : dflt;
  const bool = (v: unknown, dflt: boolean): boolean => (typeof v === "boolean" ? v : dflt);

  return {
    theme: ["system", "light", "dark"].includes(String(p.theme))
      ? (p.theme as Prefs["theme"])
      : DEFAULT_PREFS.theme,
    favoriteModels: strArr(p.favoriteModels, []),
    recentModels: strArr(p.recentModels, []),
    recentProjects: strArr(p.recentProjects, []),
    pinnedProjects: strArr(p.pinnedProjects, []),
    archivedSessions: strArr(p.archivedSessions, []),
    presets: Array.isArray(p.presets)
      ? (p.presets as unknown[]).filter(
          (x): x is SessionPreset =>
            !!x &&
            typeof x === "object" &&
            typeof (x as SessionPreset).name === "string" &&
            Array.isArray((x as SessionPreset).advisors),
        )
      : [],
    notifications: {
      completion: bool((p.notifications as Record<string, unknown> | undefined)?.completion, true),
    },
    inspectorWidth: num(p.inspectorWidth, DEFAULT_PREFS.inspectorWidth),
    sidebarWidth: num(p.sidebarWidth, DEFAULT_PREFS.sidebarWidth),
    usageRange: ["today", "7d", "30d", "all"].includes(String(p.usageRange))
      ? (p.usageRange as Prefs["usageRange"])
      : DEFAULT_PREFS.usageRange,
    setupComplete: bool(p.setupComplete, false),
    collapsedProjects: strArr(p.collapsedProjects, []),
    projectOrder: strArr(p.projectOrder, []),
    openSessionPaths: strArr(p.openSessionPaths, []),
    sessionOrder: strArr(p.sessionOrder, []),
    defaultPreset: typeof p.defaultPreset === "string" ? p.defaultPreset : undefined,
    projectAliases: strMap(p.projectAliases),
    sessionPresetByPath: strMap(p.sessionPresetByPath),
    sessionApprovalByPath: strMap(p.sessionApprovalByPath),
  };
}

export function hasLocalPrefs(): boolean {
  try {
    return localStorage.getItem(KEY) !== null;
  } catch {
    return false;
  }
}

export function loadPrefs(): Prefs {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return { ...DEFAULT_PREFS };
    return sanitizePrefs(JSON.parse(raw));
  } catch {
    return { ...DEFAULT_PREFS };
  }
}

/**
 * Optional durable sink, registered by the app shell once the engine is up:
 * prefs also persist to a file under Application Support, so a WKWebView
 * storage wipe no longer silently loses presets and session ordering.
 */
let durableSink: ((p: Prefs) => void) | null = null;
export function setPrefsSink(sink: (p: Prefs) => void): void {
  durableSink = sink;
}

/**
 * Debounced persist. savePrefs used to write synchronously on every call —
 * including ~120Hz during panel resize, stringifying the whole blob each
 * pointermove. The trailing write catches the final state; pagehide flushes.
 */
let pendingSave: Prefs | null = null;
let saveTimer: ReturnType<typeof setTimeout> | null = null;

function flushPrefs(): void {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  const p = pendingSave;
  pendingSave = null;
  if (!p) return;
  try {
    localStorage.setItem(KEY, JSON.stringify(p));
  } catch {
    /* storage full or unavailable — the durable sink below still runs */
  }
  durableSink?.(p);
}

export function savePrefs(p: Prefs): void {
  pendingSave = p;
  if (!saveTimer) saveTimer = setTimeout(flushPrefs, 300);
}

if (typeof window !== "undefined") {
  window.addEventListener("pagehide", flushPrefs);
}
