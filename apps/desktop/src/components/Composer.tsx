/**
 * Message composer.
 *
 * A message sent while the agent is already streaming is mapped onto upstream
 * semantics explicitly (steer vs follow-up) rather than racing: upstream throws
 * AgentBusyError if a prompt arrives mid-stream without a declared behaviour.
 */
import type { JSX } from "react";
import { useEffect, useRef, useState } from "react";
import type { RunState } from "@orchestrator/protocol";

export interface ComposerProps {
  runState: RunState;
  onSend(text: string, whenBusy: "steer" | "queue"): void;
  onAbort(): void;
  disabled?: boolean;
}

const BUSY: RunState[] = ["thinking", "streaming", "tool", "starting", "queued", "waiting"];

export function Composer({ runState, onSend, onAbort, disabled }: ComposerProps): JSX.Element {
  const [text, setText] = useState("");
  const ref = useRef<HTMLTextAreaElement>(null);
  const busy = BUSY.includes(runState);

  // Grow with content, up to a ceiling.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 220)}px`;
  }, [text]);

  const send = (whenBusy: "steer" | "queue") => {
    const t = text.trim();
    if (!t || disabled) return;
    onSend(t, whenBusy);
    setText("");
  };

  return (
    <div className="composer">
      <div className="composer-inner">
        <div className="composer-box">
          <textarea
            ref={ref}
            className="textarea"
            rows={1}
            value={text}
            disabled={disabled}
            placeholder={busy ? "Steer the running turn…" : "Message the agent…"}
            aria-label="Message the agent"
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                // Cmd+Enter queues as a follow-up instead of steering.
                send(e.metaKey ? "queue" : "steer");
              }
              if (e.key === "Escape" && busy) {
                e.preventDefault();
                onAbort();
              }
            }}
          />

          <div className="composer-row">
            <span className="hint">
              {busy
                ? "Enter steers · ⌘Enter queues a follow-up · Esc interrupts"
                : "Enter to send · Shift+Enter for a new line"}
            </span>
            <span className="spacer" />
            {busy && (
              <button className="btn btn-danger" onClick={onAbort} title="Interrupt (Esc)">
                Stop
              </button>
            )}
            <button
              className="btn btn-primary"
              disabled={disabled || !text.trim()}
              onClick={() => send("steer")}
            >
              {busy ? "Steer" : "Send"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
