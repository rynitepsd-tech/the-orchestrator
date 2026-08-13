/**
 * Settings.
 *
 * Sections: General (theme, notifications), Providers (connection state +
 * GUI OAuth sign-in through OMP's own flow), MCP (per-session server status),
 * Engine (diagnostics, workers, copy diagnostics), About.
 */

import type { ResponsePayloads } from "@orchestrator/protocol";
import { openUrl, revealItemInDir } from "@tauri-apps/plugin-opener";
import type { JSX } from "react";
import { useEffect, useState } from "react";
import { engine } from "../engine-client";
import { useStore } from "../store";

type Section = "general" | "providers" | "mcp" | "engine" | "about";

export function Settings({ onClose }: { onClose: () => void }): JSX.Element {
  const [section, setSection] = useState<Section>("general");
  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div
        className="modal settings"
        onMouseDown={(e) => e.stopPropagation()}
        role="dialog"
        aria-label="Settings"
        onKeyDown={(e) => e.key === "Escape" && onClose()}
      >
        <div className="settings-nav">
          {(
            [
              ["general", "General"],
              ["providers", "Providers"],
              ["mcp", "MCP"],
              ["engine", "Engine"],
              ["about", "About"],
            ] as const
          ).map(([id, label]) => (
            <button
              key={id}
              className={`settings-nav-item${section === id ? " on" : ""}`}
              onClick={() => setSection(id)}
            >
              {label}
            </button>
          ))}
        </div>
        <div className="settings-body">
          {section === "general" && <General />}
          {section === "providers" && <Providers />}
          {section === "mcp" && <Mcp />}
          {section === "engine" && <Engine />}
          {section === "about" && <About />}
        </div>
      </div>
    </div>
  );
}

function General(): JSX.Element {
  const prefs = useStore((s) => s.prefs);
  const updatePrefs = useStore((s) => s.updatePrefs);
  const n = prefs.notifications;

  return (
    <div>
      <h3>General</h3>
      <label className="field">
        <span>Appearance</span>
        <div className="segmented">
          {(["system", "light", "dark"] as const).map((t) => (
            <button
              key={t}
              className={`seg${prefs.theme === t ? " on" : ""}`}
              onClick={() => updatePrefs({ theme: t })}
            >
              {t}
            </button>
          ))}
        </div>
      </label>

      <div className="field">
        <span>Notifications</span>
        {(
          [
            ["completion", "Session completed"],
            ["errors", "Session failed"],
            ["needsInput", "Needs approval or input"],
            ["advisorBlockers", "Advisor raised a blocker"],
          ] as const
        ).map(([key, label]) => (
          <label key={key} className="row check-row">
            <input
              type="checkbox"
              checked={n[key]}
              onChange={(e) => updatePrefs({ notifications: { ...n, [key]: e.target.checked } })}
            />
            <span>{label}</span>
          </label>
        ))}
        <div className="hint">Notifications fire only for sessions you are not looking at.</div>
      </div>

      <label className="row check-row">
        <input
          type="checkbox"
          checked={prefs.keepRunningOnClose}
          onChange={(e) => updatePrefs({ keepRunningOnClose: e.target.checked })}
        />
        <span>Keep sessions running when the window closes (quit with ⌘Q)</span>
      </label>
    </div>
  );
}

function Providers(): JSX.Element {
  const providers = useStore((s) => s.providers);
  const setCatalogue = useStore((s) => s.setCatalogue);
  const [busyProvider, setBusyProvider] = useState<string | null>(null);
  const [authMsg, setAuthMsg] = useState<string | null>(null);

  const connect = async (name: string) => {
    setBusyProvider(name);
    setAuthMsg(null);
    try {
      // OAuth runs 10+ minutes worst case; the engine emits engine.auth events
      // (browser URL etc.) which App handles globally.
      const res = await engine.request("providers.login", { provider: name }, 600_000);
      setAuthMsg(res.message ?? "Connected.");
      const [m, p] = await Promise.all([
        engine.request("models.list", { refresh: true }),
        engine.request("providers.list", {}),
      ]);
      setCatalogue(m.models, p.providers);
    } catch (e) {
      setAuthMsg(String((e as { message?: string })?.message ?? e));
    } finally {
      setBusyProvider(null);
    }
  };

  const connected = providers.filter((p) => p.authenticated);
  const disconnected = providers.filter((p) => !p.authenticated);

  return (
    <div>
      <h3>Providers</h3>
      <div className="hint" style={{ marginBottom: 10 }}>
        The Orchestrator reuses your OMP credentials. Signing in here runs OMP's own OAuth flow;
        secrets never leave OMP's storage.
      </div>
      {authMsg && <div className="banner info">{authMsg}</div>}
      {connected.map((p) => (
        <div key={p.name} className="provider-row">
          <span className="dot done" />
          <span className="provider-name">{p.name}</span>
          <span className="hint">
            {p.modelCount} models{p.credentialSource ? ` · ${p.credentialSource}` : ""}
          </span>
          <span className="spacer" />
          <span className="hint">Connected</span>
        </div>
      ))}
      {disconnected.length > 0 && <div className="section-label">Not connected</div>}
      {disconnected.map((p) => (
        <div key={p.name} className="provider-row">
          <span className="dot idle" />
          <span className="provider-name">{p.name}</span>
          <span className="hint">{p.modelCount} models</span>
          <span className="spacer" />
          <button
            className="btn"
            disabled={busyProvider !== null}
            onClick={() => void connect(p.name)}
          >
            {busyProvider === p.name ? "Waiting for browser…" : "Connect"}
          </button>
        </div>
      ))}
      <div className="hint" style={{ marginTop: 10 }}>
        Providers without a supported GUI flow will say so — run <code>omp</code> in a terminal for
        those. Sign-out is managed by OMP (<code>omp logout</code>).
      </div>
    </div>
  );
}

function Mcp(): JSX.Element {
  const visibleId = useStore((s) => s.visibleSessionId);
  const sessions = useStore((s) => s.sessions);
  const [servers, setServers] = useState<ResponsePayloads["mcp.status"]["servers"] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const view = visibleId ? sessions[visibleId] : undefined;

  const refresh = async () => {
    if (!visibleId) return;
    try {
      setErr(null);
      const res = await engine.request("mcp.status", { sessionId: visibleId });
      setServers(res.servers);
    } catch (e) {
      setErr(String((e as { message?: string })?.message ?? e));
    }
  };

  useEffect(() => {
    void refresh();
  }, [visibleId]);

  const reconnect = async (server: string) => {
    if (!visibleId) return;
    setBusy(server);
    try {
      await engine.request("mcp.reconnect", { sessionId: visibleId, server }, 60_000);
      await refresh();
    } catch (e) {
      setErr(String((e as { message?: string })?.message ?? e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div>
      <h3>MCP Servers</h3>
      {!view ? (
        <div className="hint">
          MCP servers run per session. Open a session to see its server status.
        </div>
      ) : (
        <>
          <div className="hint" style={{ marginBottom: 8 }}>
            Session: {view.summary.title}
          </div>
          {err && <div className="banner">{err}</div>}
          {servers === null ? (
            <div className="hint">Loading…</div>
          ) : servers.length === 0 ? (
            <div className="hint">No MCP servers configured for this session's project.</div>
          ) : (
            servers.map((srv) => (
              <div key={srv.name} className="provider-row">
                <span
                  className={`dot ${srv.status === "connected" ? "done" : srv.status === "connecting" ? "active" : "error"}`}
                />
                <span className="provider-name">{srv.name}</span>
                <span className="hint">
                  {srv.status}
                  {typeof srv.toolCount === "number" && ` · ${srv.toolCount} tools`}
                  {srv.source && ` · ${srv.source}`}
                </span>
                <span className="spacer" />
                {srv.status !== "connected" && (
                  <button
                    className="btn"
                    disabled={busy !== null}
                    onClick={() => void reconnect(srv.name)}
                  >
                    {busy === srv.name ? "Reconnecting…" : "Reconnect"}
                  </button>
                )}
              </div>
            ))
          )}
          <button className="btn btn-ghost" style={{ marginTop: 8 }} onClick={() => void refresh()}>
            Refresh
          </button>
        </>
      )}
    </div>
  );
}

function Engine(): JSX.Element {
  const [diag, setDiag] = useState<ResponsePayloads["engine.diagnostics"] | null>(null);
  const [copied, setCopied] = useState(false);

  const refresh = async () => {
    try {
      setDiag(await engine.request("engine.diagnostics", {}));
    } catch {
      setDiag(null);
    }
  };

  useEffect(() => {
    void refresh();
  }, []);

  const copyDiagnostics = () => {
    if (!diag) return;
    // Sanitized by construction: versions, worker states, and paths only —
    // never prompts, source code, or credentials.
    const lines = [
      `The Orchestrator ${diag.info.engineVersion}`,
      `OMP ${diag.info.ompVersion} · protocol v${diag.info.protocolVersion}`,
      `${diag.info.platform}/${diag.info.arch} · bun ${diag.info.bunVersion}`,
      `agentDir: ${diag.info.agentDir}`,
      `sessions: ${diag.sessions} (${diag.activeSessions} active)`,
      ...diag.workers.map(
        (w) =>
          `worker ${w.sessionId.slice(0, 8)} pid=${w.pid ?? "?"} state=${w.runState} rss=${
            w.rssBytes ? `${Math.round(w.rssBytes / 1024 / 1024)}MB` : "?"
          } uptime=${w.uptimeMs ? `${Math.round(w.uptimeMs / 1000)}s` : "?"}`,
      ),
      ...(diag.warnings.length ? ["warnings:", ...diag.warnings] : []),
    ];
    void navigator.clipboard.writeText(lines.join("\n"));
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  return (
    <div>
      <h3>Engine</h3>
      {!diag ? (
        <div className="hint">Engine diagnostics unavailable.</div>
      ) : (
        <>
          <table className="usage-table">
            <tbody>
              <tr>
                <td>Engine</td>
                <td className="num mono">{diag.info.engineVersion}</td>
              </tr>
              <tr>
                <td>OMP</td>
                <td className="num mono">{diag.info.ompVersion}</td>
              </tr>
              <tr>
                <td>Protocol</td>
                <td className="num mono">v{diag.info.protocolVersion}</td>
              </tr>
              <tr>
                <td>Architecture</td>
                <td className="num mono">{diag.info.arch}</td>
              </tr>
              <tr>
                <td>Sessions</td>
                <td className="num">
                  {diag.sessions} ({diag.activeSessions} active)
                </td>
              </tr>
              <tr>
                <td>Log file</td>
                <td className="num">
                  <button
                    className="btn btn-ghost"
                    onClick={() => void revealItemInDir(diag.logPath).catch(() => {})}
                  >
                    Reveal
                  </button>
                </td>
              </tr>
            </tbody>
          </table>

          {diag.workers.length > 0 && (
            <>
              <div className="section-label">Workers</div>
              <table className="usage-table">
                <thead>
                  <tr>
                    <th>Session</th>
                    <th className="num">PID</th>
                    <th>State</th>
                    <th className="num">RSS</th>
                  </tr>
                </thead>
                <tbody>
                  {diag.workers.map((w) => (
                    <tr key={w.sessionId}>
                      <td title={w.title}>{w.title.slice(0, 24)}</td>
                      <td className="num mono">{w.pid ?? "—"}</td>
                      <td>{w.runState}</td>
                      <td className="num">
                        {w.rssBytes ? `${Math.round(w.rssBytes / 1024 / 1024)} MB` : "—"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          )}

          <div className="row" style={{ marginTop: 10 }}>
            <button className="btn" onClick={copyDiagnostics}>
              {copied ? "Copied" : "Copy Diagnostics"}
            </button>
            <button className="btn" onClick={() => void refresh()}>
              Refresh
            </button>
            <button className="btn btn-danger" onClick={() => void engine.restart()}>
              Restart Engine
            </button>
          </div>
          <div className="hint" style={{ marginTop: 6 }}>
            Restarting the engine stops all running sessions. Persisted transcripts are kept and can
            be resumed.
          </div>
        </>
      )}
    </div>
  );
}

function About(): JSX.Element {
  const info = useStore((s) => s.engineInfo);
  return (
    <div>
      <h3>About The Orchestrator</h3>
      <p className="hint">
        An unofficial native macOS harness for OhMyPi (OMP). Not affiliated with or endorsed by the
        OMP project. Local-first: no analytics, no telemetry, no cloud backend — network traffic
        goes only to your configured model providers, through OMP.
      </p>
      <table className="usage-table">
        <tbody>
          <tr>
            <td>App</td>
            <td className="num mono">{info?.engineVersion ?? "—"}</td>
          </tr>
          <tr>
            <td>OMP</td>
            <td className="num mono">{info?.ompVersion ?? "—"}</td>
          </tr>
          <tr>
            <td>Protocol</td>
            <td className="num mono">{info ? `v${info.protocolVersion}` : "—"}</td>
          </tr>
          <tr>
            <td>Architecture</td>
            <td className="num mono">{info?.arch ?? "—"}</td>
          </tr>
        </tbody>
      </table>
      <div className="row" style={{ marginTop: 10 }}>
        <button className="btn" onClick={() => void openUrl("https://github.com/can1357/oh-my-pi")}>
          OhMyPi (upstream)
        </button>
      </div>
    </div>
  );
}
