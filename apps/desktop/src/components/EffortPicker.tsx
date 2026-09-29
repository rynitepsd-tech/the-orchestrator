/**
 * Reasoning-effort picker.
 *
 * Same interaction contract as the model picker: a quiet collapsed row stating
 * the current choice, the segmented control only while actively choosing, and
 * it gets out of the way again the moment a level is picked.
 *
 * Levels come verbatim from the model (`thinking.efforts`), so new tiers such
 * as `xhigh` or `max` appear without code changes. "auto" is OMP's own mode:
 * it picks an effort every turn from how open-ended the request is, and the
 * level it chose is shown next to it once known.
 */

import type { JSX } from "react";
import { useState } from "react";

/** OMP's per-turn automatic effort selector. */
export const AUTO_EFFORT = "auto";

/** "auto · high" once auto has resolved a level, else the plain level name. */
export function effortLabel(level: string | undefined, resolved?: string): string {
  if (!level) return "default";
  if (level === AUTO_EFFORT && resolved) return `auto · ${resolved}`;
  return level;
}

export function EffortPicker({
  efforts,
  value,
  resolved,
  onChange,
}: {
  efforts: string[];
  /** Current level; empty string means the model's default. */
  value: string;
  /** The level "auto" resolved to for the latest turn, when known. */
  resolved?: string;
  onChange: (level: string) => void;
}): JSX.Element | null {
  const [expanded, setExpanded] = useState(false);
  if (efforts.length === 0) return null;
  // Auto only makes sense for a model with a ladder to choose from.
  const levels = efforts.includes(AUTO_EFFORT) ? efforts : [AUTO_EFFORT, ...efforts];

  if (!expanded) {
    return (
      <button
        type="button"
        className="model-picker-collapsed"
        onClick={() => setExpanded(true)}
        aria-label="Change reasoning effort"
      >
        <span className="model-name">{effortLabel(value, resolved)}</span>
        <span className="hint">
          {value === AUTO_EFFORT ? "OMP picks the effort each turn" : "reasoning effort"}
        </span>
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
      <button type="button" className={`seg${value === "" ? " on" : ""}`} onClick={() => pick("")}>
        default
      </button>
      {levels.map((lvl) => (
        <button
          type="button"
          key={lvl}
          className={`seg${value === lvl ? " on" : ""}`}
          title={
            lvl === AUTO_EFFORT
              ? "OMP picks an effort each turn from how open-ended the request is"
              : undefined
          }
          onClick={() => pick(lvl)}
        >
          {lvl}
        </button>
      ))}
    </div>
  );
}
