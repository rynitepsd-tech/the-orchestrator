/**
 * Sidebar — the session control centre.
 *
 * Live sessions group by project with truthful run-state indicators; persisted
 * OMP sessions discovered on disk can be resumed with one click. Archiving
 * hides locally and never touches OMP's files.
 */

import type { DiscoveredSession } from "@orchestrator/protocol";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import type { DragEvent, JSX } from "react";
import { useMemo, useState } from "react";
import { engine } from "../engine-client";
import { isActive, modelBasename, runStateLabel, type SessionView, useStore } from "../store";
import { ResizeHandle } from "./ResizeHandle";

/** One sidebar row inside a project group: a live session or a resume row. */
type GroupRow =
  | { key: string; path?: string; kind: "live"; v: SessionView }
  | { key: string; path: string; kind: "open"; d: DiscoveredSession };

/** Drag-to-reorder wiring shared by both row flavours. */
interface RowDragProps {
  dragging?: boolean;
  dropEdge?: "above" | "below" | null;
  onDragStart?: () => void;
  onDragEnd?: () => void;
  onDragOver?: (e: DragEvent) => void;
  onDragLeave?: () => void;
  onDrop?: (e: DragEvent) => void;
}

/**
 * A project group's rows in display order: the user's dragged order (persisted
 * as session paths) wins; sessions never placed sort after those, in creation
 * order; brand-new sessions with no path yet float to the top.
 */
function sortedRows(
  g: { views: SessionView[]; open: DiscoveredSession[] },
  sessionOrder: string[],
): GroupRow[] {
  const rows: GroupRow[] = [
    ...g.views.map((v) => ({
      key: v.summary.ompSessionPath ?? v.summary.sessionId,
      path: v.summary.ompSessionPath,
      kind: "live" as const,
      v,
    })),
    ...g.open.map((d) => ({ key: d.path, path: d.path, kind: "open" as const, d })),
  ];
  const at = (p?: string) => {
    if (!p) return -1;
    const i = sessionOrder.indexOf(p);
    return i === -1 ? Number.MAX_SAFE_INTEGER : i;
  };
  return rows.sort((a, b) => at(a.path) - at(b.path));
}

export function Sidebar({
  onResume,
  onFork,
}: {
  onResume: (d: DiscoveredSession) => void;
  onFork: (sessionId: string) => void;
}): JSX.Element {
  const sessions = useStore((s) => s.sessions);
  const order = useStore((s) => s.order);
  const visibleId = useStore((s) => s.visibleSessionId);
  const discovered = useStore((s) => s.discovered);
  const prefs = useStore((s) => s.prefs);
  const select = useStore((s) => s.select);
  const [query, setQuery] = useState("");
  const [menu, setMenu] = useState<{ id: string; x: number; y: number } | null>(null);
  const [showArchived, setShowArchived] = useState(false);
  const [dragProject, setDragProject] = useState<string | null>(null);
  const [dropProject, setDropProject] = useState<string | null>(null);
  const [dragRow, setDragRow] = useState<{ key: string; project: string } | null>(null);
  const [dropRow, setDropRow] = useState<string | null>(null);

  const q = query.trim().toLowerCase();

  const liveViews = order.map((id) => sessions[id]).filter(Boolean);
  const openPaths = new Set(
    liveViews.map((v) => v.summary.ompSessionPath).filter(Boolean) as string[],
  );

  const filteredLive = q
    ? liveViews.filter(
        (v) =>
          v.summary.title.toLowerCase().includes(q) ||
          v.summary.projectPath.toLowerCase().includes(q) ||
          (v.summary.model ?? "").toLowerCase().includes(q),
      )
    : liveViews;

  // Sessions that were open in this app before the last quit: they belong in
  // their project group with one-click resume, not in "Previous sessions".
  const openRemembered = useMemo(() => {
    const remembered = new Set(prefs.openSessionPaths);
    return discovered.filter(
      (d) =>
        remembered.has(d.path) &&
        !openPaths.has(d.path) &&
        !d.openInThisApp &&
        !d.cwdMissing &&
        (!q || d.title.toLowerCase().includes(q) || d.cwd.toLowerCase().includes(q)),
    );
  }, [discovered, openPaths, q, prefs.openSessionPaths]);

  const byProject = useMemo(() => {
    const groups = new Map<string, { views: SessionView[]; open: DiscoveredSession[] }>();
    const group = (key: string) => {
      let g = groups.get(key);
      if (!g) {
        g = { views: [], open: [] };
        groups.set(key, g);
      }
      return g;
    };
    for (const v of filteredLive) group(v.summary.projectPath).views.push(v);
    for (const d of openRemembered) group(d.cwd).open.push(d);
    // Manual drag order wins; projects never dragged fall back to pinned-first
    // alphabetical after the ordered ones.
    const orderIdx = (p: string) => {
      const i = prefs.projectOrder.indexOf(p);
      return i === -1 ? Number.MAX_SAFE_INTEGER : i;
    };
    return [...groups.entries()].sort((a, b) => {
      const ao = orderIdx(a[0]);
      const bo = orderIdx(b[0]);
      if (ao !== bo) return ao - bo;
      const ap = prefs.pinnedProjects.includes(a[0]) ? 0 : 1;
      const bp = prefs.pinnedProjects.includes(b[0]) ? 0 : 1;
      return ap - bp || a[0].localeCompare(b[0]);
    });
  }, [filteredLive, openRemembered, prefs.pinnedProjects, prefs.projectOrder]);

  // Persisted sessions not currently open and not remembered-open, newest first.
  const resumable = useMemo(() => {
    const archived = new Set(prefs.archivedSessions);
    const remembered = new Set(prefs.openSessionPaths);
    return discovered
      .filter(
        (d) =>
          !openPaths.has(d.path) && !remembered.has(d.path) && !d.openInThisApp && !d.cwdMissing,
      )
      .filter((d) => showArchived || !archived.has(d.path))
      .filter((d) => !q || d.title.toLowerCase().includes(q) || d.cwd.toLowerCase().includes(q))
      .sort((a, b) => (b.modified ?? "").localeCompare(a.modified ?? ""))
      .slice(0, q ? 50 : 20);
  }, [discovered, openPaths, q, prefs.archivedSessions, prefs.openSessionPaths, showArchived]);

  const archivedCount = discovered.filter((d) => prefs.archivedSessions.includes(d.path)).length;

  const updatePrefs = useStore((s) => s.updatePrefs);
  const setNewSession = useStore((s) => s.setNewSession);
  const moveSession = useStore((s) => s.moveSession);

  // Persist the group's new visible sequence as session paths (survives
  // relaunches); rows from other projects keep their entries untouched.
  const persistRowOrder = (rows: GroupRow[], seq: GroupRow[]) => {
    const groupPaths = new Set(rows.map((r) => r.path).filter(Boolean) as string[]);
    const newPaths = seq.map((r) => r.path).filter(Boolean) as string[];
    updatePrefs({
      sessionOrder: [...newPaths, ...prefs.sessionOrder.filter((p) => !groupPaths.has(p))].slice(
        0,
        400,
      ),
    });
  };

  const dropRowAt = (rows: GroupRow[], dragKey: string, targetKey: string) => {
    const from = rows.findIndex((r) => r.key === dragKey);
    const to = rows.findIndex((r) => r.key === targetKey);
    if (from < 0 || to < 0 || from === to) return;
    const seq = [...rows];
    const [moved] = seq.splice(from, 1);
    // Landing index after removal: below the target when dragging down,
    // above it when dragging up.
    seq.splice(to, 0, moved);
    persistRowOrder(rows, seq);
    // Keep the in-memory order in step for rows that aren't persisted yet.
    const target = rows[to];
    if (moved.kind === "live" && target.kind === "live")
      moveSession(moved.v.summary.sessionId, target.v.summary.sessionId);
  };

  // Drop `drag` in front of `target` and persist the full visible order, so
  // untouched projects keep their current positions too.
  const reorderProjects = (drag: string, target: string) => {
    if (drag === target) return;
    const keys = byProject.map(([p]) => p).filter((p) => p !== drag);
    const at = keys.indexOf(target);
    keys.splice(at === -1 ? keys.length : at, 0, drag);
    updatePrefs({ projectOrder: keys });
  };

  // Collapse is a browsing aid; an active search always shows its matches.
  const isCollapsed = (key: string) => !q && prefs.collapsedProjects.includes(key);
  const toggleCollapsed = (key: string) =>
    updatePrefs({
      collapsedProjects: prefs.collapsedProjects.includes(key)
        ? prefs.collapsedProjects.filter((p) => p !== key)
        : [...prefs.collapsedProjects, key],
    });

  return (
    <aside className="sidebar" onClick={() => setMenu(null)}>
      <div className="sidebar-head">
        <button className="btn btn-primary" onClick={() => setNewSession(true)}>
          + New Session
        </button>
      </div>
      <div className="sidebar-search">
        <input
          className="input"
          placeholder="Search sessions"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          aria-label="Search sessions"
        />
      </div>

      <div className="sidebar-scroll">
        {byProject.map(([projectPath, g]) => {
          const shared = g.views.filter((v) => isActive(v.summary.runState)).length;
          const collapsed = isCollapsed(projectPath);
          const count = g.views.length + g.open.length;
          const rows = sortedRows(g, prefs.sessionOrder);
          const rowIdx = (k: string) => rows.findIndex((r) => r.key === k);
          return (
            <div
              key={projectPath}
              className={`project-group${dropProject === projectPath ? " drop-target" : ""}${
                dragProject === projectPath ? " dragging" : ""
              }`}
              onDragOver={(e) => {
                if (!dragProject || dragProject === projectPath) return;
                e.preventDefault();
                e.dataTransfer.dropEffect = "move";
                setDropProject(projectPath);
              }}
              onDragLeave={() => setDropProject((p) => (p === projectPath ? null : p))}
              onDrop={(e) => {
                e.preventDefault();
                if (dragProject) reorderProjects(dragProject, projectPath);
                setDragProject(null);
                setDropProject(null);
              }}
            >
              <button
                className="project-head project-head-toggle"
                title={`${projectPath} — drag to reorder`}
                draggable
                onDragStart={(e) => {
                  e.dataTransfer.effectAllowed = "move";
                  e.dataTransfer.setData("text/plain", projectPath);
                  setDragProject(projectPath);
                }}
                onDragEnd={() => {
                  setDragProject(null);
                  setDropProject(null);
                }}
                onClick={() => toggleCollapsed(projectPath)}
                aria-expanded={!collapsed}
              >
                <span className="group-chevron">{collapsed ? "›" : "⌄"}</span>
                <span className="project-name">{projectPath.split("/").pop()}</span>
                {prefs.pinnedProjects.includes(projectPath) && <span className="hint">pinned</span>}
                {collapsed && <span className="hint">{count}</span>}
                {shared > 1 && (
                  <span
                    className="chip warn-chip"
                    title="These sessions share one working tree; their file changes are not isolated from each other."
                  >
                    {shared} active
                  </span>
                )}
              </button>
              {/* A collapsed group still shows the session you are IN — folding
                  the project you're working in must never hide your place. */}
              {rows
                .filter(
                  (r) => !collapsed || (r.kind === "live" && r.v.summary.sessionId === visibleId),
                )
                .map((r) => {
                  const drag = {
                    dragging: dragRow?.key === r.key,
                    dropEdge:
                      dropRow === r.key
                        ? dragRow && rowIdx(dragRow.key) < rowIdx(r.key)
                          ? ("below" as const)
                          : ("above" as const)
                        : null,
                    onDragStart: () => setDragRow({ key: r.key, project: projectPath }),
                    onDragEnd: () => {
                      setDragRow(null);
                      setDropRow(null);
                    },
                    // Reordering is within a project group only — the group is
                    // keyed by project path, so a cross-project drop would
                    // reorder invisibly.
                    onDragOver: (e: DragEvent) => {
                      if (!dragRow || dragRow.key === r.key || dragRow.project !== projectPath)
                        return;
                      e.preventDefault();
                      e.stopPropagation();
                      e.dataTransfer.dropEffect = "move";
                      setDropRow(r.key);
                    },
                    onDragLeave: () => setDropRow((p) => (p === r.key ? null : p)),
                    onDrop: (e: DragEvent) => {
                      e.preventDefault();
                      e.stopPropagation();
                      if (dragRow) dropRowAt(rows, dragRow.key, r.key);
                      setDragRow(null);
                      setDropRow(null);
                    },
                  };
                  return r.kind === "live" ? (
                    <SessionRow
                      key={r.key}
                      view={r.v}
                      active={r.v.summary.sessionId === visibleId}
                      onSelect={() => select(r.v.summary.sessionId)}
                      onMenu={(x, y) => setMenu({ id: r.v.summary.sessionId, x, y })}
                      {...drag}
                    />
                  ) : (
                    <DiscoveredRow key={r.key} d={r.d} onResume={() => onResume(r.d)} {...drag} />
                  );
                })}
            </div>
          );
        })}

        {resumable.length > 0 && (
          <div className="project-group">
            <div className="project-head">
              <button
                className="project-head-toggle row"
                onClick={() => toggleCollapsed("__previous__")}
                aria-expanded={!isCollapsed("__previous__")}
              >
                <span className="group-chevron">{isCollapsed("__previous__") ? "›" : "⌄"}</span>
                <span className="project-name">Previous sessions</span>
                {isCollapsed("__previous__") && <span className="hint">{resumable.length}</span>}
              </button>
              {archivedCount > 0 && !isCollapsed("__previous__") && (
                <button
                  className="btn btn-ghost"
                  onClick={() => setShowArchived((v) => !v)}
                  title="Archived sessions are hidden locally; transcripts are never deleted."
                >
                  {showArchived ? "Hide archived" : `${archivedCount} archived`}
                </button>
              )}
            </div>
            {!isCollapsed("__previous__") &&
              resumable.map((d) => (
                <DiscoveredRow key={d.path} d={d} onResume={() => onResume(d)} />
              ))}
          </div>
        )}

        {byProject.length === 0 && resumable.length === 0 && (
          <div className="empty">
            {q
              ? "No sessions match."
              : "No sessions yet. Create a session to start working with OMP."}
          </div>
        )}
      </div>

      {menu && (
        <SessionMenu
          sessionId={menu.id}
          x={menu.x}
          y={menu.y}
          onClose={() => setMenu(null)}
          onFork={onFork}
        />
      )}

      <ResizeHandle
        side="right"
        width={prefs.sidebarWidth}
        min={200}
        max={440}
        onResize={(w) => updatePrefs({ sidebarWidth: w })}
      />
    </aside>
  );
}

function stateDotClass(v: SessionView): string {
  const s = v.summary.runState;
  if (v.pendingInteractions > 0 || s === "waiting") return "dot needs-input";
  if (s === "error") return "dot error";
  if (s === "interrupted") return "dot interrupted";
  if (isActive(s)) return "dot active";
  if (s === "completed") return "dot done";
  return "dot idle";
}

function SessionRow({
  view,
  active,
  onSelect,
  onMenu,
  dragging,
  dropEdge,
  onDragStart,
  onDragEnd,
  onDragOver,
  onDragLeave,
  onDrop,
}: {
  view: SessionView;
  active: boolean;
  onSelect: () => void;
  onMenu: (x: number, y: number) => void;
} & RowDragProps): JSX.Element {
  const s = view.summary;
  const advisorsOn = view.advisors.filter((a) => a.enabled).length;
  const needsInput = view.pendingInteractions > 0 || s.runState === "waiting";
  const status = needsInput ? "Needs input" : runStateLabel(s.runState, s.activity);

  return (
    <button
      className={`session-row${active ? " selected" : ""}${s.unread ? " unread" : ""}${
        dragging ? " dragging" : ""
      }${dropEdge ? ` drop-${dropEdge}` : ""}`}
      onClick={onSelect}
      onContextMenu={(e) => {
        e.preventDefault();
        onMenu(e.clientX, e.clientY);
      }}
      draggable={Boolean(onDragStart)}
      onDragStart={(e) => {
        e.dataTransfer.effectAllowed = "move";
        e.dataTransfer.setData("text/plain", s.sessionId);
        onDragStart?.();
      }}
      onDragEnd={onDragEnd}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      <span className={stateDotClass(view)} aria-hidden />
      <span className="session-col">
        <span className="session-title">{s.title}</span>
        <span className="session-sub hint">
          {modelBasename(s.model)}
          {advisorsOn > 0 && ` · ${advisorsOn} advisor${advisorsOn > 1 ? "s" : ""}`}
        </span>
        <span className={`session-status hint${needsInput ? " attention" : ""}`}>{status}</span>
      </span>
      {s.unread && <span className="unread-dot" title="Unread" />}
    </button>
  );
}

function DiscoveredRow({
  d,
  onResume,
  dragging,
  dropEdge,
  onDragStart,
  onDragEnd,
  onDragOver,
  onDragLeave,
  onDrop,
}: {
  d: DiscoveredSession;
  onResume: () => void;
} & RowDragProps): JSX.Element {
  const when = d.modified ? new Date(d.modified).toLocaleDateString() : "";
  return (
    // The whole row opens the session — no hunting for a Resume button.
    <button
      className={`session-row${dragging ? " dragging" : ""}${dropEdge ? ` drop-${dropEdge}` : ""}`}
      title={`${d.path}\nClick to open`}
      onClick={onResume}
      draggable={Boolean(onDragStart)}
      onDragStart={(e) => {
        e.dataTransfer.effectAllowed = "move";
        e.dataTransfer.setData("text/plain", d.path);
        onDragStart?.();
      }}
      onDragEnd={onDragEnd}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      <span className="dot idle" aria-hidden />
      <span className="session-col">
        <span className="session-title">{d.title}</span>
        <span className="session-sub hint">
          {d.cwd.split("/").pop()} · {d.messageCount} messages{when && ` · ${when}`}
        </span>
      </span>
      <span className="hint open-hint">Open</span>
    </button>
  );
}

function SessionMenu({
  sessionId,
  x,
  y,
  onClose,
  onFork,
}: {
  sessionId: string;
  x: number;
  y: number;
  onClose: () => void;
  onFork: (sessionId: string) => void;
}): JSX.Element | null {
  const view = useStore((s) => s.sessions[sessionId]);
  const updatePrefs = useStore((s) => s.updatePrefs);
  const prefs = useStore((s) => s.prefs);
  const removeSession = useStore((s) => s.removeSession);
  const setRenameTarget = useStore((s) => s.setRenameTarget);
  if (!view) return null;
  const s = view.summary;
  const running = isActive(s.runState);
  const pinned = prefs.pinnedProjects.includes(s.projectPath);

  const act = (fn: () => void) => () => {
    fn();
    onClose();
  };

  return (
    <div className="context-menu" style={{ left: x, top: y }} onClick={(e) => e.stopPropagation()}>
      <button className="menu-item" onClick={act(() => setRenameTarget(sessionId))}>
        Rename…
      </button>
      <button
        className="menu-item"
        disabled={!s.ompSessionPath}
        onClick={act(() => onFork(sessionId))}
        title={s.ompSessionPath ? undefined : "The session has not persisted yet."}
      >
        Fork session
      </button>
      {running && (
        <button
          className="menu-item"
          onClick={act(() => void engine.request("session.abort", { sessionId }).catch(() => {}))}
        >
          Abort
        </button>
      )}
      <hr />
      <button
        className="menu-item"
        onClick={act(() =>
          updatePrefs({
            pinnedProjects: pinned
              ? prefs.pinnedProjects.filter((p) => p !== s.projectPath)
              : [...prefs.pinnedProjects, s.projectPath],
          }),
        )}
      >
        {pinned ? "Unpin project" : "Pin project"}
      </button>
      <button
        className="menu-item"
        onClick={act(() => void revealItemInDir(s.projectPath).catch(() => {}))}
      >
        Reveal project in Finder
      </button>
      {s.ompSessionPath && (
        <button
          className="menu-item"
          onClick={act(() => void revealItemInDir(s.ompSessionPath!).catch(() => {}))}
        >
          Reveal session file
        </button>
      )}
      <button
        className="menu-item"
        onClick={act(() => void navigator.clipboard.writeText(s.ompSessionId ?? sessionId))}
      >
        Copy session ID
      </button>
      <hr />
      <button
        className="menu-item"
        onClick={act(() => {
          // Close the live worker and drop the row. The OMP transcript is
          // untouched and reappears under "Previous sessions" — an explicit
          // close is the one action that demotes a session from its project
          // group across relaunches.
          void engine.request("sessions.close", { sessionId, dispose: true }).catch(() => {});
          if (s.ompSessionPath) {
            updatePrefs({
              openSessionPaths: prefs.openSessionPaths.filter((p) => p !== s.ompSessionPath),
            });
          }
          removeSession(sessionId);
        })}
      >
        {running ? "Stop and close" : "Close session"}
      </button>
    </div>
  );
}
