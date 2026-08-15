/**
 * Live todo checklist — the agent's plan as a pinned progress strip.
 *
 * Collapsed: "3/7" plus the task in flight, readable from across the room.
 * Expanded: every phase and task with its status. Disappears when the list
 * is empty or fully done — a finished plan is history, not chrome.
 */

import type { TodoTaskItem } from "@orchestrator/protocol";
import type { JSX } from "react";
import { useState } from "react";
import { fmtCount } from "../store";

const STATUS_ICON: Record<TodoTaskItem["status"], string> = {
  pending: "○",
  in_progress: "◐",
  completed: "●",
  abandoned: "⊘",
  blocked: "▲",
};

export function TodoStrip({
  phases,
}: {
  phases: Array<{ name: string; tasks: TodoTaskItem[] }>;
}): JSX.Element | null {
  const [open, setOpen] = useState(false);
  const tasks = phases.flatMap((p) => p.tasks);
  const done = tasks.filter((t) => t.status === "completed" || t.status === "abandoned").length;
  const current = tasks.find((t) => t.status === "in_progress");
  const blocked = tasks.filter((t) => t.status === "blocked").length;

  if (tasks.length === 0 || done === tasks.length) return null;

  return (
    <div className={`todo-strip${open ? " open" : ""}`}>
      <button className="todo-head" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
        <span className="tool-chevron">{open ? "▾" : "▸"}</span>
        <span className="todo-count">
          {fmtCount(done)}/{fmtCount(tasks.length)}
        </span>
        <span className="todo-current">
          {current ? current.content : blocked > 0 ? `${blocked} blocked` : "Plan"}
        </span>
        <span className="todo-bar" aria-hidden>
          <span className="todo-bar-fill" style={{ width: `${(done / tasks.length) * 100}%` }} />
        </span>
      </button>
      {open && (
        <div className="todo-body">
          {phases.map((p) => (
            <div key={p.name} className="todo-phase">
              {phases.length > 1 && <div className="todo-phase-name">{p.name}</div>}
              {p.tasks.map((t, i) => (
                <div key={i} className={`todo-task s-${t.status}`}>
                  <span className="todo-icon">{STATUS_ICON[t.status]}</span>
                  <span className="todo-task-text">{t.content}</span>
                  {t.blocker && <span className="hint">— {t.blocker}</span>}
                </div>
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
