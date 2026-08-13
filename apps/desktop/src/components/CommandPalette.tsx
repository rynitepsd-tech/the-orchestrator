/**
 * Command palette.
 *
 * One keyboard-searchable list over the app's verbs, including jumping to any
 * running session. Selecting a session here is the same pure UI selection the
 * sidebar performs — nothing is paused.
 */
import type { JSX } from "react";
import { useMemo, useState } from "react";
import { engine } from "../engine-client";
import { useStore } from "../store";

interface Cmd {
  id: string;
  label: string;
  hint?: string;
  run(): void;
}

export function CommandPalette(): JSX.Element {
  const s = useStore();
  const [q, setQ] = useState("");
  const [i, setI] = useState(0);

  const close = () => s.setPalette(false);

  const commands = useMemo<Cmd[]>(() => {
    const base: Cmd[] = [
      { id: "new", label: "New Session", hint: "⌘N", run: () => s.setNewSession(true) },
      { id: "usage", label: "Open Usage", run: () => s.setInspectorTab("usage") },
      { id: "changes", label: "Open Changes", run: () => s.setInspectorTab("changes") },
      { id: "sidebar", label: "Toggle Sidebar", hint: "⌘1", run: () => s.toggleSidebar() },
      { id: "inspector", label: "Toggle Inspector", hint: "⌘2", run: () => s.toggleInspector() },
      { id: "settings", label: "Settings", hint: "⌘,", run: () => s.setSettings(true) },
      { id: "restart", label: "Restart Engine", run: () => void engine.restart() },
    ];

    if (s.visibleSessionId) {
      const id = s.visibleSessionId;
      base.splice(1, 0,
        { id: "abort", label: "Abort Run", hint: "⌘.", run: () => void engine.request("session.abort", { sessionId: id }).catch(() => {}) },
        { id: "compact", label: "Compact Session", run: () => void engine.request("session.compact", { sessionId: id }).catch(() => {}) },
      );
    }

    for (const sid of s.order) {
      const v = s.sessions[sid];
      if (!v) continue;
      base.push({
        id: `go:${sid}`,
        label: `Switch to: ${v.summary.title}`,
        hint: v.summary.runState,
        run: () => s.select(sid),
      });
    }
    return base;
  }, [s]);

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return needle ? commands.filter((c) => c.label.toLowerCase().includes(needle)) : commands;
  }, [commands, q]);

  const pick = (n: number) => {
    const c = filtered[n];
    if (!c) return;
    c.run();
    close();
  };

  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <div className="modal" role="dialog" aria-modal="true" aria-label="Command palette">
        <div style={{ padding: 12, borderBottom: "1px solid var(--border)" }}>
          <input
            className="input"
            autoFocus
            placeholder="Type a command…"
            aria-label="Command"
            value={q}
            onChange={(e) => { setQ(e.target.value); setI(0); }}
            onKeyDown={(e) => {
              if (e.key === "Escape") close();
              if (e.key === "ArrowDown") { e.preventDefault(); setI((x) => Math.min(x + 1, filtered.length - 1)); }
              if (e.key === "ArrowUp") { e.preventDefault(); setI((x) => Math.max(x - 1, 0)); }
              if (e.key === "Enter") { e.preventDefault(); pick(i); }
            }}
          />
        </div>
        <div style={{ maxHeight: "50vh", overflowY: "auto", padding: 6 }}>
          {filtered.length === 0 && <div className="empty">No matching command.</div>}
          {filtered.map((c, n) => (
            <button
              key={c.id}
              className="session-row"
              style={{ gridTemplateColumns: "1fr auto", background: n === i ? "var(--bg-active)" : undefined }}
              onMouseEnter={() => setI(n)}
              onClick={() => pick(n)}
            >
              <span className="session-title">{c.label}</span>
              {c.hint && <span className="hint">{c.hint}</span>}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
