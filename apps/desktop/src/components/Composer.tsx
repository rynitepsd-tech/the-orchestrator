/**
 * Prompt composer.
 *
 * Enter sends (steering a busy session), ⌘Enter queues as a follow-up,
 * Shift+Enter inserts a newline. Typing "/" surfaces the session's real slash
 * commands, discovered live from the worker (builtins, skills, extensions,
 * MCP prompts) — never a hardcoded list.
 */

import type { RunState } from "@orchestrator/protocol";
import type { JSX } from "react";
import { useEffect, useRef, useState } from "react";
import { engine } from "../engine-client";
import { isActive } from "../store";

interface SlashCommand {
  name: string;
  description?: string;
  source: string;
}

export function Composer({
  sessionId,
  runState,
  onSend,
  onAbort,
  disabled,
}: {
  sessionId?: string;
  runState: RunState;
  onSend: (text: string, whenBusy: "steer" | "queue") => void;
  onAbort: () => void;
  disabled?: boolean;
}): JSX.Element {
  const [text, setText] = useState("");
  const [slash, setSlash] = useState<SlashCommand[] | null>(null);
  const [slashSel, setSlashSel] = useState(0);
  const sentAt = useRef(0);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const commandsCache = useRef<SlashCommand[] | null>(null);

  const busy = isActive(runState);

  useEffect(() => {
    commandsCache.current = null;
    setSlash(null);
    // Switching sessions should land you ready to type, like every chat app.
    taRef.current?.focus();
  }, [sessionId]);

  const refreshSlash = async (prefix: string) => {
    if (!sessionId) return;
    if (!commandsCache.current) {
      try {
        const res = await engine.request("slash.list", { sessionId });
        commandsCache.current = res.commands;
      } catch {
        commandsCache.current = [];
      }
    }
    const q = prefix.slice(1).toLowerCase();
    const matches = commandsCache.current
      .filter((c) => c.name.toLowerCase().startsWith(q))
      .slice(0, 12);
    setSlash(matches.length ? matches : null);
    setSlashSel(0);
  };

  const onChange = (value: string) => {
    setText(value);
    const firstLine = value.split("\n", 1)[0];
    if (firstLine.startsWith("/") && !firstLine.includes(" ") && value === firstLine) {
      void refreshSlash(firstLine);
    } else if (slash) {
      setSlash(null);
    }
  };

  const acceptSlash = (cmd: SlashCommand) => {
    setText(`/${cmd.name} `);
    setSlash(null);
    taRef.current?.focus();
  };

  const send = (whenBusy: "steer" | "queue") => {
    const t = text.trim();
    if (!t || disabled || !sessionId) return;
    // Guard against double-submit from key-repeat or click+Enter races.
    if (Date.now() - sentAt.current < 300) return;
    sentAt.current = Date.now();
    onSend(t, whenBusy);
    setText("");
    setSlash(null);
  };

  return (
    <div className="composer">
      {slash && (
        <div className="slash-pop" role="listbox">
          {slash.map((c, i) => (
            <button
              key={c.name}
              className={`slash-item${i === slashSel ? " selected" : ""}`}
              onMouseEnter={() => setSlashSel(i)}
              onClick={() => acceptSlash(c)}
              role="option"
              aria-selected={i === slashSel}
            >
              <span className="mono">/{c.name}</span>
              {c.description && <span className="hint">{c.description}</span>}
              {c.source !== "builtin" && <span className="chip">{c.source}</span>}
            </button>
          ))}
        </div>
      )}
      <div className="composer-row">
        <textarea
          ref={taRef}
          className="composer-input"
          placeholder={
            busy ? "Steer the agent (⌘Enter queues as follow-up)…" : "Message the agent…"
          }
          value={text}
          rows={Math.min(8, Math.max(1, text.split("\n").length))}
          disabled={disabled}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={(e) => {
            if (slash) {
              if (e.key === "ArrowDown") {
                e.preventDefault();
                setSlashSel((n) => Math.min(slash.length - 1, n + 1));
                return;
              }
              if (e.key === "ArrowUp") {
                e.preventDefault();
                setSlashSel((n) => Math.max(0, n - 1));
                return;
              }
              if (e.key === "Tab" || (e.key === "Enter" && !e.shiftKey)) {
                e.preventDefault();
                acceptSlash(slash[slashSel]);
                return;
              }
              if (e.key === "Escape") {
                e.preventDefault();
                setSlash(null);
                return;
              }
            }
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              send(e.metaKey || e.ctrlKey ? "queue" : "steer");
            }
            // The Stop button advertises Esc; honour it.
            if (e.key === "Escape" && busy) {
              e.preventDefault();
              onAbort();
            }
          }}
        />
        {busy ? (
          <div className="composer-actions">
            <button className="btn" onClick={() => send("steer")} disabled={!text.trim()}>
              Steer
            </button>
            <button className="btn" onClick={() => send("queue")} disabled={!text.trim()}>
              Queue
            </button>
            <button className="btn btn-danger" onClick={onAbort} title="Esc">
              Stop
            </button>
          </div>
        ) : (
          <div className="composer-actions">
            <button
              className="btn btn-primary"
              onClick={() => send("steer")}
              disabled={!text.trim() || disabled}
            >
              Send
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
