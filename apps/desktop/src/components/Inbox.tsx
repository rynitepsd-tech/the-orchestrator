/**
 * Review inbox — everything awaiting the human, flattened across sessions.
 *
 * Three tiers, loudest first: sessions blocked on input (approvals and
 * questions, answerable inline), sessions that finished since you last looked
 * (open or mark reviewed), and failures. Items disappear the moment they're
 * dealt with; an empty inbox says so instead of listing sessions.
 */

import type { JSX } from "react";
import { useState } from "react";
import { engine } from "../engine-client";
import {
  advisorsReviewing,
  fmtCount,
  type SessionView,
  type TranscriptItem,
  useStore,
} from "../store";

type PendingItem = Extract<TranscriptItem, { kind: "approval" | "interaction" }>;

function lastAnswerSnippet(view: SessionView): string | undefined {
  for (let i = view.transcript.length - 1; i >= 0; i--) {
    const it = view.transcript[i];
    if (it.kind === "assistant" && it.text) {
      const text = it.text.replace(/\s+/g, " ").trim();
      return text.length > 220 ? `${text.slice(0, 220)}…` : text;
    }
  }
  return undefined;
}

export function Inbox(): JSX.Element {
  const sessions = useStore((s) => s.sessions);
  const select = useStore((s) => s.select);
  const markRead = useStore((s) => s.markRead);

  const views = Object.values(sessions);
  const needsInput = views
    .filter((v) => v.pendingInteractions > 0 || v.summary.runState === "waiting")
    .sort((a, b) => (b.summary.lastActivityAt ?? "").localeCompare(a.summary.lastActivityAt ?? ""));
  const finished = views
    .filter(
      (v) =>
        v.summary.unread &&
        v.summary.runState === "completed" &&
        v.pendingInteractions === 0 &&
        !advisorsReviewing(v),
    )
    .sort((a, b) => (b.summary.lastActivityAt ?? "").localeCompare(a.summary.lastActivityAt ?? ""));
  const failed = views
    .filter((v) => v.summary.runState === "error" || v.summary.runState === "interrupted")
    .sort((a, b) => (b.summary.lastActivityAt ?? "").localeCompare(a.summary.lastActivityAt ?? ""));

  const empty = needsInput.length === 0 && finished.length === 0 && failed.length === 0;

  return (
    <div className="inbox">
      <div className="row usage-toolbar">
        <h2 style={{ margin: 0 }}>Inbox</h2>
        <span className="hint">Everything waiting on you, across all sessions</span>
      </div>

      {empty ? (
        <div className="empty" style={{ marginTop: "14vh" }}>
          <h3>Inbox zero</h3>
          Nothing needs you right now — agents are either working or idle.
        </div>
      ) : (
        <>
          {needsInput.length > 0 && (
            <section className="inbox-section">
              <div className="section-label">Needs input · {fmtCount(needsInput.length)}</div>
              {needsInput.map((v) => (
                <NeedsInputCard key={v.summary.sessionId} view={v} onOpen={select} />
              ))}
            </section>
          )}

          {finished.length > 0 && (
            <section className="inbox-section">
              <div className="section-label">Finished · {fmtCount(finished.length)}</div>
              {finished.map((v) => (
                <div key={v.summary.sessionId} className="inbox-card">
                  <div className="row">
                    <span className="dot finished" aria-hidden />
                    <span className="inbox-title">{v.summary.title}</span>
                    <span className="chip mono">{v.summary.projectPath.split("/").pop()}</span>
                    <span className="spacer" />
                    <button className="btn btn-ghost" onClick={() => markRead(v.summary.sessionId)}>
                      Mark reviewed
                    </button>
                    <button className="btn" onClick={() => select(v.summary.sessionId)}>
                      Open
                    </button>
                  </div>
                  {lastAnswerSnippet(v) && (
                    <div className="inbox-snippet hint">{lastAnswerSnippet(v)}</div>
                  )}
                </div>
              ))}
            </section>
          )}

          {failed.length > 0 && (
            <section className="inbox-section">
              <div className="section-label">Failed / interrupted · {fmtCount(failed.length)}</div>
              {failed.map((v) => (
                <div key={v.summary.sessionId} className="inbox-card">
                  <div className="row">
                    <span
                      className={`dot ${v.summary.runState === "error" ? "error" : "interrupted"}`}
                      aria-hidden
                    />
                    <span className="inbox-title">{v.summary.title}</span>
                    <span className="chip mono">{v.summary.projectPath.split("/").pop()}</span>
                    <span className="spacer" />
                    <button className="btn" onClick={() => select(v.summary.sessionId)}>
                      Open
                    </button>
                  </div>
                  {v.error?.message && <div className="inbox-snippet hint">{v.error.message}</div>}
                </div>
              ))}
            </section>
          )}
        </>
      )}
    </div>
  );
}

/** A blocked session: answer simple approvals right here, in the inbox. */
function NeedsInputCard({
  view,
  onOpen,
}: {
  view: SessionView;
  onOpen: (id: string) => void;
}): JSX.Element {
  const [busy, setBusy] = useState(false);
  const pending = view.transcript.filter(
    (i): i is PendingItem =>
      (i.kind === "approval" || i.kind === "interaction") && i.state === "pending",
  );

  const respond = async (approvalId: string, optionId: string) => {
    setBusy(true);
    try {
      await engine.request("approval.respond", {
        sessionId: view.summary.sessionId,
        approvalId,
        optionId,
      });
    } catch {
      /* resolution event updates the card; failures leave it pending */
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="inbox-card attention-card">
      <div className="row">
        <span className="dot attention blink" aria-hidden />
        <span className="inbox-title">{view.summary.title}</span>
        <span className="chip mono">{view.summary.projectPath.split("/").pop()}</span>
        <span className="spacer" />
        <button className="btn" onClick={() => onOpen(view.summary.sessionId)}>
          Open
        </button>
      </div>
      {pending.map((p) =>
        p.kind === "approval" ? (
          <div key={p.id} className="inbox-approval">
            <span className="chip">{p.toolName}</span>
            <span className="tool-arg mono" title={p.detail ?? p.summary}>
              {p.summary}
            </span>
            <span className="spacer" />
            {p.options.map((o) => (
              <button
                key={o.id}
                className={`btn ${
                  o.kind === "deny" ? "btn-danger" : o.kind === "allow" ? "btn-primary" : ""
                }`}
                disabled={busy}
                onClick={() => void respond(p.approvalId, o.id)}
              >
                {o.label}
              </button>
            ))}
          </div>
        ) : (
          <div key={p.id} className="inbox-approval">
            <span className="chip">{p.extensionName}</span>
            <span className="hint">Asked a question — open the session to answer.</span>
          </div>
        ),
      )}
    </div>
  );
}
