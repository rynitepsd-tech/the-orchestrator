/** Harness-owned task identity, publication, and observed verification evidence. */
export type TaskPhase =
  | "working"
  | "reviewing"
  | "revising"
  | "finalizing"
  | "complete"
  | "blocked"
  | "interrupted"
  | "error";
export type ReviewStatus = "pending" | "passed" | "incomplete" | "not-required";

export interface VerificationEvidence {
  id: string;
  requestId: string;
  callId: string;
  kind: "command" | "browser";
  label: string;
  status: "passed" | "failed" | "observed" | "unknown";
  exitCode?: number;
  output?: string;
  artifactPaths?: string[];
  startedAt: string;
  finishedAt: string;
  /** Content fingerprint of the workspace before and after execution. */
  revision?: string;
  stale: boolean;
  detail?: string;
}

export interface ReviewFinding {
  id: string;
  advisorName: string;
  severity: "nit" | "concern" | "blocker" | "unknown";
  text: string;
  revision: number;
  resolution: "pending" | "accepted" | "rejected" | "unresolved";
  rationale?: string;
}

export interface PublishedAnswer {
  id: string;
  requestId: string;
  messageId: string;
  text: string;
  at: string;
  revision: number;
  reviewStatus: ReviewStatus;
}

export interface TaskSnapshot {
  requestId: string;
  prompt: string;
  phase: TaskPhase;
  revision: number;
  reviewStatus: ReviewStatus;
  reviewDetail?: string;
  findings: ReviewFinding[];
  evidence: VerificationEvidence[];
  answer?: PublishedAnswer;
  startedAt: string;
  updatedAt: string;
  completedAt?: string;
}

export interface SessionSearchHit {
  sessionPath: string;
  ompSessionId: string;
  projectPath: string;
  title: string;
  entryId: string;
  role: "user" | "assistant";
  snippet: string;
  at?: string;
}

export interface SessionSource {
  hit: SessionSearchHit;
  text: string;
}

export interface ProjectDecision {
  id: string;
  projectPath: string;
  title: string;
  text: string;
  source: { sessionPath: string; entryId: string };
  createdAt: string;
  updatedAt: string;
}
