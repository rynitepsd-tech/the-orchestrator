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
import { Home } from "./components/Home";
import { Inbox } from "./components/Inbox";
import { Inspector } from "./components/Inspector";
import { FolderIcon, PanelLeftIcon, PanelRightIcon } from "./components/icons";
import { NewSession } from "./components/NewSession";
import { Onboarding } from "./components/Onboarding";
import { PendingBar } from "./components/PendingBar";
import { PreviewPanel } from "./components/PreviewPanel";
import { PromptDialog } from "./components/PromptDialog";
import { QuitDialog } from "./components/QuitDialog";
import { Settings } from "./components/Settings";
import { Sidebar } from "./components/Sidebar";
import { TodoStrip } from "./components/TodoStrip";
import { Transcript } from "./components/Transcript";
import { UsageCenter } from "./components/UsageCenter";
import { engine } from "./engine-client";
import { hasLocalPrefs, sanitizePrefs, setPrefsSink } from "./lib/prefs";
import { checkForUpdates, installUpdate } from "./lib/updater";
import {
  advisorsReviewing,
  fmtTokens,
  isActive,
  modelBasename,
  runStateLabel,
  useStore,
} from "./store";

export function App(): JSX.Element {
  const s = useStore();
  const [creating, setCreating] = useState(false);
  /** Per-session preview-pane visibility; the detected URL lives in the view. */
  const [previewOpen, setPreviewOpen] = useState<Record<string, boolean>>({});
  const notifyOk = useRef(false);
  /**
   * Sessions whose turn has finished but whose advisors are still reviewing.
   * The announcement is armed here and fires once the review window closes —
   * a revised answer is still coming, so "the agent is done" would be a lie.
   */
  const notifyArmed = useRef(new Set<string>());

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
  // Silent checks: at startup, again shortly after (a launch can race a fresh
  // publish or an offline boot), hourly, and whenever the window regains focus
  // (throttled) — so a new release is offered in minutes, not hours. The feed
  // is one static JSON file; this cadence is negligible traffic.
  useEffect(() => {
    let last = Date.now();
    const run = () => {
      last = Date.now();
      void checkForUpdates({ silent: true });
    };
    run();
    const retry = setTimeout(() => {
      if (!useStore.getState().updateAvailable) run();
    }, 5 * 60_000);
    const t = setInterval(run, 60 * 60_000);
    const onFocus = () => {
      const st = useStore.getState();
      if (Date.now() - last > 15 * 60_000 && !st.updateAvailable && !st.updateBusy) run();
    };
    window.addEventListener("focus", onFocus);
    return () => {
      clearTimeout(retry);
      clearInterval(t);
      window.removeEventListener("focus", onFocus);
    };
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

      // Remember which sessions are open in this app, so a relaunch keeps
      // them under their project group instead of "Previous sessions".
      if (e.type === "session.persisted" && e.ompSessionPath) {
        const open = st.prefs.openSessionPaths;
        if (!open.includes(e.ompSessionPath)) {
          st.updatePrefs({ openSessionPaths: [...open, e.ompSessionPath].slice(-100) });
        }
      }

      // One notification per USER turn, fired the moment the turn is really
      // over. `session.finished` alone is not that moment: advisors review
      // afterwards and the model may revise its answer in a continuation turn
      // that raises a second `session.finished`. So the finish only ARMS the
      // announcement; it fires on the first event that leaves the session
      // completed with no review outstanding.
      if (
        before &&
        e.type === "session.finished" &&
        e.runState === "completed" &&
        st.prefs.notifications.completion
      ) {
        notifyArmed.current.add(e.sessionId);
      }
      if (notifyArmed.current.has(e.sessionId)) {
        const after = useStore.getState().sessions[e.sessionId];
        if (!after) notifyArmed.current.delete(e.sessionId);
        else if (after.summary.runState === "completed" && !advisorsReviewing(after)) {
          notifyArmed.current.delete(e.sessionId);
          // Not while the user is already watching it: a background session,
          // OR the visible one while the window is unfocused (the canonical
          // "⌘-Tab away and wait" flow the old visible-only gate inverted).
          const watching =
            useStore.getState().visibleSessionId === e.sessionId && document.hasFocus();
          if (!watching) notify(`${after.summary.title} finished`, "The agent is done.");
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
        // Durable prefs: every save also lands in a file under Application
        // Support, and a wiped localStorage restores from it on next launch.
        setPrefsSink((p) => {
          void engine.request("prefs.save", { prefs: p }).catch(() => {});
        });
        void engine
          .request("prefs.load", {})
          .then((res) => {
            const cur = useStore.getState();
            if (res.prefs && !hasLocalPrefs()) {
              cur.updatePrefs(sanitizePrefs(res.prefs));
            } else {
              // Heal a missing/stale mirror from the live prefs.
              void engine.request("prefs.save", { prefs: cur.prefs }).catch(() => {});
            }
          })
          .catch(() => {});
      }
      if (e.type === "engine.error") st.setEngineError(e.error);
      if (e.type === "engine.auth") {
        // The engine never opens a browser itself; the OAuth URL arrives here.
        // https (or OMP's localhost launch route) only, and a failure to open
        // must be SAID — this is the whole provider sign-in path.
        if (e.status === "browser" && e.url) {
          const url = e.url;
          const openable =
            /^https:\/\//i.test(url) || /^http:\/\/(localhost|127\.0\.0\.1|\[::1\])[:/]/i.test(url);
          if (openable) {
            void openUrl(url).catch(() => {
              st.setEngineError({
                kind: "auth",
                message: `Could not open the sign-in page. Open it manually: ${url}`,
              });
            });
          } else {
            st.setEngineError({
              kind: "auth",
              message: `Refusing to open a non-https sign-in URL. Open it manually: ${url}`,
            });
          }
          // Device-code flows put the code the user must type here.
          if (e.message) st.setAuthNotice(e.message);
        }
        if (e.status === "prompt") {
          if (e.promptId && e.message) {
            st.setAuthPrompt({
              promptId: e.promptId,
              provider: e.provider,
              message: e.message,
              placeholder: e.placeholder,
              allowEmpty: e.allowEmpty,
            });
          } else if (e.message) {
            st.setAuthNotice(e.message);
          }
        }
        if (e.status === "done") {
          st.setAuthNotice(undefined);
          st.setAuthPrompt(undefined);
        }
        if (e.status === "failed") {
          st.setAuthNotice(undefined);
          st.setAuthPrompt(undefined);
          if (e.message) st.setEngineError({ kind: "auth", message: e.message });
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

    // Dropped frames: the sequence counter is engine-global, so the loss
    // cannot be attributed to one session — refetch every live session's
    // authoritative transcript rather than leaving any of them with a hole.
    engine.onSequenceGap = () => {
      for (const id of Object.keys(useStore.getState().sessions)) {
        void refetchTranscript(id);
      }
    };

    void engine.connect();
    return () => engine.dispose();
  }, [notify]);

  /**
   * `rediscover` re-runs OMP's provider model discovery instead of serving the
   * engine's cached catalogue. Boot passes false (discovery is already settling
   * behind the first `models.list`); the periodic reload passes true.
   *
   * That request is cache-aware upstream: OMP's built-in discovery holds a
   * two-hour TTL, so this asks every ten minutes but only reaches the provider
   * once the TTL lapses. Deliberate — polling every configured provider's model
   * endpoint six times an hour would cost real requests and risk rate limits to
   * learn something that changes a few times a year.
   */
  const loadCatalogue = async (rediscover = false) => {
    try {
      const [m, p] = await Promise.all([
        engine.request("models.list", rediscover ? { refresh: true } : {}),
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
      // Full catalogue refresh (models + providers + quotas) so a credential
      // that dies mid-session (expired OAuth grant) surfaces as a banner
      // without an app restart, and a newly released model becomes selectable
      // without one either (within OMP's two-hour discovery TTL).
      if (useStore.getState().engineStage === "ready") void loadCatalogue(true);
    }, 600_000);
    return () => clearInterval(t);
  }, []);

  const loadDiscovered = async () => {
    try {
      const res = await engine.request("sessions.discover", {});
      const st = useStore.getState();
      st.setDiscovered(res.sessions);
      // Prune remembered-open paths whose session files no longer exist.
      const known = new Set(res.sessions.map((d) => d.path));
      const pruned = st.prefs.openSessionPaths.filter((p) => known.has(p));
      if (pruned.length !== st.prefs.openSessionPaths.length) {
        st.updatePrefs({ openSessionPaths: pruned });
      }
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
  const createSession = async (config: SessionLaunchConfig): Promise<string | undefined> => {
    setCreating(true);
    try {
      // Open the project FIRST: if the folder is bad we fail before a worker
      // exists, so a failed create can never orphan a process.
      const proj = await engine.request("project.open", { path: config.projectPath });
      const res = await engine.request("sessions.create", config);
      useStore.getState().addProject(proj.project);
      useStore.getState().addSession(res.session, config.advisors ?? []);
      // The launch-time mode is already enforced worker-side; record it so
      // the composer chip shows it and it persists across restarts.
      if (config.approvalMode) {
        useStore.getState().setSessionApproval(res.session.sessionId, config.approvalMode);
      }
      useStore.getState().setNewSession(false);
      return res.session.sessionId;
    } catch (e) {
      useStore.getState().setEngineError(e as never);
      return undefined;
    } finally {
      setCreating(false);
    }
  };

  // Home-screen launch: create the session and fire the first message in one
  // motion, so "type what you want, hit Enter" is the whole flow.
  const launchWithPrompt = async (
    config: SessionLaunchConfig,
    firstMessage: string,
    presetName?: string,
    attachments: Array<{ kind: "image" | "file"; name: string; path: string }> = [],
  ) => {
    const id = await createSession(config);
    if (!id) return;
    if (presetName) useStore.getState().setSessionPreset(id, presetName);
    useStore.getState().apply({
      type: "user.message",
      sessionId: id,
      messageId: `u${Date.now()}`,
      text: firstMessage,
      attachments: attachments.map((a) => ({ kind: a.kind, name: a.name, path: a.path })),
    });
    void engine
      .request("session.prompt", {
        sessionId: id,
        text: firstMessage,
        whenBusy: "steer",
        attachments: attachments.length
          ? attachments.map((a) => ({ kind: a.kind, path: a.path }))
          : undefined,
      })
      .catch((e) => {
        useStore.getState().setEngineError(e);
      });
  };

  // Whole-row click makes accidental double-activation easy; one resume of the
  // same session file at a time, or two workers would fight over it.
  const resuming = useRef<string | null>(null);

  const resumeSession = async (d: DiscoveredSession): Promise<string | undefined> => {
    if (resuming.current) return undefined;
    resuming.current = d.path;
    setCreating(true);
    try {
      // Re-apply the session's remembered preset so a restart doesn't silently
      // fall back to OMP defaults until the user reselects it. Advisors must
      // ride along in the boot config: a resume that launches with [] runs the
      // whole session with zero reviewers no matter what the preset says.
      const prefs = useStore.getState().prefs;
      const remembered = prefs.sessionPresetByPath[d.path];
      const preset = remembered ? prefs.presets.find((p) => p.name === remembered) : undefined;
      const advisors = preset?.advisors.map((a) => ({ ...a })) ?? [];
      const proj = await engine.request("project.open", { path: d.cwd });
      const res = await engine.request("sessions.create", {
        projectPath: d.cwd,
        title: d.title,
        advisors,
        resumeSessionPath: d.path,
        // Restore the session's remembered approval mode at boot, so the
        // tier gate is correct from the first tool call.
        approvalMode: prefs.sessionApprovalByPath[d.path] as
          | "always-ask"
          | "write"
          | "yolo"
          | undefined,
      });
      useStore.getState().addProject(proj.project);
      useStore.getState().addSession(res.session, advisors, { resumed: true });
      if (preset?.model) {
        void engine
          .request("session.setModel", {
            sessionId: res.session.sessionId,
            model: preset.model,
            thinkingLevel: preset.thinkingLevel,
          })
          .catch(() => {});
      }
      if (preset?.fastMode) {
        void engine
          .request("session.setFastMode", { sessionId: res.session.sessionId, enabled: true })
          .catch(() => {});
      }
      // Pull the persisted conversation into the view.
      await refetchTranscript(res.session.sessionId);
      void loadDiscovered();
      return res.session.sessionId;
    } catch (e) {
      useStore.getState().setEngineError(e as never);
      return undefined;
    } finally {
      setCreating(false);
      resuming.current = null;
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

  const sendTo = (
    id: string,
    text: string,
    whenBusy: "steer" | "queue",
    attachments: Array<{ kind: "image" | "file"; name: string; path: string }> = [],
  ) => {
    // Optimistically show the user's message immediately; the worker echoes it
    // once OMP picks it up, and the store reconciles that echo into this
    // bubble by id pattern + text (see reduce "user.message").
    const messageId = `u${Date.now()}`;
    useStore.getState().apply({
      type: "user.message",
      sessionId: id,
      messageId,
      text,
      attachments: attachments.map((a) => ({ kind: a.kind, name: a.name, path: a.path })),
    });
    void engine
      .request("session.prompt", {
        sessionId: id,
        text,
        whenBusy,
        attachments: attachments.length
          ? attachments.map((a) => ({ kind: a.kind, path: a.path }))
          : undefined,
      })
      .catch((e) => {
        // The send failed: the bubble must not sit there looking delivered,
        // and the text (its only surviving copy) goes back to the composer.
        const st = useStore.getState();
        st.removeTranscriptItem(id, messageId);
        st.setComposerPrefill({ sessionId: id, text });
        st.setEngineError(e);
      });
  };

  const send = (
    text: string,
    whenBusy: "steer" | "queue",
    attachments: Array<{ kind: "image" | "file"; name: string; path: string }> = [],
  ) => {
    if (!s.visibleSessionId) return;
    const id = s.visibleSessionId;
    const view = useStore.getState().sessions[id];
    // A hibernated session wakes transparently: respawn its worker from the
    // persisted file, then deliver the prompt to the fresh session.
    if (view?.summary.runState === "hibernated" && view.summary.ompSessionPath) {
      const d: DiscoveredSession = {
        ompSessionId: view.summary.ompSessionId ?? "",
        path: view.summary.ompSessionPath,
        cwd: view.summary.projectPath,
        title: view.summary.title,
        messageCount: view.summary.messageCount,
        sizeBytes: 0,
        openInThisApp: false,
      };
      void (async () => {
        useStore.getState().removeSession(id);
        const newId = await resumeSession(d);
        if (newId) sendTo(newId, text, whenBusy, attachments);
        else useStore.getState().setComposerPrefill({ sessionId: id, text });
      })();
      return;
    }
    sendTo(id, text, whenBusy, attachments);
  };

  const abort = useCallback(() => {
    const id = useStore.getState().visibleSessionId;
    if (id) void engine.request("session.abort", { sessionId: id }).catch(() => {});
  }, []);

  // ---- quit flow ----------------------------------------------------------
  const quitNow = useCallback(async () => {
    try {
      // The ack is honest now — it resolves only after every worker has been
      // disposed and the usage index flushed, so the budget must cover the
      // engine's own teardown ladder (up to ~17s/worker, in parallel).
      await engine.request("engine.shutdown", { force: false }, 30_000);
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
      listen("menu://new-session", () => st().goHome()),
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
      listen("menu://session-model", () =>
        window.dispatchEvent(new CustomEvent("orchestrator:change-model")),
      ),
      listen("menu://session-advisors", () =>
        window.dispatchEvent(new CustomEvent("orchestrator:configure-advisors")),
      ),
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
        st.goHome();
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
      } else if (meta && e.key.toLowerCase() === "f" && !e.shiftKey && !e.altKey) {
        // Native find can't reach unmounted history; the transcript has its own.
        if (st.mainView === "sessions" && st.visibleSessionId) {
          e.preventDefault();
          window.dispatchEvent(new CustomEvent("orchestrator:find"));
        }
      } else if (meta && e.altKey && (e.key === "ArrowUp" || e.key === "ArrowDown")) {
        // ⌥⌘↑/↓ cycles through open sessions in sidebar order.
        e.preventDefault();
        const order = st.order;
        if (order.length > 1) {
          const cur = st.visibleSessionId ? order.indexOf(st.visibleSessionId) : -1;
          const step = e.key === "ArrowUp" ? -1 : 1;
          const next = order[(cur + step + order.length) % order.length];
          if (next) st.select(next);
        }
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

  const showInspector = s.inspectorOpen && s.mainView !== "usage";

  // Live status for the breadcrumb: only worth showing while something moves.
  const crumbStatus = view
    ? !isActive(view.summary.runState) && advisorsReviewing(view)
      ? "Advisors reviewing…"
      : isActive(view.summary.runState)
        ? (view.summary.activity ?? runStateLabel(view.summary.runState))
        : undefined
    : undefined;

  const projectName = view
    ? (s.prefs.projectAliases[view.summary.projectPath] ??
      (view.summary.projectPath.split("/").pop() || view.summary.projectPath))
    : undefined;

  const gridColumns = `${s.sidebarOpen ? `${s.prefs.sidebarWidth}px` : "0px"} 1fr ${
    showInspector ? `${s.prefs.inspectorWidth}px` : "0px"
  }`;

  const sidebarToggle = (
    <button
      className={`icon-btn${s.sidebarOpen ? " on" : ""}`}
      title="Toggle sidebar (⌘1)"
      onClick={() => s.toggleSidebar()}
    >
      <PanelLeftIcon />
    </button>
  );
  const logo = (
    <span className="titlebar-logo" data-tauri-drag-region>
      <span className="logo-the">The</span>
      <span className="logo-orchestrator">Orchestrator</span>
    </span>
  );
  const inspectorToggle = (
    <button
      className={`icon-btn${showInspector ? " on" : ""}`}
      title="Toggle inspector (⌘2)"
      onClick={() => s.toggleInspector()}
    >
      <PanelRightIcon />
    </button>
  );

  return (
    <div className="app" style={{ gridTemplateColumns: gridColumns }}>
      {/* data-tauri-drag-region is what actually makes the window draggable
          in Tauri; -webkit-app-region is an Electron-ism and does nothing.
          The bar mirrors the app's three columns: the stretches above the
          sidebar and inspector share their darker ground, T3-style. */}
      <header
        className="titlebar"
        style={{ gridTemplateColumns: gridColumns }}
        data-tauri-drag-region
      >
        {s.sidebarOpen && (
          <div className="titlebar-side titlebar-left" data-tauri-drag-region>
            {sidebarToggle}
            {logo}
          </div>
        )}
        <div className={`titlebar-main${s.sidebarOpen ? "" : " no-left"}`} data-tauri-drag-region>
          {!s.sidebarOpen && sidebarToggle}
          {!s.sidebarOpen && logo}
          {s.engineStage !== "ready" && (
            <span className="titlebar-sub" data-tauri-drag-region>
              {stageLabel[s.engineStage] ?? s.engineStage}
            </span>
          )}
          {view && s.mainView === "sessions" && (
            <span
              className="titlebar-crumbs"
              data-tauri-drag-region
              title={view.summary.projectPath}
            >
              <FolderIcon />
              <span className="crumb-project">{projectName}</span>
              <span className="crumb-sep">/</span>
              <span className="crumb-title">{view.summary.title}</span>
              {crumbStatus && <span className="crumb-status">· {crumbStatus}</span>}
            </span>
          )}
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
          <span className="spacer" data-tauri-drag-region />
          {view && s.mainView === "sessions" && (
            <span
              className="chip"
              title={view.summary.model ? `Model: ${view.summary.model}` : "OMP decides the model"}
            >
              {view.presetName ?? modelBasename(view.summary.model)}
              {view.summary.thinkingLevel && (
                <span className="chip-effort"> · {view.summary.thinkingLevel}</span>
              )}
            </span>
          )}
          {view && s.mainView === "sessions" && enabledAdvisors.length > 0 && (
            <span
              className="chip chip-advisors"
              title={enabledAdvisors
                .map((a) => {
                  const st = view.advisorStates[a.id];
                  return `${a.name}${st ? ` — ${st}` : ""}`;
                })
                .join("\n")}
            >
              {enabledAdvisors.length} advisor{enabledAdvisors.length > 1 ? "s" : ""}
            </span>
          )}
          {view?.context && (
            <span
              className="chip"
              title={`${view.context.usedTokens} / ${view.context.maxTokens} tokens in the model's context window`}
            >
              <span className="ctx-label">Context </span>
              <strong>{Math.round(view.context.fraction * 100)}%</strong>
            </span>
          )}
          {view?.usage && (
            <button
              className="chip chip-btn chip-usage"
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
          {!showInspector && inspectorToggle}
        </div>
        {showInspector && (
          <div className="titlebar-side titlebar-right" data-tauri-drag-region>
            {inspectorToggle}
          </div>
        )}
      </header>

      {s.sidebarOpen && (
        <Sidebar onResume={(d) => void resumeSession(d)} onFork={(id) => void forkSession(id)} />
      )}

      <main className="main">
        {/* Dead sign-in banner: the engine refuses sessions on these
            providers (auth gate) — say why and route to the fix. */}
        {s.mainView !== "settings" &&
          (() => {
            const dead = s.providers.filter((p) => !p.authenticated && p.disabledCause);
            if (dead.length === 0) return null;
            return (
              <div className="banner banner-auth">
                <strong>
                  {dead.map((p) => p.name).join(", ")} sign-in expired — sessions blocked.
                </strong>
                <div style={{ marginTop: 4 }}>
                  Requests through an expired sign-in can be silently billed to your API credits
                  instead of your subscription, so the engine refuses them until you reconnect.
                </div>
                <button
                  className="btn"
                  style={{ marginTop: 8 }}
                  onClick={() => s.setMainView("settings")}
                >
                  Reconnect in Settings
                </button>
              </div>
            );
          })()}
        {s.mainView === "usage" ? (
          <UsageCenter />
        ) : s.mainView === "inbox" ? (
          <Inbox />
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
              <div className="session-split">
                <div className="session-col">
                  {view.interrupted && view.summary.ompSessionPath && (
                    <div className="banner" style={{ margin: "10px 12px 0" }}>
                      This session was interrupted.
                      <button
                        className="btn"
                        style={{ marginLeft: 8 }}
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
                    </div>
                  )}

                  {/* Keyed by session: scroll pin, render window, and find state
                    are per-conversation. Without the key one shared instance
                    carried another session's scroll offset (and unpinned
                    state) across a switch, landing mid-history. */}
                  <Transcript
                    key={view.summary.sessionId}
                    items={view.transcript}
                    sessionId={view.summary.sessionId}
                  />

                  {view.pendingInteractions > 0 && <PendingBar view={view} />}

                  {/* The plan docks on the composer, a tab growing out of its top. */}
                  <div className="composer-zone">
                    {view.todoPhases && <TodoStrip phases={view.todoPhases} />}
                    <Composer
                      sessionId={view.summary.sessionId}
                      runState={view.summary.runState}
                      onSend={send}
                      onAbort={abort}
                      disabled={s.engineStage === "offline" || Boolean(view.interrupted)}
                    />
                  </div>

                  {view.previewUrl && !previewOpen[view.summary.sessionId] && (
                    <button
                      className="btn preview-chip"
                      title={view.previewUrl}
                      onClick={() =>
                        setPreviewOpen((p) => ({ ...p, [view.summary.sessionId]: true }))
                      }
                    >
                      Preview {new URL(view.previewUrl).host}
                    </button>
                  )}
                </div>

                {view.previewUrl && previewOpen[view.summary.sessionId] && (
                  <PreviewPanel
                    url={view.previewUrl}
                    onClose={() =>
                      setPreviewOpen((p) => ({ ...p, [view.summary.sessionId]: false }))
                    }
                  />
                )}
              </div>
            ) : (
              <Home
                busy={creating}
                disabled={s.engineStage === "offline"}
                onLaunch={(config, msg, preset, attachments) =>
                  void launchWithPrompt(config, msg, preset, attachments)
                }
              />
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

      {s.renameProjectTarget && (
        <PromptDialog
          title="Rename project"
          initial={
            s.prefs.projectAliases[s.renameProjectTarget] ?? s.renameProjectTarget.split("/").pop()
          }
          placeholder="Project display name"
          submitLabel="Rename"
          onCancel={() => s.setRenameProjectTarget(undefined)}
          onSubmit={(name) => {
            const path = s.renameProjectTarget;
            s.setRenameProjectTarget(undefined);
            if (!path) return;
            // Display alias only — the folder on disk keeps its real name.
            const aliases = { ...s.prefs.projectAliases };
            if (name === path.split("/").pop()) delete aliases[path];
            else aliases[path] = name;
            s.updatePrefs({ projectAliases: aliases });
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
