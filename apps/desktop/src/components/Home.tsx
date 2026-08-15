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

export function Home({
  busy,
  disabled,
  onLaunch,
}: {
  busy: boolean;
  disabled?: boolean;
  onLaunch: (config: SessionLaunchConfig, firstMessage: string) => void;
}): JSX.Element {
  const prefs = useStore((s) => s.prefs);
  const updatePrefs = useStore((s) => s.updatePrefs);
  const setNewSession = useStore((s) => s.setNewSession);

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

  const folder = projectPath ? (projectPath.split("/").pop() ?? projectPath) : undefined;
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
                ? `${modelBasename(preset.model)}${preset.thinkingLevel ? ` · ${preset.thinkingLevel}` : ""}${preset.fastMode ? " · fast" : ""}`
                : "OMP decides the model"
            }
            onChange={(e) => updatePrefs({ defaultPreset: e.target.value || undefined })}
          >
            <option value="">OMP default</option>
            {prefs.presets.map((p) => (
              <option key={p.name} value={p.name}>
                {p.name} · {modelBasename(p.model)}
              </option>
            ))}
          </select>

          {/* Project: last-worked first, with the rest one click away. */}
          <div className="home-project-picker" onClick={(e) => e.stopPropagation()}>
            <button
              className="input home-select"
              onClick={() => setProjectMenu((v) => !v)}
              title={projectPath || "Choose a project folder"}
            >
              📁 {folder ?? "Choose folder…"}
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
                    {p.split("/").pop()}
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
      </div>

      <button className="btn btn-ghost home-advanced" onClick={() => setNewSession(true)}>
        New session with advisors & full options…
      </button>
    </div>
  );
}
