/**
 * Sidebar — the session control centre.
 *
 * Live sessions group by project with truthful run-state indicators; persisted
 * OMP sessions discovered on disk can be resumed with one click. Archiving
 * hides locally and never touches OMP's files.
 */

import type { DiscoveredSession } from "@orchestrator/protocol";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import type { JSX } from "react";
import { useMemo, useState } from "react";
import { engine } from "../engine-client";
import { isActive, modelBasename, runStateLabel, type SessionView, useStore } from "../store";

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

  const byProject = useMemo(() => {
    const groups = new Map<string, SessionView[]>();
    for (const v of filteredLive) {
      const key = v.summary.projectPath;
      const list = groups.get(key);
      if (list) list.push(v);
      else groups.set(key, [v]);
    }
    return [...groups.entries()].sort((a, b) => {
      const ap = prefs.pinnedProjects.includes(a[0]) ? 0 : 1;
      const bp = prefs.pinnedProjects.includes(b[0]) ? 0 : 1;
      return ap - bp || a[0].localeCompare(b[0]);
    });
  }, [filteredLive, prefs.pinnedProjects]);

  // Persisted sessions not currently open, newest first.
  const resumable = useMemo(() => {
    const archived = new Set(prefs.archivedSessions);
    return discovered
      .filter((d) => !openPaths.has(d.path) && !d.openInThisApp && !d.cwdMissing)
      .filter((d) => showArchived || !archived.has(d.path))
      .filter((d) => !q || d.title.toLowerCase().includes(q) || d.cwd.toLowerCase().includes(q))
      .sort((a, b) => (b.modified ?? "").localeCompare(a.modified ?? ""))
      .slice(0, q ? 50 : 20);
  }, [discovered, openPaths, q, prefs.archivedSessions, showArchived]);

  const archivedCount = discovered.filter((d) => prefs.archivedSessions.includes(d.path)).length;

  return (
    <aside className="sidebar" onClick={() => setMenu(null)}>
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
        {byProject.map(([projectPath, views]) => {
          const shared = views.filter((v) => isActive(v.summary.runState)).length;
          return (
            <div key={projectPath} className="project-group">
              <div className="project-head" title={projectPath}>
                <span className="project-name">{projectPath.split("/").pop()}</span>
                {prefs.pinnedProjects.includes(projectPath) && <span className="hint">pinned</span>}
                {shared > 1 && (
                  <span
                    className="chip warn-chip"
                    title="These sessions share one working tree; their file changes are not isolated from each other."
                  >
                    {shared} active
                  </span>
                )}
              </div>
              {views.map((v) => (
                <SessionRow
                  key={v.summary.sessionId}
                  view={v}
                  active={v.summary.sessionId === visibleId}
                  onSelect={() => select(v.summary.sessionId)}
                  onMenu={(x, y) => setMenu({ id: v.summary.sessionId, x, y })}
                />
              ))}
            </div>
          );
        })}

        {resumable.length > 0 && (
          <div className="project-group">
            <div className="project-head">
              <span className="project-name">Previous sessions</span>
              {archivedCount > 0 && (
                <button
                  className="btn btn-ghost"
                  onClick={() => setShowArchived((v) => !v)}
                  title="Archived sessions are hidden locally; transcripts are never deleted."
                >
                  {showArchived ? "Hide archived" : `${archivedCount} archived`}
                </button>
              )}
            </div>
            {resumable.map((d) => (
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
}: {
  view: SessionView;
  active: boolean;
  onSelect: () => void;
  onMenu: (x: number, y: number) => void;
}): JSX.Element {
  const s = view.summary;
  const advisorsOn = view.advisors.filter((a) => a.enabled).length;
  const needsInput = view.pendingInteractions > 0 || s.runState === "waiting";
  const status = needsInput ? "Needs input" : runStateLabel(s.runState, s.activity);

  return (
    <button
      className={`session-row${active ? " selected" : ""}${s.unread ? " unread" : ""}`}
      onClick={onSelect}
      onContextMenu={(e) => {
        e.preventDefault();
        onMenu(e.clientX, e.clientY);
      }}
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
}: {
  d: DiscoveredSession;
  onResume: () => void;
}): JSX.Element {
  const when = d.modified ? new Date(d.modified).toLocaleDateString() : "";
  return (
    <div className="session-row discovered">
      <span className="dot idle" aria-hidden />
      <span className="session-col" title={d.path}>
        <span className="session-title">{d.title}</span>
        <span className="session-sub hint">
          {d.cwd.split("/").pop()} · {d.messageCount} messages{when && ` · ${when}`}
        </span>
      </span>
      <button className="btn btn-ghost" onClick={onResume}>
        Resume
      </button>
    </div>
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
      <button
        className="menu-item"
        onClick={act(() => {
          const title = prompt("Session title", s.title);
          if (title?.trim()) {
            void engine.request("session.setTitle", { sessionId, title: title.trim() });
          }
        })}
      >
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
          // untouched and reappears under "Previous sessions".
          void engine.request("sessions.close", { sessionId, dispose: true }).catch(() => {});
          removeSession(sessionId);
        })}
      >
        {running ? "Stop and close" : "Close session"}
      </button>
    </div>
  );
}
