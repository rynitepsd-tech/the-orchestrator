/**
 * Home — the no-session-selected opening screen.
 *
 * One big question ("What should we build in <project>?") over a launch
 * composer: type, hit Enter, and a session is created with your default
 * preset and last-worked folder already selected. Both are changeable inline;
 * the preset choice persists as the new default. "New Session" still opens
 * the full sheet for advisor surgery.
 */

import type { SessionLaunchConfig } from "@orchestrator/protocol";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import type { JSX } from "react";
import { useMemo, useRef, useState } from "react";
import type { SessionPreset } from "../lib/prefs";
import { modelBasename, useStore } from "../store";
import { FolderIcon } from "./icons";
import { PresetForm } from "./PresetForm";

export function Home({
  busy,
  disabled,
  onLaunch,
}: {
  busy: boolean;
  disabled?: boolean;
  onLaunch: (config: SessionLaunchConfig, firstMessage: string, presetName?: string) => void;
}): JSX.Element {
  const prefs = useStore((s) => s.prefs);
  const updatePrefs = useStore((s) => s.updatePrefs);
  const setNewSession = useStore((s) => s.setNewSession);
  const addPreset = useStore((s) => s.addPreset);
  const models = useStore((s) => s.models);
  const [presetDraft, setPresetDraft] = useState(false);

  // Last-worked folder first: recents are unshifted on every project open.
  const projects = useMemo(
    () => [...new Set([...prefs.recentProjects, ...prefs.pinnedProjects])],
    [prefs.recentProjects, prefs.pinnedProjects],
  );
  const [projectPath, setProjectPath] = useState(projects[0] ?? "");
  const [projectMenu, setProjectMenu] = useState(false);
  const [text, setText] = useState("");
  const taRef = useRef<HTMLTextAreaElement>(null);

  const preset: SessionPreset | undefined =
    prefs.presets.find((p) => p.name === prefs.defaultPreset) ?? prefs.presets[0];

  const alias = (p: string) => prefs.projectAliases[p] ?? (p.split("/").pop() || p);
  const folder = projectPath ? alias(projectPath) : undefined;
  const canLaunch = Boolean(text.trim() && projectPath && !busy && !disabled);

  const launch = () => {
    if (!canLaunch) return;
    onLaunch(
      {
        projectPath,
        model: preset?.model,
        thinkingLevel: preset?.thinkingLevel,
        fastMode: preset?.fastMode || undefined,
        advisors: preset?.advisors ?? [],
      },
      text.trim(),
      preset?.name,
    );
    setText("");
  };

  const pickFolder = () => {
    void openDialog({ directory: true, multiple: false }).then((p) => {
      if (typeof p === "string") {
        setProjectPath(p);
        setProjectMenu(false);
      }
    });
  };

  return (
    <div className="home" onClick={() => setProjectMenu(false)}>
      <h1 className="home-title">
        What should we build{folder ? " in " : "?"}
        {folder && (
          <>
            <span className="home-project">{folder}</span>?
          </>
        )}
      </h1>

      <div className="home-composer">
        <textarea
          ref={taRef}
          className="home-input"
          placeholder="Describe a task to start a session…"
          value={text}
          rows={Math.min(8, Math.max(2, text.split("\n").length))}
          autoFocus
          disabled={disabled}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              launch();
            }
          }}
        />
        <div className="home-controls">
          {/* Preset: the launch contract, changeable and sticky. */}
          <select
            className="input home-select"
            value={preset?.name ?? ""}
            title={
              preset
                ? `${modelBasename(preset.model)}${preset.thinkingLevel ? ` · ${preset.thinkingLevel}` : ""}${preset.fastMode ? " · fast" : ""}${(() => {
                    const on = preset.advisors.filter((a) => a.enabled);
                    return on.length
                      ? ` · advisors: ${on.map((a) => a.name).join(", ")}`
                      : " · no advisors";
                  })()}`
                : "Create a preset to choose a model and advisors"
            }
            onChange={(e) => {
              if (e.target.value === "__new") {
                setPresetDraft(true);
                return;
              }
              updatePrefs({ defaultPreset: e.target.value || undefined });
            }}
          >
            {prefs.presets.length === 0 && (
              <option value="" disabled>
                No presets yet
              </option>
            )}
            {prefs.presets.map((p) => (
              <option key={p.name} value={p.name}>
                {p.name} · {modelBasename(p.model)}
              </option>
            ))}
            <option value="__new">＋ New preset…</option>
          </select>

          {/* Project: last-worked first, with the rest one click away. */}
          <div className="home-project-picker" onClick={(e) => e.stopPropagation()}>
            <button
              className="input home-select"
              onClick={() => setProjectMenu((v) => !v)}
              title={projectPath || "Choose a project folder"}
            >
              <FolderIcon /> {folder ?? "Choose folder…"}
            </button>
            {projectMenu && (
              <div className="home-project-menu">
                {projects.map((p) => (
                  <button
                    key={p}
                    className={`menu-item home-menu-item${p === projectPath ? " selected" : ""}`}
                    title={p}
                    onClick={() => {
                      setProjectPath(p);
                      setProjectMenu(false);
                    }}
                  >
                    {alias(p)}
                    <span className="hint home-menu-path">{p}</span>
                  </button>
                ))}
                <hr />
                <button className="menu-item" onClick={pickFolder}>
                  Browse…
                </button>
              </div>
            )}
          </div>

          <span className="spacer" />
          <button
            className="btn btn-primary home-go"
            disabled={!canLaunch}
            onClick={launch}
            title="Enter"
          >
            {busy ? "Starting…" : "↑"}
          </button>
        </div>

        {/* Say what the preset launches with — advisors were invisible here. */}
        {preset && (
          <div className="hint home-preset-hint">
            {(() => {
              const on = preset.advisors.filter((a) => a.enabled);
              return on.length
                ? `Starts with advisor${on.length === 1 ? "" : "s"}: ${on.map((a) => a.name).join(", ")}`
                : "Starts with no advisors";
            })()}
          </div>
        )}
      </div>

      <button className="btn btn-ghost home-advanced" onClick={() => setNewSession(true)}>
        New session with advisors & full options…
      </button>

      {presetDraft && (
        <div className="modal-backdrop" onMouseDown={() => setPresetDraft(false)}>
          <div
            className="modal preset-dialog"
            onMouseDown={(e) => e.stopPropagation()}
            role="dialog"
            aria-label="New preset"
            onKeyDown={(e) => e.key === "Escape" && setPresetDraft(false)}
          >
            <div className="modal-head">
              <strong>New preset</strong>
            </div>
            <div className="modal-body">
              <PresetForm
                models={models}
                onSave={(p) => {
                  addPreset(p);
                  updatePrefs({ defaultPreset: p.name });
                  setPresetDraft(false);
                }}
                onCancel={() => setPresetDraft(false)}
              />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
