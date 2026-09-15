import type { SessionId, VerificationEvidence } from "@orchestrator/protocol";
import type { JSX } from "react";
import { useState } from "react";
import { engine } from "../engine-client";

const RECENT_RUNS = 8;

/** Tool outcomes are supporting context, not a second answer or a test-success badge. */
export function EvidenceList({
  sessionId,
  requestId,
  evidence,
}: {
  sessionId: SessionId;
  requestId: string;
  evidence: VerificationEvidence[];
}): JSX.Element {
  const [expanded, setExpanded] = useState(false);
  const [showAll, setShowAll] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string>();
  const [copied, setCopied] = useState<string>();
  const records = evidence.filter((record) => record.requestId === requestId);
  const failed = records.filter((record) => record.status === "failed").length;
  const incomplete = records.some((record) => record.stale || !record.revision);
  const visible = showAll ? records : records.slice(-RECENT_RUNS);

  async function refresh() {
    if (refreshing) return;
    setRefreshing(true);
    setError(undefined);
    try {
      // task.updated owns the refreshed records; this does not rerun any tools.
      await engine.request("session.evidence.refresh", { sessionId, requestId });
    } catch (cause) {
      setError(
        `Could not check coverage: ${cause instanceof Error ? cause.message : String(cause)}`,
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
          `Revision: ${record.revision ?? "unavailable"} · ${record.stale ? "coverage unconfirmed" : "matched at last capture"}`,
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
    <details
      className="evidence-list"
      aria-label="Verification evidence"
      onToggle={(event) => setExpanded(event.currentTarget.open)}
    >
      <summary className="evidence-summary">
        <span>Checks &amp; activity</span>
        <span className="evidence-count">
          {records.length === 0
            ? "No recorded runs"
            : `${records.length} ${records.length === 1 ? "run" : "runs"}`}
        </span>
        {failed > 0 && (
          <span className="evidence-failure">
            {failed} failed {failed === 1 ? "run" : "runs"}
          </span>
        )}
        {incomplete && <span className="evidence-count">Coverage incomplete</span>}
      </summary>
      {expanded && (
        <div className="evidence-content" aria-busy={refreshing}>
          <div className="evidence-toolbar">
            <p className="hint">Recorded tool outcomes, not a claim that every check passed.</p>
            <button
              className="btn btn-ghost"
              disabled={refreshing || records.length === 0}
              onClick={() => void refresh()}
              title="Compare workspace coverage without rerunning tools"
            >
              {refreshing ? "Checking…" : "Check coverage"}
            </button>
          </div>
          {error && (
            <div className="banner" role="alert">
              {error}
            </div>
          )}
          {records.length === 0 ? (
            <p className="hint">No command or browser evidence was captured for this request.</p>
          ) : (
            <>
              {visible.map((record) => (
                <EvidenceRecord
                  key={record.id}
                  record={record}
                  copied={copied === record.id}
                  onCopy={() => void copy(record)}
                />
              ))}
              {records.length > RECENT_RUNS && (
                <div className="evidence-pagination">
                  <span className="hint">
                    {showAll
                      ? `All ${records.length} runs`
                      : `Latest ${RECENT_RUNS} of ${records.length} runs`}
                  </span>
                  <button className="btn btn-ghost" onClick={() => setShowAll(!showAll)}>
                    {showAll ? "Show recent runs" : `Show all ${records.length} runs`}
                  </button>
                </div>
              )}
            </>
          )}
        </div>
      )}
    </details>
  );
}

function EvidenceRecord({
  record,
  copied,
  onCopy,
}: {
  record: VerificationEvidence;
  copied: boolean;
  onCopy: () => void;
}): JSX.Element {
  const [expanded, setExpanded] = useState(false);
  const status =
    record.status === "failed"
      ? record.exitCode === undefined
        ? "Failed"
        : `Failed · exit ${record.exitCode}`
      : record.kind === "command"
        ? record.exitCode === undefined
          ? "Exit unavailable"
          : `Exit ${record.exitCode}`
        : record.status === "passed"
          ? "Assertions passed"
          : "Observed";
  return (
    <details
      className="evidence-record"
      onToggle={(event) => setExpanded(event.currentTarget.open)}
    >
      <summary>
        <span
          className={record.kind === "command" ? "evidence-label mono" : "evidence-label"}
          title={record.label}
        >
          {record.label}
        </span>
        <span
          className={`evidence-outcome${record.status === "failed" ? " evidence-failure" : ""}`}
        >
          {status}
        </span>
      </summary>
      {expanded && (
        <div className="evidence-body">
          <p className="evidence-full-label mono">{record.label}</p>
          <dl className="evidence-meta">
            <dt>Kind</dt>
            <dd>{record.kind === "command" ? "Command" : "Browser"}</dd>
            <dt>Coverage</dt>
            <dd>
              {record.stale || !record.revision
                ? "Not confirmed for the current workspace."
                : "Workspace matched at the last capture. External and browser state are not covered."}
            </dd>
            <dt>Finished</dt>
            <dd>
              <time dateTime={record.finishedAt}>
                {new Date(record.finishedAt).toLocaleString()}
              </time>
            </dd>
            <dt>Revision</dt>
            <dd className="mono">{record.revision ?? "Unavailable"}</dd>
          </dl>
          {record.detail && <p className="hint">{record.detail}</p>}
          {record.output ? (
            <pre className="tool-output">{record.output}</pre>
          ) : (
            <p className="hint">Output unavailable.</p>
          )}
          {record.artifactPaths?.length ? (
            <div className="evidence-artifacts">
              <span className="hint">Recorded artifacts</span>
              <ul>
                {record.artifactPaths.map((path) => (
                  <li className="mono" key={path}>
                    {path}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          <button className="btn btn-ghost" onClick={onCopy}>
            {copied ? "Copied evidence" : "Copy evidence"}
          </button>
        </div>
      )}
    </details>
  );
}
