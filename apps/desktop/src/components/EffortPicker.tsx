/**
 * Reasoning-effort picker.
 *
 * Same interaction contract as the model picker: a quiet collapsed row stating
 * the current choice, the segmented control only while actively choosing, and
 * it gets out of the way again the moment a level is picked.
 */

import type { JSX } from "react";
import { useState } from "react";

export function EffortPicker({
  efforts,
  value,
  onChange,
}: {
  efforts: string[];
  /** Current level; empty string means the model's default. */
  value: string;
  onChange: (level: string) => void;
}): JSX.Element | null {
  const [expanded, setExpanded] = useState(false);
  if (efforts.length === 0) return null;

  if (!expanded) {
    return (
      <button
        type="button"
        className="model-picker-collapsed"
        onClick={() => setExpanded(true)}
        aria-label="Change reasoning effort"
      >
        <span className="model-name">{value || "default"}</span>
        <span className="hint">reasoning effort</span>
        <span className="spacer" />
        <span className="chevron">▼</span>
      </button>
    );
  }

  const pick = (level: string) => {
    onChange(level);
    setExpanded(false);
  };

  return (
    <div className="segmented">
      <button className={`seg${value === "" ? " on" : ""}`} onClick={() => pick("")}>
        default
      </button>
      {efforts.map((lvl) => (
        <button key={lvl} className={`seg${value === lvl ? " on" : ""}`} onClick={() => pick(lvl)}>
          {lvl}
        </button>
      ))}
    </div>
  );
}
