/**
 * Global usage centre.
 *
 * Aggregates the engine's persistent usage index across sessions, projects,
 * models, and actors. All numbers come from the normalized usage subsystem —
 * nothing is re-derived in React, and absent cost is "unavailable", never $0.
 */

import type { TokenCounts, UsageRecord } from "@orchestrator/protocol";
import type { JSX } from "react";
import { useEffect, useMemo, useState } from "react";
import { engine } from "../engine-client";
import { fmtCost, fmtCount, fmtTokens, useStore } from "../store";
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

function sumT(t: TokenCounts): number {
  return t.inputTokens + t.outputTokens + t.cacheReadTokens + t.cacheWriteTokens;
}

export function UsageCenter(): JSX.Element {
  const prefs = useStore((s) => s.prefs);
  const updatePrefs = useStore((s) => s.updatePrefs);
  const globalUsage = useStore((s) => s.globalUsage);
  const setGlobalUsage = useStore((s) => s.setGlobalUsage);
  const [range, setRange] = useState<Range>(prefs.usageRange);
  const [reindexing, setReindexing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [modelFilter, setModelFilter] = useState<string | null>(null);

  const refresh = async (r: Range) => {
    try {
      setError(null);
      const res = await engine.request("usage.query", { since: sinceFor(r) });
      setGlobalUsage({ records: res.records, breakdown: res.breakdown, fetchedAt: Date.now() });
    } catch (e) {
      setError(String((e as { message?: string })?.message ?? e));
    }
  };

  useEffect(() => {
    void refresh(range);
  }, [range]);

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

  const records = useMemo(() => {
    let rows = globalUsage?.records ?? [];
    if (modelFilter) rows = rows.filter((r) => `${r.provider}/${r.model}` === modelFilter);
    return rows;
  }, [globalUsage, modelFilter]);

  const agg = useMemo(() => aggregate(records), [records]);
  const b = globalUsage?.breakdown;

  return (
    <div className="usage-center">
      <div className="row usage-toolbar">
        <h2 style={{ margin: 0 }}>Usage</h2>
        <div className="segmented">
          {(["today", "7d", "30d", "all"] as const).map((r) => (
            <button
              key={r}
              className={`seg${range === r ? " on" : ""}`}
              onClick={() => setRangeAndSave(r)}
            >
              {r === "today"
                ? "Today"
                : r === "7d"
                  ? "7 days"
                  : r === "30d"
                    ? "30 days"
                    : "All time"}
            </button>
          ))}
        </div>
        <span className="spacer" />
        {modelFilter && (
          <button className="chip chip-btn" onClick={() => setModelFilter(null)}>
            {modelFilter} ×
          </button>
        )}
        <button className="btn" disabled={reindexing} onClick={() => void reindex()}>
          {reindexing ? "Reindexing…" : "Reindex from session files"}
        </button>
      </div>

      {error && <div className="banner">{error}</div>}

      {!b || records.length === 0 ? (
        <div className="empty" style={{ marginTop: "10vh" }}>
          <h3>No usage in this period</h3>
          Run sessions, or reindex to pull history from your persisted OMP sessions.
        </div>
      ) : (
        <div className="usage-grid">
          <section>
            <div className="section-label">Totals</div>
            <table className="usage-table">
              <tbody>
                <tr>
                  <td>Total usage</td>
                  <td className="num">{fmtTokens(agg.total)}</td>
                  <td className="num">{fmtCost(agg.cost) ?? "$—"}</td>
                </tr>
                <tr>
                  <td>Primary agents</td>
                  <td className="num">{fmtTokens(agg.byActor.primary)}</td>
                  <td />
                </tr>
                <tr>
                  <td>Advisors</td>
                  <td className="num">{fmtTokens(agg.byActor.advisor)}</td>
                  <td />
                </tr>
                <tr>
                  <td>Subagents</td>
                  <td className="num">{fmtTokens(agg.byActor.subagent)}</td>
                  <td />
                </tr>
              </tbody>
            </table>
            {agg.costPartial && (
              <div className="hint">
                {fmtCost(agg.cost) ?? "$0.00"} reported — cost unavailable for{" "}
                {fmtCount(agg.modelsWithoutCost)} model{agg.modelsWithoutCost === 1 ? "" : "s"}.
              </div>
            )}
          </section>

          <section>
            <div className="section-label">By model</div>
            <table className="usage-table">
              <thead>
                <tr>
                  <th>Model</th>
                  <th className="num">Input</th>
                  <th className="num">Output</th>
                  <th className="num">Total</th>
                  <th className="num">Cost</th>
                </tr>
              </thead>
              <tbody>
                {agg.byModel.map((m) => (
                  <tr
                    key={m.key}
                    className="clickable"
                    onClick={() => setModelFilter(modelFilter === m.key ? null : m.key)}
                  >
                    <td className="mono">{m.key}</td>
                    <td className="num">{fmtTokens(m.tokens.inputTokens)}</td>
                    <td className="num">{fmtTokens(m.tokens.outputTokens)}</td>
                    <td className="num">{fmtTokens(sumT(m.tokens))}</td>
                    <td className="num">{fmtCost(m.cost) ?? ""}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>

          {agg.advisors.length > 0 && (
            <section>
              <div className="section-label">Advisors</div>
              <table className="usage-table">
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
            <div className="section-label">By session</div>
            <table className="usage-table">
              <thead>
                <tr>
                  <th>Session</th>
                  <th>Project</th>
                  <th className="num">Total</th>
                  <th className="num">Cost</th>
                </tr>
              </thead>
              <tbody>
                {agg.bySession.slice(0, 30).map((s) => (
                  <tr key={s.key}>
                    <td className="mono" title={s.key}>
                      {s.key.slice(0, 8)}
                    </td>
                    <td title={s.project}>{s.project.split("/").pop() || "—"}</td>
                    <td className="num">{fmtTokens(s.total)}</td>
                    <td className="num">{fmtCost(s.cost) ?? ""}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {agg.bySession.length > 30 && (
              <div className="hint">Top 30 of {fmtCount(agg.bySession.length)} sessions shown.</div>
            )}
          </section>

          <section>
            <div className="section-label">By project</div>
            <table className="usage-table">
              <tbody>
                {agg.byProject.map((p) => (
                  <tr key={p.key}>
                    <td title={p.key}>{p.key.split("/").pop() || p.key}</td>
                    <td className="num">{fmtTokens(p.total)}</td>
                    <td className="num">{fmtCost(p.cost) ?? ""}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>

          <section>
            <QuotaSection />
          </section>
        </div>
      )}
    </div>
  );
}

function aggregate(records: UsageRecord[]) {
  const byActor = { primary: 0, advisor: 0, subagent: 0 };
  const models = new Map<
    string,
    { tokens: TokenCounts; cost: number; hasCost: boolean; missing: boolean }
  >();
  const sessionsAgg = new Map<
    string,
    { total: number; cost: number; hasCost: boolean; project: string }
  >();
  const projects = new Map<string, { total: number; cost: number; hasCost: boolean }>();
  const advisorsAgg = new Map<string, { total: number; cost: number; hasCost: boolean }>();
  let total = 0;
  let cost = 0;
  let hasCost = false;
  let costPartial = false;

  for (const r of records) {
    const t = r.inputTokens + r.outputTokens + r.cacheReadTokens + r.cacheWriteTokens;
    total += t;
    byActor[r.actorType] += t;
    if (typeof r.cost === "number") {
      cost += r.cost;
      hasCost = true;
    } else {
      costPartial = true;
    }

    const mk = `${r.provider}/${r.model}`;
    const m = models.get(mk) ?? {
      tokens: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
      cost: 0,
      hasCost: false,
      missing: false,
    };
    m.tokens.inputTokens += r.inputTokens;
    m.tokens.outputTokens += r.outputTokens;
    m.tokens.cacheReadTokens += r.cacheReadTokens;
    m.tokens.cacheWriteTokens += r.cacheWriteTokens;
    if (typeof r.cost === "number") {
      m.cost += r.cost;
      m.hasCost = true;
    } else m.missing = true;
    models.set(mk, m);

    const sk = r.ompSessionId || r.sessionId;
    const s = sessionsAgg.get(sk) ?? { total: 0, cost: 0, hasCost: false, project: r.projectId };
    s.total += t;
    if (typeof r.cost === "number") {
      s.cost += r.cost;
      s.hasCost = true;
    }
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

  return {
    total,
    cost: hasCost ? cost : undefined,
    costPartial,
    modelsWithoutCost: [...models.values()].filter((m) => m.missing).length,
    byActor,
    byModel: [...models.entries()]
      .map(([key, v]) => ({ key, tokens: v.tokens, cost: v.hasCost ? v.cost : undefined }))
      .sort((a, b) => sumT(b.tokens) - sumT(a.tokens)),
    bySession: [...sessionsAgg.entries()]
      .map(([key, v]) => ({
        key,
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
