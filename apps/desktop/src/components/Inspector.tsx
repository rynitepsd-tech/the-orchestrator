/**
 * Right-hand inspector: Usage, Changes, Files.
 *
 * The Usage tab is the product's answer to "which models are consuming my
 * usage". It never invents a number: absent cost or quota is stated plainly
 * rather than shown as zero.
 */
import type { JSX } from "react";
import { useEffect, useState } from "react";
import type { ProviderQuota } from "@orchestrator/protocol";
import { fmtCost, fmtTokens, useStore, type SessionView } from "../store";

function Row({ label, tokens, cost }: { label: string; tokens: number; cost?: number }) {
  const c = fmtCost(cost);
  return (
    <tr>
      <td>{label}</td>
      <td className="num">{fmtTokens(tokens)}</td>
      <td className="num" style={{ color: "var(--text-faint)" }}>
        {c ?? ""}
      </td>
    </tr>
  );
}

function UsageTab({ view }: { view: SessionView }): JSX.Element {
  const u = view.usage;
  const ctx = view.context;

  if (!u) {
    return <div className="empty">No usage recorded yet.</div>;
  }

  const total = u.total.inputTokens + u.total.outputTokens + u.total.cacheReadTokens + u.total.cacheWriteTokens;

  return (
    <div>
      {ctx && (
        <>
          <div className="section-label">Context</div>
          <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 4 }}>
            <span>{Math.round(ctx.fraction * 100)}%</span>
            <span className="mono" style={{ color: "var(--text-faint)" }}>
              {fmtTokens(ctx.usedTokens)} / {fmtTokens(ctx.maxTokens)}
            </span>
          </div>
          <div className="meter">
            <span style={{ width: `${Math.min(100, ctx.fraction * 100)}%` }} />
          </div>
          <div className="hint" style={{ marginTop: 4 }}>
            Context is what fits in the window now — not cumulative tokens billed.
          </div>
        </>
      )}

      <div className="section-label">Session usage</div>
      <table className="usage-table">
        <tbody>
          <Row
            label={`Primary${view.summary.model ? ` · ${view.summary.model.split("/").pop()}` : ""}`}
            tokens={
              u.primary.inputTokens +
              u.primary.outputTokens +
              u.primary.cacheReadTokens +
              u.primary.cacheWriteTokens
            }
            cost={u.primary.cost}
          />
          {u.advisors.map((a) => (
            <Row
              key={a.actorId}
              label={`  ${a.actorName ?? a.actorId}`}
              tokens={
                a.tokens.inputTokens +
                a.tokens.outputTokens +
                a.tokens.cacheReadTokens +
                a.tokens.cacheWriteTokens
              }
              cost={a.cost}
            />
          ))}
          {u.subagents.runs > 0 && (
            <Row
              label={`  Subagents (${u.subagents.runs} run${u.subagents.runs === 1 ? "" : "s"})`}
              tokens={
                u.subagents.tokens.inputTokens +
                u.subagents.tokens.outputTokens +
                u.subagents.tokens.cacheReadTokens +
                u.subagents.tokens.cacheWriteTokens
              }
              cost={u.subagents.cost}
            />
          )}
          <tr className="total">
            <td>Total</td>
            <td className="num">{fmtTokens(total)}</td>
            <td className="num">{fmtCost(u.total.cost) ?? "—"}</td>
          </tr>
        </tbody>
      </table>

      {u.costPartial && (
        <div className="hint" style={{ marginTop: 6 }}>
          Cost is partial — some models did not report it.
        </div>
      )}

      <div className="section-label">Breakdown</div>
      <table className="usage-table">
        <tbody>
          <Row label="Input" tokens={u.total.inputTokens} />
          <Row label="Output" tokens={u.total.outputTokens} />
          {u.total.cacheReadTokens > 0 && <Row label="Cache read" tokens={u.total.cacheReadTokens} />}
          {u.total.cacheWriteTokens > 0 && <Row label="Cache write" tokens={u.total.cacheWriteTokens} />}
        </tbody>
      </table>

      {u.byModel.length > 0 && (
        <>
          <div className="section-label">By model</div>
          <table className="usage-table">
            <tbody>
              {u.byModel.map((m) => (
                <Row
                  key={`${m.provider}/${m.model}`}
                  label={m.model}
                  tokens={
                    m.tokens.inputTokens +
                    m.tokens.outputTokens +
                    m.tokens.cacheReadTokens +
                    m.tokens.cacheWriteTokens
                  }
                  cost={m.cost}
                />
              ))}
            </tbody>
          </table>
        </>
      )}

      <QuotaSection />
    </div>
  );
}

function QuotaSection(): JSX.Element | null {
  const quotas = useStore((s) => s.quotas);
  if (quotas.length === 0) return null;

  return (
    <>
      <div className="section-label">Provider limits</div>
      {quotas.map((q: ProviderQuota) => (
        <div key={`${q.provider}-${q.accountLabel ?? ""}`} style={{ marginBottom: 10 }}>
          <div style={{ fontWeight: 600, fontSize: 12 }}>{q.provider}</div>
          {q.unavailableReason ? (
            <div className="hint">{q.unavailableReason}</div>
          ) : (
            q.windows.map((w) => (
              <div key={w.label} style={{ marginTop: 4 }}>
                <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11.5 }}>
                  <span style={{ color: "var(--text-muted)" }}>{w.label}</span>
                  <span className="mono">
                    {w.fraction !== undefined ? `${Math.round(w.fraction * 100)}%` : "—"}
                  </span>
                </div>
                {w.fraction !== undefined && (
                  <div className="meter">
                    <span style={{ width: `${Math.min(100, w.fraction * 100)}%` }} />
                  </div>
                )}
              </div>
            ))
          )}
        </div>
      ))}
      <div className="hint">
        Reported by the provider through OMP. Never estimated from token volume.
      </div>
    </>
  );
}

function ChangesTab({ view }: { view: SessionView }): JSX.Element {
  const [files, setFiles] = useState<Array<{ path: string; status: string }> | null>(null);

  useEffect(() => {
    // Git status is read through the engine so the webview needs no fs access.
    setFiles(null);
  }, [view.summary.projectPath]);

  if (!files) {
    return (
      <div className="empty">
        <h3>Changes</h3>
        Git status for {view.summary.projectPath.split("/").pop()} appears here once the session
        modifies files.
      </div>
    );
  }

  return (
    <table className="usage-table">
      <tbody>
        {files.map((f) => (
          <tr key={f.path}>
            <td className="mono">{f.path}</td>
            <td className="num">{f.status}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function Inspector({ view }: { view?: SessionView }): JSX.Element {
  const { inspectorTab, setInspectorTab } = useStore();

  return (
    <aside className="inspector" aria-label="Inspector">
      <div className="tabs" role="tablist">
        {(["usage", "changes", "files"] as const).map((t) => (
          <button
            key={t}
            className="tab"
            role="tab"
            aria-selected={inspectorTab === t}
            onClick={() => setInspectorTab(t)}
          >
            {t[0].toUpperCase() + t.slice(1)}
          </button>
        ))}
      </div>

      <div className="inspector-body" role="tabpanel">
        {!view ? (
          <div className="empty">No session selected.</div>
        ) : inspectorTab === "usage" ? (
          <UsageTab view={view} />
        ) : inspectorTab === "changes" ? (
          <ChangesTab view={view} />
        ) : (
          <div className="empty">
            <h3>Files</h3>
            {view.summary.projectPath}
          </div>
        )}
      </div>
    </aside>
  );
}
