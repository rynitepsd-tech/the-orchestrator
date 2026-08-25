/**
 * Live preview of a dev server the session's agent started.
 *
 * The iframe points at a localhost origin detected from tool output
 * (`session.preview`). Reload bumps the iframe key: the frame is
 * cross-origin to the app shell, so `contentWindow.location.reload()`
 * is unreachable and a fresh mount is the reload.
 */
import { openUrl } from "@tauri-apps/plugin-opener";
import type { JSX } from "react";
import { useState } from "react";

export function PreviewPanel({ url, onClose }: { url: string; onClose: () => void }): JSX.Element {
  const [gen, setGen] = useState(0);
  return (
    <div className="preview-panel">
      <div className="preview-bar">
        <span className="preview-url" title={url}>
          {url}
        </span>
        <button className="btn btn-ghost" title="Reload" onClick={() => setGen((n) => n + 1)}>
          ⟳
        </button>
        <button className="btn btn-ghost" title="Open in browser" onClick={() => void openUrl(url)}>
          ↗
        </button>
        <button className="btn btn-ghost" title="Close preview" onClick={onClose}>
          ✕
        </button>
      </div>
      <iframe key={gen} className="preview-frame" src={url} title="Dev server preview" />
    </div>
  );
}
