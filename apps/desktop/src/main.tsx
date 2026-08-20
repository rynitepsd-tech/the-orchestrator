import React from "react";
import ReactDOM from "react-dom/client";
import { App } from "./App";
import "./styles.css";
// Registers the <omp-tool-view> custom element (OMP's own tool renderers).
import "./vendor/tool-views.generated.js";

// Tauri's native drag-drop interception is off (dragDropEnabled: false) so the
// composers get real HTML5 drop events — but that also means a file dropped
// anywhere else hits WKWebView's default behaviour: NAVIGATE to the file,
// replacing the entire app with e.g. a JPEG, with no way back. Neutralise the
// default at the window level; component drop handlers still run first and
// take the files they want.
window.addEventListener("dragover", (e) => e.preventDefault());
window.addEventListener("drop", (e) => e.preventDefault());

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
