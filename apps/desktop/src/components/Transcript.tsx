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
import { ask } from "@tauri-apps/plugin-dialog";
import type { JSX } from "react";
import { memo, useLayoutEffect, useRef, useState } from "react";
import { engine } from "../engine-client";
import {
  fmtCount,
  fmtDuration,
  fmtTokens,
  isActive,
  type TranscriptItem,
  useStore,
} from "../store";
import { Markdown } from "./Markdown";

/**
 * Rewind the conversation to before a user message (OMP tree navigation).
 * The transcript's user bubbles and OMP's branchable user entries are the
 * same list in the same order; the text check catches any drift and refuses
 * rather than rewinding to the wrong place. Conversation-only — files on
 * disk stay as the agent left them.
 */
async function rewindTo(
  sessionId: string,
  items: TranscriptItem[],
  item: Extract<TranscriptItem, { kind: "user" }>,
): Promise<void> {
  const yes = await ask(
    "Rewind the conversation to before this message? The message text returns to the composer for editing. Files on disk are not changed.",
    { title: "Rewind", kind: "warning" },
  );
  if (!yes) return;
  const st = useStore.getState();
  try {
    const { points } = await engine.request("session.rewindPoints", { sessionId });
    const userItems = items.filter((i) => i.kind === "user");
    const idx = userItems.findIndex((i) => i.id === item.id);
    const norm = (t: string) => t.trim().slice(0, 120);
    let point = idx >= 0 && idx < points.length ? points[idx] : undefined;
    if (!point || norm(point.text) !== norm(item.text)) {
      const matches = points.filter((p) => norm(p.text) === norm(item.text));
      point = matches.length === 1 ? matches[0] : undefined;
    }
    if (!point) {
      throw new Error("Couldn't match this message to a rewind point — try an adjacent one.");
    }
    const res = await engine.request("session.rewind", { sessionId, entryId: point.entryId });
    if (res.cancelled) return;
    const t = await engine.request("session.transcript", { sessionId });
    st.hydrateTranscript(sessionId, t.events);
    st.setComposerPrefill({ sessionId, text: res.editorText ?? item.text });
  } catch (e) {
    st.setEngineError(e as never);
  }
}

const WINDOW = 300;

export function Transcript({
  items,
  sessionId,
}: {
  items: TranscriptItem[];
  sessionId: string;
}): JSX.Element {
  const projectPath = useStore((s) => s.sessions[sessionId]?.summary.projectPath);
  const runState = useStore((s) => s.sessions[sessionId]?.summary.runState);
  // Rewind is only offered at rest — mid-run history surgery is a footgun.
  const canRewind = runState !== undefined && !isActive(runState);
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
        {/* .stream is the measure: centred column with side padding, so text
            never runs wall to wall. */}
        <div className="stream">
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
          {toNodes(visible).map((n) =>
            n.kind === "plain" ? (
              <Item
                key={n.item.id}
                item={n.item}
                sessionId={sessionId}
                projectPath={projectPath}
                onRewind={
                  canRewind && n.item.kind === "user"
                    ? () => void rewindTo(sessionId, items, n.item as never)
                    : undefined
                }
              />
            ) : (
              <WorkGroup
                key={n.key}
                items={n.items}
                sessionId={sessionId}
                live={n.live}
                projectPath={projectPath}
              />
            ),
          )}
        </div>
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
// Turn condensing
//
// Once a turn's answer arrives, the work that produced it — thinking-only
// messages, tool calls, subagents, settled approvals — condenses into one
// "Worked for …" line before the answer. Work still in flight (no answer yet)
// gathers into a LIVE group: one status line naming the current step, with the
// latest thinking previewed underneath, expandable to the full step list —
// never a wall of interleaved cards. Advisor notes, system lines, and anything
// pending never condense.
// ---------------------------------------------------------------------------

type RenderNode =
  | { kind: "plain"; item: TranscriptItem }
  | { kind: "work"; key: string; items: TranscriptItem[]; live: boolean };

/** Items that must never disappear into a collapsed work group. */
function alwaysVisible(i: TranscriptItem): boolean {
  if (i.kind === "user" || i.kind === "system" || i.kind === "advisor") return true;
  if ((i.kind === "approval" || i.kind === "interaction") && i.state === "pending") return true;
  return false;
}

/**
 * Condensing, done completely: within a turn (user message to user message),
 * EVERYTHING that led to the latest answer — thinking, tool calls, subagents,
 * settled approvals, and intermediate narration — folds into a single
 * "Worked" line before that answer. Only the latest answer stays out. Work
 * with no answer yet (before the first answer, or after one when the agent
 * keeps going) gathers into a live group instead of streaming as loose cards.
 * Advisor notes, system lines, and pending approvals are always visible.
 */
function toNodes(items: TranscriptItem[]): RenderNode[] {
  const nodes: RenderNode[] = [];
  let turn: TranscriptItem[] = [];

  const flushTurn = () => {
    if (!turn.length) return;
    // The latest answer in this turn (streaming or not — once answer text
    // exists, the work that produced it is history).
    let lastAnswer = -1;
    for (let i = turn.length - 1; i >= 0; i--) {
      const it = turn[i];
      if (it.kind === "assistant" && it.text) {
        lastAnswer = i;
        break;
      }
    }
    const bucket: TranscriptItem[] = [];
    let bucketLive = false;
    const flushBucket = () => {
      if (!bucket.length) return;
      nodes.push({ kind: "work", key: `wg-${bucket[0].id}`, items: [...bucket], live: bucketLive });
      bucket.length = 0;
    };
    turn.forEach((it, i) => {
      if (i === lastAnswer || alwaysVisible(it)) {
        // The answer itself, or a kind that never collapses.
        flushBucket();
        nodes.push({ kind: "plain", item: it });
        return;
      }
      // Work before the latest answer is history; work after it (or with no
      // answer yet) is still in flight.
      const live = lastAnswer === -1 || i > lastAnswer;
      if (bucket.length && bucketLive !== live) flushBucket();
      bucketLive = live;
      bucket.push(it);
    });
    flushBucket();
    turn = [];
  };

  for (const item of items) {
    if (item.kind === "user") {
      flushTurn();
      nodes.push({ kind: "plain", item });
    } else {
      turn.push(item);
    }
  }
  flushTurn();
  return nodes;
}

/** What the agent is doing right now, from the newest item of a live group. */
function liveLabel(items: TranscriptItem[]): string {
  for (let i = items.length - 1; i >= 0; i--) {
    const it = items[i];
    if (it.kind === "tool" && it.state === "running") {
      const { label } = toolTitle(it.name);
      return `Running ${label}`;
    }
    if (it.kind === "subagent" && it.state === "running") return "Running subagent";
    if (it.kind === "assistant" && it.streaming) return "Thinking…";
    // Anything settled below this point is done work, not current activity.
    if (it.kind === "tool" || it.kind === "subagent" || it.kind === "assistant") break;
  }
  return "Working…";
}

function WorkGroup({
  items,
  sessionId,
  live,
  projectPath,
}: {
  items: TranscriptItem[];
  sessionId: string;
  live: boolean;
  projectPath?: string;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const ms = items.reduce(
    (n, i) => n + ((i.kind === "tool" || i.kind === "subagent") && i.durationMs ? i.durationMs : 0),
    0,
  );
  const label = live ? liveLabel(items) : ms > 0 ? `Worked for ${fmtDuration(ms)}` : "Worked";
  // Collapsed live groups still show where the reasoning is going: the tail of
  // the newest thinking, clipped to its last few lines.
  let preview: string | undefined;
  if (live && !open) {
    for (let i = items.length - 1; i >= 0; i--) {
      const it = items[i];
      if (it.kind === "assistant" && it.thinking) {
        preview = it.thinking;
        break;
      }
    }
  }
  return (
    <div className={`work-group${open ? " open" : ""}${live ? " live" : ""}`}>
      <button className="work-head" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
        <span className="tool-chevron">{open ? "▾" : "▸"}</span>
        {live && <span className="work-live-dot" aria-hidden />}
        <span>{label}</span>
        <span className="hint">
          {fmtCount(items.length)} step{items.length === 1 ? "" : "s"}
        </span>
      </button>
      {preview && (
        <div className="work-live-preview">
          <div className="thinking-live-clip">
            <div className="thinking-body">{preview}</div>
          </div>
        </div>
      )}
      {open && (
        <div className="work-body">
          {items.map((item) => (
            <Item key={item.id} item={item} sessionId={sessionId} projectPath={projectPath} />
          ))}
        </div>
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
  projectPath,
  onRewind,
}: {
  item: TranscriptItem;
  sessionId: string;
  projectPath?: string;
  onRewind?: () => void;
}): JSX.Element | null {
  switch (item.kind) {
    case "user":
      return (
        <div className="msg-user">
          {onRewind && (
            <button
              type="button"
              className="rewind-btn"
              title="Rewind the conversation to before this message (files are not changed)"
              onClick={onRewind}
            >
              ↺
            </button>
          )}
          {item.attachments && item.attachments.length > 0 && (
            <div className="attachment-row">
              {item.attachments.map((a, i) => (
                <span key={i} className="chip attachment-chip" title={a.path}>
                  {a.kind === "image" ? "🖼" : "📄"} {a.name}
                </span>
              ))}
            </div>
          )}
          {item.text}
        </div>
      );
    case "assistant": {
      // Thinking is visible live while the model reasons, then tucks behind a
      // dropdown the moment answer text arrives — the transcript shows answers,
      // not scratch work.
      const thinkingLive = item.streaming && !item.text;
      return (
        <div className="msg-assistant">
          {item.thinking &&
            (thinkingLive ? (
              <div className="thinking-live">
                <div className="thinking-live-label hint">Thinking…</div>
                <div className="thinking-live-clip">
                  <div className="thinking-body">{item.thinking}</div>
                </div>
              </div>
            ) : (
              <details className="thinking">
                <summary>Thought process</summary>
                <div className="thinking-body">{item.thinking}</div>
              </details>
            ))}
          {item.text &&
            (item.streaming ? (
              // Plain text while streaming avoids re-parsing markdown per delta;
              // the final render swaps in the full markdown tree.
              <div className="streaming-text">{item.text}</div>
            ) : (
              <Markdown text={item.text} projectPath={projectPath} />
            ))}
        </div>
      );
    }
    case "tool":
      return <ToolCard item={item} projectPath={projectPath} />;
    case "advisor":
      return <AdvisorCard item={item} projectPath={projectPath} />;
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
  projectPath,
}: {
  item: Extract<TranscriptItem, { kind: "tool" }>;
  projectPath?: string;
}): JSX.Element {
  const { label, mcp } = toolTitle(item.name);
  const d = item.detail;
  // File-flavoured tool calls get a clickable path, like Codex/Claude Code.
  const clickPath =
    d?.kind === "edit" || d?.kind === "write" || d?.kind === "read" ? d.path : undefined;
  const openPath = () => {
    if (!clickPath) return;
    const abs = clickPath.startsWith("/") ? clickPath : `${projectPath}/${clickPath}`;
    // Project files preview in the inspector; anything else opens externally.
    if (projectPath && (abs === projectPath || abs.startsWith(`${projectPath}/`))) {
      useStore.getState().openFilePreview({ path: abs, projectPath });
      return;
    }
    void engine.request("path.open", { path: abs }).catch(() => {});
  };
  // One quiet line per tool call; output/diff only on request. Errors
  // auto-expand — those are the ones worth reading.
  const [openState, setOpen] = useState<boolean | null>(null);
  const hasBody = Boolean(
    (d?.kind === "edit" && d.diff) || item.output || (item.error && item.state === "error"),
  );
  const open = openState ?? item.state === "error";
  return (
    <div className={`tool-card ${item.state}`}>
      <div
        className={`tool-head${hasBody ? " expandable" : ""}`}
        onClick={hasBody ? () => setOpen((v) => !(v ?? item.state === "error")) : undefined}
      >
        {hasBody && <span className="tool-chevron">{open ? "▾" : "▸"}</span>}
        {mcp && <span className="chip mcp-chip">MCP · {mcp}</span>}
        <span className="tool-name">{label}</span>
        {clickPath ? (
          <button
            type="button"
            className="tool-arg mono file-ref"
            title={`${argSummary(item.name, item.args, d)} — click to preview`}
            onClick={(e) => {
              e.stopPropagation();
              openPath();
            }}
          >
            {argSummary(item.name, item.args, d)}
          </button>
        ) : (
          <span className="tool-arg mono" title={argSummary(item.name, item.args, d)}>
            {argSummary(item.name, item.args, d)}
          </span>
        )}
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
      {open && (
        <>
          {d?.kind === "edit" && d.diff ? (
            <Diff diff={d.diff} />
          ) : item.output ? (
            <Output text={item.output} error={item.state === "error"} />
          ) : null}
          {item.error && item.state === "error" && !item.output && (
            <div className="banner">{item.error.slice(0, 600)}</div>
          )}
        </>
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
  projectPath,
}: {
  item: Extract<TranscriptItem, { kind: "advisor" }>;
  projectPath?: string;
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
        <Markdown text={item.text} projectPath={projectPath} />
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
    <div className="approval-card" id={`titem-${item.id}`}>
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
    <div className="approval-card" id={`titem-${item.id}`}>
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
