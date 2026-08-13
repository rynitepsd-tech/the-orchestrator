/**
 * Model picker.
 *
 * A 4,000-model registry is unusable as a flat list. Ordering: favourites,
 * recents, then authenticated providers' models; unauthenticated models hide
 * behind "Show all models". Search always spans everything. Favouriting is
 * Orchestrator-local metadata — OMP's model configuration is never written.
 */

import type { ModelInfo } from "@orchestrator/protocol";
import type { JSX } from "react";
import { useMemo, useRef, useState } from "react";
import { useStore } from "../store";

const PAGE = 60;

export function ModelPicker({
  models,
  value,
  onChange,
  autoFocus,
  startExpanded,
}: {
  models: ModelInfo[];
  value?: string;
  onChange: (key: string | undefined, model?: ModelInfo) => void;
  autoFocus?: boolean;
  /** Open the search list immediately instead of the collapsed summary row. */
  startExpanded?: boolean;
}): JSX.Element {
  const prefs = useStore((s) => s.prefs);
  const updatePrefs = useStore((s) => s.updatePrefs);
  const [query, setQuery] = useState("");
  const [showAll, setShowAll] = useState(false);
  const [limit, setLimit] = useState(PAGE);
  const [expanded, setExpanded] = useState(Boolean(startExpanded));
  const listRef = useRef<HTMLDivElement>(null);

  const q = query.trim().toLowerCase();
  const favs = new Set(prefs.favoriteModels);
  const recents = prefs.recentModels;

  const ranked = useMemo(() => {
    const rank = (m: ModelInfo): number => {
      if (favs.has(m.key)) return 0;
      const r = recents.indexOf(m.key);
      if (r >= 0) return 1 + r / 100;
      if (m.authenticated) return 2;
      return 3;
    };
    let list = models;
    if (q) {
      list = list.filter(
        (m) =>
          m.key.toLowerCase().includes(q) ||
          m.name.toLowerCase().includes(q) ||
          m.provider.toLowerCase().includes(q),
      );
    } else if (!showAll) {
      list = list.filter((m) => m.authenticated || favs.has(m.key));
    }
    return [...list].sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
  }, [models, q, showAll, prefs.favoriteModels, prefs.recentModels]);

  const hiddenCount = models.length - ranked.length;
  const shown = ranked.slice(0, limit);
  const selected = value ? models.find((m) => m.key === value) : undefined;

  const toggleFav = (key: string) => {
    updatePrefs({
      favoriteModels: favs.has(key)
        ? prefs.favoriteModels.filter((k) => k !== key)
        : [...prefs.favoriteModels, key],
    });
  };

  const pick = (key: string | undefined, model?: ModelInfo) => {
    onChange(key, model);
    // The choice is made — get the list out of the way.
    setExpanded(false);
    setQuery("");
  };

  // Collapsed: one quiet row stating the current choice; click to change.
  if (!expanded) {
    return (
      <button
        type="button"
        className="model-picker-collapsed"
        onClick={() => setExpanded(true)}
        aria-label="Change model"
      >
        <span className="model-name">{selected ? selected.name : "OMP default model"}</span>
        <span className="hint">
          {selected
            ? `${selected.provider}${selected.authenticated ? "" : " · not connected"}`
            : "whatever your OMP config resolves"}
        </span>
        <span className="spacer" />
        <span className="chevron">▼</span>
      </button>
    );
  }

  return (
    <div className="model-picker">
      <input
        className="input"
        placeholder="Search models…"
        value={query}
        onChange={(e) => {
          setQuery(e.target.value);
          setLimit(PAGE);
        }}
        autoFocus={autoFocus || !startExpanded}
        aria-label="Search models"
      />
      <div
        className="model-list"
        ref={listRef}
        onScroll={() => {
          const el = listRef.current;
          if (
            el &&
            el.scrollHeight - el.scrollTop - el.clientHeight < 200 &&
            limit < ranked.length
          ) {
            setLimit((n) => n + PAGE);
          }
        }}
      >
        <button className={`model-row${!value ? " selected" : ""}`} onClick={() => pick(undefined)}>
          <span className="model-name">OMP default model</span>
          <span className="hint">whatever your OMP config resolves</span>
        </button>
        {shown.map((m) => (
          <div key={m.key} className={`model-row${m.key === value ? " selected" : ""}`}>
            <button className="model-main" onClick={() => pick(m.key, m)}>
              <span className="model-name">
                {m.name}
                {!m.authenticated && <span className="hint"> · not connected</span>}
              </span>
              <span className="hint">
                {m.provider}
                {m.contextWindow > 0 && ` · ${Math.round(m.contextWindow / 1000)}k ctx`}
                {m.thinking && ` · ${m.thinking.efforts.length} effort levels`}
              </span>
            </button>
            <button
              className={`fav-btn${favs.has(m.key) ? " on" : ""}`}
              title={favs.has(m.key) ? "Remove favourite" : "Favourite"}
              onClick={() => toggleFav(m.key)}
            >
              ★
            </button>
          </div>
        ))}
        {shown.length === 0 && <div className="empty">No models match.</div>}
        {!q && !showAll && hiddenCount > 0 && (
          <button className="btn btn-ghost show-all" onClick={() => setShowAll(true)}>
            Show all models ({models.length.toLocaleString()} in registry)
          </button>
        )}
      </div>
      {selected && !selected.authenticated && (
        <div className="banner warn">
          {selected.provider} is not connected. Connect it in Settings → Providers, or run{" "}
          <code>omp</code> once in a terminal.
        </div>
      )}
    </div>
  );
}
