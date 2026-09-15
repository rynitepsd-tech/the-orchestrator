import type { SessionSource } from "@orchestrator/protocol";
import { type JSX, useEffect, useRef, useState } from "react";
import { Markdown } from "./Markdown";

/** Reading a source never switches OMP branches or starts a model run. */
export function SourceViewer({
  source,
  onClose,
  onOpenConversation,
}: {
  source: SessionSource;
  onClose: () => void;
  onOpenConversation: () => Promise<void>;
}): JSX.Element {
  const dialog = useRef<HTMLDivElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    dialog.current?.focus();
    return () => previous?.focus();
  }, []);

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div
        ref={dialog}
        className="modal source-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="source-title"
        tabIndex={-1}
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.stopPropagation();
            onClose();
          }
          if (e.key !== "Tab") return;
          const focusable = dialog.current?.querySelectorAll<HTMLElement>(
            'button:not(:disabled), a[href], [tabindex="0"]',
          );
          if (!focusable?.length) {
            e.preventDefault();
            return;
          }
          const first = focusable[0];
          const last = focusable[focusable.length - 1];
          if (
            e.shiftKey &&
            (document.activeElement === first || document.activeElement === dialog.current)
          ) {
            e.preventDefault();
            last.focus();
          } else if (!e.shiftKey && document.activeElement === last) {
            e.preventDefault();
            first.focus();
          }
        }}
      >
        <div className="modal-head">
          <div className="row">
            <h3 id="source-title">{source.hit.title}</h3>
            <span className="spacer" />
            <button className="btn btn-ghost" onClick={onClose}>
              Close
            </button>
          </div>
          <p className="hint">
            {source.hit.role === "user" ? "User message" : "Assistant message"}
            {source.hit.at ? ` · ${new Date(source.hit.at).toLocaleString()}` : ""}
            {" · Historical source, not a new answer"}
          </p>
        </div>
        <div className="source-content modal-body">
          <Markdown text={source.text} projectPath={source.hit.projectPath} />
          {error && (
            <p className="banner" role="alert">
              {error}
            </p>
          )}
        </div>
        <div className="row modal-foot">
          <span className="hint">Entry {source.hit.entryId}</span>
          <span className="spacer" />
          <button
            className="btn"
            onClick={() => {
              void navigator.clipboard.writeText(source.text).catch((e) => setError(String(e)));
            }}
          >
            Copy source
          </button>
          <button
            className="btn btn-primary"
            disabled={busy}
            onClick={() => {
              setBusy(true);
              setError(undefined);
              void onOpenConversation()
                .catch((e) => setError(String(e)))
                .finally(() => setBusy(false));
            }}
          >
            {busy ? "Opening…" : "Open conversation"}
          </button>
        </div>
      </div>
    </div>
  );
}
