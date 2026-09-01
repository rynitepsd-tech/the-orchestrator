/**
 * Global usage centre, T3-style.
 *
 * A big raw-cost headline with per-provider share bars, a daily cost/tokens
 * area chart, a stat row (processed / cached / uncached / output / savings),
 * and a model-or-day breakdown table. All numbers come from the normalized
 * usage subsystem — nothing is re-derived in React, and absent cost is
 * "unavailable", never $0. Cache savings are the one estimate on the page and
 * are labeled as such (token counts × catalogue rates).
 */

import type { ModelInfo, TokenCounts, UsageRecord } from "@orchestrator/protocol";
import type { JSX } from "react";
import { useEffect, useMemo, useState } from "react";
import { engine } from "../engine-client";
import { fmtCost, fmtCount, fmtTokens, providerLabel, providerVendor, useStore } from "../store";
import { QuotaSection } from "./Inspector";

type Range = "today" | "7d" | "30d" | "all";

function sinceFor(range: Range): string | undefined {
  const now = new Date();
  switch (range) {
    case "today": {
      const d = new Date(now.getFullYear(), now.getMonth(), now.getDate());
      return d.toISOString();
    }
    case "7d":
      return new Date(now.getTime() - 7 * 86_400_000).toISOString();
    case "30d":
      return new Date(now.getTime() - 30 * 86_400_000).toISOString();
    case "all":
      return undefined;
  }
}

/**
 * Stable accent per provider. Keyed by VENDOR, because OMP provider ids name
 * the transport too — a ChatGPT subscription reports `openai-codex`, never
 * `openai`, and cycling the fallback palette gave OpenAI a different colour
 * every time the share ranking changed.
 */
const PROVIDER_COLORS: Record<string, string> = {
  anthropic: "#ff8f66",
  openai: "#e8e8e8",
  google: "#7d93ff",
  openrouter: "#59d4c4",
  xai: "#d9a441",
};
const FALLBACK_COLORS = ["#b28dff", "#6fc1ff", "#8be59a", "#f2a0c0", "#c9c9c9"];

function providerColor(provider: string, index: number): string {
  return (
    PROVIDER_COLORS[provider] ??
    PROVIDER_COLORS[providerVendor(provider)] ??
    FALLBACK_COLORS[index % FALLBACK_COLORS.length]
  );
}

function fmtDay(iso: string): string {
  const d = new Date(`${iso}T12:00:00`);
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

/**
 * LOCAL calendar day of a timestamp. Day buckets used to slice the UTC ISO
 * string, so west of UTC every evening's work filed under tomorrow while the
 * range filter used local midnight.
 */
function localDay(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${m}-${day}`;
}

export function UsageCenter(): JSX.Element {
  const prefs = useStore((s) => s.prefs);
  const updatePrefs = useStore((s) => s.updatePrefs);
  const globalUsage = useStore((s) => s.globalUsage);
  const setGlobalUsage = useStore((s) => s.setGlobalUsage);
  const models = useStore((s) => s.models);
  const [range, setRange] = useState<Range>(prefs.usageRange);
  const [reindexing, setReindexing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [chartMode, setChartMode] = useState<"cost" | "tokens">("cost");
  const [breakdown, setBreakdown] = useState<"model" | "day">("model");
  // Engine-side filters (implemented there all along; never sent before).
  const [actorFilter, setActorFilter] = useState<"" | "primary" | "advisor" | "subagent">("");
  const [providerFilter, setProviderFilter] = useState("");
  const [projectFilter, setProjectFilter] = useState("");
  const projects = useStore((s) => s.projects);
  /**
   * Providers the index actually holds, captured from the UNFILTERED query.
   *
   * The menu used to list the model catalogue's provider ids, which are not
   * the ids records carry: a ChatGPT subscription indexes every response under
   * `openai-codex` while the catalogue also advertises a plain `openai`, so
   * picking the option that read "OpenAI" filtered every row away and the tab
   * reported no usage at all.
   */
  const [seenProviders, setSeenProviders] = useState<string[]>([]);

  const refresh = async (r: Range) => {
    try {
      setError(null);
      const res = await engine.request("usage.query", {
        since: sinceFor(r),
        actorType: actorFilter || undefined,
        provider: providerFilter || undefined,
        projectPath: projectFilter || undefined,
      });
      setGlobalUsage({ records: res.records, breakdown: res.breakdown, fetchedAt: Date.now() });
    } catch (e) {
      setError(String((e as { message?: string })?.message ?? e));
    }
  };

  useEffect(() => {
    void refresh(range);
  }, [range, actorFilter, providerFilter, projectFilter]);

  const setRangeAndSave = (r: Range) => {
    setRange(r);
    updatePrefs({ usageRange: r });
  };

  const reindex = async () => {
    setReindexing(true);
    try {
      await engine.request("usage.reindex", {}, 300_000);
      await refresh(range);
    } catch (e) {
      setError(String((e as { message?: string })?.message ?? e));
    } finally {
      setReindexing(false);
    }
  };

  const records = globalUsage?.records ?? [];
  const agg = useMemo(() => aggregate(records, models), [records, models]);
  useEffect(() => {
    if (providerFilter) return; // a filtered query only ever sees one provider
    const found = agg.byProvider.map((p) => p.provider).sort();
    setSeenProviders((prev) =>
      prev.length === found.length && prev.every((p, i) => p === found[i]) ? prev : found,
    );
  }, [agg, providerFilter]);

  const rangeLabel =
    agg.firstDay && agg.lastDay
      ? agg.firstDay === agg.lastDay
        ? fmtDay(agg.firstDay)
        : `${fmtDay(agg.firstDay)} to ${fmtDay(agg.lastDay)}`
      : "";

  return (
    <div className="usage-center">
      <div className="row usage-toolbar">
        <h2 style={{ margin: 0 }}>Usage</h2>
        <span className="hint">{rangeLabel}</span>
        <span className="spacer" />
        <div className="segmented">
          {(["today", "7d", "30d", "all"] as const).map((r) => (
            <button
              key={r}
              className={`seg${range === r ? " on" : ""}`}
              onClick={() => setRangeAndSave(r)}
            >
              {r === "today" ? "Today" : r === "7d" ? "7 days" : r === "30d" ? "30 days" : "All"}
            </button>
          ))}
        </div>
        <select
          className="ctl-chip ctl-select"
          value={actorFilter}
          title="Filter by actor type"
          onChange={(e) => setActorFilter(e.target.value as typeof actorFilter)}
        >
          <option value="">All actors</option>
          <option value="primary">Primary</option>
          <option value="advisor">Advisors</option>
          <option value="subagent">Subagents</option>
        </select>
        <select
          className="ctl-chip ctl-select"
          value={providerFilter}
          title="Filter by provider"
          onChange={(e) => setProviderFilter(e.target.value)}
        >
          <option value="">All providers</option>
          {seenProviders.map((p) => (
            <option key={p} value={p}>
              {providerLabel(p)}
            </option>
          ))}
        </select>
        {projects.length > 0 && (
          <select
            className="ctl-chip ctl-select"
            value={projectFilter}
            title="Filter by project (open projects)"
            onChange={(e) => setProjectFilter(e.target.value)}
          >
            <option value="">All projects</option>
            {projects.map((p) => (
              <option key={p.projectId} value={p.path}>
                {p.path.split("/").pop() || p.path}
              </option>
            ))}
          </select>
        )}
        <button
          className="btn"
          disabled={reindexing}
          onClick={() => void reindex()}
          title="Rebuild the usage index from persisted OMP session files"
        >
          {reindexing ? "Reindexing…" : "⟳ Reindex"}
        </button>
      </div>

      {error && <div className="banner">{error}</div>}

      {records.length === 0 ? (
        <div className="empty" style={{ marginTop: "10vh" }}>
          <h3>No usage in this period</h3>
          Run sessions, or reindex to pull history from your persisted OMP sessions.
        </div>
      ) : (
        <>
          <div className="usage-hero">
            <div className="usage-hero-left">
              <div className="stat-label">Raw token cost</div>
              <div className="usage-cost-big">
                {fmtCost(agg.cost) ?? "$—"}
                {agg.cost !== undefined && <span className="usage-cost-star">*</span>}
              </div>
              <div className="hint">* if billed at full API rate</div>

              <div className="provider-list">
                {agg.byProvider.map((p) => (
                  <div key={p.provider} className="provider-row">
                    <div className="provider-row-head">
                      <span className="provider-dot" style={{ background: p.color }} />
                      <span className="provider-name">{providerLabel(p.provider)}</span>
                      <span className="spacer" />
                      <span className="provider-cost">{fmtCost(p.cost) ?? "—"}</span>
                    </div>
                    <div className="provider-bar">
                      <div
                        className="provider-bar-fill"
                        style={{ width: `${Math.max(1, p.share * 100)}%`, background: p.color }}
                      />
                    </div>
                    <div className="hint">
                      {(p.share * 100).toFixed(1)}% of {agg.cost !== undefined ? "cost" : "tokens"}{" "}
                      · {fmtTokens(p.tokens)} tokens
                    </div>
                  </div>
                ))}
              </div>
            </div>

            <div className="usage-hero-chart">
              <div className="row">
                <span className="stat-label">Daily {chartMode}</span>
                <span className="spacer" />
                <div className="segmented">
                  <button
                    className={`seg${chartMode === "cost" ? " on" : ""}`}
                    onClick={() => setChartMode("cost")}
                  >
                    Cost
                  </button>
                  <button
                    className={`seg${chartMode === "tokens" ? " on" : ""}`}
                    onClick={() => setChartMode("tokens")}
                  >
                    Tokens
                  </button>
                </div>
                <div className="chart-legend">
                  {agg.byProvider.map((p) => (
                    <span key={p.provider} className="chart-legend-item">
                      <span className="provider-dot" style={{ background: p.color }} />
                      {providerLabel(p.provider)}
                    </span>
                  ))}
                </div>
              </div>
              <DailyChart days={agg.days} series={agg.daily} mode={chartMode} />
            </div>
          </div>

          <div className="stat-row">
            <div className="stat-tile">
              <div className="stat-label">Processed tokens</div>
              <div className="stat-value">{fmtTokens(agg.total)}</div>
              <div className="hint">
                {agg.activeDays > 0 &&
                  `${fmtTokens(Math.round(agg.total / agg.activeDays))} per active day`}
              </div>
            </div>
            <div className="stat-tile">
              <div className="stat-label">Cached input</div>
              <div className="stat-value">{fmtTokens(agg.tokens.cacheReadTokens)}</div>
              <div className="hint">
                {agg.observedInput > 0 &&
                  `${((agg.tokens.cacheReadTokens / agg.observedInput) * 100).toFixed(1)}% of observed input`}
              </div>
            </div>
            <div className="stat-tile">
              <div className="stat-label">Uncached input</div>
              <div className="stat-value">{fmtTokens(agg.tokens.inputTokens)}</div>
              <div className="hint">{fmtTokens(agg.tokens.cacheWriteTokens)} cache writes</div>
            </div>
            <div className="stat-tile">
              <div className="stat-label">Output</div>
              <div className="stat-value">{fmtTokens(agg.tokens.outputTokens)}</div>
              <div className="hint">across {fmtCount(agg.sessionCount)} sessions</div>
            </div>
            {agg.cacheSavings !== undefined && agg.cost !== undefined && agg.cost > 0 && (
              <div className="stat-tile">
                <div className="stat-label">Cache savings</div>
                <div className="stat-value">{fmtCost(agg.cacheSavings)}</div>
                <div className="hint">
                  est. · {(agg.cacheSavings / agg.cost).toFixed(1)}x the raw token cost
                </div>
              </div>
            )}
          </div>

          <div className="usage-breakdown">
            <div className="row">
              <h3 style={{ margin: 0 }}>Breakdown</h3>
              <span className="spacer" />
              <div className="segmented">
                <button
                  className={`seg${breakdown === "model" ? " on" : ""}`}
                  onClick={() => setBreakdown("model")}
                >
                  Model
                </button>
                <button
                  className={`seg${breakdown === "day" ? " on" : ""}`}
                  onClick={() => setBreakdown("day")}
                >
                  Day
                </button>
              </div>
            </div>
            <table className="usage-table breakdown-table">
              <thead>
                <tr>
                  <th>{breakdown === "model" ? "Model" : "Day"}</th>
                  <th className="num">Cost</th>
                  <th className="num">Share</th>
                  <th className="num">Tokens</th>
                </tr>
              </thead>
              <tbody>
                {(breakdown === "model" ? agg.byModel : agg.byDay).map((row) => (
                  <tr key={row.key}>
                    <td>
                      {row.color && (
                        <span className="provider-dot" style={{ background: row.color }} />
                      )}{" "}
                      <span className={breakdown === "model" ? "mono" : undefined}>
                        {row.label}
                      </span>
                    </td>
                    <td className="num">{fmtCost(row.cost) ?? "—"}</td>
                    <td className="num">{(row.share * 100).toFixed(1)}%</td>
                    <td className="num">{fmtTokens(row.tokens)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="usage-grid">
            <section>
              <div className="section-label">By session</div>
              <table className="usage-table">
                <thead>
                  <tr>
                    <th>Session</th>
                    <th className="col-project">Project</th>
                    <th className="num">Tokens</th>
                    <th className="num">Cost</th>
                  </tr>
                </thead>
                <tbody>
                  {agg.bySession.slice(0, 20).map((s) => (
                    <tr key={s.key}>
                      <td className={s.title ? undefined : "mono"} title={s.key}>
                        {s.title ?? s.key.slice(0, 8)}
                      </td>
                      <td className="col-project" title={s.project}>
                        {s.project.split("/").pop() || "—"}
                      </td>
                      <td className="num">{fmtTokens(s.total)}</td>
                      <td className="num">{fmtCost(s.cost) ?? ""}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {agg.bySession.length > 20 && (
                <div className="hint">
                  Top 20 of {fmtCount(agg.bySession.length)} sessions shown.
                </div>
              )}
            </section>

            <section>
              <div className="section-label">By project</div>
              <table className="usage-table">
                <thead>
                  <tr>
                    <th>Project</th>
                    <th className="num">Tokens</th>
                    <th className="num">Cost</th>
                  </tr>
                </thead>
                <tbody>
                  {agg.byProject.slice(0, 20).map((p) => (
                    <tr key={p.key}>
                      <td title={p.key}>{p.key.split("/").pop() || p.key}</td>
                      <td className="num">{fmtTokens(p.total)}</td>
                      <td className="num">{fmtCost(p.cost) ?? ""}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {agg.byProject.length > 20 && (
                <div className="hint">
                  Top 20 of {fmtCount(agg.byProject.length)} projects shown.
                </div>
              )}
            </section>

            {agg.advisors.length > 0 && (
              <section>
                <div className="section-label">Advisors</div>
                <table className="usage-table">
                  <thead>
                    <tr>
                      <th>Advisor</th>
                      <th className="num">Tokens</th>
                      <th className="num">Cost</th>
                    </tr>
                  </thead>
                  <tbody>
                    {agg.advisors.map((a) => (
                      <tr key={a.name}>
                        <td>{a.name}</td>
                        <td className="num">{fmtTokens(a.total)}</td>
                        <td className="num">{fmtCost(a.cost) ?? ""}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </section>
            )}

            <section>
              <QuotaSection />
            </section>
          </div>
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Daily area chart (inline SVG, no dependencies)
// ---------------------------------------------------------------------------

interface DailySeries {
  provider: string;
  color: string;
  cost: number[];
  tokens: number[];
}

/** Smooth a polyline with quadratic midpoint curves. */
function smoothPath(pts: Array<[number, number]>): string {
  if (pts.length === 0) return "";
  if (pts.length === 1) return `M ${pts[0][0]} ${pts[0][1]}`;
  let d = `M ${pts[0][0]} ${pts[0][1]}`;
  for (let i = 1; i < pts.length - 1; i++) {
    const [x0, y0] = pts[i];
    const [x1, y1] = pts[i + 1];
    d += ` Q ${x0} ${y0} ${(x0 + x1) / 2} ${(y0 + y1) / 2}`;
  }
  const last = pts[pts.length - 1];
  d += ` L ${last[0]} ${last[1]}`;
  return d;
}

function DailyChart({
  days,
  series,
  mode,
}: {
  days: string[];
  series: DailySeries[];
  mode: "cost" | "tokens";
}): JSX.Element {
  const W = 640;
  const H = 210;
  const PAD_L = 46;
  const PAD_B = 22;
  const PAD_T = 10;

  const max = Math.max(1e-9, ...series.flatMap((s) => (mode === "cost" ? s.cost : s.tokens)));
  const x = (i: number) =>
    PAD_L + (days.length <= 1 ? 0.5 : i / (days.length - 1)) * (W - PAD_L - 8);
  const y = (v: number) => PAD_T + (1 - v / max) * (H - PAD_T - PAD_B);

  const fmtY = (v: number) => (mode === "cost" ? (fmtCost(v) ?? "") : fmtTokens(v));

  return (
    <svg
      className="daily-chart"
      viewBox={`0 0 ${W} ${H}`}
      role="img"
      aria-label={`Daily ${mode} by provider`}
    >
      {/* gridlines at 50% and 100% */}
      {[0.5, 1].map((f) => (
        <g key={f}>
          <line x1={PAD_L} x2={W - 8} y1={y(max * f)} y2={y(max * f)} className="chart-grid" />
          <text x={PAD_L - 6} y={y(max * f) + 4} className="chart-tick" textAnchor="end">
            {fmtY(max * f)}
          </text>
        </g>
      ))}
      <line x1={PAD_L} x2={W - 8} y1={y(0)} y2={y(0)} className="chart-grid baseline" />

      {series.map((s) => {
        const vals = mode === "cost" ? s.cost : s.tokens;
        const pts = vals.map((v, i) => [x(i), y(v)] as [number, number]);
        const line = smoothPath(pts);
        const area = `${line} L ${x(vals.length - 1)} ${y(0)} L ${x(0)} ${y(0)} Z`;
        return (
          <g key={s.provider}>
            <path d={area} fill={s.color} opacity={0.14} />
            <path d={line} fill="none" stroke={s.color} strokeWidth={1.8} />
          </g>
        );
      })}

      {days.length > 0 && (
        <>
          <text x={PAD_L} y={H - 6} className="chart-tick">
            {fmtDay(days[0]).toUpperCase()}
          </text>
          {days.length > 2 && (
            <text
              x={x(Math.floor((days.length - 1) / 2))}
              y={H - 6}
              className="chart-tick"
              textAnchor="middle"
            >
              {fmtDay(days[Math.floor((days.length - 1) / 2)]).toUpperCase()}
            </text>
          )}
          {days.length > 1 && (
            <text x={x(days.length - 1)} y={H - 6} className="chart-tick" textAnchor="end">
              {fmtDay(days[days.length - 1]).toUpperCase()}
            </text>
          )}
        </>
      )}
    </svg>
  );
}

// ---------------------------------------------------------------------------
// Aggregation
// ---------------------------------------------------------------------------

function aggregate(records: UsageRecord[], models: ModelInfo[]) {
  const tokens: TokenCounts = {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
  };
  const providers = new Map<string, { tokens: number; cost: number; hasCost: boolean }>();
  const modelAgg = new Map<string, { tokens: number; cost: number; hasCost: boolean }>();
  const dayAgg = new Map<string, { tokens: number; cost: number; hasCost: boolean }>();
  const dailyByProvider = new Map<string, Map<string, { cost: number; tokens: number }>>();
  const sessionsAgg = new Map<
    string,
    { total: number; cost: number; hasCost: boolean; project: string; title?: string }
  >();
  const projects = new Map<string, { total: number; cost: number; hasCost: boolean }>();
  const advisorsAgg = new Map<string, { total: number; cost: number; hasCost: boolean }>();

  // Catalogue rates for the savings estimate (rates are $/M tokens).
  const rates = new Map<string, { input: number; cacheRead: number }>();
  for (const m of models) {
    if (m.cost) rates.set(m.key, { input: m.cost.input, cacheRead: m.cost.cacheRead });
  }

  let total = 0;
  let cost = 0;
  let hasCost = false;
  let cacheSavings = 0;
  let hasSavings = false;

  for (const r of records) {
    const t = r.inputTokens + r.outputTokens + r.cacheReadTokens + r.cacheWriteTokens;
    total += t;
    tokens.inputTokens += r.inputTokens;
    tokens.outputTokens += r.outputTokens;
    tokens.cacheReadTokens += r.cacheReadTokens;
    tokens.cacheWriteTokens += r.cacheWriteTokens;
    if (typeof r.cost === "number") {
      cost += r.cost;
      hasCost = true;
    }

    const rate = rates.get(`${r.provider}/${r.model}`);
    if (rate && rate.input > rate.cacheRead && r.cacheReadTokens > 0) {
      cacheSavings += (r.cacheReadTokens * (rate.input - rate.cacheRead)) / 1_000_000;
      hasSavings = true;
    }

    const pv = providers.get(r.provider) ?? { tokens: 0, cost: 0, hasCost: false };
    pv.tokens += t;
    if (typeof r.cost === "number") {
      pv.cost += r.cost;
      pv.hasCost = true;
    }
    providers.set(r.provider, pv);

    const mk = `${r.provider}/${r.model}`;
    const mv = modelAgg.get(mk) ?? { tokens: 0, cost: 0, hasCost: false };
    mv.tokens += t;
    if (typeof r.cost === "number") {
      mv.cost += r.cost;
      mv.hasCost = true;
    }
    modelAgg.set(mk, mv);

    const day = localDay(r.completedAt ?? r.startedAt ?? "");
    if (day) {
      const dv = dayAgg.get(day) ?? { tokens: 0, cost: 0, hasCost: false };
      dv.tokens += t;
      if (typeof r.cost === "number") {
        dv.cost += r.cost;
        dv.hasCost = true;
      }
      dayAgg.set(day, dv);

      let perDay = dailyByProvider.get(r.provider);
      if (!perDay) {
        perDay = new Map();
        dailyByProvider.set(r.provider, perDay);
      }
      const cell = perDay.get(day) ?? { cost: 0, tokens: 0 };
      cell.tokens += t;
      cell.cost += r.cost ?? 0;
      perDay.set(day, cell);
    }

    const sk = r.ompSessionId || r.sessionId;
    const s = sessionsAgg.get(sk) ?? {
      total: 0,
      cost: 0,
      hasCost: false,
      project: r.projectId,
      title: undefined as string | undefined,
    };
    s.total += t;
    if (typeof r.cost === "number") {
      s.cost += r.cost;
      s.hasCost = true;
    }
    if (r.sessionTitle) s.title = r.sessionTitle;
    sessionsAgg.set(sk, s);

    const p = projects.get(r.projectId) ?? { total: 0, cost: 0, hasCost: false };
    p.total += t;
    if (typeof r.cost === "number") {
      p.cost += r.cost;
      p.hasCost = true;
    }
    projects.set(r.projectId, p);

    if (r.actorType === "advisor") {
      const name = r.actorName ?? r.actorId.replace(/^advisor:/, "");
      const a = advisorsAgg.get(name) ?? { total: 0, cost: 0, hasCost: false };
      a.total += t;
      if (typeof r.cost === "number") {
        a.cost += r.cost;
        a.hasCost = true;
      }
      advisorsAgg.set(name, a);
    }
  }

  // Share denominators: cost when we have it, tokens otherwise.
  const shareOf = (c: number, tk: number, has: boolean) =>
    hasCost && cost > 0 && has ? c / cost : total > 0 ? tk / total : 0;

  const byProvider = [...providers.entries()]
    .map(([provider, v]) => ({
      provider,
      tokens: v.tokens,
      cost: v.hasCost ? v.cost : undefined,
      share: shareOf(v.cost, v.tokens, v.hasCost),
    }))
    .sort((a, b) => b.share - a.share)
    .map((p, i) => ({ ...p, color: providerColor(p.provider, i) }));

  // Continuous day axis from first to last observed day.
  const sortedDays = [...dayAgg.keys()].sort();
  const days: string[] = [];
  if (sortedDays.length > 0) {
    const first = new Date(`${sortedDays[0]}T12:00:00`);
    const last = new Date(`${sortedDays[sortedDays.length - 1]}T12:00:00`);
    for (let d = new Date(first); d <= last; d.setDate(d.getDate() + 1)) {
      days.push(localDay(d.toISOString()));
    }
  }

  const daily: DailySeries[] = byProvider.map((p) => {
    const perDay = dailyByProvider.get(p.provider);
    return {
      provider: p.provider,
      color: p.color,
      cost: days.map((d) => perDay?.get(d)?.cost ?? 0),
      tokens: days.map((d) => perDay?.get(d)?.tokens ?? 0),
    };
  });

  const providerColorOf = (key: string) =>
    byProvider.find((p) => key.startsWith(`${p.provider}/`))?.color;

  return {
    total,
    tokens,
    observedInput: tokens.inputTokens + tokens.cacheReadTokens,
    cost: hasCost ? cost : undefined,
    cacheSavings: hasSavings ? cacheSavings : undefined,
    activeDays: dayAgg.size,
    sessionCount: sessionsAgg.size,
    firstDay: sortedDays[0],
    lastDay: sortedDays[sortedDays.length - 1],
    days,
    daily,
    byProvider,
    byModel: [...modelAgg.entries()]
      .map(([key, v]) => ({
        key,
        label: key.split("/").slice(1).join("/") || key,
        color: providerColorOf(key),
        tokens: v.tokens,
        cost: v.hasCost ? v.cost : undefined,
        share: shareOf(v.cost, v.tokens, v.hasCost),
      }))
      .sort((a, b) => b.share - a.share),
    byDay: [...dayAgg.entries()]
      .sort((a, b) => b[0].localeCompare(a[0]))
      .map(([key, v]) => ({
        key,
        label: fmtDay(key),
        color: undefined as string | undefined,
        tokens: v.tokens,
        cost: v.hasCost ? v.cost : undefined,
        share: shareOf(v.cost, v.tokens, v.hasCost),
      })),
    bySession: [...sessionsAgg.entries()]
      .map(([key, v]) => ({
        key,
        title: v.title,
        total: v.total,
        cost: v.hasCost ? v.cost : undefined,
        project: v.project,
      }))
      .sort((a, b) => b.total - a.total),
    byProject: [...projects.entries()]
      .map(([key, v]) => ({ key, total: v.total, cost: v.hasCost ? v.cost : undefined }))
      .sort((a, b) => b.total - a.total),
    advisors: [...advisorsAgg.entries()]
      .map(([name, v]) => ({ name, total: v.total, cost: v.hasCost ? v.cost : undefined }))
      .sort((a, b) => b.total - a.total),
  };
}
