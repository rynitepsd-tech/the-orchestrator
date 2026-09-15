import type { SessionId, VerificationEvidence } from "@orchestrator/protocol";
import type { JSX } from "react";
import { useState } from "react";
import { engine } from "../engine-client";

/** Incumbent tool/output styling; only observed results, never a task-success badge. */
export function EvidenceList({
  sessionId,
  requestId,
  evidence,
}: {
  sessionId: SessionId;
  requestId: string;
  evidence: VerificationEvidence[];
}): JSX.Element {
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string>();
  const [copied, setCopied] = useState<string>();
  const records = evidence.filter((record) => record.requestId === requestId);
  const browserEvidence = records.some((record) => record.kind === "browser");

  async function refresh() {
    if (refreshing) return;
    setRefreshing(true);
    setError(undefined);
    try {
      // The backend publishes task.updated; the canonical snapshot owns this list.
      await engine.request("session.evidence.refresh", { sessionId, requestId });
    } catch (cause) {
      setError(
        `Could not refresh evidence: ${cause instanceof Error ? cause.message : String(cause)}`,
      );
    } finally {
      setRefreshing(false);
    }
  }

  async function copy(record: VerificationEvidence) {
    setError(undefined);
    try {
      await navigator.clipboard.writeText(
        [
          record.label,
          `${record.kind} · ${record.status}${record.exitCode === undefined ? "" : ` · exit ${record.exitCode}`}`,
          `Started: ${record.startedAt}\nFinished: ${record.finishedAt}`,
          `Revision: ${record.revision ?? "unavailable"} · ${record.stale ? "stale / coverage unconfirmed" : "matched at last refresh"}`,
          record.detail,
          record.output ?? "Output unavailable.",
          record.artifactPaths?.length
            ? `Artifacts:\n${record.artifactPaths.join("\n")}`
            : undefined,
        ]
          .filter(Boolean)
          .join("\n\n"),
      );
      setCopied(record.id);
    } catch (cause) {
      setError(
        `Could not copy evidence: ${cause instanceof Error ? cause.message : String(cause)}`,
      );
    }
  }

  return (
    <section className="evidence-list" aria-label="Verification evidence" aria-busy={refreshing}>
      <div className="row">
        <strong>Verification evidence</strong>
        <span className="spacer" />
        <button className="btn btn-ghost" disabled={refreshing} onClick={() => void refresh()}>
          {refreshing ? "Refreshing…" : "Refresh evidence"}
        </button>
      </div>
      <p className="hint">
        Observed tools, not a completion claim. Refresh checks workspace coverage; it does not rerun
        checks.
      </p>
      {error && (
        <div className="banner" role="alert">
          {error}
        </div>
      )}
      {records.length === 0 && (
        <p className="hint">No command or browser evidence recorded for this request.</p>
      )}
      {!browserEvidence && (
        <p className="hint">Browser behavior unverified — no browser evidence recorded.</p>
      )}
      {records.map((record) => {
        const status =
          record.kind === "command"
            ? record.exitCode === undefined
              ? record.status === "failed"
                ? "Invocation failed · exit unknown"
                : "Exit status unknown"
              : `Exit ${record.exitCode}${record.status === "failed" && record.exitCode === 0 ? " · invocation failed" : ""}`
            : record.status === "passed"
              ? "Structured assertion passed"
              : record.status === "failed"
                ? "Browser assertion or invocation failed"
                : "Observed · browser unverified";
        return (
          <details className="tool-card evidence-record" key={record.id}>
            <summary className="tool-header">
              <span className="chip">{record.kind}</span>
              <span className="tool-arg mono" title={record.label}>
                {record.label}
              </span>
              <span className="hint">{status}</span>
              <span className={`chip${record.stale ? " warn-chip" : ""}`}>
                {record.stale ? "Stale / unconfirmed" : "Revision matched"}
              </span>
            </summary>
            <div className="evidence-body">
              <p className="hint">{record.detail}</p>
              <dl className="evidence-meta">
                <dt>Started</dt>
                <dd>
                  <time dateTime={record.startedAt}>
                    {new Date(record.startedAt).toLocaleString()}
                  </time>
                </dd>
                <dt>Finished</dt>
                <dd>
                  <time dateTime={record.finishedAt}>
                    {new Date(record.finishedAt).toLocaleString()}
                  </time>
                </dd>
                <dt>Revision</dt>
                <dd className="mono">
                  {record.revision ?? "Unavailable — coverage cannot be confirmed"}
                </dd>
                <dt>Coverage</dt>
                <dd>
                  {record.stale
                    ? "Workspace changed, changed during execution, or could not be fingerprinted. Rerun verification for current work."
                    : "Workspace matched the recorded revision at the last capture or refresh. Later edits are detected on refresh."}
                </dd>
              </dl>
              {record.output ? (
                <pre className="tool-output">{record.output}</pre>
              ) : (
                <p className="hint">Output unavailable.</p>
              )}
              {record.artifactPaths?.length ? (
                <div>
                  <strong>Observed artifact references</strong>
                  <ul>
                    {record.artifactPaths.map((path) => (
                      <li className="mono" key={path}>
                        {path}
                      </li>
                    ))}
                  </ul>
                  <p className="hint">
                    References were exposed by the tool; artifact presence is not a passing
                    assertion.
                  </p>
                </div>
              ) : record.kind === "browser" ? (
                <p className="hint">No browser artifact reference was exposed.</p>
              ) : null}
              <button className="btn btn-ghost" onClick={() => void copy(record)}>
                {copied === record.id ? "Copied evidence" : "Copy evidence"}
              </button>
            </div>
          </details>
        );
      })}
    </section>
  );
}
