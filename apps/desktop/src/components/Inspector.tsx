/**
 * Right-hand inspector: Usage, Changes, Files.
 *
 * The Usage tab is the product's answer to "which models are consuming my
 * usage". It never invents a number: absent cost or quota is stated plainly
 * rather than shown as zero. The Changes tab shows the WHOLE working tree —
 * labelled as such, because concurrent sessions share it.
 */

import type { GitDiff, ProviderQuota } from "@orchestrator/protocol";
import { ask } from "@tauri-apps/plugin-dialog";
import { openUrl } from "@tauri-apps/plugin-opener";
import type { JSX } from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import { engine } from "../engine-client";
import {
  type FilePreview,
  fmtCost,
  fmtCount,
  fmtTokens,
  type InspectorTab,
  isActive,
  type SessionView,
  useStore,
} from "../store";
import { Markdown } from "./Markdown";
import { ResizeHandle } from "./ResizeHandle";
import { Diff } from "./Transcript";

function Row({
  label,
  tokens,
  cost,
  hideCost,
}: {
  label: string;
  tokens: number;
  cost?: number;
  /** Two-column tables (no costs anywhere) keep the numbers on the right edge. */
  hideCost?: boolean;
}) {
  const c = fmtCost(cost);
  return (
    <tr>
      <td>{label}</td>
      <td className="num">{fmtTokens(tokens)}</td>
      {!hideCost && (
        <td className="num" style={{ color: "var(--text-faint)" }}>
          {c ?? ""}
        </td>
      )}
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
  const sessionId = view.summary.sessionId;

  // Live events populate this during a turn; on resume/relaunch the panel
  // would otherwise sit empty until the next turn — pull the persisted
  // breakdown from the engine's usage index instead.
  useEffect(() => {
    if (u) return;
    void engine
      .request("usage.session", { sessionId })
      .then((res) => {
        if (res.breakdown) useStore.getState().setSessionUsage(sessionId, res.breakdown);
      })
      .catch(() => {});
  }, [u, sessionId]);

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
          <Row label="Input" tokens={u.total.inputTokens} hideCost />
          <Row label="Output" tokens={u.total.outputTokens} hideCost />
          {u.total.cacheReadTokens > 0 && (
            <Row label="Cache read" tokens={u.total.cacheReadTokens} hideCost />
          )}
          {u.total.cacheWriteTokens > 0 && (
            <Row label="Cache write" tokens={u.total.cacheWriteTokens} hideCost />
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
          <div style={{ fontWeight: 600, fontSize: 14 }}>{q.provider}</div>
          {q.unavailableReason ? (
            <div className="hint">{q.unavailableReason}</div>
          ) : (
            q.windows.map((w) => (
              <div key={w.label} style={{ marginTop: 4 }}>
                <div style={{ display: "flex", justifyContent: "space-between", fontSize: 13.5 }}>
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
  const [shipping, setShipping] = useState(false);
  const [shipped, setShipped] = useState<{ prUrl?: string; branch: string; note?: string } | null>(
    null,
  );
  const [shipError, setShipError] = useState<string | null>(null);

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

  // One confirm, then the whole exit ramp: branch if needed, commit, push, PR.
  const ship = async () => {
    if (!changes || shipping) return;
    const onDefault = changes.branch === "main" || changes.branch === "master";
    const yes = await ask(
      `Commit ${fmtCount(changes.files.length)} changed file${changes.files.length === 1 ? "" : "s"}${
        onDefault
          ? `, on a new branch (you're on ${changes.branch})`
          : ` on ${changes.branch ?? "the current branch"}`
      }, push, and open a pull request?`,
      { title: "Commit, Push & PR", kind: "info" },
    );
    if (!yes) return;
    setShipping(true);
    setShipError(null);
    setShipped(null);
    try {
      const res = await engine.request(
        "project.ship",
        { path: view.summary.projectPath, title: view.summary.title },
        180_000,
      );
      setShipped({ prUrl: res.prUrl, branch: res.branch, note: res.note });
      await refresh();
    } catch (e) {
      setShipError(String((e as { message?: string })?.message ?? e));
    } finally {
      setShipping(false);
    }
  };

  const shipStatus = (
    <>
      {shipError && <div className="banner">{shipError}</div>}
      {shipped && (
        <div className="ship-result">
          ✓ Shipped on <span className="mono">{shipped.branch}</span>
          {shipped.prUrl && (
            <button
              type="button"
              className="btn btn-ghost ship-pr-link"
              onClick={() => void openUrl(shipped.prUrl!)}
            >
              Open PR ↗
            </button>
          )}
          {shipped.note && <div className="hint">{shipped.note}</div>}
        </div>
      )}
    </>
  );

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
        {shipStatus}
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
        <button
          className="btn btn-primary"
          disabled={shipping}
          onClick={() => void ship()}
          title="Commit everything, push (branching off the default branch if needed), and open a PR"
        >
          {shipping ? "Shipping…" : "Commit, Push & PR"}
        </button>
      </div>
      {shipStatus}
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

/** Beyond this, line-numbered rendering gets sluggish — fall back to plain text. */
const NUMBERED_LINES_MAX = 4000;

const MARKDOWN_EXT_RX = /\.(md|markdown|mdx)$/i;

interface FileReadResult {
  kind: "text" | "image" | "pdf" | "binary" | "missing" | "directory";
  content?: string;
  base64?: string;
  mime?: string;
  truncated?: boolean;
}

function FilePreviewTab({ preview }: { preview: FilePreview }): JSX.Element {
  const closeFilePreview = useStore((s) => s.closeFilePreview);
  const [data, setData] = useState<FileReadResult | null>(null);
  const [failed, setFailed] = useState(false);
  // Markdown renders as a preview first, Codex-style; the toggle shows source.
  const [viewSource, setViewSource] = useState(false);
  const [openMenu, setOpenMenu] = useState(false);
  // PDFs render through a blob URL (the CSP allows object/frame blob: only).
  const [pdfUrl, setPdfUrl] = useState<string | null>(null);
  const lineRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (data?.kind !== "pdf" || !data.base64) {
      setPdfUrl(null);
      return;
    }
    const bytes = Uint8Array.from(atob(data.base64), (c) => c.charCodeAt(0));
    const url = URL.createObjectURL(new Blob([bytes], { type: "application/pdf" }));
    setPdfUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [data]);

  useEffect(() => {
    let cancelled = false;
    setData(null);
    setFailed(false);
    setViewSource(false);
    setOpenMenu(false);

    // Agents often cite a file by bare name (`SESSION_LOG.md`) even when it
    // lives in a subfolder. If the literal path is missing, locate the file
    // by basename inside the project and reopen at the real path.
    const locateByName = async (): Promise<boolean> => {
      const pp = preview.projectPath;
      if (!pp || !preview.path.startsWith(`${pp}/`)) return false;
      const base = preview.path.split("/").pop();
      if (!base) return false;
      try {
        const res = await engine.request("project.files", { path: pp, query: base, limit: 200 });
        const matches = res.files.filter((f) => f === base || f.endsWith(`/${base}`));
        // Shortest path first: prefer docs/README.md over deep vendored copies.
        matches.sort((a, b) => a.length - b.length);
        const found = matches[0];
        if (!found || `${pp}/${found}` === preview.path) return false;
        if (!cancelled) {
          useStore.getState().openFilePreview({
            path: `${pp}/${found}`,
            projectPath: pp,
            line: preview.line,
          });
        }
        return true;
      } catch {
        return false;
      }
    };

    void engine
      .request("file.read", { path: preview.path })
      .then(async (r) => {
        if (cancelled) return;
        if (r.kind === "missing" && (await locateByName())) return;
        if (!cancelled) setData(r);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [preview]);

  // Jump to the cited line once content is in.
  useEffect(() => {
    lineRef.current?.scrollIntoView({ block: "center" });
  }, [data, viewSource]);

  const name = preview.path.split("/").pop() ?? preview.path;
  const dir = preview.path.slice(0, preview.path.lastIndexOf("/")) || "/";
  const isMarkdown = MARKDOWN_EXT_RX.test(name);

  // Breadcrumbs: project name › … › file when inside the project, else the path.
  const crumbs = (() => {
    const pp = preview.projectPath;
    if (pp && preview.path.startsWith(`${pp}/`)) {
      const projectName = pp.split("/").pop() ?? pp;
      return [projectName, ...preview.path.slice(pp.length + 1).split("/")];
    }
    return preview.path.replace(/^\//, "").split("/");
  })();

  const openWith = (opts?: { app?: string; reveal?: boolean; path?: string }) => {
    setOpenMenu(false);
    void engine
      .request("path.open", {
        path: opts?.path ?? preview.path,
        app: opts?.app,
        reveal: opts?.reveal,
      })
      .catch(() => {});
  };

  const lines = data?.kind === "text" && data.content ? data.content.split("\n") : null;

  const body = () => {
    if (failed) return <div className="empty">Could not read this file.</div>;
    if (!data) return <div className="hint">Loading…</div>;
    switch (data.kind) {
      case "missing":
        return <div className="empty">File not found on disk.</div>;
      case "directory":
        return (
          <div className="empty">
            This is a folder.{" "}
            <button className="btn btn-ghost" onClick={() => openWith({ reveal: true })}>
              Open in Finder
            </button>
          </div>
        );
      case "binary":
        return (
          <div className="empty">
            No inline preview for this file type — use Open to view it in another app.
          </div>
        );
      case "image":
        return (
          <div className="fp-image-wrap">
            <img className="fp-image" src={`data:${data.mime};base64,${data.base64}`} alt={name} />
          </div>
        );
      case "pdf":
        return pdfUrl ? (
          <embed className="fp-pdf" src={pdfUrl} type="application/pdf" title={name} />
        ) : (
          <div className="hint">Loading…</div>
        );
      default: {
        if (!data.content) return <div className="empty">Empty file.</div>;
        if (isMarkdown && !viewSource) {
          return (
            <div className="fp-markdown">
              <Markdown text={data.content} projectPath={preview.projectPath} />
              {data.truncated && <div className="hint">Preview truncated.</div>}
            </div>
          );
        }
        return (
          <>
            <pre className="tool-output file-preview file-preview-body">
              {lines && lines.length <= NUMBERED_LINES_MAX
                ? lines.map((l, i) => (
                    <div
                      key={i}
                      ref={i + 1 === preview.line ? lineRef : undefined}
                      className={`fp-line${i + 1 === preview.line ? " hl" : ""}`}
                    >
                      <span className="fp-ln">{i + 1}</span>
                      <span className="fp-text">{l || " "}</span>
                    </div>
                  ))
                : data.content}
            </pre>
            {data.truncated && <div className="hint">Preview truncated.</div>}
          </>
        );
      }
    }
  };

  return (
    <div className="file-preview-pane" onClick={() => setOpenMenu(false)}>
      <div className="row file-preview-head">
        <span className="fp-crumbs" title={preview.path}>
          {crumbs.map((c, i) => (
            <span key={i} className={i === crumbs.length - 1 ? "fp-crumb-file" : "fp-crumb"}>
              {i > 0 && <span className="fp-crumb-sep">›</span>}
              {c}
              {i === crumbs.length - 1 && preview.line ? `:${preview.line}` : ""}
            </span>
          ))}
        </span>
        <span className="spacer" />
        {isMarkdown && data?.kind === "text" && (
          <button
            className="btn btn-ghost fp-toggle"
            onClick={() => setViewSource((v) => !v)}
            title={viewSource ? "Show the rendered markdown" : "Show the raw source"}
          >
            {viewSource ? "View preview" : "View source"}
          </button>
        )}
        <div className="fp-open" onClick={(e) => e.stopPropagation()}>
          <button
            className="btn fp-open-main"
            title="Open in VS Code"
            onClick={() => openWith({ app: "Visual Studio Code" })}
          >
            Open
          </button>
          <button
            className="btn fp-open-arrow"
            title="Open with…"
            aria-haspopup="menu"
            aria-expanded={openMenu}
            onClick={() => setOpenMenu((v) => !v)}
          >
            ▾
          </button>
          {openMenu && (
            <div className="fp-open-menu" role="menu">
              <button className="menu-item" onClick={() => openWith({ app: "Visual Studio Code" })}>
                VS Code
              </button>
              <button className="menu-item" onClick={() => openWith()}>
                Default app
              </button>
              <button
                className="menu-item"
                onClick={() => openWith({ app: "Terminal", path: dir })}
              >
                Terminal
              </button>
              <button className="menu-item" onClick={() => openWith({ reveal: true })}>
                Open in folder
              </button>
            </div>
          )}
        </div>
        <button className="icon-btn" title="Close preview" onClick={closeFilePreview}>
          ×
        </button>
      </div>
      {body()}
    </div>
  );
}

export function Inspector({ view }: { view?: SessionView }): JSX.Element {
  const inspectorTab = useStore((s) => s.inspectorTab);
  const setInspectorTab = useStore((s) => s.setInspectorTab);
  const inspectorWidth = useStore((s) => s.prefs.inspectorWidth);
  const updatePrefs = useStore((s) => s.updatePrefs);
  const filePreview = useStore((s) => s.filePreview);

  // The preview tab only exists while a clicked file is open.
  const tabs: { id: InspectorTab; label: string }[] = [
    { id: "usage", label: "Usage" },
    { id: "changes", label: "Changes" },
    { id: "files", label: "Files" },
    ...(filePreview ? [{ id: "preview" as const, label: "File" }] : []),
  ];

  return (
    <aside className="inspector" aria-label="Inspector">
      <ResizeHandle
        side="left"
        width={inspectorWidth}
        min={260}
        max={600}
        onResize={(w) => updatePrefs({ inspectorWidth: w })}
      />
      <div className="tabs" role="tablist">
        {tabs.map((t) => (
          <button
            key={t.id}
            className="tab"
            role="tab"
            aria-selected={inspectorTab === t.id}
            onClick={() => setInspectorTab(t.id)}
          >
            {t.label}
          </button>
        ))}
      </div>

      <div className="inspector-body" role="tabpanel">
        {inspectorTab === "preview" && filePreview ? (
          <FilePreviewTab preview={filePreview} />
        ) : !view ? (
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
