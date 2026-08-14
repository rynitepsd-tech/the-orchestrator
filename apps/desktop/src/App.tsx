/**
 * Application shell.
 *
 * Holds no session runtime state of its own: everything lives in the store and
 * is driven by engine events, so unmounting a view never affects a running
 * agent. Switching the visible session is a pure UI selection.
 */

import type { AdvisorConfig, DiscoveredSession, SessionLaunchConfig } from "@orchestrator/protocol";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import {
  isPermissionGranted,
  requestPermission,
  sendNotification,
} from "@tauri-apps/plugin-notification";
import { openUrl } from "@tauri-apps/plugin-opener";
import type { JSX } from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import { CommandPalette } from "./components/CommandPalette";
import { Composer } from "./components/Composer";
import { Inspector } from "./components/Inspector";
import { NewSession } from "./components/NewSession";
import { Onboarding } from "./components/Onboarding";
import { PendingBar } from "./components/PendingBar";
import { PromptDialog } from "./components/PromptDialog";
import { QuitDialog } from "./components/QuitDialog";
import { Settings } from "./components/Settings";
import { Sidebar } from "./components/Sidebar";
import { Transcript } from "./components/Transcript";
import { UsageCenter } from "./components/UsageCenter";
import { engine } from "./engine-client";
import { checkForUpdates, installUpdate } from "./lib/updater";
import { fmtTokens, isActive, modelBasename, useStore } from "./store";

export function App(): JSX.Element {
  const s = useStore();
  const [creating, setCreating] = useState(false);
  const notifyOk = useRef(false);

  const view = s.visibleSessionId ? s.sessions[s.visibleSessionId] : undefined;

  // ---- notifications ------------------------------------------------------
  useEffect(() => {
    void (async () => {
      let ok = await isPermissionGranted();
      if (!ok) ok = (await requestPermission()) === "granted";
      notifyOk.current = ok;
    })();
  }, []);

  const notify = useCallback((title: string, body: string) => {
    if (notifyOk.current) sendNotification({ title, body });
  }, []);

  // ---- theme --------------------------------------------------------------
  useEffect(() => {
    const root = document.documentElement;
    if (s.prefs.theme === "system") root.removeAttribute("data-theme");
    else root.setAttribute("data-theme", s.prefs.theme);
  }, [s.prefs.theme]);

  // ---- updates ------------------------------------------------------------
  // Silent check at startup and every 4 hours; the titlebar chip appears when
  // a release is available. Failures (dev build, no feed yet) are invisible.
  useEffect(() => {
    void checkForUpdates({ silent: true });
    const t = setInterval(() => void checkForUpdates({ silent: true }), 4 * 60 * 60 * 1000);
    return () => clearInterval(t);
  }, []);

  // ---- engine wiring ------------------------------------------------------
  useEffect(() => {
    engine.onEvent = (e) => {
      const st = useStore.getState();
      const before = st.sessions[e.sessionId];
      st.apply(e);

      // A finished turn moved the provider's usage needle — refetch limits so
      // the Usage panel doesn't show launch-time numbers all day.
      if (e.type === "session.finished") void refreshQuotas();

      // Native notifications for BACKGROUND sessions only, per user prefs.
      if (before && st.visibleSessionId !== e.sessionId) {
        const n = st.prefs.notifications;
        const title = before.summary.title;
        if (e.type === "session.finished" && e.runState === "completed" && n.completion) {
          notify(`${title} finished`, "The session completed.");
        }
        if (e.type === "session.failed" && n.errors) {
          notify(`${title} failed`, e.error.message);
        }
        if (e.type === "approval.request" && n.needsInput) {
          notify(`${title} needs your approval`, e.summary);
        }
        if (e.type === "extension.ui.request" && e.ui.kind !== "notification" && n.needsInput) {
          notify(`${title} needs input`, "An extension is waiting for a response.");
        }
        if (e.type === "advisor.message" && e.severity === "blocker" && n.advisorBlockers) {
          notify(`${e.advisorName} raised a blocker`, title);
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
          agentDir: e.info.agentDir,
        });
        void loadCatalogue();
        void loadDiscovered();
      }
      if (e.type === "engine.error") st.setEngineError(e.error);
      if (e.type === "engine.auth") {
        // The engine never opens a browser itself; the OAuth URL arrives here.
        if (e.status === "browser" && e.url) void openUrl(e.url);
        if (e.status === "failed" && e.message) {
          st.setEngineError({ kind: "auth", message: e.message });
        }
      }
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

    // Dropped frames: refetch the authoritative transcript for the visible
    // session instead of living with a silently incomplete view.
    engine.onSequenceGap = () => {
      const id = useStore.getState().visibleSessionId;
      if (id) void refetchTranscript(id);
    };

    void engine.connect();
    return () => engine.dispose();
  }, [notify]);

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

  const refreshQuotas = async () => {
    try {
      const q = await engine.request("providers.quota", {});
      useStore.getState().setQuotas(q.quotas);
    } catch {
      /* quota is optional; keep the last known values */
    }
  };

  // Periodic quota refresh so limits stay current even without local activity
  // (other machines and the CLI consume the same windows).
  useEffect(() => {
    const t = setInterval(() => {
      if (useStore.getState().engineStage === "ready") void refreshQuotas();
    }, 600_000);
    return () => clearInterval(t);
  }, []);

  const loadDiscovered = async () => {
    try {
      const res = await engine.request("sessions.discover", {});
      useStore.getState().setDiscovered(res.sessions);
    } catch {
      /* discovery is progressive enhancement */
    }
  };

  const refetchTranscript = async (sessionId: string) => {
    try {
      const res = await engine.request("session.transcript", { sessionId });
      if (res.events.length) useStore.getState().hydrateTranscript(sessionId, res.events);
    } catch {
      /* a dead worker has no transcript to refetch */
    }
  };

  // ---- actions ------------------------------------------------------------
  const createSession = async (config: SessionLaunchConfig) => {
    setCreating(true);
    try {
      // Open the project FIRST: if the folder is bad we fail before a worker
      // exists, so a failed create can never orphan a process.
      const proj = await engine.request("project.open", { path: config.projectPath });
      const res = await engine.request("sessions.create", config);
      useStore.getState().addProject(proj.project);
      useStore.getState().addSession(res.session, config.advisors ?? []);
      useStore.getState().setNewSession(false);
    } catch (e) {
      useStore.getState().setEngineError(e as never);
    } finally {
      setCreating(false);
    }
  };

  const resumeSession = async (d: DiscoveredSession) => {
    setCreating(true);
    try {
      const proj = await engine.request("project.open", { path: d.cwd });
      const res = await engine.request("sessions.create", {
        projectPath: d.cwd,
        title: d.title,
        advisors: [],
        resumeSessionPath: d.path,
      });
      useStore.getState().addProject(proj.project);
      useStore.getState().addSession(res.session, []);
      // Pull the persisted conversation into the view.
      await refetchTranscript(res.session.sessionId);
      void loadDiscovered();
    } catch (e) {
      useStore.getState().setEngineError(e as never);
    } finally {
      setCreating(false);
    }
  };

  const forkSession = useCallback(async (sessionId: string) => {
    const st = useStore.getState();
    const src = st.sessions[sessionId];
    if (!src?.summary.ompSessionPath) return;
    try {
      const res = await engine.request("session.fork", {
        sessionId,
        title: `${src.summary.title} (fork)`,
      });
      st.addSession(res.session, src.advisors);
      await refetchTranscript(res.session.sessionId);
    } catch (e) {
      st.setEngineError(e as never);
    }
  }, []);

  useEffect(() => {
    const onFork = (e: Event) => {
      const id = (e as CustomEvent).detail?.sessionId;
      if (id) void forkSession(id);
    };
    window.addEventListener("orchestrator:fork", onFork);
    return () => window.removeEventListener("orchestrator:fork", onFork);
  }, [forkSession]);

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

  const abort = useCallback(() => {
    const id = useStore.getState().visibleSessionId;
    if (id) void engine.request("session.abort", { sessionId: id }).catch(() => {});
  }, []);

  // ---- quit flow ----------------------------------------------------------
  const quitNow = useCallback(async () => {
    try {
      await engine.request("engine.shutdown", { force: false }, 20_000);
    } catch {
      /* the engine may already be gone */
    }
    await invoke("app_quit").catch(() => {});
  }, []);

  useEffect(() => {
    const un = listen("app://exit-requested", () => {
      const st = useStore.getState();
      const running = Object.values(st.sessions).filter((v) => isActive(v.summary.runState)).length;
      if (running > 0) st.setQuitConfirm({ running });
      else void quitNow();
    });
    return () => void un.then((f) => f());
  }, [quitNow]);

  // ---- menus --------------------------------------------------------------
  useEffect(() => {
    const st = () => useStore.getState();
    const uns: Array<Promise<() => void>> = [
      listen("menu://new-session", () => st().setNewSession(true)),
      listen("menu://open-project", () => st().setNewSession(true)),
      listen("menu://command-palette", () => st().setPalette(true, "commands")),
      listen("menu://toggle-sidebar", () => st().toggleSidebar()),
      listen("menu://toggle-inspector", () => st().toggleInspector()),
      listen("menu://session-abort", () => abort()),
      listen("menu://session-compact", () => {
        const id = st().visibleSessionId;
        if (id) void engine.request("session.compact", { sessionId: id }).catch(() => {});
      }),
      listen("menu://session-fork", () => {
        const id = st().visibleSessionId;
        if (id) void forkSession(id);
      }),
      listen("menu://session-model", () => st().setPalette(true, "commands")),
      listen("menu://session-advisors", () => st().setPalette(true, "commands")),
      listen("menu://settings", () => st().setMainView("settings")),
      listen("menu://view-usage", () => st().setMainView("usage")),
      listen("menu://view-changes", () => st().setInspectorTab("changes")),
    ];
    return () => {
      void Promise.all(uns).then((fns) => {
        for (const f of fns) f();
      });
    };
  }, [abort, forkSession]);

  // ---- keyboard -----------------------------------------------------------
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const meta = e.metaKey || e.ctrlKey;
      const st = useStore.getState();
      if (meta && !e.shiftKey && e.key.toLowerCase() === "n") {
        e.preventDefault();
        st.setNewSession(true);
      } else if (meta && e.shiftKey && e.key.toLowerCase() === "p") {
        e.preventDefault();
        st.setPalette(true, "commands");
      } else if (meta && e.key.toLowerCase() === "k") {
        e.preventDefault();
        st.setPalette(true, "sessions");
      } else if (meta && e.key === ",") {
        e.preventDefault();
        st.setMainView(st.mainView === "settings" ? "sessions" : "settings");
      } else if (meta && e.key.toLowerCase() === "u") {
        e.preventDefault();
        st.setMainView(st.mainView === "usage" ? "sessions" : "usage");
      } else if (e.key === "Escape") {
        // One consistent rule: Escape dismisses the topmost surface.
        if (st.paletteOpen) st.setPalette(false);
        else if (st.renameTarget) st.setRenameTarget(undefined);
        else if (st.newSessionOpen) st.setNewSession(false);
        else if (st.quitConfirm) st.setQuitConfirm(undefined);
        else if (st.mainView !== "sessions") st.setMainView("sessions");
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const discoverAdvisors = useCallback(async (projectPath: string): Promise<AdvisorConfig[]> => {
    try {
      const env = await engine.request("project.environment", { path: projectPath });
      return env.advisors;
    } catch {
      return [];
    }
  }, []);

  // ---- render -------------------------------------------------------------
  const stageLabel: Record<string, string> = {
    starting: "Starting engine",
    "loading-config": "Loading OMP configuration",
    "loading-models": "Loading models",
    "loading-extensions": "Loading extensions",
    ready: "Ready",
    degraded: "Degraded",
    stopping: "Stopping",
    offline: "Engine offline",
  };

  const enabledAdvisors = view?.advisors.filter((a) => a.enabled) ?? [];
  const pendingTotal = Object.values(s.sessions).reduce((n, v) => n + v.pendingInteractions, 0);

  const showInspector = s.inspectorOpen && s.mainView !== "usage";

  return (
    <div
      className="app"
      style={{
        gridTemplateColumns: `${s.sidebarOpen ? `${s.prefs.sidebarWidth}px` : "0px"} 1fr ${
          showInspector ? `${s.prefs.inspectorWidth}px` : "0px"
        }`,
      }}
    >
      {/* data-tauri-drag-region is what actually makes the window draggable
          in Tauri; -webkit-app-region is an Electron-ism and does nothing. */}
      <header className="titlebar" data-tauri-drag-region>
        <button
          className={`icon-btn${s.sidebarOpen ? " on" : ""}`}
          title="Toggle sidebar (⌘1)"
          onClick={() => s.toggleSidebar()}
        >
          ◧
        </button>
        <span className="titlebar-title" data-tauri-drag-region>
          The Orchestrator
        </span>
        <span className="titlebar-sub" data-tauri-drag-region>
          {s.engineStage === "ready"
            ? s.engineInfo
              ? `OMP ${s.engineInfo.ompVersion}`
              : ""
            : (stageLabel[s.engineStage] ?? s.engineStage)}
        </span>
        {s.updateAvailable && (
          <button
            className="chip update"
            title={
              s.updateBusy
                ? "Downloading update…"
                : `Version ${s.updateAvailable.version} is available — click to install`
            }
            onClick={() => void installUpdate()}
          >
            {s.updateBusy ? "Updating…" : `Update to ${s.updateAvailable.version}`}
          </button>
        )}
        {pendingTotal > 0 && (
          <button
            className="chip attention chip-btn"
            title="Sessions waiting for your input"
            onClick={() => {
              const st = useStore.getState();
              const waiting = Object.values(st.sessions).find((v) => v.pendingInteractions > 0);
              if (waiting) st.select(waiting.summary.sessionId);
            }}
          >
            {pendingTotal} needs input
          </button>
        )}
        <span className="spacer" data-tauri-drag-region />
        {view?.context && (
          <span
            className="chip"
            title={`${view.context.usedTokens} / ${view.context.maxTokens} tokens in the model's context window`}
          >
            Context <strong>{Math.round(view.context.fraction * 100)}%</strong>
          </span>
        )}
        {view?.usage && (
          <button
            className="chip chip-btn"
            title="Cumulative session usage — open breakdown"
            onClick={() => s.setInspectorTab("usage")}
          >
            Usage{" "}
            <strong>
              {fmtTokens(
                view.usage.total.inputTokens +
                  view.usage.total.outputTokens +
                  view.usage.total.cacheReadTokens +
                  view.usage.total.cacheWriteTokens,
              )}
            </strong>
          </button>
        )}
        <button
          className={`icon-btn${showInspector ? " on" : ""}`}
          title="Toggle inspector (⌘2)"
          onClick={() => s.toggleInspector()}
        >
          ◨
        </button>
        <button
          className="icon-btn"
          title="Settings (⌘,)"
          onClick={() => s.setMainView(s.mainView === "settings" ? "sessions" : "settings")}
        >
          ⚙
        </button>
      </header>

      {s.sidebarOpen && (
        <Sidebar onResume={(d) => void resumeSession(d)} onFork={(id) => void forkSession(id)} />
      )}

      <main className="main">
        {s.mainView === "usage" ? (
          <UsageCenter />
        ) : (
          <>
            {s.engineStage === "offline" && (
              <div className="banner" style={{ margin: 12 }}>
                <strong>The OMP engine is not running.</strong>
                <div style={{ marginTop: 4 }}>
                  {s.engineError?.message ?? "It exited unexpectedly."}
                  {s.engineError?.detail && (
                    <details style={{ marginTop: 6 }}>
                      <summary className="hint">Details</summary>
                      <pre className="tool-output" style={{ marginTop: 6 }}>
                        {s.engineError.detail}
                      </pre>
                    </details>
                  )}
                </div>
                <button
                  className="btn"
                  style={{ marginTop: 8 }}
                  onClick={() => void engine.restart()}
                >
                  Restart engine
                </button>
              </div>
            )}

            {s.engineError && s.engineStage !== "offline" && (
              <div className="banner" style={{ margin: "8px 12px 0" }}>
                {s.engineError.message}
                <button
                  className="btn btn-ghost"
                  style={{ marginLeft: 8 }}
                  onClick={() => s.setEngineError(undefined)}
                >
                  Dismiss
                </button>
              </div>
            )}

            {view ? (
              <>
                <div className="session-header">
                  <span className="titlebar-title">{view.summary.title}</span>
                  <span className="chip">
                    {modelBasename(view.summary.model)}
                    {view.summary.thinkingLevel ? ` · ${view.summary.thinkingLevel}` : ""}
                  </span>
                  {enabledAdvisors.length > 0 && (
                    <span
                      className="chip"
                      title={enabledAdvisors
                        .map((a) => {
                          const st = view.advisorStates[a.id];
                          return `${a.name}${st ? ` — ${st}` : ""}`;
                        })
                        .join("\n")}
                    >
                      {enabledAdvisors.length} advisor{enabledAdvisors.length > 1 ? "s" : ""}
                      {Object.values(view.advisorStates).some((st) => st === "reviewing") &&
                        " · reviewing"}
                    </span>
                  )}
                  <span className="chip mono" title={view.summary.projectPath}>
                    {view.summary.projectPath.split("/").pop()}
                  </span>
                  <span className="spacer" />
                  {view.interrupted && view.summary.ompSessionPath ? (
                    <button
                      className="btn"
                      onClick={() => {
                        const d: DiscoveredSession = {
                          ompSessionId: view.summary.ompSessionId ?? "",
                          path: view.summary.ompSessionPath!,
                          cwd: view.summary.projectPath,
                          title: view.summary.title,
                          messageCount: view.summary.messageCount,
                          sizeBytes: 0,
                          openInThisApp: false,
                        };
                        useStore.getState().removeSession(view.summary.sessionId);
                        void resumeSession(d);
                      }}
                    >
                      Resume Session
                    </button>
                  ) : (
                    <span className="hint">{view.summary.activity ?? view.summary.runState}</span>
                  )}
                </div>

                <Transcript items={view.transcript} sessionId={view.summary.sessionId} />

                {view.pendingInteractions > 0 && <PendingBar view={view} />}

                <Composer
                  sessionId={view.summary.sessionId}
                  runState={view.summary.runState}
                  onSend={send}
                  onAbort={abort}
                  disabled={s.engineStage === "offline" || Boolean(view.interrupted)}
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
          </>
        )}
      </main>

      {showInspector && <Inspector view={view} />}

      {s.mainView === "settings" && <Settings onClose={() => s.setMainView("sessions")} />}

      {s.renameTarget && (
        <PromptDialog
          title="Rename session"
          initial={s.sessions[s.renameTarget]?.summary.title}
          placeholder="Session title"
          submitLabel="Rename"
          onCancel={() => s.setRenameTarget(undefined)}
          onSubmit={(title) => {
            const sessionId = s.renameTarget;
            s.setRenameTarget(undefined);
            if (sessionId) void engine.request("session.setTitle", { sessionId, title });
          }}
        />
      )}

      {s.newSessionOpen && (
        <NewSession
          models={s.models}
          discoverAdvisors={discoverAdvisors}
          busy={creating}
          onCancel={() => s.setNewSession(false)}
          onCreate={(c) => void createSession(c)}
        />
      )}

      {s.paletteOpen && <CommandPalette />}

      {s.quitConfirm && (
        <QuitDialog
          running={s.quitConfirm.running}
          onCancel={() => s.setQuitConfirm(undefined)}
          onQuit={() => void quitNow()}
        />
      )}

      {!s.prefs.setupComplete && <Onboarding />}
    </div>
  );
}
