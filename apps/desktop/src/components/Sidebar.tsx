/**
 * Project + session sidebar.
 *
 * Sessions are grouped by project. Selecting a row is purely a UI change —
 * every other session keeps running in its own worker process.
 */
import type { JSX } from "react";
import { useMemo, useState } from "react";
import type { RunState } from "@orchestrator/protocol";
import { useStore, type SessionView } from "../store";

function dotClass(s: RunState): string {
  switch (s) {
    case "thinking":
    case "streaming":
    case "tool":
    case "starting":
    case "queued":
    case "waiting":
    case "stopping":
      return "dot running";
    case "error":
      return "dot error";
    case "completed":
      return "dot done";
    default:
      return "dot idle";
  }
}

function activityLabel(v: SessionView): string {
  const s = v.summary.runState;
  switch (s) {
    case "thinking":
      return "Thinking…";
    case "streaming":
      return "Responding…";
    case "tool":
      return "Running tool…";
    case "starting":
    case "queued":
      return "Starting…";
    case "stopping":
      return "Stopping…";
    case "waiting":
      return "Waiting…";
    case "error":
      return "Error";
    case "interrupted":
      return "Interrupted";
    default: {
      const bits: string[] = [];
      if (v.summary.model) bits.push(v.summary.model.split("/").pop() ?? v.summary.model);
      const n = v.advisors.filter((a) => a.enabled).length;
      if (n) bits.push(`${n} advisor${n > 1 ? "s" : ""}`);
      return bits.join(" · ") || "Idle";
    }
  }
}

export function Sidebar(): JSX.Element {
  const { sessions, order, visibleSessionId, projects, select, setNewSession } = useStore();
  const [query, setQuery] = useState("");

  const groups = useMemo(() => {
    const q = query.trim().toLowerCase();
    const byProject = new Map<string, SessionView[]>();
    for (const id of order) {
      const v = sessions[id];
      if (!v) continue;
      if (q && !v.summary.title.toLowerCase().includes(q)) continue;
      const list = byProject.get(v.summary.projectId);
      if (list) list.push(v);
      else byProject.set(v.summary.projectId, [v]);
    }
    return byProject;
  }, [sessions, order, query]);

  const projectName = (id: string): string =>
    projects.find((p) => p.projectId === id)?.name ?? id.split("/").pop() ?? id;
  const projectBranch = (id: string): string | undefined =>
    projects.find((p) => p.projectId === id)?.git?.branch;

  return (
    <nav className="sidebar" aria-label="Projects and sessions">
      <div className="sidebar-head">
        <button className="btn btn-primary" onClick={() => setNewSession(true)}>
          New Session
          <span style={{ opacity: 0.7, fontSize: 11 }}>⌘N</span>
        </button>
        <input
          className="input"
          type="search"
          placeholder="Search sessions"
          aria-label="Search sessions"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>

      <div className="sidebar-scroll">
        {groups.size === 0 && (
          <div className="empty">
            <h3>No sessions yet</h3>
            Choose a project and start an OMP session.
          </div>
        )}

        {[...groups.entries()].map(([projectId, list]) => (
          <div className="project-group" key={projectId}>
            <div className="project-head">
              <span>{projectName(projectId)}</span>
              {projectBranch(projectId) && (
                <span className="project-branch">{projectBranch(projectId)}</span>
              )}
            </div>
            {list.map((v) => (
              <button
                key={v.summary.sessionId}
                className="session-row"
                aria-current={v.summary.sessionId === visibleSessionId}
                onClick={() => select(v.summary.sessionId)}
              >
                <span
                  className={dotClass(v.summary.runState)}
                  aria-hidden="true"
                />
                <span style={{ minWidth: 0 }}>
                  <span className={`session-title${v.summary.unread ? " unread" : ""}`}>
                    {v.summary.title}
                  </span>
                  <span className="session-meta">{activityLabel(v)}</span>
                  <span className="sr-only">
                    {v.summary.runState}
                    {v.summary.unread ? ", unread" : ""}
                  </span>
                </span>
              </button>
            ))}
          </div>
        ))}
      </div>
    </nav>
  );
}
