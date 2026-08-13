/**
 * Application shell.
 *
 * Holds no session runtime state of its own: everything lives in the store and
 * is driven by engine events, so unmounting a view never affects a running
 * agent. Switching the visible session is a pure UI selection.
 */
import type { JSX } from "react";
import { useCallback, useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { isPermissionGranted, requestPermission, sendNotification } from "@tauri-apps/plugin-notification";
import type { AdvisorConfig, SessionLaunchConfig } from "@orchestrator/protocol";
import { engine } from "./engine-client";
import { fmtTokens, useStore } from "./store";
import { Sidebar } from "./components/Sidebar";
import { Transcript } from "./components/Transcript";
import { Composer } from "./components/Composer";
import { Inspector } from "./components/Inspector";
import { NewSession } from "./components/NewSession";
import { CommandPalette } from "./components/CommandPalette";

export function App(): JSX.Element {
  const s = useStore();
  const [creating, setCreating] = useState(false);
  const [notifyOk, setNotifyOk] = useState(false);

  const view = s.visibleSessionId ? s.sessions[s.visibleSessionId] : undefined;

  // ---- engine wiring ------------------------------------------------------
  useEffect(() => {
    let disposed = false;

    engine.onEvent = (e) => {
      const before = useStore.getState().sessions[e.sessionId];
      useStore.getState().apply(e);

      // Native notification when a BACKGROUND session finishes or is blocked.
      if (!disposed && before) {
        const visible = useStore.getState().visibleSessionId === e.sessionId;
        if (!visible && e.type === "session.finished" && e.runState === "completed") {
          notify(`${before.summary.title} finished`, "The session completed.");
        }
        if (!visible && e.type === "advisor.message" && e.severity === "blocker") {
          notify(`${e.advisorName} raised a blocker`, before.summary.title);
        }
      }
    };

    engine.onLifecycle = (e) => {
      const st = useStore.getState();
      if (e.type === "engine.status") st.setEngineStage(e.stage, e.message);
      if (e.type === "engine.ready") {
        st.setEngineStage("ready");
        st.setEngineInfo({
          ompVersion: e.info.ompVersion,
          engineVersion: e.info.engineVersion,
          arch: e.info.arch,
          protocolVersion: e.info.protocolVersion,
        });
        void loadCatalogue();
      }
      if (e.type === "engine.error") st.setEngineError(e.error);
    };

    engine.onSupervisor = (ev) => {
      const st = useStore.getState();
      if (ev.kind === "exited") {
        st.setEngineStage("offline");
        // Never pretend an in-flight request survived a dead process.
        st.markAllInterrupted(
          "The engine stopped. This session was interrupted; its transcript is preserved.",
        );
      }
      if (ev.kind === "launch-failed") {
        st.setEngineStage("offline");
        st.setEngineError({
          kind: "packaging-mismatch",
          message: ev.message ?? "The bundled OMP engine could not start.",
          detail: ev.detail,
        });
      }
      if (ev.kind === "ready") st.setEngineStage("starting");
    };

    void engine.connect();
    return () => {
      disposed = true;
      engine.dispose();
    };
  }, []);

  // ---- notifications ------------------------------------------------------
  useEffect(() => {
    void (async () => {
      let ok = await isPermissionGranted();
      if (!ok) ok = (await requestPermission()) === "granted";
      setNotifyOk(ok);
    })();
  }, []);

  const notify = useCallback(
    (title: string, body: string) => {
      if (notifyOk) sendNotification({ title, body });
    },
    [notifyOk],
  );

  const loadCatalogue = async () => {
    try {
      const [m, p] = await Promise.all([
        engine.request("models.list", {}),
        engine.request("providers.list", {}),
      ]);
      useStore.getState().setCatalogue(m.models, p.providers);
    } catch {
      /* the picker degrades to "OMP default" rather than blocking startup */
    }
    try {
      const q = await engine.request("providers.quota", {});
      useStore.getState().setQuotas(q.quotas);
    } catch {
      /* quota is optional; absence is rendered as "not reported" */
    }
  };

  // ---- actions ------------------------------------------------------------
  const createSession = async (config: SessionLaunchConfig) => {
    setCreating(true);
    try {
      const res = await engine.request("sessions.create", config);
      const proj = await engine.request("project.open", { path: config.projectPath });
      useStore.getState().addProject(proj.project);
      useStore.getState().addSession(res.session, config.advisors ?? []);
      useStore.getState().setNewSession(false);
    } catch (e) {
      useStore.getState().setEngineError(e as any);
    } finally {
      setCreating(false);
    }
  };

  const discoverAdvisors = useCallback(async (projectPath: string): Promise<AdvisorConfig[]> => {
    try {
      const env = await engine.request("project.environment", { path: projectPath });
      return env.advisors;
    } catch {
      return [];
    }
  }, []);

  const send = (text: string, whenBusy: "steer" | "queue") => {
    if (!s.visibleSessionId) return;
    const id = s.visibleSessionId;
    // Optimistically show the user's message; the engine echoes nothing back
    // for it, so this is the single source for that bubble.
    useStore.getState().apply({
      type: "user.message",
      sessionId: id,
      messageId: `u${Date.now()}`,
      text,
    });
    void engine.request("session.prompt", { sessionId: id, text, whenBusy }).catch((e) => {
      useStore.getState().setEngineError(e);
    });
  };

  const abort = () => {
    if (!s.visibleSessionId) return;
    void engine.request("session.abort", { sessionId: s.visibleSessionId }).catch(() => {});
  };

  // ---- menus & shortcuts --------------------------------------------------
  useEffect(() => {
    const uns: Array<Promise<() => void>> = [
      listen("menu://new-session", () => useStore.getState().setNewSession(true)),
      listen("menu://command-palette", () => useStore.getState().setPalette(true)),
      listen("menu://toggle-sidebar", () => useStore.getState().toggleSidebar()),
      listen("menu://toggle-inspector", () => useStore.getState().toggleInspector()),
      listen("menu://session-abort", () => abort()),
      listen("menu://settings", () => useStore.getState().setSettings(true)),
      listen("menu://view-usage", () => {
        useStore.getState().setInspectorTab("usage");
      }),
      listen("menu://view-changes", () => {
        useStore.getState().setInspectorTab("changes");
      }),
    ];
    return () => {
      void Promise.all(uns).then((fns) => fns.forEach((f) => f()));
    };
  }, [s.visibleSessionId]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const meta = e.metaKey || e.ctrlKey;
      if (meta && e.key.toLowerCase() === "n") {
        e.preventDefault();
        useStore.getState().setNewSession(true);
      } else if (meta && e.shiftKey && e.key.toLowerCase() === "p") {
        e.preventDefault();
        useStore.getState().setPalette(true);
      } else if (meta && e.key.toLowerCase() === "k") {
        e.preventDefault();
        useStore.getState().setPalette(true);
      } else if (meta && e.key === ",") {
        e.preventDefault();
        useStore.getState().setSettings(true);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // ---- render -------------------------------------------------------------
  const stageLabel: Record<string, string> = {
    starting: "Starting OMP",
    "loading-config": "Loading configuration",
    "loading-models": "Loading models",
    "loading-extensions": "Loading extensions",
    ready: "Ready",
    degraded: "Degraded",
    stopping: "Stopping",
    offline: "Engine offline",
  };

  return (
    <div
      className="app"
      style={{
        gridTemplateColumns: `${s.sidebarOpen ? "var(--sidebar-w)" : "0px"} 1fr ${
          s.inspectorOpen ? "auto" : "0px"
        }`,
      }}
    >
      <header className="titlebar">
        <span className="titlebar-title">The Orchestrator</span>
        <span className="titlebar-sub">
          {s.engineStage === "ready"
            ? s.engineInfo
              ? `OMP ${s.engineInfo.ompVersion}`
              : ""
            : stageLabel[s.engineStage] ?? s.engineStage}
        </span>
        <span className="spacer" />
        {view?.context && (
          <span className="chip" title={`${view.context.usedTokens} / ${view.context.maxTokens} tokens`}>
            Context <strong>{Math.round(view.context.fraction * 100)}%</strong>
          </span>
        )}
        {view?.usage && (
          <span className="chip" title="Session usage">
            <strong>
              {fmtTokens(
                view.usage.total.inputTokens +
                  view.usage.total.outputTokens +
                  view.usage.total.cacheReadTokens +
                  view.usage.total.cacheWriteTokens,
              )}
            </strong>
          </span>
        )}
      </header>

      {s.sidebarOpen && <Sidebar />}

      <main className="main">
        {s.engineStage === "offline" && (
          <div className="banner" style={{ margin: 12 }}>
            <strong>The OMP engine is not running.</strong>
            <div style={{ marginTop: 4 }}>
              {s.engineError?.message ?? "It exited unexpectedly."}
              {s.engineError?.detail && (
                <details style={{ marginTop: 6 }}>
                  <summary className="hint">Diagnostics</summary>
                  <pre className="tool-output" style={{ marginTop: 6 }}>
                    {s.engineError.detail}
                  </pre>
                </details>
              )}
            </div>
            <button className="btn" style={{ marginTop: 8 }} onClick={() => void engine.restart()}>
              Restart engine
            </button>
          </div>
        )}

        {view ? (
          <>
            <div className="session-header">
              <span className="titlebar-title">{view.summary.title}</span>
              <span className="chip">
                {view.summary.model?.split("/").pop() ?? "OMP default"}
                {view.summary.thinkingLevel ? ` · ${view.summary.thinkingLevel}` : ""}
              </span>
              {view.advisors.filter((a) => a.enabled).length > 0 && (
                <span className="chip">
                  {view.advisors.filter((a) => a.enabled).length} advisor
                  {view.advisors.filter((a) => a.enabled).length > 1 ? "s" : ""}
                </span>
              )}
              <span className="chip mono" title={view.summary.projectPath}>
                {view.summary.projectPath.split("/").pop()}
              </span>
              <span className="spacer" />
              <span className="hint">{view.summary.runState}</span>
            </div>

            <Transcript items={view.transcript} />

            <Composer
              runState={view.summary.runState}
              onSend={send}
              onAbort={abort}
              disabled={s.engineStage === "offline"}
            />
          </>
        ) : (
          <div className="empty" style={{ marginTop: "18vh" }}>
            <h3>No session selected</h3>
            Choose a project and start an OMP session.
            <div style={{ marginTop: 14 }}>
              <button className="btn btn-primary" onClick={() => s.setNewSession(true)}>
                New Session
              </button>
            </div>
          </div>
        )}
      </main>

      {s.inspectorOpen && <Inspector view={view} />}

      {s.newSessionOpen && (
        <NewSession
          models={s.models}
          discoverAdvisors={discoverAdvisors}
          busy={creating}
          onCancel={() => s.setNewSession(false)}
          onCreate={createSession}
        />
      )}

      {s.paletteOpen && <CommandPalette />}
    </div>
  );
}
