import type { ReviewFinding, TaskSnapshot, VerificationEvidence } from "@orchestrator/protocol";

export const TASK_ENTRY_TYPE = "orchestrator.task";
export const ANSWER_ENTRY_TYPE = "orchestrator.answer";
const MAX_REVISIONS = 3;

export interface AnswerSubmission {
  requestId: string;
  text: string;
  dispositions: Array<{
    findingId: string;
    revision: number;
    resolution: "accepted" | "rejected" | "unresolved";
    rationale: string;
  }>;
}

export interface StoredTask {
  task: TaskSnapshot;
  candidate?: { text: string; messageId: string; revision: number };
}

export interface ReviewOwner {
  requestId: string;
  revision: number;
}

export interface FinalizationHost {
  persist(record: StoredTask): void;
  updated(task: TaskSnapshot): void;
  notice(message: string): void;
  stage(text: string, requestId: string, revision: number): string;
  review(owner: ReviewOwner): Promise<boolean>;
  reviewRequired(): boolean;
  settleWork(): Promise<boolean>;
  revise(instruction: string): Promise<void>;
  evidence(requestId: string): Promise<VerificationEvidence[]>;
}

/** Publication is a commit, not a guess about the last assistant message. */
export class TaskFinalizer {
  readonly records = new Map<string, StoredTask>();
  currentId?: string;
  #epoch = 0;
  #revisionLimit = MAX_REVISIONS;
  #retryReview = false;
  #running?: Promise<void>;

  constructor(private readonly host: FinalizationHost) {}

  get current(): TaskSnapshot | undefined {
    return this.currentId ? this.records.get(this.currentId)?.task : undefined;
  }

  restore(records: StoredTask[]): void {
    this.#epoch++;
    this.records.clear();
    this.currentId = undefined;
    for (const record of records) {
      this.records.set(record.task.requestId, structuredClone(record));
      this.currentId = record.task.requestId;
    }
    // A process boundary cannot prove any in-flight review or execution settled.
    for (const record of this.records.values()) {
      if (!["complete", "blocked", "interrupted", "error"].includes(record.task.phase)) {
        record.task.phase = "interrupted";
        record.task.reviewStatus = "incomplete";
        record.task.reviewDetail =
          "Execution ended before finalization. Resume explicitly; review was not completed.";
        this.#save(record);
      }
    }
  }

  create(prompt: string): string {
    const requestId = crypto.randomUUID();
    const at = new Date().toISOString();
    const record: StoredTask = {
      task: {
        requestId,
        prompt,
        phase: "working",
        revision: 0,
        reviewStatus: "pending",
        findings: [],
        evidence: [],
        startedAt: at,
        updatedAt: at,
      },
    };
    this.records.set(requestId, record);
    this.#save(record);
    return requestId;
  }

  activate(requestId: string): void {
    const record = this.#record(requestId);
    if (record.task.answer) throw new Error("A published task cannot be resumed.");
    this.#epoch++;
    this.currentId = requestId;
    this.#revisionLimit = record.task.revision + MAX_REVISIONS;
    this.#retryReview = false;
    record.task.phase = "working";
    record.task.reviewStatus = "pending";
    record.task.reviewDetail = undefined;
    this.#save(record);
  }

  steer(text: string): void {
    const record = this.#active();
    record.task.prompt += `\n\nUser intent update:\n${text}`;
    record.candidate = undefined;
    record.task.reviewStatus = "pending";
    record.task.phase = "working";
    this.#save(record);
  }
  invalidateCandidate(): boolean {
    const record = this.currentId ? this.records.get(this.currentId) : undefined;
    if (
      !record?.candidate ||
      record.task.answer ||
      ["interrupted", "error", "blocked"].includes(record.task.phase)
    )
      return false;
    record.candidate = undefined;
    record.task.phase = "working";
    record.task.reviewStatus = "pending";
    this.#save(record);
    return true;
  }

  submit(input: AnswerSubmission): number {
    const record = this.#active();
    if (input.requestId !== record.task.requestId)
      throw new Error("submit_answer requestId does not own this run.");
    if (record.candidate && record.task.phase !== "revising")
      throw new Error(
        "This candidate is awaiting review. Do not supersede it before the harness requests a revision.",
      );
    if (!input.text.trim()) throw new Error("An answer must contain user-facing text.");
    if (record.task.revision >= this.#revisionLimit)
      throw new Error("Revision limit reached. Unresolved review requires explicit user action.");
    const seen = new Set<string>();
    for (const disposition of input.dispositions) {
      const finding = record.task.findings.find((item) => item.id === disposition.findingId);
      if (!finding || finding.revision !== disposition.revision || seen.has(finding.id)) {
        throw new Error("Disposition references an unknown, stale, or duplicate finding.");
      }
      if (!disposition.rationale.trim()) throw new Error("Every disposition requires a rationale.");
      seen.add(finding.id);
    }
    for (const disposition of input.dispositions) {
      const finding = record.task.findings.find((item) => item.id === disposition.findingId)!;
      finding.resolution = disposition.resolution;
      finding.rationale = disposition.rationale;
    }
    const revision = ++record.task.revision;
    const messageId = this.host.stage(input.text, input.requestId, revision);
    record.candidate = { text: input.text, messageId, revision };
    record.task.phase = "finalizing";
    record.task.reviewStatus = "pending";
    record.task.reviewDetail = undefined;
    this.#save(record);
    return revision;
  }

  finding(
    note: { id: string; advisorName: string; severity: ReviewFinding["severity"]; text: string },
    owner: ReviewOwner,
  ): void {
    const record = this.records.get(owner.requestId);
    if (!record || record.task.findings.some((item) => item.id === note.id)) return;
    if (owner.revision > record.task.revision)
      throw new Error("Reviewer finding refers to an unknown candidate revision.");
    const finding: ReviewFinding = { ...note, revision: owner.revision, resolution: "pending" };
    record.task.findings.push(finding);
    if (record.task.answer) {
      this.host.notice(
        `Post-publication ${finding.severity} from ${finding.advisorName}: ${finding.text}. The committed answer is unchanged.`,
      );
    }
    this.#save(record);
  }

  stop(detail = "Stopped by the user. No answer was published."): void {
    this.#epoch++;
    for (const record of this.records.values()) {
      if (record.task.answer || ["interrupted", "error"].includes(record.task.phase)) continue;
      if (record.task.requestId !== this.currentId && record.task.phase !== "working") continue;
      record.task.phase = "interrupted";
      record.task.reviewStatus = "incomplete";
      record.task.reviewDetail = detail;
      this.#save(record);
    }
  }

  fail(detail: string): void {
    this.#epoch++;
    if (!this.currentId) return;
    const record = this.#record(this.currentId);
    if (record.task.answer) return;
    record.task.phase = "error";
    record.task.reviewStatus = "incomplete";
    record.task.reviewDetail = detail;
    this.#save(record);
  }

  async refreshEvidence(requestId: string): Promise<VerificationEvidence[]> {
    const record = this.#record(requestId);
    record.task.evidence = await this.host.evidence(requestId);
    this.#save(record);
    return record.task.evidence;
  }

  retry(requestId: string): Promise<void> {
    const record = this.#record(requestId);
    if (record.task.answer || !["blocked", "interrupted", "error"].includes(record.task.phase)) {
      throw new Error("Only an unfinished task can retry review.");
    }
    if (this.#running)
      throw new Error("Finalization is still settling. Retry when the current run stops.");
    this.#revisionLimit = record.task.revision + MAX_REVISIONS;
    this.#retryReview = true;
    this.currentId = requestId;
    this.#epoch++;
    record.task.phase = "reviewing";
    record.task.reviewStatus = "pending";
    record.task.reviewDetail = undefined;
    this.#save(record);
    return this.finalize();
  }

  finalize(): Promise<void> {
    if (this.#running) return this.#running;
    const record = this.#active();
    const epoch = this.#epoch;
    const run = this.#finalize(record, epoch).catch((error) => {
      if (this.#valid(record, epoch))
        this.#block(record, String((error as Error)?.message ?? error));
    });
    this.#running = run.finally(() => {
      this.#running = undefined;
    });
    return this.#running;
  }

  async #finalize(record: StoredTask, epoch: number): Promise<void> {
    // Missing submission is blocked, not guessed or automatically retried.
    // Only the user's explicit retry may request the missing primary answer.
    for (let attempt = 0; attempt <= MAX_REVISIONS; attempt++) {
      if (!this.#valid(record, epoch)) return;
      if (!(await this.host.settleWork())) {
        if (this.#valid(record, epoch))
          this.#block(record, "Required finite work has not settled; completion is not proven.");
        return;
      }
      if (!this.#valid(record, epoch)) return;
      if (this.#retryReview) {
        this.#retryReview = false;
        await this.#revise(record);
        continue;
      }
      if (!record.candidate) {
        this.#block(
          record,
          "The primary did not submit a user-facing answer. Retry explicitly to request one.",
        );
        return;
      }
      const candidate = record.candidate;
      record.task.phase = "reviewing";
      record.task.reviewStatus = this.host.reviewRequired() ? "pending" : "not-required";
      this.#save(record);
      let caughtUp: boolean;
      try {
        caughtUp = await this.host.review({
          requestId: record.task.requestId,
          revision: candidate.revision,
        });
      } catch (error) {
        if (!this.#valid(record, epoch)) return;
        if (record.candidate !== candidate) continue;
        this.#block(record, `Advisor review failed: ${String((error as Error)?.message ?? error)}`);
        return;
      }
      if (!this.#valid(record, epoch)) return;
      if (record.candidate !== candidate) continue;
      if (caughtUp !== true) {
        this.#block(record, "Advisor review did not finish successfully. Retry review explicitly.");
        return;
      }
      const unresolved = record.task.findings.filter(
        (finding) =>
          finding.severity !== "nit" &&
          (finding.resolution === "pending" || finding.resolution === "unresolved"),
      );
      if (unresolved.length) {
        if (record.task.revision >= this.#revisionLimit) {
          this.#block(record, "Review revision limit reached with unresolved findings.");
          return;
        }
        await this.#revise(record);
        continue;
      }
      record.task.phase = "finalizing";
      this.#save(record);
      const evidence = await this.host.evidence(record.task.requestId);
      if (!this.#valid(record, epoch)) return;
      if (record.candidate !== candidate) continue;
      // Evidence refresh can yield while an advisor card arrives.
      if (
        record.task.findings.some(
          (finding) =>
            finding.severity !== "nit" &&
            (finding.resolution === "pending" || finding.resolution === "unresolved"),
        )
      )
        continue;
      if (!(await this.host.settleWork())) {
        if (this.#valid(record, epoch))
          this.#block(record, "Required finite work remains pending.");
        return;
      }
      if (!this.#valid(record, epoch) || record.candidate !== candidate) return;
      if (
        record.task.findings.some(
          (finding) =>
            finding.severity !== "nit" &&
            (finding.resolution === "pending" || finding.resolution === "unresolved"),
        )
      )
        continue;
      const at = new Date().toISOString();
      const committed = structuredClone(record);
      committed.task.evidence = evidence;
      committed.task.reviewStatus = this.host.reviewRequired() ? "passed" : "not-required";
      committed.task.answer = {
        id: crypto.randomUUID(),
        requestId: record.task.requestId,
        messageId: candidate.messageId,
        text: candidate.text,
        at,
        revision: candidate.revision,
        reviewStatus: committed.task.reviewStatus,
      };
      committed.task.phase = "complete";
      committed.task.completedAt = at;
      committed.task.updatedAt = at;
      this.host.persist(committed);
      record.task = committed.task;
      this.host.updated(structuredClone(committed.task));
      return;
    }
    if (this.#valid(record, epoch))
      this.#block(record, "Finalization did not converge within the revision limit.");
  }

  async #revise(record: StoredTask): Promise<void> {
    record.task.phase = record.candidate ? "revising" : "finalizing";
    this.#save(record);
    await this.host.revise(
      `Finalize request ${record.task.requestId}. Original request and explicit intent updates:\n${record.task.prompt}\n\n` +
        `Current candidate revision: ${record.task.revision}. Review findings (retain IDs and revision when adjudicating):\n${JSON.stringify(record.task.findings)}\n\n` +
        "You own the user-facing wording; reviewers own their findings, not your answer. Address each non-nit finding with an accepted, rejected, or unresolved disposition and concrete rationale. Apply and verify warranted corrections. Submit the complete standalone answer to the USER via submit_answer with this requestId. Do not answer the reviewer. Do not claim completion while required finite work remains pending.",
    );
  }

  #valid(record: StoredTask, epoch: number): boolean {
    return (
      this.#epoch === epoch &&
      this.currentId === record.task.requestId &&
      !record.task.answer &&
      !["interrupted", "error", "blocked"].includes(record.task.phase)
    );
  }

  #block(record: StoredTask, detail: string): void {
    record.task.phase = "blocked";
    record.task.reviewStatus = "incomplete";
    record.task.reviewDetail = detail;
    this.#save(record);
  }

  #active(): StoredTask {
    if (!this.currentId) throw new Error("There is no active user request.");
    const record = this.#record(this.currentId);
    if (record.task.answer || ["interrupted", "error", "blocked"].includes(record.task.phase))
      throw new Error("This request is not accepting answers; resume or retry explicitly.");
    return record;
  }

  #record(requestId: string): StoredTask {
    const record = this.records.get(requestId);
    if (!record) throw new Error("Unknown task requestId.");
    return record;
  }

  #save(record: StoredTask): void {
    record.task.updatedAt = new Date().toISOString();
    // Persist a detached record before notifying consumers: the SDK keeps custom
    // data by reference, and subsequent mutations must not rewrite past entries.
    const copy = structuredClone(record);
    this.host.persist(copy);
    this.host.updated(copy.task);
  }
}
