/**
 * First-run setup.
 *
 * Three real steps: connect providers, create a default preset (primary model
 * + two advisors), optionally add a second preset. Everything it writes is
 * Orchestrator-local (prefs); skipping is always allowed and presets can be
 * managed later in Settings → Presets.
 */

import type { JSX } from "react";
import { useState } from "react";
import { useStore } from "../store";
import { PresetForm, RECOMMENDED_ADVISORS } from "./PresetForm";
import { Providers } from "./Settings";

const STEPS = 5;

export function Onboarding(): JSX.Element {
  const models = useStore((s) => s.models);
  const prefs = useStore((s) => s.prefs);
  const addPreset = useStore((s) => s.addPreset);
  const updatePrefs = useStore((s) => s.updatePrefs);
  const engineStage = useStore((s) => s.engineStage);
  const engineInfo = useStore((s) => s.engineInfo);

  const [step, setStep] = useState(0);
  // Forces a fresh PresetForm when the user adds "one more" preset.
  const [formGen, setFormGen] = useState(0);

  const finish = () => updatePrefs({ setupComplete: true });

  return (
    <div className="modal-backdrop">
      <div className="modal onboarding" role="dialog" aria-label="Setup">
        <div className="onboarding-steps">
          {Array.from({ length: STEPS }, (_, i) => (
            <span key={i} className={`onboarding-step-dot${i <= step ? " done" : ""}`} />
          ))}
        </div>

        {step === 0 && (
          <>
            <h2>Welcome to The Orchestrator</h2>
            <p className="lead">
              Run several OMP agent sessions side by side — each with a primary model and a bench of
              advisor models reviewing its work. This short setup connects your agents and creates
              your session presets.
            </p>
            <div className="row" style={{ marginBottom: 14 }}>
              <span
                className={`dot ${engineStage === "ready" ? "done" : engineStage === "offline" ? "error" : "active"}`}
              />
              <span className="hint">
                {engineStage === "ready"
                  ? `Engine ready · OMP ${engineInfo?.ompVersion ?? ""}`
                  : engineStage === "offline"
                    ? "Engine offline — you can still finish setup."
                    : "Starting the OMP engine…"}
              </span>
            </div>
            <div className="row">
              <button className="btn btn-ghost" onClick={finish}>
                Skip setup
              </button>
              <span className="spacer" />
              <button className="btn btn-primary" onClick={() => setStep(1)}>
                Get started
              </button>
            </div>
          </>
        )}

        {step === 1 && (
          <>
            <h2>Connect your agents</h2>
            <p className="lead">
              Sign in to the model providers you use. The Orchestrator reuses your OMP credentials —
              if you have run <code>omp</code> before, you may already be connected.
            </p>
            <Providers />
            <div className="row" style={{ marginTop: 14 }}>
              <button className="btn btn-ghost" onClick={() => setStep(0)}>
                Back
              </button>
              <span className="spacer" />
              <button className="btn btn-primary" onClick={() => setStep(2)}>
                Continue
              </button>
            </div>
          </>
        )}

        {step === 2 && (
          <>
            <h2>Create your default preset</h2>
            <p className="lead">
              A preset is a one-click session template: a primary model that does the work, plus
              advisors that review it. Start with a main agent and two advisors — tweak anything.
            </p>
            <PresetForm
              models={models}
              initial={{ name: "Main", advisors: RECOMMENDED_ADVISORS }}
              saveLabel="Save and continue"
              onSave={(p) => {
                addPreset(p);
                setStep(3);
              }}
            />
            <div className="row" style={{ marginTop: 6 }}>
              <button className="btn btn-ghost" onClick={() => setStep(1)}>
                Back
              </button>
              <span className="spacer" />
              <button className="btn btn-ghost" onClick={() => setStep(3)}>
                Skip
              </button>
            </div>
          </>
        )}

        {step === 3 && (
          <>
            <h2>Add a second preset</h2>
            <p className="lead">
              We recommend keeping two presets — say, a heavyweight one for deep work and a fast,
              cheap one for quick questions. You can add as many as you like.
            </p>
            <PresetForm
              key={formGen}
              models={models}
              initial={{ name: formGen === 0 ? "Quick" : "", advisors: [] }}
              saveLabel="Save preset"
              onSave={(p) => {
                addPreset(p);
                setFormGen((g) => g + 1);
              }}
            />
            {prefs.presets.length > 0 && (
              <div className="hint" style={{ marginTop: 4 }}>
                Saved so far: {prefs.presets.map((p) => p.name).join(", ")}
              </div>
            )}
            <div className="row" style={{ marginTop: 10 }}>
              <button className="btn btn-ghost" onClick={() => setStep(2)}>
                Back
              </button>
              <span className="spacer" />
              <button className="btn btn-primary" onClick={() => setStep(4)}>
                Continue
              </button>
            </div>
          </>
        )}

        {step === 4 && (
          <>
            <h2>You're set</h2>
            <p className="lead">
              {prefs.presets.length > 0
                ? `Presets ready: ${prefs.presets.map((p) => p.name).join(", ")}. `
                : "No presets yet — you can create them any time. "}
              Manage presets and providers later in Settings (⌘,), and start a session with ⌘N.
            </p>
            <div className="row">
              <span className="spacer" />
              <button className="btn btn-primary" onClick={finish}>
                Start using The Orchestrator
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
