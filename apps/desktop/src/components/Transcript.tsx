/**
 * The conversation.
 *
 * OMP events are rendered as native components — never as terminal text.
 * Large tool output collapses by default so a noisy build cannot bury the
 * conversation, and long transcripts render only a trailing window so a
 * thousand-event session stays responsive.
 */
import type { JSX } from "react";
import { memo, useEffect, useLayoutEffect, useRef, useState } from "react";
import { fmtTokens, type TranscriptItem } from "../store";

/** Beyond this, only the most recent slice is mounted. */
const WINDOW = 300;
const COLLAPSE_LINES = 14;

function argSummary(name: string, args: Record<string, unknown>): string {
  const pick = (k: string) => (typeof args[k] === "string" ? (args[k] as string) : undefined);
  switch (name) {
    case "bash":
      return pick("command") ?? "";
    case "read":
    case "write":
    case "edit":
      return pick("path") ?? pick("file") ?? "";
    case "grep":
    case "ast_grep":
      return pick("pattern") ?? pick("query") ?? "";
    case "glob":
      return pick("pattern") ?? "";
    default: {
      const first = Object.values(args).find((v) => typeof v === "string");
      return typeof first === "string" ? first : "";
    }
  }
}

const Output = memo(function Output({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  if (!text) return null;
  const lines = text.split("\n");
  const long = lines.length > COLLAPSE_LINES;
  const shown = open || !long ? text : lines.slice(0, COLLAPSE_LINES).join("\n");

  return (
    <>
      <pre className="tool-output">{shown}</pre>
      {long && (
        <button
          className="btn"
          style={{ marginTop: 6, fontSize: 11.5, padding: "3px 8px" }}
          onClick={() => setOpen((o) => !o)}
        >
          {open ? "Collapse" : `Show all ${lines.length} lines`}
        </button>
      )}
    </>
  );
});

const Diff = memo(function Diff({ diff }: { diff: string }) {
  return (
    <div className="diff">
      {diff.split("\n").map((l, i) => (
        <div
          key={i}
          className={l.startsWith("+") && !l.startsWith("+++") ? "l-add" : l.startsWith("-") && !l.startsWith("---") ? "l-del" : undefined}
        >
          {l || " "}
        </div>
      ))}
    </div>
  );
});

const ToolCard = memo(function ToolCard({ item }: { item: Extract<TranscriptItem, { kind: "tool" }> }) {
  const d = item.detail;
  return (
    <div className={`card${item.state === "error" ? " err" : ""}`}>
      <div className="card-head">
        <span className="name">{item.name}</span>
        <span className="arg" title={argSummary(item.name, item.args)}>
          {argSummary(item.name, item.args)}
        </span>
        {item.state === "running" && <span className="hint">running…</span>}
        {d?.kind === "edit" && (
          <span className="diffstat mono">
            <span className="add">+{d.additions}</span> <span className="del">−{d.deletions}</span>
          </span>
        )}
        {d?.kind === "search" && <span className="hint">{d.matches} matches</span>}
        {typeof item.durationMs === "number" && item.durationMs > 500 && (
          <span className="hint">{(item.durationMs / 1000).toFixed(1)}s</span>
        )}
      </div>

      {(item.output || item.error || (d?.kind === "edit" && d.diff)) && (
        <div className="card-body">
          {d?.kind === "edit" && d.diff ? <Diff diff={d.diff} /> : <Output text={item.output} />}
          {item.error && (
            <div className="banner" style={{ marginTop: 6 }}>
              {item.error.slice(0, 600)}
            </div>
          )}
        </div>
      )}
    </div>
  );
});

const AdvisorCard = memo(function AdvisorCard({
  item,
}: {
  item: Extract<TranscriptItem, { kind: "advisor" }>;
}) {
  const sev = item.severity;
  return (
    <div className={`advisor-card ${sev}`}>
      <div className="advisor-head">
        <span className="advisor-name">{item.name}</span>
        <span className={`sev ${sev}`}>{sev === "unknown" ? "note" : sev}</span>
      </div>
      <div style={{ whiteSpace: "pre-wrap" }}>{item.text}</div>
    </div>
  );
});

const SubagentCard = memo(function SubagentCard({
  item,
}: {
  item: Extract<TranscriptItem, { kind: "subagent" }>;
}) {
  return (
    <div className="card">
      <div className="card-head">
        <span className="name">Subagent</span>
        <span className="arg">{item.label}</span>
        <span className="hint">
          {item.state === "running"
            ? "running"
            : item.state === "error"
              ? "failed"
              : item.durationMs
                ? `${(item.durationMs / 1000).toFixed(0)}s`
                : "done"}
        </span>
      </div>
      <div className="card-body">
        <div className="hint">
          {item.model ? `${item.model} · ` : ""}
          {item.toolCalls} tool call{item.toolCalls === 1 ? "" : "s"}
        </div>
      </div>
    </div>
  );
});

const Item = memo(function Item({ item }: { item: TranscriptItem }) {
  switch (item.kind) {
    case "user":
      return <div className="msg-user">{item.text}</div>;

    case "assistant":
      return (
        <div className="msg-assistant">
          {item.thinking && (
            <details className="thinking" style={{ marginBottom: 6 }}>
              <summary>Thinking</summary>
              {item.thinking}
            </details>
          )}
          {item.text}
        </div>
      );

    case "tool":
      return <ToolCard item={item} />;

    case "advisor":
      return <AdvisorCard item={item} />;

    case "subagent":
      return <SubagentCard item={item} />;

    case "system":
      return (
        <div
          className={item.tone === "info" ? "hint" : `banner${item.tone === "warn" ? " warn" : ""}`}
          style={item.tone === "info" ? { textAlign: "center" } : undefined}
        >
          {item.text}
        </div>
      );
  }
});

export function Transcript({ items }: { items: TranscriptItem[] }): JSX.Element {
  const ref = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);

  // Only follow the tail when the user is already at the bottom, so scrolling
  // back to read something is never yanked away by streaming output.
  useLayoutEffect(() => {
    const el = ref.current;
    if (el && pinned.current) el.scrollTop = el.scrollHeight;
  }, [items]);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const onScroll = () => {
      pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, []);

  const hidden = Math.max(0, items.length - WINDOW);
  const shown = hidden ? items.slice(hidden) : items;

  return (
    <div className="transcript" ref={ref}>
      <div className="stream">
        {items.length === 0 && (
          <div className="empty">
            <h3>Ready</h3>
            Send a message to start this session.
          </div>
        )}
        {hidden > 0 && (
          <div className="hint" style={{ textAlign: "center" }}>
            {fmtTokens(hidden)} earlier events hidden for performance
          </div>
        )}
        {shown.map((it) => (
          <Item key={it.id} item={it} />
        ))}
      </div>
    </div>
  );
}
