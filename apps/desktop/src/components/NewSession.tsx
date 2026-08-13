/**
 * New-session sheet: project → primary model → effort → advisors → go.
 *
 * Advisors come from OMP's own WATCHDOG discovery for the chosen project and
 * can be overridden per session (model, effort, enable) or extended with a
 * session-only custom advisor. Session overrides never write config files —
 * the note in the panel says so because it is true.
 */

import type { AdvisorConfig, ModelInfo, SessionLaunchConfig } from "@orchestrator/protocol";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import type { JSX } from "react";
import { useEffect, useMemo, useState } from "react";
import type { SessionPreset } from "../lib/prefs";
import { useStore } from "../store";
import { ModelPicker } from "./ModelPicker";

export function NewSession({
  models,
  discoverAdvisors,
  busy,
  onCancel,
  onCreate,
}: {
  models: ModelInfo[];
  discoverAdvisors: (projectPath: string) => Promise<AdvisorConfig[]>;
  busy: boolean;
  onCancel: () => void;
  onCreate: (config: SessionLaunchConfig) => void;
}): JSX.Element {
  const prefs = useStore((s) => s.prefs);
  const addPreset = useStore((s) => s.addPreset);
  const removePreset = useStore((s) => s.removePreset);
  const updatePrefs = useStore((s) => s.updatePrefs);

  const [projectPath, setProjectPath] = useState(prefs.recentProjects[0] ?? "");
  const [title, setTitle] = useState("");
  const [modelKey, setModelKey] = useState<string | undefined>(undefined);
  const [effort, setEffort] = useState<string>("");
  const [advisors, setAdvisors] = useState<AdvisorConfig[]>([]);
  const [advisorsLoading, setAdvisorsLoading] = useState(false);
  const [advisorsSource, setAdvisorsSource] = useState<"project" | "session">("project");
  const [editingAdvisor, setEditingAdvisor] = useState<string | null>(null);

  const selectedModel = modelKey ? models.find((m) => m.key === modelKey) : undefined;
  const efforts = selectedModel?.thinking?.efforts ?? [];

  useEffect(() => {
    setEffort("");
  }, [modelKey]);

  useEffect(() => {
    if (!projectPath.trim()) {
      setAdvisors([]);
      return;
    }
    let cancelled = false;
    setAdvisorsLoading(true);
    void discoverAdvisors(projectPath.trim()).then((list) => {
      if (!cancelled) {
        setAdvisors(list);
        setAdvisorsSource("project");
        setAdvisorsLoading(false);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [projectPath, discoverAdvisors]);

  const canStart = projectPath.trim().length > 0 && !busy;

  const start = () => {
    if (!canStart) return;
    if (modelKey) {
      updatePrefs({
        recentModels: [modelKey, ...prefs.recentModels.filter((k) => k !== modelKey)].slice(0, 10),
      });
    }
    onCreate({
      projectPath: projectPath.trim(),
      title: title.trim() || undefined,
      model: modelKey,
      thinkingLevel: effort || undefined,
      advisors,
    });
  };

  const applyPreset = (p: SessionPreset) => {
    setModelKey(p.model);
    setEffort(p.thinkingLevel ?? "");
    if (p.advisors.length) {
      setAdvisors(p.advisors.map((a) => ({ ...a })));
      setAdvisorsSource("session");
    }
  };

  const saveAsPreset = () => {
    const name = prompt("Preset name");
    if (!name?.trim()) return;
    addPreset({
      name: name.trim(),
      model: modelKey,
      thinkingLevel: effort || undefined,
      advisors,
    });
  };

  const patchAdvisor = (id: string, patch: Partial<AdvisorConfig>) => {
    setAdvisors((list) =>
      list.map((a) => (a.id === id ? { ...a, ...patch, origin: "session" } : a)),
    );
    setAdvisorsSource("session");
  };

  const addCustomAdvisor = () => {
    const name = prompt("Advisor name (session only)");
    if (!name?.trim()) return;
    const id = `advisor:${name.trim()}`;
    if (advisors.some((a) => a.id === id)) return;
    setAdvisors((list) => [...list, { id, name: name.trim(), enabled: true, origin: "session" }]);
    setAdvisorsSource("session");
    setEditingAdvisor(id);
  };

  const recentProjects = useMemo(
    () =>
      [...new Set([...prefs.pinnedProjects, ...prefs.recentProjects])].filter(
        (p) => p !== projectPath,
      ),
    [prefs.pinnedProjects, prefs.recentProjects, projectPath],
  );

  return (
    <div className="modal-backdrop" onMouseDown={onCancel}>
      <div
        className="modal new-session"
        onMouseDown={(e) => e.stopPropagation()}
        role="dialog"
        aria-label="New session"
        onKeyDown={(e) => {
          if (e.key === "Escape") onCancel();
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) start();
        }}
      >
        <h2>New Session</h2>

        {prefs.presets.length > 0 && (
          <div className="preset-row">
            {prefs.presets.map((p) => (
              <span key={p.name} className="preset-chip">
                <button
                  className="preset-use"
                  onClick={() => applyPreset(p)}
                  title={presetTitle(p)}
                >
                  {p.name}
                </button>
                <button
                  className="preset-del"
                  title="Delete preset"
                  onClick={() => removePreset(p.name)}
                >
                  ×
                </button>
              </span>
            ))}
          </div>
        )}

        <label className="field">
          <span>Project</span>
          <div className="row">
            <input
              className="input"
              value={projectPath}
              onChange={(e) => setProjectPath(e.target.value)}
              placeholder="/path/to/project"
              spellCheck={false}
            />
            <button
              className="btn"
              onClick={() =>
                void openDialog({ directory: true, multiple: false }).then((p) => {
                  if (typeof p === "string") setProjectPath(p);
                })
              }
            >
              Browse…
            </button>
          </div>
          {recentProjects.length > 0 && (
            <div className="recent-projects">
              {recentProjects.slice(0, 6).map((p) => (
                <button
                  key={p}
                  className="chip chip-btn"
                  title={p}
                  onClick={() => setProjectPath(p)}
                >
                  {p.split("/").pop()}
                </button>
              ))}
            </div>
          )}
        </label>

        <label className="field">
          <span>Session title (optional)</span>
          <input
            className="input"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="OMP generates one if left blank"
          />
        </label>

        <div className="field">
          <span>Primary model</span>
          <ModelPicker models={models} value={modelKey} onChange={(k) => setModelKey(k)} />
        </div>

        {efforts.length > 0 && (
          <label className="field">
            <span>Effort</span>
            <div className="segmented">
              <button className={`seg${effort === "" ? " on" : ""}`} onClick={() => setEffort("")}>
                default
              </button>
              {efforts.map((lvl) => (
                <button
                  key={lvl}
                  className={`seg${effort === lvl ? " on" : ""}`}
                  onClick={() => setEffort(lvl)}
                >
                  {lvl}
                </button>
              ))}
            </div>
          </label>
        )}

        <div className="field">
          <div className="row">
            <span>Advisors</span>
            <span className="hint">
              {advisorsSource === "session" ? "Session override" : "Project default"}
            </span>
            <span className="spacer" />
            <button className="btn btn-ghost" onClick={addCustomAdvisor}>
              + Add advisor
            </button>
          </div>

          {!projectPath.trim() ? (
            <div className="hint">Choose a project to discover its advisors.</div>
          ) : advisorsLoading ? (
            <div className="hint">Reading WATCHDOG configuration…</div>
          ) : advisors.length === 0 ? (
            <div className="hint">
              No advisors configured for this project. Add a session advisor above if you want one.
            </div>
          ) : (
            <div className="advisor-list">
              {advisors.map((a) => (
                <div key={a.id} className="advisor-row">
                  <label className="row">
                    <input
                      type="checkbox"
                      checked={a.enabled}
                      onChange={(e) => patchAdvisor(a.id, { enabled: e.target.checked })}
                    />
                    <span className="advisor-row-name">{a.name}</span>
                    <span className="hint">
                      {a.model ?? "OMP default model"}
                      {a.thinkingLevel && ` · ${a.thinkingLevel}`}
                      {a.origin === "session" && " · session"}
                    </span>
                    <span className="spacer" />
                    <button
                      className="btn btn-ghost"
                      onClick={() => setEditingAdvisor(editingAdvisor === a.id ? null : a.id)}
                    >
                      {editingAdvisor === a.id ? "Done" : "Configure"}
                    </button>
                  </label>
                  {editingAdvisor === a.id && (
                    <AdvisorEditor
                      advisor={a}
                      models={models}
                      onPatch={(patch) => patchAdvisor(a.id, patch)}
                      onRemove={
                        a.origin === "session"
                          ? () => {
                              setAdvisors((list) => list.filter((x) => x.id !== a.id));
                              setEditingAdvisor(null);
                            }
                          : undefined
                      }
                    />
                  )}
                </div>
              ))}
            </div>
          )}
          <div className="hint">
            Changes here apply to this session only. Your WATCHDOG file is not modified.
          </div>
        </div>

        <div className="row modal-actions">
          <button className="btn btn-ghost" onClick={saveAsPreset}>
            Save as preset
          </button>
          <span className="spacer" />
          <button className="btn" onClick={onCancel}>
            Cancel
          </button>
          <button className="btn btn-primary" disabled={!canStart} onClick={start}>
            {busy ? "Starting…" : "Start Session"}
          </button>
        </div>
      </div>
    </div>
  );
}

function presetTitle(p: SessionPreset): string {
  const parts = [p.model ?? "OMP default"];
  if (p.thinkingLevel) parts.push(p.thinkingLevel);
  const on = p.advisors.filter((a) => a.enabled).map((a) => a.name);
  if (on.length) parts.push(`advisors: ${on.join(", ")}`);
  return parts.join(" · ");
}

function AdvisorEditor({
  advisor,
  models,
  onPatch,
  onRemove,
}: {
  advisor: AdvisorConfig;
  models: ModelInfo[];
  onPatch: (patch: Partial<AdvisorConfig>) => void;
  onRemove?: () => void;
}): JSX.Element {
  const advisorModel = advisor.model ? models.find((m) => m.key === advisor.model) : undefined;
  const efforts = advisorModel?.thinking?.efforts ?? [];

  return (
    <div className="advisor-editor">
      <label className="field">
        <span>Model</span>
        <ModelPicker
          models={models}
          value={advisor.model}
          onChange={(k) => onPatch({ model: k, thinkingLevel: undefined })}
        />
      </label>
      {efforts.length > 0 && (
        <label className="field">
          <span>Effort</span>
          <div className="segmented">
            <button
              className={`seg${!advisor.thinkingLevel ? " on" : ""}`}
              onClick={() => onPatch({ thinkingLevel: undefined })}
            >
              default
            </button>
            {efforts.map((lvl) => (
              <button
                key={lvl}
                className={`seg${advisor.thinkingLevel === lvl ? " on" : ""}`}
                onClick={() => onPatch({ thinkingLevel: lvl })}
              >
                {lvl}
              </button>
            ))}
          </div>
        </label>
      )}
      <label className="field">
        <span>Instructions {advisor.origin !== "session" && "(session override)"}</span>
        <textarea
          className="input"
          rows={3}
          value={advisor.instructions ?? ""}
          placeholder="What should this advisor watch for?"
          onChange={(e) => onPatch({ instructions: e.target.value || undefined })}
        />
      </label>
      {onRemove && (
        <button className="btn btn-danger" onClick={onRemove}>
          Remove advisor
        </button>
      )}
    </div>
  );
}
