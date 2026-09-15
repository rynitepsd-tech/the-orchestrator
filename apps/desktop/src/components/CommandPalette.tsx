/**
 * Command palette (⌘⇧P) and quick session switcher (⌘K).
 *
 * Commands, quick switching, and persisted transcript content search; every
 * entry performs a real action — no dead rows.
 */
import type { SessionSearchHit } from "@orchestrator/protocol";
import { isActiveRunState } from "@orchestrator/protocol";
import { ask } from "@tauri-apps/plugin-dialog";
import type { JSX } from "react";
import { useEffect, useMemo, useRef, useState } from "react";
import { engine } from "../engine-client";
import { basename } from "../lib/prefs";
import { advisorsReviewing, modelBasename, runStateLabel, useStore } from "../store";

interface Command {
  id: string;
  label: string;
  hint?: string;
  keepOpen?: boolean;
  run: () => void;
}

export function CommandPalette(): JSX.Element {
  const store = useStore();
  const [historySearch, setHistorySearch] = useState(false);
  const mode = historySearch ? "history" : store.paletteMode;
  const [searchHits, setSearchHits] = useState<SessionSearchHit[]>([]);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState("");
  const [truncated, setTruncated] = useState(false);
  const [retry, setRetry] = useState(0);
  const [query, setQuery] = useState("");
  const [sel, setSel] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, [mode]);

  useEffect(() => {
    let cancelled = false;
    setSearchHits([]);
    setSearchError("");
    setTruncated(false);
    if (!historySearch || !query.trim()) {
      setSearching(false);
      return;
    }
    setSearching(true);
    const timer = setTimeout(() => {
      void engine
        .request("sessions.search", { query: query.trim(), limit: 50 })
        .then((result) => {
          if (!cancelled) {
            setSearchHits(result.hits);
            setTruncated(result.truncated);
          }
        })
        .catch((error: unknown) => {
          if (!cancelled) setSearchError(String((error as { message?: string })?.message ?? error));
        })
        .finally(() => {
          if (!cancelled) setSearching(false);
        });
    }, 200);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [historySearch, query, retry]);

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
        id: "search-history",
        label: "Search All Saved Transcripts…",
        keepOpen: true,
        run: () => {
          setHistorySearch(true);
          setQuery("");
        },
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
      if (isActiveRunState(view.summary.runState)) {
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

  const rows = useMemo((): Command[] => {
    if (mode === "history") {
      return searchHits.map((hit) => ({
        id: `${hit.sessionPath}:${hit.entryId}`,
        label: hit.snippet,
        hint: `${hit.title} · ${basename(hit.projectPath)} · ${hit.role === "user" ? "You" : "Assistant"}`,
        run: () =>
          window.dispatchEvent(new CustomEvent("orchestrator:open-history", { detail: hit })),
      }));
    }
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
      return [
        {
          id: "search-history",
          label: q
            ? `Search saved transcripts for “${query.trim()}”`
            : "Search All Saved Transcripts…",
          hint: "Includes closed sessions and older messages",
          keepOpen: true,
          run: () => setHistorySearch(true),
        },
        ...views.map((v) => ({
          id: v.summary.sessionId,
          label: v.summary.title,
          hint: `${basename(v.summary.projectPath)} · ${modelBasename(v.summary.model)} · ${
            v.summary.runState === "completed" && advisorsReviewing(v)
              ? "Advisors reviewing"
              : runStateLabel(v.summary.runState)
          }`,
          run: () => store.select(v.summary.sessionId),
        })),
      ];
    }
    return commands.filter((c) => !q || c.label.toLowerCase().includes(q));
  }, [mode, q, query, commands, store, searchHits]);

  useEffect(() => setSel(0), [q, mode]);

  const runSel = (i: number) => {
    const row = rows[i];
    if (!row) return;
    if (!row.keepOpen) close();
    row.run();
  };

  return (
    <div className="modal-backdrop palette-backdrop" onMouseDown={close}>
      <div className="palette" onMouseDown={(e) => e.stopPropagation()}>
        <input
          ref={inputRef}
          className="palette-input"
          aria-label={
            mode === "history"
              ? "Search all saved transcripts"
              : mode === "sessions"
                ? "Switch session"
                : "Run command"
          }
          maxLength={mode === "history" ? 1000 : undefined}
          placeholder={
            mode === "history"
              ? "Search all saved transcripts…"
              : mode === "sessions"
                ? "Switch to session…"
                : "Run command…"
          }
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape") close();
            else if (e.key === "ArrowDown") {
              e.preventDefault();
              setSel((n) => Math.max(0, Math.min(rows.length - 1, n + 1)));
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              setSel((n) => Math.max(0, n - 1));
            } else if (e.key === "Enter") {
              e.preventDefault();
              runSel(sel);
            }
          }}
        />
        {mode === "history" && (
          <div style={{ padding: "8px 14px" }}>
            <button
              className="btn-ghost"
              onClick={() => {
                setHistorySearch(false);
                setQuery("");
              }}
            >
              Back to {store.paletteMode === "sessions" ? "sessions" : "commands"}
            </button>
            <div className="hint" role="status">
              {searching
                ? "Searching saved transcripts…"
                : !q
                  ? "Search message content across all projects."
                  : `${searchHits.length} matching messages`}
            </div>
            {searchError && (
              <div role="alert">
                <p>{searchError}</p>
                <button className="btn" onClick={() => setRetry((value) => value + 1)}>
                  Retry search
                </button>
              </div>
            )}
            {truncated && (
              <p className="hint">
                Results are incomplete. Refine your search; some transcripts may be unreadable.
              </p>
            )}
          </div>
        )}
        <div className="palette-list" role="listbox">
          {rows.map((r, i) => (
            <button
              key={r.id}
              className={`palette-item${i === sel ? " selected" : ""}`}
              role="option"
              aria-selected={i === sel}
              onMouseEnter={() => setSel(i)}
              onClick={() => runSel(i)}
              style={
                mode === "history"
                  ? {
                      flexDirection: "column",
                      alignItems: "flex-start",
                      whiteSpace: "normal",
                      overflowWrap: "anywhere",
                    }
                  : undefined
              }
            >
              <span>{r.label}</span>
              {r.hint && <span className="hint">{r.hint}</span>}
            </button>
          ))}
          {rows.length === 0 && !searching && !searchError && (
            <div className="empty">
              {mode === "history"
                ? q
                  ? "No matching messages. Try different words."
                  : "Enter words from a conversation to find its source."
                : mode === "sessions"
                  ? "No open sessions."
                  : "No matching commands."}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
