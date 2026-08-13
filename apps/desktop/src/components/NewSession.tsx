/**
 * New session sheet.
 *
 * The three decisions that matter — project, primary agent, advisors — are all
 * on one surface. Advisors are prominent, not buried in "advanced".
 *
 * Effort levels come from the SELECTED MODEL's own reported `thinking.efforts`.
 * The UI never invents a level, so a model that reports none simply shows none.
 */
import type { JSX } from "react";
import { useEffect, useMemo, useState } from "react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import type { AdvisorConfig, ModelInfo, SessionLaunchConfig } from "@orchestrator/protocol";

export interface NewSessionProps {
  models: ModelInfo[];
  /** Advisors discovered from the chosen project's WATCHDOG config. */
  discoverAdvisors(projectPath: string): Promise<AdvisorConfig[]>;
  onCancel(): void;
  onCreate(config: SessionLaunchConfig): void;
  busy?: boolean;
  initialProject?: string;
}

export function NewSession({
  models,
  discoverAdvisors,
  onCancel,
  onCreate,
  busy,
  initialProject,
}: NewSessionProps): JSX.Element {
  const [projectPath, setProjectPath] = useState(initialProject ?? "");
  const [title, setTitle] = useState("");
  const [query, setQuery] = useState("");
  const [modelKey, setModelKey] = useState<string>("");
  const [effort, setEffort] = useState<string>("");
  const [advisors, setAdvisors] = useState<AdvisorConfig[]>([]);
  const [advisorsLoading, setAdvisorsLoading] = useState(false);

  // Only authenticated models are offered as ready-to-use; the rest are
  // visibly marked so a session cannot be started against a dead provider.
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const pool = models.filter((m) => (q ? `${m.provider}/${m.name}`.toLowerCase().includes(q) : true));
    pool.sort((a, b) => {
      if (a.authenticated !== b.authenticated) return a.authenticated ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    return pool.slice(0, 300);
  }, [models, query]);

  const selected = models.find((m) => m.key === modelKey);
  const efforts = selected?.thinking?.efforts ?? [];

  // Reset effort whenever the model changes: a level valid for one model is
  // not necessarily offered by another.
  useEffect(() => {
    setEffort((e) => (efforts.includes(e) ? e : ""));
  }, [modelKey]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!projectPath) return;
    let cancelled = false;
    setAdvisorsLoading(true);
    discoverAdvisors(projectPath)
      .then((list) => {
        if (!cancelled) setAdvisors(list);
      })
      .finally(() => {
        if (!cancelled) setAdvisorsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [projectPath, discoverAdvisors]);

  const pickFolder = async () => {
    const dir = await openDialog({ directory: true, multiple: false, title: "Choose a project" });
    if (typeof dir === "string") setProjectPath(dir);
  };

  const submit = () => {
    if (!projectPath) return;
    onCreate({
      projectPath,
      title: title.trim() || undefined,
      model: modelKey || undefined,
      thinkingLevel: effort || undefined,
      advisors,
    });
  };

  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onCancel()}>
      <div className="modal" role="dialog" aria-modal="true" aria-label="New session">
        <div className="modal-head">New Session</div>

        <div className="modal-body">
          <div className="field">
            <label htmlFor="ns-project">Project</label>
            <div style={{ display: "flex", gap: 8 }}>
              <input
                id="ns-project"
                className="input mono"
                value={projectPath}
                placeholder="Choose a folder…"
                onChange={(e) => setProjectPath(e.target.value)}
              />
              <button className="btn" onClick={pickFolder}>
                Browse…
              </button>
            </div>
          </div>

          <div className="field">
            <label htmlFor="ns-title">Title (optional)</label>
            <input
              id="ns-title"
              className="input"
              value={title}
              placeholder="OMP generates one if left blank"
              onChange={(e) => setTitle(e.target.value)}
            />
          </div>

          <div className="field">
            <label htmlFor="ns-model">Primary agent</label>
            <input
              id="ns-model"
              className="input"
              placeholder="Search models…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              style={{ marginBottom: 6 }}
            />
            <select
              className="select"
              size={7}
              value={modelKey}
              onChange={(e) => setModelKey(e.target.value)}
              aria-label="Model"
            >
              <option value="">OMP default</option>
              {filtered.map((m) => (
                <option key={m.key} value={m.key}>
                  {m.authenticated ? "" : "◌ "}
                  {m.name} — {m.provider}
                  {m.authenticated ? "" : " (not connected)"}
                </option>
              ))}
            </select>
            {selected && !selected.authenticated && (
              <div className="hint" style={{ color: "var(--warn)", marginTop: 4 }}>
                No credentials for {selected.provider}. Connect it in OMP first.
              </div>
            )}
          </div>

          {efforts.length > 0 && (
            <div className="field">
              <label htmlFor="ns-effort">Effort</label>
              <select
                id="ns-effort"
                className="select"
                value={effort}
                onChange={(e) => setEffort(e.target.value)}
              >
                <option value="">Model default</option>
                {efforts.map((lv) => (
                  <option key={lv} value={lv}>
                    {lv}
                  </option>
                ))}
              </select>
            </div>
          )}

          <div className="field">
            <label>Advisors</label>
            {!projectPath && <div className="hint">Choose a project to see its advisors.</div>}
            {projectPath && advisorsLoading && <div className="hint">Reading WATCHDOG configuration…</div>}
            {projectPath && !advisorsLoading && advisors.length === 0 && (
              <div className="hint">
                No advisors configured for this project. OMP reads WATCHDOG.yml / WATCHDOG.yaml.
              </div>
            )}
            {advisors.map((a, i) => (
              <div className="advisor-pick" key={a.id}>
                <input
                  type="checkbox"
                  checked={a.enabled}
                  aria-label={`Enable ${a.name}`}
                  onChange={(e) => {
                    const next = [...advisors];
                    next[i] = { ...a, enabled: e.target.checked };
                    setAdvisors(next);
                  }}
                />
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontWeight: 600, fontSize: 12 }}>{a.name}</div>
                  <div className="hint">
                    {a.model ?? "OMP default model"}
                    {a.thinkingLevel ? ` · ${a.thinkingLevel}` : ""}
                  </div>
                </div>
              </div>
            ))}
            {advisors.length > 0 && (
              <div className="hint" style={{ marginTop: 6 }}>
                Changes here apply to this session only. Your WATCHDOG file is not modified.
              </div>
            )}
          </div>
        </div>

        <div className="modal-foot">
          <button className="btn" onClick={onCancel}>
            Cancel
          </button>
          <button className="btn btn-primary" disabled={!projectPath || busy} onClick={submit}>
            {busy ? "Starting…" : "Start Session"}
          </button>
        </div>
      </div>
    </div>
  );
}
