/**
 * Transcript view.
 *
 * Renders the normalized event stream as native cards. Older items collapse
 * behind "Show earlier" in windows (never destroyed), streaming pins to the
 * bottom only while the user is already there, and every interactive card
 * (approvals, extension prompts) answers through the engine — no local state
 * pretends to be the runtime.
 */

import type { ToolDetail } from "@orchestrator/protocol";
import type { JSX } from "react";
import { memo, useLayoutEffect, useRef, useState } from "react";
import { engine } from "../engine-client";
import { fmtCount, fmtDuration, fmtTokens, type TranscriptItem, useStore } from "../store";
import { Markdown } from "./Markdown";

const WINDOW = 300;

export function Transcript({
  items,
  sessionId,
}: {
  items: TranscriptItem[];
  sessionId: string;
}): JSX.Element {
  const ref = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  const [shown, setShown] = useState(WINDOW);
  const [atBottom, setAtBottom] = useState(true);

  const hidden = Math.max(0, items.length - shown);
  const visible = hidden > 0 ? items.slice(hidden) : items;

  useLayoutEffect(() => {
    const el = ref.current;
    if (el && pinned.current) el.scrollTop = el.scrollHeight;
  });

  const onScroll = () => {
    const el = ref.current;
    if (!el) return;
    const near = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
    pinned.current = near;
    setAtBottom(near);
  };

  return (
    <div className="transcript-wrap">
      <div className="transcript" ref={ref} onScroll={onScroll}>
        {hidden > 0 && (
          <div className="hint center">
            <button
              className="btn btn-ghost"
              onClick={() => {
                const el = ref.current;
                const before = el?.scrollHeight ?? 0;
                setShown((n) => n + WINDOW);
                // Keep the viewport anchored on the first previously-visible item.
                requestAnimationFrame(() => {
                  if (el) el.scrollTop += el.scrollHeight - before;
                });
              }}
            >
              Show {fmtCount(Math.min(WINDOW, hidden))} earlier ({fmtCount(hidden)} hidden)
            </button>
          </div>
        )}
        {visible.map((item) => (
          <Item key={item.id} item={item} sessionId={sessionId} />
        ))}
      </div>
      {!atBottom && (
        <button
          className="btn jump-latest"
          onClick={() => {
            const el = ref.current;
            if (el) {
              pinned.current = true;
              el.scrollTop = el.scrollHeight;
              setAtBottom(true);
            }
          }}
        >
          Jump to latest ↓
        </button>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Cards
// ---------------------------------------------------------------------------

const Item = memo(function Item({
  item,
  sessionId,
}: {
  item: TranscriptItem;
  sessionId: string;
}): JSX.Element | null {
  switch (item.kind) {
    case "user":
      return <div className="msg-user">{item.text}</div>;
    case "assistant":
      return (
        <div className="msg-assistant">
          {item.thinking && (
            <details className="thinking">
              <summary>Thinking</summary>
              <div className="thinking-body">{item.thinking}</div>
            </details>
          )}
          {item.text &&
            (item.streaming ? (
              // Plain text while streaming avoids re-parsing markdown per delta;
              // the final render swaps in the full markdown tree.
              <div className="streaming-text">{item.text}</div>
            ) : (
              <Markdown text={item.text} />
            ))}
        </div>
      );
    case "tool":
      return <ToolCard item={item} />;
    case "advisor":
      return <AdvisorCard item={item} />;
    case "subagent":
      return <SubagentCard item={item} />;
    case "approval":
      return <ApprovalCard item={item} sessionId={sessionId} />;
    case "interaction":
      return <InteractionCard item={item} sessionId={sessionId} />;
    case "system":
      return item.tone === "info" ? (
        <div className="hint center">{item.text}</div>
      ) : (
        <div className={`banner${item.tone === "warn" ? " warn" : ""}`}>{item.text}</div>
      );
    default:
      return null;
  }
});

// ---- tools ----------------------------------------------------------------

function argSummary(name: string, args: Record<string, unknown>, detail?: ToolDetail): string {
  if (detail?.kind === "bash") return detail.command;
  if (detail?.kind === "edit" || detail?.kind === "write" || detail?.kind === "read")
    return detail.path;
  if (detail?.kind === "search") return `"${detail.query}"`;
  switch (name) {
    case "bash":
      return String(args.command ?? "");
    case "read":
    case "write":
    case "edit":
    case "ast_edit":
      return String(args.path ?? args.file ?? "");
    case "grep":
    case "ast_grep":
    case "glob":
      return String(args.pattern ?? args.query ?? "");
    default: {
      const first = Object.values(args).find((v) => typeof v === "string");
      return typeof first === "string" ? first.slice(0, 120) : "";
    }
  }
}

/** "server__tool" style MCP names render with explicit MCP identity. */
function toolTitle(name: string): { label: string; mcp?: string } {
  const m = /^mcp__([^_]+(?:_[^_]+)*?)__(.+)$/.exec(name) ?? /^([^_]+)__(.+)$/.exec(name);
  if (m) return { label: m[2], mcp: m[1] };
  return { label: name };
}

const ToolCard = memo(function ToolCard({
  item,
}: {
  item: Extract<TranscriptItem, { kind: "tool" }>;
}): JSX.Element {
  const { label, mcp } = toolTitle(item.name);
  const d = item.detail;
  return (
    <div className={`tool-card ${item.state}`}>
      <div className="tool-head">
        {mcp && <span className="chip mcp-chip">MCP · {mcp}</span>}
        <span className="tool-name">{label}</span>
        <span className="tool-arg mono" title={argSummary(item.name, item.args, d)}>
          {argSummary(item.name, item.args, d)}
        </span>
        <span className="spacer" />
        {item.state === "running" && <span className="hint">running…</span>}
        {d?.kind === "edit" && (
          <span className="diffstat">
            <span className="add">+{d.additions}</span> <span className="del">-{d.deletions}</span>
          </span>
        )}
        {d?.kind === "search" && <span className="hint">{fmtCount(d.matches)} matches</span>}
        {d?.kind === "read" && d.lines > 0 && (
          <span className="hint">{fmtCount(d.lines)} lines</span>
        )}
        {d?.kind === "bash" && typeof d.exitCode === "number" && d.exitCode !== 0 && (
          <span className="chip warn-chip">exit {d.exitCode}</span>
        )}
        {typeof item.durationMs === "number" && item.durationMs > 500 && (
          <span className="hint">{fmtDuration(item.durationMs)}</span>
        )}
      </div>
      {d?.kind === "edit" && d.diff ? (
        <Diff diff={d.diff} />
      ) : item.output ? (
        <Output text={item.output} error={item.state === "error"} />
      ) : null}
      {item.error && item.state === "error" && !item.output && (
        <div className="banner">{item.error.slice(0, 600)}</div>
      )}
    </div>
  );
});

const OUTPUT_COLLAPSE_LINES = 14;

const Output = memo(function Output({
  text,
  error,
}: {
  text: string;
  error?: boolean;
}): JSX.Element {
  const [expanded, setExpanded] = useState(false);
  const lines = text.replace(/\n+$/, "").split("\n");
  const collapsed = !expanded && lines.length > OUTPUT_COLLAPSE_LINES;
  const shown = collapsed
    ? [...lines.slice(0, 6), `… ${fmtCount(lines.length - 12)} lines …`, ...lines.slice(-6)]
    : lines;
  return (
    <div>
      <pre className={`tool-output${error ? " error" : ""}`}>{shown.join("\n")}</pre>
      <div className="row">
        {lines.length > OUTPUT_COLLAPSE_LINES && (
          <button className="btn btn-ghost" onClick={() => setExpanded((v) => !v)}>
            {expanded ? "Collapse" : `Show all ${fmtCount(lines.length)} lines`}
          </button>
        )}
        <button className="btn btn-ghost" onClick={() => void navigator.clipboard.writeText(text)}>
          Copy
        </button>
      </div>
    </div>
  );
});

const DIFF_COLLAPSE_LINES = 80;

export const Diff = memo(function Diff({ diff }: { diff: string }): JSX.Element {
  const [expanded, setExpanded] = useState(false);
  const lines = diff.split("\n");
  const shown = expanded ? lines : lines.slice(0, DIFF_COLLAPSE_LINES);
  return (
    <div>
      <pre className="diff">
        {shown.map((l, i) => (
          <div
            key={i}
            className={
              l.startsWith("+") && !l.startsWith("+++")
                ? "l-add"
                : l.startsWith("-") && !l.startsWith("---")
                  ? "l-del"
                  : l.startsWith("@@")
                    ? "l-hunk"
                    : undefined
            }
          >
            {l || " "}
          </div>
        ))}
      </pre>
      <div className="row">
        {lines.length > DIFF_COLLAPSE_LINES && (
          <button className="btn btn-ghost" onClick={() => setExpanded((v) => !v)}>
            {expanded ? "Collapse" : `Show all ${fmtCount(lines.length)} lines`}
          </button>
        )}
        <button className="btn btn-ghost" onClick={() => void navigator.clipboard.writeText(diff)}>
          Copy
        </button>
      </div>
    </div>
  );
});

// ---- advisors -------------------------------------------------------------

const AdvisorCard = memo(function AdvisorCard({
  item,
}: {
  item: Extract<TranscriptItem, { kind: "advisor" }>;
}): JSX.Element {
  return (
    <div className={`advisor-card ${item.severity}`}>
      <div className="advisor-head">
        <span className="advisor-name">{item.name}</span>
        <span className={`severity-badge ${item.severity}`}>
          {item.severity === "unknown" ? "note" : item.severity}
        </span>
        {item.at && (
          <span className="hint">
            {new Date(item.at).toLocaleTimeString(undefined, {
              hour: "2-digit",
              minute: "2-digit",
            })}
          </span>
        )}
      </div>
      <div className="advisor-body">
        <Markdown text={item.text} />
      </div>
    </div>
  );
});

// ---- subagents ------------------------------------------------------------

const SubagentCard = memo(function SubagentCard({
  item,
}: {
  item: Extract<TranscriptItem, { kind: "subagent" }>;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const status =
    item.state === "running"
      ? item.currentTool
        ? `running ${item.currentTool}`
        : (item.activity ?? "running")
      : item.state === "error"
        ? (item.error ?? "failed")
        : "complete";
  return (
    <div className={`subagent-card ${item.state}`}>
      <div className="subagent-head" onClick={() => setOpen((v) => !v)}>
        <span className="chip">
          Subagent{item.agent && item.agent !== "task" ? ` · ${item.agent}` : ""}
        </span>
        <span className="subagent-label">{item.label}</span>
        <span className="spacer" />
        <span className="hint">{status}</span>
      </div>
      <div className="subagent-meta hint">
        {fmtCount(item.toolCalls)} tool calls
        {typeof item.tokens === "number" && ` · ${fmtTokens(item.tokens)} tokens`}
        {typeof item.durationMs === "number" && ` · ${fmtDuration(item.durationMs)}`}
        {item.model && ` · ${item.model}`}
      </div>
      {open && item.task && (
        <div className="subagent-task">
          <div className="hint">Task</div>
          <div>{item.task}</div>
        </div>
      )}
    </div>
  );
});

// ---- approvals ------------------------------------------------------------

const ApprovalCard = memo(function ApprovalCard({
  item,
  sessionId,
}: {
  item: Extract<TranscriptItem, { kind: "approval" }>;
  sessionId: string;
}): JSX.Element {
  const [busy, setBusy] = useState(false);

  const respond = async (optionId: string) => {
    setBusy(true);
    try {
      await engine.request("approval.respond", {
        sessionId,
        approvalId: item.approvalId,
        optionId,
      });
    } catch {
      setBusy(false); // resolution event flips the card on success
    }
  };

  if (item.state !== "pending") {
    const label =
      item.state === "cancelled"
        ? "Cancelled"
        : (item.options.find((o) => o.id === item.resolution)?.label ?? item.resolution);
    return (
      <div className="approval-card resolved">
        <span className="chip">{item.toolName}</span>
        <span className="tool-arg mono">{item.detail ?? item.summary}</span>
        <span className="spacer" />
        <span className="hint">{label}</span>
      </div>
    );
  }

  return (
    <div className="approval-card">
      <div className="approval-head">
        <span className="approval-title">Approval needed</span>
        <span className="chip">{item.toolName}</span>
      </div>
      <div className="approval-summary">{item.summary}</div>
      {item.detail && <pre className="tool-output approval-detail">{item.detail}</pre>}
      <div className="row approval-actions">
        {item.options.map((o) => (
          <button
            key={o.id}
            className={`btn ${o.kind === "deny" ? "btn-danger" : o.kind === "allow" ? "btn-primary" : ""}`}
            disabled={busy}
            onClick={() => void respond(o.id)}
          >
            {o.label}
          </button>
        ))}
      </div>
    </div>
  );
});

// ---- extension UI ---------------------------------------------------------

const InteractionCard = memo(function InteractionCard({
  item,
  sessionId,
}: {
  item: Extract<TranscriptItem, { kind: "interaction" }>;
  sessionId: string;
}): JSX.Element {
  const [busy, setBusy] = useState(false);
  const [text, setText] = useState(item.ui.kind === "editor" ? item.ui.initial : "");

  const respond = async (value: unknown, cancelled = false) => {
    setBusy(true);
    try {
      await engine.request("extension.ui.respond", {
        sessionId,
        requestId: item.requestId,
        value,
        cancelled,
      });
      // The worker resolves the promise; the local card state flips when the
      // store sees the response acknowledged (no dedicated event — mark now).
      useStore.getState().apply({
        type: "approval.resolved",
        sessionId,
        approvalId: item.requestId,
        optionId: cancelled ? "cancelled" : "ok",
      } as never);
    } catch {
      setBusy(false);
    }
  };

  if (item.state !== "pending") {
    return (
      <div className="approval-card resolved">
        <span className="chip">{item.extensionName}</span>
        <span className="hint">{item.state === "cancelled" ? "Cancelled" : "Answered"}</span>
      </div>
    );
  }

  const ui = item.ui;
  return (
    <div className="approval-card">
      <div className="approval-head">
        <span className="approval-title">
          {ui.kind === "unsupported" ? "Unsupported interaction" : "Input needed"}
        </span>
        {item.extensionName !== "extension" && <span className="chip">{item.extensionName}</span>}
      </div>

      {ui.kind === "confirm" && (
        <>
          <div className="approval-summary">{ui.title}</div>
          {ui.message && <div className="hint">{ui.message}</div>}
          <div className="row approval-actions">
            <button className="btn btn-primary" disabled={busy} onClick={() => void respond(true)}>
              Confirm
            </button>
            <button className="btn" disabled={busy} onClick={() => void respond(false)}>
              Cancel
            </button>
          </div>
        </>
      )}

      {ui.kind === "select" && (
        <>
          <div className="approval-summary">{ui.title}</div>
          <div className="select-options">
            {ui.options.map((o) => (
              <button
                key={o.id}
                className="btn select-option"
                disabled={busy}
                onClick={() => void respond(o.id)}
              >
                {o.label}
              </button>
            ))}
          </div>
          <div className="row approval-actions">
            <button
              className="btn btn-ghost"
              disabled={busy}
              onClick={() => void respond(undefined, true)}
            >
              Cancel
            </button>
          </div>
        </>
      )}

      {(ui.kind === "input" || ui.kind === "editor") && (
        <>
          <div className="approval-summary">{ui.title}</div>
          {ui.kind === "input" ? (
            <input
              className="input"
              type={ui.secret ? "password" : "text"}
              placeholder={ui.placeholder}
              value={text}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void respond(text);
              }}
              autoFocus
            />
          ) : (
            <textarea
              className="input"
              rows={8}
              value={text}
              onChange={(e) => setText(e.target.value)}
              autoFocus
            />
          )}
          <div className="row approval-actions">
            <button className="btn btn-primary" disabled={busy} onClick={() => void respond(text)}>
              Submit
            </button>
            <button className="btn" disabled={busy} onClick={() => void respond(undefined, true)}>
              Cancel
            </button>
          </div>
        </>
      )}

      {ui.kind === "unsupported" && (
        <>
          <div className="hint">{ui.description}</div>
          <div className="row approval-actions">
            <button className="btn" disabled={busy} onClick={() => void respond(undefined, true)}>
              Dismiss
            </button>
          </div>
        </>
      )}
    </div>
  );
});
