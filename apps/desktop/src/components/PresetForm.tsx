/**
 * Preset editor — shared by first-run setup and Settings → Presets.
 *
 * A preset is a launch template: primary model + effort + a set of advisors.
 * Presets are Orchestrator-local; they never write OMP configuration.
 */

import type { AdvisorConfig, ModelInfo } from "@orchestrator/protocol";
import type { JSX } from "react";
import { useState } from "react";
import type { SessionPreset } from "../lib/prefs";
import { EffortPicker } from "./EffortPicker";
import { ModelPicker } from "./ModelPicker";

export const RECOMMENDED_ADVISORS: AdvisorConfig[] = [
  {
    id: "advisor:Reviewer",
    name: "Reviewer",
    enabled: true,
    origin: "session",
    instructions: "Watch for bugs, regressions, and risky changes. Flag blockers early.",
  },
  {
    id: "advisor:Architect",
    name: "Architect",
    enabled: true,
    origin: "session",
    instructions: "Watch the overall approach: simplicity, structure, and scope creep.",
  },
];

export function PresetForm({
  models,
  initial,
  saveLabel,
  onSave,
  onCancel,
}: {
  models: ModelInfo[];
  initial?: SessionPreset;
  saveLabel?: string;
  onSave: (p: SessionPreset) => void;
  onCancel?: () => void;
}): JSX.Element {
  const [name, setName] = useState(initial?.name ?? "");
  const [model, setModel] = useState<string | undefined>(initial?.model);
  const [effort, setEffort] = useState(initial?.thinkingLevel ?? "");
  const [fastMode, setFastMode] = useState(Boolean(initial?.fastMode));
  const [advisors, setAdvisors] = useState<AdvisorConfig[]>(
    initial?.advisors.map((a) => ({ ...a })) ?? RECOMMENDED_ADVISORS.map((a) => ({ ...a })),
  );

  const selectedModel = model ? models.find((m) => m.key === model) : undefined;
  const efforts = selectedModel?.thinking?.efforts ?? [];

  const patchAdvisor = (idx: number, patch: Partial<AdvisorConfig>) => {
    setAdvisors((list) =>
      list.map((a, i) =>
        i === idx
          ? {
              ...a,
              ...patch,
              // Keep the derived id in sync when the name changes.
              id: patch.name !== undefined ? `advisor:${patch.name}` : a.id,
            }
          : a,
      ),
    );
  };

  const save = () => {
    const trimmed = name.trim();
    if (!trimmed) return;
    onSave({
      name: trimmed,
      model,
      thinkingLevel: effort || undefined,
      fastMode: fastMode || undefined,
      advisors: advisors
        .filter((a) => a.name.trim())
        .map((a) => ({ ...a, name: a.name.trim(), id: `advisor:${a.name.trim()}` })),
    });
  };

  return (
    <div>
      <label className="field">
        <span>Preset name</span>
        <input
          className="input"
          value={name}
          placeholder="e.g. Deep work"
          onChange={(e) => setName(e.target.value)}
        />
      </label>

      <div className="field">
        <span>Primary model</span>
        <ModelPicker
          models={models}
          value={model}
          onChange={(k) => {
            setModel(k);
            setEffort("");
          }}
        />
      </div>

      {efforts.length > 0 && (
        <div className="field">
          <span>Effort</span>
          <EffortPicker efforts={efforts} value={effort} onChange={setEffort} />
        </div>
      )}

      <label className="row check-row">
        <input type="checkbox" checked={fastMode} onChange={(e) => setFastMode(e.target.checked)} />
        <span>⚡ Fast mode</span>
        <span className="hint">priority tier on OpenAI / Anthropic</span>
      </label>

      <div className="field">
        <div className="row">
          <span>Advisors</span>
          <span className="spacer" />
          <button
            className="btn btn-ghost"
            onClick={() =>
              setAdvisors((list) => [
                ...list,
                {
                  id: `advisor:Advisor ${list.length + 1}`,
                  name: `Advisor ${list.length + 1}`,
                  enabled: true,
                  origin: "session",
                },
              ])
            }
          >
            + Add advisor
          </button>
        </div>
        <div className="advisor-list">
          {advisors.map((a, i) => {
            const advisorModel = a.model ? models.find((m) => m.key === a.model) : undefined;
            const advisorEfforts = advisorModel?.thinking?.efforts ?? [];
            return (
              <div key={i} className="advisor-row">
                <div className="row">
                  <input
                    type="checkbox"
                    checked={a.enabled}
                    title="Enabled"
                    onChange={(e) => patchAdvisor(i, { enabled: e.target.checked })}
                  />
                  <input
                    className="input"
                    style={{ width: 150 }}
                    value={a.name}
                    placeholder="Advisor name"
                    onChange={(e) => patchAdvisor(i, { name: e.target.value })}
                  />
                  <div style={{ flex: 1 }}>
                    <ModelPicker
                      models={models}
                      value={a.model}
                      onChange={(k) => patchAdvisor(i, { model: k, thinkingLevel: undefined })}
                    />
                  </div>
                  <button
                    className="btn btn-ghost"
                    title="Remove advisor"
                    onClick={() => setAdvisors((list) => list.filter((_, j) => j !== i))}
                  >
                    ×
                  </button>
                </div>
                {advisorEfforts.length > 0 && (
                  <div className="row" style={{ marginTop: 6 }}>
                    <span className="hint" style={{ width: 150, flex: "none" }}>
                      Effort
                    </span>
                    <div style={{ flex: 1 }}>
                      <EffortPicker
                        efforts={advisorEfforts}
                        value={a.thinkingLevel ?? ""}
                        onChange={(lvl) => patchAdvisor(i, { thinkingLevel: lvl || undefined })}
                      />
                    </div>
                  </div>
                )}
                <textarea
                  className="input"
                  rows={2}
                  style={{ marginTop: 6 }}
                  value={a.instructions ?? ""}
                  placeholder="What should this advisor watch for?"
                  onChange={(e) => patchAdvisor(i, { instructions: e.target.value || undefined })}
                />
              </div>
            );
          })}
          {advisors.length === 0 && (
            <div className="hint">No advisors — the primary agent runs alone.</div>
          )}
        </div>
      </div>

      <div className="row modal-actions">
        <span className="spacer" />
        {onCancel && (
          <button className="btn" onClick={onCancel}>
            Cancel
          </button>
        )}
        <button className="btn btn-primary" disabled={!name.trim()} onClick={save}>
          {saveLabel ?? "Save preset"}
        </button>
      </div>
    </div>
  );
}
