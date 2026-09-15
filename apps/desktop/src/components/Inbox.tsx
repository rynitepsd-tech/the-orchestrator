/** Cross-session triage: intervention first, live work next, published answers last. */

import type { TaskSnapshot } from "@orchestrator/protocol";
import { isActiveRunState } from "@orchestrator/protocol";
import type { JSX } from "react";
import { useRef, useState } from "react";
import { engine } from "../engine-client";
import { basename } from "../lib/prefs";
import type { SessionView, TranscriptItem } from "../store";
import {
  activeTask,
  advisorsReviewing,
  fmtCount,
  publishedAnswer,
  taskPhaseLabel,
  useStore,
} from "../store";

type PendingItem = Extract<TranscriptItem, { kind: "approval" | "interaction" }>;
type Tier = "attention" | "working" | "finished";
type ActionState = { busy?: string; error?: string };

interface InboxProps {
  onResume: (view: SessionView) => Promise<void>;
  onRestore: () => Promise<void>;
  restoring: boolean;
  restoreCount: number;
}

function tier(view: SessionView): Tier | undefined {
  const task = activeTask(view);
  const state = view.summary.runState;
  if (
    view.pendingInteractions > 0 ||
    state === "waiting" ||
    view.interrupted ||
    state === "error" ||
    state === "interrupted" ||
    task?.phase === "blocked" ||
    task?.phase === "error" ||
    task?.phase === "interrupted"
  )
    return "attention";
  if ((task && task.phase !== "complete") || isActiveRunState(state) || advisorsReviewing(view)) {
    return "working";
  }
  if (task?.reviewStatus === "incomplete") return "attention";
  if (view.summary.unread && task?.phase === "complete" && publishedAnswer(view)) {
    return "finished";
  }
  return undefined;
}

function stateLabel(view: SessionView): string {
  const task = activeTask(view);
  if (view.interrupted || view.summary.runState === "interrupted") return "Interrupted";
  if (view.summary.runState === "error") return "Failed";
  if (task) {
    if (task.phase === "blocked" && task.reviewStatus === "incomplete")
      return "Blocked · Review incomplete";
    return task.phase === "complete" && task.reviewStatus === "incomplete"
      ? "Review incomplete"
      : taskPhaseLabel(task.phase);
  }
  if (advisorsReviewing(view)) return "Reviewing";
  if (view.summary.runState === "waiting") return "Needs input";
  if (view.summary.runState === "completed") return "Finished";
  return view.summary.activity ?? "Working";
}

function snippet(text: string, limit = 220): string {
  const compact = text.replace(/\s+/g, " ").trim();
  return compact.length > limit ? `${compact.slice(0, limit)}…` : compact;
}

function errorMessage(error: unknown): string {
  if (
    error &&
    typeof error === "object" &&
    "message" in error &&
    typeof error.message === "string"
  ) {
    return error.message;
  }
  return String(error);
}

function evidenceSummary(task: TaskSnapshot): string {
  if (task.evidence.length === 0) return "No verification evidence recorded.";
  let stale = 0;
  let passed = 0;
  let failed = 0;
  let observed = 0;
  for (const evidence of task.evidence) {
    if (evidence.stale) stale++;
    else if (evidence.status === "passed") passed++;
    else if (evidence.status === "failed") failed++;
    else observed++;
  }
  return [
    passed > 0 ? `${fmtCount(passed)} current passed` : undefined,
    failed > 0 ? `${fmtCount(failed)} current failed` : undefined,
    observed > 0 ? `${fmtCount(observed)} observed / unverified` : undefined,
    stale > 0 ? `${fmtCount(stale)} stale — recheck needed` : undefined,
  ]
    .filter(Boolean)
    .join(" · ");
}

export function Inbox({ onResume, onRestore, restoring, restoreCount }: InboxProps): JSX.Element {
  const sessions = useStore((s) => s.sessions);
  const select = useStore((s) => s.select);
  const markRead = useStore((s) => s.markRead);
  const online = useStore((s) => s.engineStage === "ready");
  const [actions, setActions] = useState<Record<string, ActionState>>({});
  const running = useRef(new Set<string>());
  const [restoreState, setRestoreState] = useState<ActionState>({});
  const restoringRef = useRef(false);
  const groups: Record<Tier, SessionView[]> = { attention: [], working: [], finished: [] };
  const views = Object.values(sessions).sort((a, b) =>
    (b.summary.lastActivityAt ?? "").localeCompare(a.summary.lastActivityAt ?? ""),
  );
  for (const view of views) {
    const group = tier(view);
    if (group) groups[group].push(view);
  }
  const empty = Object.values(groups).every((group) => group.length === 0);

  const act = async (id: string, label: string, operation: () => Promise<unknown>) => {
    if (running.current.has(id)) return;
    running.current.add(id);
    setActions((previous) => ({ ...previous, [id]: { busy: label } }));
    try {
      await operation();
      setActions((previous) => ({ ...previous, [id]: {} }));
    } catch (error) {
      setActions((previous) => ({
        ...previous,
        [id]: { error: `${label.replace(/…$/, "")} failed: ${errorMessage(error)}` },
      }));
    } finally {
      running.current.delete(id);
    }
  };

  const restore = async () => {
    if (restoring || restoringRef.current) return;
    restoringRef.current = true;
    setRestoreState({ busy: "Restoring…" });
    try {
      await onRestore();
      setRestoreState({});
    } catch (error) {
      setRestoreState({ error: `Restore failed: ${errorMessage(error)}` });
    } finally {
      restoringRef.current = false;
    }
  };

  return (
    <div className="inbox">
      <div className="row usage-toolbar">
        <h2 style={{ margin: 0 }}>Inbox</h2>
        <span className="hint">What needs you, what is working, and what is ready</span>
        <span className="spacer" />
        {(restoreCount > 0 || restoring || restoreState.busy) && (
          <button
            className="btn"
            disabled={!online || restoring || !!restoreState.busy || restoreCount === 0}
            title="Restore saved sessions without resending their prompts"
            onClick={() => void restore()}
          >
            {restoring || restoreState.busy
              ? "Restoring…"
              : `Restore ${fmtCount(restoreCount)} ${restoreCount === 1 ? "session" : "sessions"}`}
          </button>
        )}
      </div>
      {restoreState.error && (
        <div className="inbox-snippet" style={{ color: "var(--danger)" }} role="alert">
          {restoreState.error}
        </div>
      )}
      {empty && (
        <div className="empty" style={{ marginTop: "14vh" }}>
          <h3>Inbox zero</h3>
          Nothing needs you right now.{" "}
          {restoreCount > 0
            ? "Saved sessions are available to restore above."
            : "No active tasks or unread answers."}
        </div>
      )}
      {(["attention", "working", "finished"] as const).map(
        (group) =>
          groups[group].length > 0 && (
            <section className="inbox-section" key={group}>
              <div className="section-label">
                {{ attention: "Needs attention", working: "Working", finished: "Finished" }[group]}{" "}
                · {fmtCount(groups[group].length)}
              </div>
              {groups[group].map((view) => (
                <InboxItem
                  key={view.summary.sessionId}
                  view={view}
                  group={group}
                  action={actions[view.summary.sessionId]}
                  onOpen={select}
                  onMarkRead={markRead}
                  onResume={() => act(view.summary.sessionId, "Resuming…", () => onResume(view))}
                  onRetryReview={() =>
                    act(view.summary.sessionId, "Retrying review…", async () => {
                      const task = activeTask(view);
                      if (!task) throw new Error("No task is available for review.");
                      const result = await engine.request("session.task.retryReview", {
                        sessionId: view.summary.sessionId,
                        requestId: task.requestId,
                      });
                      if (!result.accepted)
                        throw new Error(
                          "Review was not started. Open the session to check its current state.",
                        );
                    })
                  }
                  onRespond={(approvalId, optionId) =>
                    act(view.summary.sessionId, "Sending response…", () =>
                      engine.request("approval.respond", {
                        sessionId: view.summary.sessionId,
                        approvalId,
                        optionId,
                      }),
                    )
                  }
                />
              ))}
            </section>
          ),
      )}
    </div>
  );
}

function InboxItem({
  view,
  group,
  action,
  onOpen,
  onMarkRead,
  onResume,
  onRetryReview,
  onRespond,
}: {
  view: SessionView;
  group: Tier;
  action?: ActionState;
  onOpen: (id: string) => void;
  onMarkRead: (id: string) => void;
  onResume: () => Promise<void>;
  onRetryReview: () => Promise<void>;
  onRespond: (approvalId: string, optionId: string) => Promise<void>;
}): JSX.Element {
  const task = activeTask(view);
  const online = useStore((s) => s.engineStage === "ready");
  const answer = group === "finished" ? publishedAnswer(view) : undefined;
  const pending = view.transcript.filter(
    (item): item is PendingItem =>
      (item.kind === "approval" || item.kind === "interaction") && item.state === "pending",
  );
  const findings =
    task?.findings.filter(
      (finding) =>
        finding.revision === task.revision &&
        (finding.resolution === "pending" || finding.resolution === "unresolved"),
    ) ?? [];
  const interrupted =
    view.interrupted || view.summary.runState === "interrupted" || task?.phase === "interrupted";
  const retryReview = task?.phase === "blocked" && task.reviewStatus === "incomplete";
  const resumeDisabled = !online || !!action?.busy || isActiveRunState(view.summary.runState);
  const recoveryDisabled = resumeDisabled || !!view.interrupted || view.pendingInteractions > 0;
  const dot = group === "finished" ? "finished" : group === "attention" ? "attention" : "active";
  const label = stateLabel(view);
  const error = view.error?.message ?? view.summary.error?.message;

  return (
    <div
      className={`inbox-card${group === "attention" ? " attention-card" : ""}`}
      aria-busy={!!action?.busy}
    >
      <div className="row">
        <span className={`dot ${dot}`} aria-hidden />
        <span className="inbox-title">{view.summary.title}</span>
        <span className="chip mono">{basename(view.summary.projectPath)}</span>
        <span className="chip">{label}</span>
        <span className="spacer" />
        {group === "finished" && (
          <button className="btn btn-ghost" onClick={() => onMarkRead(view.summary.sessionId)}>
            Mark reviewed
          </button>
        )}
        {interrupted && (
          <button
            className="btn"
            disabled={resumeDisabled}
            title="Restore this session without resending its prompt"
            onClick={() => void onResume()}
          >
            Resume
          </button>
        )}
        {retryReview && (
          <button
            className="btn"
            disabled={recoveryDisabled}
            title={
              recoveryDisabled
                ? "Resume interrupted sessions, finish current activity, and resolve pending input before retrying review"
                : "Retry the incomplete review, not the original prompt"
            }
            onClick={() => void onRetryReview()}
          >
            Retry review
          </button>
        )}
        <button className="btn" onClick={() => onOpen(view.summary.sessionId)}>
          Open
        </button>
      </div>
      {view.summary.activity && group !== "finished" && view.summary.activity !== label && (
        <div className="inbox-snippet hint">{snippet(view.summary.activity)}</div>
      )}
      {group !== "finished" && task?.reviewDetail && (
        <div className="inbox-snippet hint">{snippet(task.reviewDetail)}</div>
      )}
      {group !== "finished" && findings.length > 0 && (
        <div className="inbox-snippet hint">
          {fmtCount(findings.length)} open review {findings.length === 1 ? "finding" : "findings"} ·{" "}
          {findings[0].severity}: {snippet(findings[0].text, 160)}
        </div>
      )}
      {task && <div className="inbox-snippet hint">Evidence: {evidenceSummary(task)}</div>}
      {answer && <div className="inbox-snippet hint">{snippet(answer.text)}</div>}
      {group === "attention" && error && (
        <div className="inbox-snippet" style={{ color: "var(--danger)" }}>
          {snippet(error)}
        </div>
      )}
      {interrupted && (
        <div className="inbox-snippet hint">
          Resume restores the session; it does not resend your request.
        </div>
      )}
      {pending.length === 0 &&
        (view.pendingInteractions > 0 || view.summary.runState === "waiting") && (
          <div className="inbox-snippet hint">Input is pending — open the session to respond.</div>
        )}
      {pending.map((item) =>
        item.kind === "approval" ? (
          <div key={item.id} className="inbox-approval">
            <span className="chip">{item.toolName}</span>
            <span className="tool-arg mono" title={item.detail ?? item.summary}>
              {item.summary}
            </span>
            <span className="spacer" />
            {item.options.map((option) => (
              <button
                key={option.id}
                className={`btn ${option.kind === "deny" ? "btn-danger" : option.kind === "allow" ? "btn-primary" : ""}`}
                disabled={!!action?.busy}
                onClick={() => void onRespond(item.approvalId, option.id)}
              >
                {option.label}
              </button>
            ))}
          </div>
        ) : (
          <div key={item.id} className="inbox-approval">
            <span className="chip">{item.extensionName}</span>
            <span className="hint">
              {"title" in item.ui
                ? snippet(item.ui.title, 160)
                : "message" in item.ui
                  ? snippet(item.ui.message, 160)
                  : snippet(item.ui.description, 160)}{" "}
              — open to respond.
            </span>
          </div>
        ),
      )}
      {action?.busy && (
        <div className="inbox-snippet hint" role="status">
          {action.busy}
        </div>
      )}
      {action?.error && (
        <div className="inbox-snippet" style={{ color: "var(--danger)" }} role="alert">
          {action.error}
        </div>
      )}
    </div>
  );
}
