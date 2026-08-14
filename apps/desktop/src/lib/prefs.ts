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
  advisors: AdvisorConfig[];
}

export interface NotificationPrefs {
  completion: boolean;
  errors: boolean;
  needsInput: boolean;
  advisorBlockers: boolean;
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
  keepRunningOnClose: boolean;
  /** First-run setup finished (or explicitly skipped). */
  setupComplete: boolean;
  /** Project paths whose sidebar group is collapsed. */
  collapsedProjects: string[];
  /**
   * OMP session paths that were open (not explicitly closed) in this app.
   * After a relaunch these render inside their project group with one-click
   * resume, instead of sinking into "Previous sessions".
   */
  openSessionPaths: string[];
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
  notifications: { completion: true, errors: true, needsInput: true, advisorBlockers: true },
  inspectorWidth: 320,
  sidebarWidth: 260,
  usageRange: "7d",
  keepRunningOnClose: true,
  setupComplete: false,
  collapsedProjects: [],
  openSessionPaths: [],
};

export function loadPrefs(): Prefs {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return { ...DEFAULT_PREFS };
    const parsed = JSON.parse(raw);
    return {
      ...DEFAULT_PREFS,
      ...parsed,
      notifications: { ...DEFAULT_PREFS.notifications, ...(parsed?.notifications ?? {}) },
    };
  } catch {
    return { ...DEFAULT_PREFS };
  }
}

export function savePrefs(p: Prefs): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(p));
  } catch {
    /* storage full or unavailable — prefs are conveniences, not data */
  }
}
