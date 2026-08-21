/**
 * Command palette (⌘⇧P) and quick session switcher (⌘K).
 *
 * One component, two modes. Commands are registered centrally here; every
 * entry performs a real action — no dead rows.
 */
import { ask } from "@tauri-apps/plugin-dialog";
import type { JSX } from "react";
import { useEffect, useMemo, useRef, useState } from "react";
import { engine } from "../engine-client";
import { advisorsReviewing, isActive, modelBasename, runStateLabel, useStore } from "../store";

interface Command {
  id: string;
  label: string;
  hint?: string;
  run: () => void;
}

export function CommandPalette(): JSX.Element {
  const store = useStore();
  const mode = store.paletteMode;
  const [query, setQuery] = useState("");
  const [sel, setSel] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const close = () => store.setPalette(false);

  const view = store.visibleSessionId ? store.sessions[store.visibleSessionId] : undefined;

  const commands = useMemo((): Command[] => {
    const cmds: Command[] = [
      { id: "new-session", label: "New Session", hint: "⌘N", run: () => store.goHome() },
      {
        id: "switch-session",
        label: "Switch Session…",
        hint: "⌘K",
        run: () => store.setPalette(true, "sessions"),
      },
      {
        id: "usage",
        label: "Open Usage Center",
        hint: "⌘U",
        run: () => store.setMainView("usage"),
      },
      { id: "settings", label: "Settings", hint: "⌘,", run: () => store.setMainView("settings") },
      {
        id: "toggle-sidebar",
        label: "Toggle Sidebar",
        hint: "⌘1",
        run: () => store.toggleSidebar(),
      },
      {
        id: "toggle-inspector",
        label: "Toggle Inspector",
        hint: "⌘2",
        run: () => store.toggleInspector(),
      },
      {
        id: "view-changes",
        label: "Open Changes",
        hint: "⌘G",
        run: () => store.setInspectorTab("changes"),
      },
      {
        id: "view-files",
        label: "Open Files",
        run: () => store.setInspectorTab("files"),
      },
      {
        id: "restart-engine",
        label: "Restart Engine",
        hint: "stops all sessions",
        // The most destructive action in the app must not fire off three
        // typed characters and a Return.
        run: () =>
          void ask(
            "Restarting the engine stops every running session mid-turn. Transcripts are preserved. Restart now?",
            { title: "Restart Engine", kind: "warning" },
          ).then((yes) => {
            if (yes) void engine.restart();
          }),
      },
    ];
    if (view) {
      const id = view.summary.sessionId;
      if (isActive(view.summary.runState)) {
        cmds.push({
          id: "abort",
          label: "Abort Session",
          hint: "⌘.",
          run: () => void engine.request("session.abort", { sessionId: id }).catch(() => {}),
        });
      }
      cmds.push(
        {
          id: "compact",
          label: "Compact Session Context",
          run: () => void engine.request("session.compact", { sessionId: id }).catch(() => {}),
        },
        {
          id: "rename",
          label: "Rename Session…",
          run: () => store.setRenameTarget(id),
        },
        {
          id: "change-model",
          label: "Change Model…",
          hint: "⌘⇧M",
          run: () => window.dispatchEvent(new CustomEvent("orchestrator:change-model")),
        },
        {
          id: "configure-advisors",
          label: "Configure Advisors…",
          hint: "⌘⇧A",
          run: () => window.dispatchEvent(new CustomEvent("orchestrator:configure-advisors")),
        },
      );
      if (view.summary.ompSessionPath) {
        cmds.push({
          id: "fork",
          label: "Fork Session",
          run: () => {
            window.dispatchEvent(
              new CustomEvent("orchestrator:fork", { detail: { sessionId: id } }),
            );
          },
        });
      }
    }
    return cmds;
  }, [store, view]);

  const q = query.trim().toLowerCase();

  const rows = useMemo(() => {
    if (mode === "sessions") {
      const views = store.order
        .map((id) => store.sessions[id])
        .filter(Boolean)
        .filter(
          (v) =>
            !q ||
            v.summary.title.toLowerCase().includes(q) ||
            v.summary.projectPath.toLowerCase().includes(q) ||
            (v.summary.model ?? "").toLowerCase().includes(q),
        );
      return views.map((v) => ({
        id: v.summary.sessionId,
        label: v.summary.title,
        hint: `${v.summary.projectPath.split("/").pop()} · ${modelBasename(v.summary.model)} · ${
          v.summary.runState === "completed" && advisorsReviewing(v)
            ? "Advisors reviewing"
            : runStateLabel(v.summary.runState)
        }`,
        run: () => store.select(v.summary.sessionId),
      }));
    }
    return commands.filter((c) => !q || c.label.toLowerCase().includes(q));
  }, [mode, q, commands, store]);

  useEffect(() => setSel(0), [q, mode]);

  const runSel = (i: number) => {
    const row = rows[i];
    if (!row) return;
    close();
    row.run();
  };

  return (
    <div className="modal-backdrop palette-backdrop" onMouseDown={close}>
      <div className="palette" onMouseDown={(e) => e.stopPropagation()}>
        <input
          ref={inputRef}
          className="palette-input"
          placeholder={mode === "sessions" ? "Switch to session…" : "Run command…"}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape") close();
            else if (e.key === "ArrowDown") {
              e.preventDefault();
              setSel((n) => Math.min(rows.length - 1, n + 1));
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              setSel((n) => Math.max(0, n - 1));
            } else if (e.key === "Enter") {
              e.preventDefault();
              runSel(sel);
            }
          }}
        />
        <div className="palette-list" role="listbox">
          {rows.map((r, i) => (
            <button
              key={r.id}
              className={`palette-item${i === sel ? " selected" : ""}`}
              role="option"
              aria-selected={i === sel}
              onMouseEnter={() => setSel(i)}
              onClick={() => runSel(i)}
            >
              <span>{r.label}</span>
              {r.hint && <span className="hint">{r.hint}</span>}
            </button>
          ))}
          {rows.length === 0 && (
            <div className="empty">
              {mode === "sessions" ? "No open sessions." : "No matching commands."}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
