/**
 * Right-hand inspector: Usage, Changes, Files.
 *
 * The Usage tab is the product's answer to "which models are consuming my
 * usage". It never invents a number: absent cost or quota is stated plainly
 * rather than shown as zero. The Changes tab shows the WHOLE working tree —
 * labelled as such, because concurrent sessions share it.
 */

import type { GitDiff, ProviderQuota } from "@orchestrator/protocol";
import type { JSX } from "react";
import { useCallback, useEffect, useState } from "react";
import { engine } from "../engine-client";
import { fmtCost, fmtCount, fmtTokens, isActive, type SessionView, useStore } from "../store";
import { Diff } from "./Transcript";

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

function sumT(t: {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}) {
  return t.inputTokens + t.outputTokens + t.cacheReadTokens + t.cacheWriteTokens;
}

function UsageTab({ view }: { view: SessionView }): JSX.Element {
  const u = view.usage;
  const ctx = view.context;

  if (!u) {
    return <div className="empty">No usage recorded yet.</div>;
  }

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
            tokens={sumT(u.primary)}
            cost={u.primary.cost}
          />
          {u.advisors.map((a) => (
            <Row
              key={a.actorId}
              label={`  ${a.actorName ?? a.actorId}`}
              tokens={sumT(a.tokens)}
              cost={a.cost}
            />
          ))}
          {u.subagents.runs > 0 && (
            <Row
              label={`  Subagents (${u.subagents.runs} run${u.subagents.runs === 1 ? "" : "s"})`}
              tokens={sumT(u.subagents.tokens)}
              cost={u.subagents.cost}
            />
          )}
          <tr className="total">
            <td>Total</td>
            <td className="num">{fmtTokens(sumT(u.total))}</td>
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
          {u.total.cacheReadTokens > 0 && (
            <Row label="Cache read" tokens={u.total.cacheReadTokens} />
          )}
          {u.total.cacheWriteTokens > 0 && (
            <Row label="Cache write" tokens={u.total.cacheWriteTokens} />
          )}
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
                  tokens={sumT(m.tokens)}
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

export function QuotaSection(): JSX.Element | null {
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
  const changes = useStore((s) => s.changes[view.summary.projectId]);
  const setChanges = useStore((s) => s.setChanges);
  const sessions = useStore((s) => s.sessions);
  const [selected, setSelected] = useState<string | null>(null);
  const [diff, setDiff] = useState<GitDiff | null>(null);
  const [loading, setLoading] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const c = await engine.request("project.changes", { path: view.summary.projectPath });
      setChanges(view.summary.projectId, c);
    } catch {
      /* non-git projects render the empty state */
    }
  }, [view.summary.projectId, view.summary.projectPath, setChanges]);

  // Refresh when the panel opens and again whenever this project's sessions
  // settle (a finished turn usually means files changed).
  useEffect(() => {
    void refresh();
  }, [refresh]);
  const projectRunStates = Object.values(sessions)
    .filter((v) => v.summary.projectId === view.summary.projectId)
    .map((v) => v.summary.runState)
    .join(",");
  useEffect(() => {
    void refresh();
  }, [projectRunStates, refresh]);

  const openDiff = async (file: string) => {
    setSelected(file);
    setLoading(true);
    setDiff(null);
    try {
      setDiff(await engine.request("project.diff", { path: view.summary.projectPath, file }));
    } catch {
      setDiff(null);
    } finally {
      setLoading(false);
    }
  };

  const activeHere = Object.values(sessions).filter(
    (v) => v.summary.projectId === view.summary.projectId && isActive(v.summary.runState),
  ).length;

  if (!changes || changes.files.length === 0) {
    return (
      <div>
        <div className="row">
          <span className="section-label" style={{ margin: 0 }}>
            Working tree changes
          </span>
          <span className="spacer" />
          <button className="btn btn-ghost" onClick={() => void refresh()}>
            Refresh
          </button>
        </div>
        <div className="empty">
          {changes ? "The working tree is clean." : "Not a git repository, or git is unavailable."}
        </div>
      </div>
    );
  }

  return (
    <div>
      <div className="row">
        <span className="section-label" style={{ margin: 0 }}>
          Working tree · {fmtCount(changes.files.length)}
        </span>
        {changes.branch && <span className="chip mono">{changes.branch}</span>}
        <span className="spacer" />
        <button className="btn btn-ghost" onClick={() => void refresh()}>
          Refresh
        </button>
      </div>
      {activeHere > 1 && (
        <div className="hint" style={{ margin: "6px 0" }}>
          {activeHere} active sessions share this working tree — changes are not attributable to one
          session.
        </div>
      )}
      <div className="changes-list">
        {changes.files.map((f) => (
          <button
            key={f.path}
            className={`change-row${selected === f.path ? " selected" : ""}`}
            onClick={() => void openDiff(f.path)}
            title={f.renamedFrom ? `from ${f.renamedFrom}` : f.path}
          >
            <span className={`status-badge s-${f.status === "?" ? "u" : f.status.toLowerCase()}`}>
              {f.status}
            </span>
            <span className="mono change-path">{f.path}</span>
          </button>
        ))}
      </div>
      {selected && (
        <div className="diff-pane">
          <div className="row">
            <span className="mono hint">{selected}</span>
            <span className="spacer" />
            {diff && !diff.binary && (
              <span className="diffstat">
                <span className="add">+{diff.additions}</span>{" "}
                <span className="del">-{diff.deletions}</span>
              </span>
            )}
          </div>
          {loading ? (
            <div className="hint">Loading diff…</div>
          ) : diff?.binary ? (
            <div className="hint">Binary file — no text diff.</div>
          ) : diff?.diff ? (
            <>
              {diff.untracked && <div className="hint">Untracked file — full content shown.</div>}
              <Diff diff={diff.diff} />
              {diff.truncated && <div className="hint">Diff truncated for display.</div>}
            </>
          ) : (
            <div className="hint">No textual changes.</div>
          )}
        </div>
      )}
    </div>
  );
}

function FilesTab({ view }: { view: SessionView }): JSX.Element {
  const [query, setQuery] = useState("");
  const [files, setFiles] = useState<string[]>([]);
  const [truncated, setTruncated] = useState(false);
  const [preview, setPreview] = useState<{
    file: string;
    content: string;
    binary: boolean;
    truncated: boolean;
  } | null>(null);

  useEffect(() => {
    let cancelled = false;
    const t = setTimeout(() => {
      void engine
        .request("project.files", {
          path: view.summary.projectPath,
          query: query.trim() || undefined,
          limit: 500,
        })
        .then((r) => {
          if (!cancelled) {
            setFiles(r.files);
            setTruncated(r.truncated);
          }
        })
        .catch(() => {});
    }, 150);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [view.summary.projectPath, query]);

  return (
    <div>
      <input
        className="input"
        placeholder="Filter files…"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />
      <div className="files-list">
        {files.map((f) => (
          <button
            key={f}
            className={`change-row${preview?.file === f ? " selected" : ""}`}
            onClick={() =>
              void engine
                .request("project.readFile", { path: view.summary.projectPath, file: f })
                .then(setPreview)
                .catch(() => {})
            }
          >
            <span className="mono change-path">{f}</span>
          </button>
        ))}
        {truncated && <div className="hint">List truncated — refine the filter.</div>}
        {files.length === 0 && <div className="empty">No files match.</div>}
      </div>
      {preview && (
        <div className="diff-pane">
          <div className="mono hint">{preview.file}</div>
          {preview.binary ? (
            <div className="hint">Binary file.</div>
          ) : preview.content ? (
            <>
              <pre className="tool-output file-preview">{preview.content}</pre>
              {preview.truncated && <div className="hint">Preview truncated.</div>}
            </>
          ) : (
            <div className="hint">Empty or unreadable.</div>
          )}
        </div>
      )}
    </div>
  );
}

export function Inspector({ view }: { view?: SessionView }): JSX.Element {
  const inspectorTab = useStore((s) => s.inspectorTab);
  const setInspectorTab = useStore((s) => s.setInspectorTab);

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
          <FilesTab view={view} />
        )}
      </div>
    </aside>
  );
}
