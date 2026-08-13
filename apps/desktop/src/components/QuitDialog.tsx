/**
 * Quit confirmation when sessions are still running. No ambiguous buttons:
 * one cancels, one names exactly what it does.
 */
import type { JSX } from "react";

export function QuitDialog({
  running,
  onCancel,
  onQuit,
}: {
  running: number;
  onCancel: () => void;
  onQuit: () => void;
}): JSX.Element {
  return (
    <div className="modal-backdrop" onMouseDown={onCancel}>
      <div
        className="modal quit-dialog"
        onMouseDown={(e) => e.stopPropagation()}
        role="alertdialog"
        aria-label="Quit confirmation"
        onKeyDown={(e) => e.key === "Escape" && onCancel()}
      >
        <h2>
          {running} session{running === 1 ? " is" : "s are"} still running
        </h2>
        <p>
          Quitting stops their current work. Transcripts are persisted by OMP and every session can
          be resumed later.
        </p>
        <div className="row modal-actions">
          <span className="spacer" />
          <button className="btn" onClick={onCancel} autoFocus>
            Cancel
          </button>
          <button className="btn btn-danger" onClick={onQuit}>
            Quit and Stop Sessions
          </button>
        </div>
      </div>
    </div>
  );
}
