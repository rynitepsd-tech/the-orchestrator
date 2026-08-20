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
import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { engine } from "../engine-client";
import {
  fmtCount,
  fmtDuration,
  fmtTokens,
  isActive,
  type TranscriptItem,
  useStore,
} from "../store";
import type { OmpToolViewData, OmpToolViewElement } from "../types/omp-tool-view";
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
          {toNodes(visible, runState !== undefined && isActive(runState)).map((n) =>
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
            ) : n.kind === "files" ? (
              <FilesRow key={n.key} files={n.files} projectPath={projectPath} />
            ) : (
              <WorkGroup
                key={n.key}
                items={n.items}
                sessionId={sessionId}
                live={n.live}
                durationMs={n.durationMs}
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
// While a turn is running, NOTHING condenses: the work streams as an open
// timeline — thinking, tool calls, subagents — so the user can watch where
// the agent is heading and steer or stop it. Advisor notes and anything
// pending stay outside the timeline, always visible.
//
// Only when the turn is completely finished (a turn-end marker arrives, a new
// user message starts the next turn, or the session is at rest) does the work
// collapse into one Codex-style "Worked for …" line, followed by the final
// answer and the files it edited.
// ---------------------------------------------------------------------------

type EditedFile = { path: string; additions: number; deletions: number; created?: boolean };

type RenderNode =
  | { kind: "plain"; item: TranscriptItem }
  | { kind: "work"; key: string; items: TranscriptItem[]; live: boolean; durationMs?: number }
  | { kind: "files"; key: string; files: EditedFile[] };

/** Items that must never disappear into a collapsed work group. */
function alwaysVisible(i: TranscriptItem): boolean {
  if (i.kind === "user" || i.kind === "system" || i.kind === "turn-end") return true;
  if ((i.kind === "approval" || i.kind === "interaction") && i.state === "pending") return true;
  return false;
}

/** Files the segment's successful edit/write tool calls touched, deduped. */
function editedFiles(items: TranscriptItem[]): EditedFile[] {
  const map = new Map<string, EditedFile>();
  for (const it of items) {
    if (it.kind !== "tool" || it.state !== "ok") continue;
    const d = it.detail;
    if (!d || (d.kind !== "edit" && d.kind !== "write")) continue;
    const f = map.get(d.path) ?? { path: d.path, additions: 0, deletions: 0 };
    if (d.kind === "edit") {
      f.additions += d.additions;
      f.deletions += d.deletions;
    } else if (d.created) {
      f.created = true;
    }
    map.set(d.path, f);
  }
  return [...map.values()];
}

/**
 * Segments are delimited by user messages and turn-end markers. An open
 * (still-running) segment renders as live groups with everything visible;
 * a finished one condenses everything but its final answer into a single
 * "Worked for …" line, with an edited-files row after the answer.
 */
function toNodes(items: TranscriptItem[], sessionActive: boolean): RenderNode[] {
  const nodes: RenderNode[] = [];
  let seg: TranscriptItem[] = [];

  const flushSegment = (closed: boolean, durationMs?: number) => {
    if (!seg.length) return;
    const segment = seg;
    seg = [];

    if (!closed) {
      // Still running: advisor notes and alwaysVisible items stay plain; all
      // work gathers into live groups that render expanded.
      const bucket: TranscriptItem[] = [];
      const flushBucket = () => {
        if (!bucket.length) return;
        nodes.push({ kind: "work", key: `wg-${bucket[0].id}`, items: [...bucket], live: true });
        bucket.length = 0;
      };
      for (const it of segment) {
        // System notices ride inside the live timeline (it's expanded, so
        // they're visible) rather than splitting it into several pulsing
        // groups; the closed pass pulls them back out as plain lines.
        if ((alwaysVisible(it) && it.kind !== "system") || it.kind === "advisor") {
          flushBucket();
          nodes.push({ kind: "plain", item: it });
        } else {
          bucket.push(it);
        }
      }
      flushBucket();
      return;
    }

    // Finished: answers stay out; everything else — thinking, tools,
    // subagents, settled approvals, advisor notes, intermediate narration —
    // folds into "Worked" lines. An advisor-driven turn produces SEVERAL real
    // answers separated by review notes, so every substantive report stays
    // visible — folding all but the literal last message buried a 20-minute
    // report under the "Worked" line while a trailing bookkeeping remark
    // became "the" answer. One-line narration ("Now the db layer:") condenses.
    const isReport = (it: TranscriptItem): boolean =>
      it.kind === "assistant" && (it.text.trim().length >= 400 || /\n\s*\n/.test(it.text.trim()));
    let lastAnswer = -1;
    for (let i = segment.length - 1; i >= 0; i--) {
      const it = segment[i];
      if (it.kind === "assistant" && it.text) {
        lastAnswer = i;
        break;
      }
    }
    const files = editedFiles(segment);
    let filesEmitted = false;
    const bucket: TranscriptItem[] = [];
    let firstBucket = true;
    const flushBucket = () => {
      if (!bucket.length) return;
      nodes.push({
        kind: "work",
        key: `wg-${bucket[0].id}`,
        items: [...bucket],
        live: false,
        // The turn's wall time labels the main work line; splinter buckets
        // (split off by system lines) fall back to their summed durations.
        durationMs: firstBucket ? durationMs : undefined,
      });
      firstBucket = false;
      bucket.length = 0;
    };
    segment.forEach((it, i) => {
      if (i === lastAnswer || isReport(it) || alwaysVisible(it)) {
        flushBucket();
        nodes.push({ kind: "plain", item: it });
        if (i === lastAnswer && files.length) {
          nodes.push({ kind: "files", key: `files-${it.id}`, files });
          filesEmitted = true;
        }
        return;
      }
      bucket.push(it);
    });
    flushBucket();
    // A segment with edits but no answer (interrupted turn) still lists them.
    if (files.length && !filesEmitted) {
      nodes.push({ kind: "files", key: `files-${segment[0].id}`, files });
    }
  };

  for (const item of items) {
    if (item.kind === "user") {
      flushSegment(true);
      nodes.push({ kind: "plain", item });
    } else if (item.kind === "turn-end") {
      flushSegment(true, item.durationMs);
      nodes.push({ kind: "plain", item });
    } else {
      seg.push(item);
    }
  }
  // The trailing segment is live only while the session is actually running;
  // at rest (including hydrated sessions with no markers) it condenses.
  flushSegment(!sessionActive);
  return nodes;
}

// ---------------------------------------------------------------------------
// Work-group body: Fable-style timeline
//
// Inside an expanded work group, consecutive tool calls fold into one compact
// row — "Ran 6 commands, read 2 files, edited store.ts +12 -1" — expandable
// to the individual cards. Narration, thinking, subagents, and everything
// else render between those rows, so the timeline reads as prose punctuated
// by activity summaries instead of a wall of tool cards.
// ---------------------------------------------------------------------------

type ToolItem = Extract<TranscriptItem, { kind: "tool" }>;

type BodyNode =
  | { kind: "item"; item: TranscriptItem }
  | { kind: "tools"; key: string; tools: ToolItem[] };

/** Chunk a group's items so consecutive tool calls share one summary row. */
function toBodyNodes(items: TranscriptItem[]): BodyNode[] {
  const nodes: BodyNode[] = [];
  let run: ToolItem[] = [];
  const flush = () => {
    if (!run.length) return;
    nodes.push({ kind: "tools", key: `tr-${run[0].id}`, tools: run });
    run = [];
  };
  for (const it of items) {
    if (it.kind === "tool") run.push(it);
    else {
      flush();
      nodes.push({ kind: "item", item: it });
    }
  }
  flush();
  return nodes;
}

const base = (p: string) => p.split("/").pop() || p;

/** "Ran 6 commands, read 2 files, edited store.ts +12 -1" */
function toolRunSummary(tools: ToolItem[]): string {
  type Cat = "cmd" | "read" | "edit" | "search" | "other";
  const catOf = (t: ToolItem): Cat => {
    const k = t.detail?.kind;
    if (k === "bash" || t.name === "bash") return "cmd";
    if (k === "read" || t.name === "read") return "read";
    if (k === "edit" || k === "write" || ["edit", "ast_edit", "write"].includes(t.name))
      return "edit";
    if (k === "search" || ["grep", "ast_grep", "glob", "search"].includes(t.name)) return "search";
    return "other";
  };
  const order: Cat[] = [];
  const n: Record<Cat, number> = { cmd: 0, read: 0, edit: 0, search: 0, other: 0 };
  const readPaths = new Set<string>();
  const editPaths = new Set<string>();
  const otherLabels = new Set<string>();
  let additions = 0;
  let deletions = 0;
  let query: string | undefined;
  for (const t of tools) {
    const c = catOf(t);
    if (!order.includes(c)) order.push(c);
    n[c]++;
    const d = t.detail;
    if (c === "read" && d?.kind === "read") readPaths.add(d.path);
    if (c === "edit" && (d?.kind === "edit" || d?.kind === "write")) editPaths.add(d.path);
    if (c === "edit" && d?.kind === "edit") {
      additions += d.additions;
      deletions += d.deletions;
    }
    if (c === "search" && d?.kind === "search") query = d.query;
    if (c === "other") otherLabels.add(toolTitle(t.name).label);
  }
  const parts = order.map((c) => {
    switch (c) {
      case "cmd":
        return n.cmd === 1 ? "ran a command" : `ran ${n.cmd} commands`;
      case "read": {
        const files = readPaths.size || n.read;
        return files === 1
          ? `read ${readPaths.size === 1 ? base([...readPaths][0]) : "a file"}`
          : `read ${files} files`;
      }
      case "edit": {
        const files = editPaths.size || n.edit;
        const what =
          files === 1
            ? `edited ${editPaths.size === 1 ? base([...editPaths][0]) : "a file"}`
            : `edited ${files} files`;
        return additions > 0 || deletions > 0 ? `${what} +${additions} -${deletions}` : what;
      }
      case "search":
        return n.search === 1
          ? query
            ? `searched "${query.length > 30 ? `${query.slice(0, 30)}…` : query}"`
            : "ran a search"
          : `ran ${n.search} searches`;
      default:
        return n.other === 1
          ? `used ${[...otherLabels][0]}`
          : otherLabels.size === 1
            ? `used ${[...otherLabels][0]} ×${n.other}`
            : `made ${n.other} tool calls`;
    }
  });
  const s = parts.join(", ");
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function ToolRunRow({
  tools,
  sessionId,
  projectPath,
}: {
  tools: ToolItem[];
  sessionId: string;
  projectPath?: string;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const running = tools.some((t) => t.state === "running");
  const failed = tools.filter((t) => t.state === "error").length;
  return (
    <div className={`tool-run${open ? " open" : ""}`}>
      <button className="tool-run-head" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
        <span className="tool-chevron">{open ? "▾" : "▸"}</span>
        <span className="tool-run-summary">{toolRunSummary(tools)}</span>
        {running && <span className="hint">running…</span>}
        {failed > 0 && <span className="chip warn-chip">{failed} failed</span>}
      </button>
      {open && (
        <div className="tool-run-body">
          {tools.map((t) => (
            <Item key={t.id} item={t} sessionId={sessionId} projectPath={projectPath} />
          ))}
        </div>
      )}
    </div>
  );
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
    if (it.kind === "assistant" && it.streaming) return it.text ? "Responding…" : "Thinking…";
    // Anything settled below this point is done work, not current activity.
    if (it.kind === "tool" || it.kind === "subagent" || it.kind === "assistant") break;
  }
  return "Working…";
}

function WorkGroup({
  items,
  sessionId,
  live,
  durationMs,
  projectPath,
}: {
  items: TranscriptItem[];
  sessionId: string;
  live: boolean;
  /** Wall time of the finished turn, from its turn-end marker. */
  durationMs?: number;
  projectPath?: string;
}): JSX.Element {
  // Live groups stream expanded so the user can watch the agent work; the
  // moment the turn finishes they condense to one line. A manual toggle wins
  // either way, but resets when the group settles so finishing collapses it.
  const [toggled, setToggled] = useState<boolean | null>(null);
  useEffect(() => {
    if (!live) setToggled(null);
  }, [live]);
  const open = toggled ?? live;
  const summed = items.reduce(
    (n, i) => n + ((i.kind === "tool" || i.kind === "subagent") && i.durationMs ? i.durationMs : 0),
    0,
  );
  const ms = durationMs ?? summed;
  const label = live ? liveLabel(items) : ms >= 1000 ? `Worked for ${fmtDuration(ms)}` : "Worked";
  // A manually-collapsed live group still shows where the reasoning is going:
  // the tail of the newest thinking, clipped to its last few lines.
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
      <button className="work-head" onClick={() => setToggled(!open)} aria-expanded={open}>
        <span className="tool-chevron">{open ? "▾" : "▸"}</span>
        {live && <span className="work-live-dot" aria-hidden />}
        <span>{label}</span>
        <span className="hint">
          {fmtCount(items.length)} step{items.length === 1 ? "" : "s"}
          {(() => {
            const notes = items.filter((i) => i.kind === "advisor").length;
            return notes > 0 ? ` · ${notes} advisor note${notes === 1 ? "" : "s"}` : "";
          })()}
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
          {toBodyNodes(items).map((n) =>
            n.kind === "item" ? (
              <Item key={n.item.id} item={n.item} sessionId={sessionId} projectPath={projectPath} />
            ) : (
              <ToolRunRow
                key={n.key}
                tools={n.tools}
                sessionId={sessionId}
                projectPath={projectPath}
              />
            ),
          )}
        </div>
      )}
    </div>
  );
}

/** Post-answer list of the files a finished turn edited, Codex-style. */
function FilesRow({
  files,
  projectPath,
}: {
  files: EditedFile[];
  projectPath?: string;
}): JSX.Element {
  return (
    <div className="files-row">
      <span className="hint">Edited</span>
      {files.map((f) => {
        const rel =
          projectPath && f.path.startsWith(`${projectPath}/`)
            ? f.path.slice(projectPath.length + 1)
            : f.path;
        const abs = f.path.startsWith("/") ? f.path : projectPath ? `${projectPath}/${f.path}` : "";
        return (
          <button
            key={f.path}
            type="button"
            className="file-chip"
            title={`${f.path} — click to preview`}
            disabled={!abs}
            onClick={() => abs && useStore.getState().openFilePreview({ path: abs, projectPath })}
          >
            <span className="file-chip-name mono">{rel}</span>
            {f.created && <span className="hint">new</span>}
            {(f.additions > 0 || f.deletions > 0) && (
              <span className="diffstat">
                <span className="add">+{f.additions}</span>{" "}
                <span className="del">-{f.deletions}</span>
              </span>
            )}
          </button>
        );
      })}
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
        <>
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
          {item.pickup && (
            <div
              className={`msg-pickup ${item.pickup}`}
              title={
                item.pickup === "read"
                  ? "The agent has picked this message up."
                  : "Sent mid-turn — the agent will pick this up at its next stopping point."
              }
            >
              {item.pickup === "read" ? "✓ Read" : "Unread"}
            </div>
          )}
        </>
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
              // The summary previews the thought's first line so a scrolling
              // timeline shows where the reasoning went, not a wall of
              // identical "Thought process" rows.
              <details className="thinking">
                <summary title="Thought process">{thinkingPreview(item.thinking)}</summary>
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
    case "turn-end":
      // The turn is only announced as finished once advisors are done —
      // "finished" with a reviewer still reading would be a contradiction.
      return item.pending ? (
        <div className="turn-done pending">
          <span className="work-live-dot" aria-hidden />
          Advisors reviewing…
        </div>
      ) : (
        <div className="turn-done">
          ✓ Turn finished
          {item.durationMs && item.durationMs >= 1000 ? ` in ${fmtDuration(item.durationMs)}` : ""}
          {item.at && <TimeAgo iso={item.at} />}
        </div>
      );
    default:
      return null;
  }
});

/** "just now" → "3 min ago" → "2 hours ago" → "3 days ago". */
function fmtAgo(iso: string, now: number): string {
  const s = Math.max(0, Math.floor((now - Date.parse(iso)) / 1000));
  if (s < 60) return "just now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} hour${h === 1 ? "" : "s"} ago`;
  const d = Math.floor(h / 24);
  return `${d} day${d === 1 ? "" : "s"} ago`;
}

/**
 * Live relative timestamp. Ticks once a minute so "3 min ago" stays honest —
 * useful for judging whether the provider prompt cache is still warm.
 */
function TimeAgo({ iso }: { iso: string }): JSX.Element {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(t);
  }, []);
  return (
    <span className="turn-done-when" title={new Date(iso).toLocaleString()}>
      {" "}
      · {fmtAgo(iso, now)}
    </span>
  );
}

/** First meaningful line of a thought, clipped for use as a summary label. */
function thinkingPreview(thinking: string): string {
  const line =
    thinking
      .split("\n")
      .find((l) => l.trim())
      ?.trim() ?? "Thought process";
  return line.length > 110 ? `${line.slice(0, 110)}…` : line;
}

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

/**
 * Tools with a NATIVE card here: file-link clicks, inline diffs, and the
 * compact one-line style. Everything else renders through OMP's own
 * <omp-tool-view> component — ~35 specialized renderers (todo, task, hub,
 * lsp, eval, browser, github, memory…) plus a decent generic card for
 * MCP/unknown tools, kept in sync with the OMP release automatically.
 */
const NATIVE_TOOL_NAMES = new Set([
  "bash",
  "edit",
  "ast_edit",
  "write",
  "read",
  "grep",
  "ast_grep",
  "glob",
  "search",
]);

function OmpToolCard({ item }: { item: Extract<TranscriptItem, { kind: "tool" }> }): JSX.Element {
  const ref = useRef<OmpToolViewElement>(null);
  const data = useMemo<OmpToolViewData>(
    () => ({
      name: item.name,
      args: (item.args ?? {}) as Record<string, unknown>,
      result: item.ompResult
        ? {
            // content must be an array — the renderer iterates it unguarded.
            content: item.ompResult.content ?? [],
            details: item.ompResult.details,
            isError: item.ompResult.isError,
          }
        : undefined,
      running: item.state === "running" || undefined,
    }),
    [item.name, item.args, item.ompResult, item.state],
  );
  // The element takes its payload via PROPERTY; attributes are not observed.
  useEffect(() => {
    if (ref.current) ref.current.data = data;
  }, [data]);
  return (
    <div className="tool-omp">
      <omp-tool-view ref={ref} />
    </div>
  );
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
  // Hooks live above the OMP-card early return: the return condition can flip
  // mid-lifecycle (a running tool ending without an OMP payload), and a
  // changed hook count between renders is a React crash.
  const [openState, setOpen] = useState<boolean | null>(null);
  // Rich rendering for the long tail — only when we have the raw payload
  // (or the call is still running); old replays keep the text fallback.
  if (!NATIVE_TOOL_NAMES.has(item.name) && (item.state === "running" || item.ompResult)) {
    return <OmpToolCard item={item} />;
  }
  // File-flavoured tool calls get a clickable path, like Codex/Claude Code.
  const clickPath =
    d?.kind === "edit" || d?.kind === "write" || d?.kind === "read" ? d.path : undefined;
  const openPath = () => {
    if (!clickPath) return;
    if (!clickPath.startsWith("/") && !projectPath) return;
    const abs = clickPath.startsWith("/") ? clickPath : `${projectPath}/${clickPath}`;
    useStore.getState().openFilePreview({ path: abs, projectPath });
  };
  // One quiet line per tool call; output/diff only on request. Errors
  // auto-expand — those are the ones worth reading.
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
  // Blockers open by default — they're the ones that change what happens
  // next. Everything else collapses to its header with a one-line preview.
  const [open, setOpen] = useState(item.severity === "blocker");
  const preview = item.text.replace(/\s+/g, " ").trim();
  return (
    <div className={`advisor-card ${item.severity}`}>
      <button
        type="button"
        className="advisor-head"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
      >
        <span className="tool-chevron">{open ? "▾" : "▸"}</span>
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
        {!open && <span className="advisor-preview hint">{preview}</span>}
      </button>
      {open && (
        <div className="advisor-body">
          <Markdown text={item.text} projectPath={projectPath} />
        </div>
      )}
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
