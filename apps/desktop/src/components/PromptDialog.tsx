/**
 * Minimal text-input dialog.
 *
 * WKWebView does not implement window.prompt() — it silently returns null —
 * so anything that needs a one-line answer (rename, names) goes through this.
 */

import type { JSX } from "react";
import { useState } from "react";

export function PromptDialog({
  title,
  initial,
  placeholder,
  submitLabel,
  onCancel,
  onSubmit,
}: {
  title: string;
  initial?: string;
  placeholder?: string;
  submitLabel?: string;
  onCancel: () => void;
  onSubmit: (value: string) => void;
}): JSX.Element {
  const [value, setValue] = useState(initial ?? "");
  const submit = () => {
    if (value.trim()) onSubmit(value.trim());
  };

  return (
    <div className="modal-backdrop" onMouseDown={onCancel}>
      <div
        className="modal prompt-dialog"
        role="dialog"
        aria-label={title}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <h3>{title}</h3>
        <input
          className="input"
          value={value}
          placeholder={placeholder}
          autoFocus
          onFocus={(e) => e.target.select()}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") submit();
            if (e.key === "Escape") onCancel();
          }}
        />
        <div className="row modal-actions">
          <span className="spacer" />
          <button className="btn" onClick={onCancel}>
            Cancel
          </button>
          <button className="btn btn-primary" disabled={!value.trim()} onClick={submit}>
            {submitLabel ?? "Save"}
          </button>
        </div>
      </div>
    </div>
  );
}
