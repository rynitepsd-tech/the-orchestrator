import React from "react";
import ReactDOM from "react-dom/client";
import { App } from "./App";
import "./styles.css";
// Registers the <omp-tool-view> custom element (OMP's own tool renderers).
import "./vendor/tool-views.generated.js";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
