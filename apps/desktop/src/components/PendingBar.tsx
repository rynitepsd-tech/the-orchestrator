/**
 * Pinned "needs your review" bar.
 *
 * A pending approval can scroll out of view while the transcript keeps
 * streaming; this bar sits above the composer for the visible session until
 * every pending interaction is answered. Approvals are answerable directly
 * from the bar; richer extension prompts jump to their card.
 */

import type { JSX } from "react";
import { useState } from "react";
import { engine } from "../engine-client";
import type { SessionView, TranscriptItem } from "../store";

type Pending = Extract<TranscriptItem, { kind: "approval" | "interaction" }>;

function scrollToCard(id: string): void {
  document.getElementById(`titem-${id}`)?.scrollIntoView({ behavior: "smooth", block: "center" });
}

export function PendingBar({ view }: { view: SessionView }): JSX.Element | null {
  const [busy, setBusy] = useState(false);
  const pending = view.transcript.filter(
    (i): i is Pending =>
      (i.kind === "approval" || i.kind === "interaction") && i.state === "pending",
  );
  const first = pending[0];
  if (!first) return null;

  const sessionId = view.summary.sessionId;

  const respond = async (approvalId: string, optionId: string) => {
    setBusy(true);
    try {
      await engine.request("approval.respond", { sessionId, approvalId, optionId });
    } catch {
      /* the resolution event clears the bar on success */
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="pending-bar" role="alert">
      <div className="pending-bar-head">
        <span className="approval-title">
          {first.kind === "approval" ? "Approval needed" : "Input needed"}
        </span>
        {first.kind === "approval" ? (
          <span className="chip">{first.toolName}</span>
        ) : (
          first.extensionName !== "extension" && <span className="chip">{first.extensionName}</span>
        )}
        <span className="spacer" />
        {pending.length > 1 && <span className="hint">{pending.length - 1} more waiting</span>}
        <button className="btn btn-ghost" onClick={() => scrollToCard(first.id)}>
          Show in transcript
        </button>
      </div>

      {first.kind === "approval" ? (
        <>
          <div className="pending-bar-summary mono" title={first.detail ?? first.summary}>
            {first.detail ?? first.summary}
          </div>
          <div className="row" style={{ marginTop: 6 }}>
            {first.options.map((o) => (
              <button
                key={o.id}
                className={`btn ${o.kind === "deny" ? "btn-danger" : o.kind === "allow" ? "btn-primary" : ""}`}
                disabled={busy}
                onClick={() => void respond(first.approvalId, o.id)}
              >
                {o.label}
              </button>
            ))}
          </div>
        </>
      ) : (
        <div className="pending-bar-summary">
          An extension is waiting for a response — answer it in the transcript above.
        </div>
      )}
    </div>
  );
}
