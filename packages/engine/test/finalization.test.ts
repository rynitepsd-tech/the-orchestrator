import { describe, expect, test } from "bun:test";
import { replayEventsFromEntries } from "@orchestrator/omp-adapter";
import type { TaskSnapshot, VerificationEvidence } from "@orchestrator/protocol";
import type { FinalizationHost, StoredTask } from "../src/worker/finalization";
import { TaskFinalizer } from "../src/worker/finalization";

function harness(overrides: Partial<FinalizationHost> = {}) {
  const snapshots: TaskSnapshot[] = [];
  const stored: StoredTask[] = [];
  const notices: string[] = [];
  const controller = new TaskFinalizer({
    persist(record) {
      stored.push(structuredClone(record));
    },
    updated(task) {
      snapshots.push(structuredClone(task));
    },
    notice(message) {
      notices.push(message);
    },
    stage(_text, _requestId, revision) {
      return `entry-${revision}`;
    },
    review: async () => true,
    reviewRequired: () => true,
    settleWork: async () => true,
    revise: async () => {
      throw new Error("Unexpected primary revision");
    },
    evidence: async () => [],
    ...overrides,
  });
  const requestId = controller.create("Fix the reported defect without changing unrelated files.");
  controller.activate(requestId);
  return { controller, requestId, snapshots, stored, notices };
}

function stage(controller: TaskFinalizer, requestId: string) {
  controller.submit({
    requestId,
    text: "The defect is fixed and the targeted check passes.",
    dispositions: [],
  });
}

describe("durable task finalization", () => {
  test("missing submission never selects transcript text or starts a fallback run", async () => {
    let controller: TaskFinalizer;
    let requestId: string;
    let revisions = 0;
    const h = harness({
      revise: async () => {
        revisions++;
        stage(controller, requestId);
      },
    });
    controller = h.controller;
    requestId = h.requestId;
    await controller.finalize();
    expect(controller.current?.phase).toBe("blocked");
    expect(controller.current?.answer).toBeUndefined();
    expect(revisions).toBe(0);
    await controller.retry(requestId);
    expect(controller.current?.phase).toBe("complete");
    expect(revisions).toBe(1);
  });

  test("boolean false is incomplete, and only explicit retry can commit", async () => {
    let catchup = false;
    let controller: TaskFinalizer;
    let requestId: string;
    const h = harness({
      review: async () => catchup,
      revise: async () => stage(controller, requestId),
    });
    controller = h.controller;
    requestId = h.requestId;
    stage(h.controller, h.requestId);
    await h.controller.finalize();
    expect(h.controller.current?.phase).toBe("blocked");
    expect(h.controller.current?.reviewStatus).toBe("incomplete");
    expect(h.controller.current?.answer).toBeUndefined();
    catchup = true;
    await h.controller.retry(h.requestId);
    expect(h.controller.current?.phase).toBe("complete");
    expect(h.controller.current?.answer?.text).toBe(
      "The defect is fixed and the targeted check passes.",
    );
  });

  test("Stop during evidence refresh fences publication and automatic revision", async () => {
    const refresh = Promise.withResolvers<VerificationEvidence[]>();
    const entered = Promise.withResolvers<void>();
    let revisions = 0;
    const h = harness({
      evidence: () => {
        entered.resolve();
        return refresh.promise;
      },
      revise: async () => {
        revisions++;
      },
    });
    stage(h.controller, h.requestId);
    const pending = h.controller.finalize();
    await entered.promise;
    h.controller.stop();
    refresh.resolve([]);
    await pending;
    expect(h.controller.current?.phase).toBe("interrupted");
    expect(h.controller.current?.answer).toBeUndefined();
    expect(revisions).toBe(0);
  });

  test("Stop cannot be overwritten by a late failed subordinate drain", async () => {
    const drain = Promise.withResolvers<boolean>();
    let calls = 0;
    const entered = Promise.withResolvers<void>();
    const h = harness({
      settleWork: async () => {
        if (++calls === 1) return true;
        entered.resolve();
        return drain.promise;
      },
    });
    stage(h.controller, h.requestId);
    const pending = h.controller.finalize();
    await entered.promise;
    h.controller.stop();
    drain.resolve(false);
    await pending;
    expect(h.controller.current?.phase).toBe("interrupted");
    expect(h.controller.current?.answer).toBeUndefined();
  });

  test("nits do not reopen, and post-publication concerns preserve the exact committed answer across restore", async () => {
    const h = harness();
    stage(h.controller, h.requestId);
    h.controller.finding(
      { id: "nit", advisorName: "Reviewer", severity: "nit", text: "Optional wording polish." },
      { requestId: h.requestId, revision: 1 },
    );
    await h.controller.finalize();
    const answer = structuredClone(h.controller.current?.answer);
    h.controller.finding(
      {
        id: "late",
        advisorName: "Reviewer",
        severity: "concern",
        text: "A newly discovered edge case.",
      },
      { requestId: h.requestId, revision: 1 },
    );
    expect(h.controller.current?.phase).toBe("complete");
    expect(h.controller.current?.answer).toEqual(answer);
    expect(h.notices).toHaveLength(1);
    const restored = harness();
    restored.controller.restore(h.stored);
    expect(restored.controller.current?.answer).toEqual(answer);
    expect(
      restored.controller.current?.findings.find((finding) => finding.id === "late")?.resolution,
    ).toBe("pending");
  });

  test("a finding arriving during evidence refresh requires adjudication against its exact revision", async () => {
    let controller: TaskFinalizer;
    let requestId: string;
    let refreshes = 0;
    const h = harness({
      evidence: async () => {
        if (++refreshes === 1)
          controller.finding(
            {
              id: "race",
              advisorName: "Reviewer",
              severity: "blocker",
              text: "The error path still fails.",
            },
            { requestId, revision: 1 },
          );
        return [];
      },
      revise: async (instruction) => {
        expect(instruction).toContain("Fix the reported defect without changing unrelated files.");
        expect(() =>
          controller.submit({
            requestId,
            text: "Corrected result.",
            dispositions: [
              { findingId: "race", revision: 0, resolution: "accepted", rationale: "Fixed." },
            ],
          }),
        ).toThrow();
        controller.submit({
          requestId,
          text: "Corrected result.",
          dispositions: [
            {
              findingId: "race",
              revision: 1,
              resolution: "accepted",
              rationale: "Fixed the error path and verified the reproduction.",
            },
          ],
        });
      },
    });
    controller = h.controller;
    requestId = h.requestId;
    stage(h.controller, h.requestId);
    await h.controller.finalize();
    expect(h.controller.current?.answer?.text).toBe("Corrected result.");
    expect(h.controller.current?.answer?.revision).toBe(2);
    expect(h.controller.current?.findings[0]?.resolution).toBe("accepted");
  });
  test("a failed superseded review cannot block a steered candidate's new review", async () => {
    const oldReview = Promise.withResolvers<boolean>();
    const entered = Promise.withResolvers<void>();
    const h = harness({
      review: async (owner) => {
        if (owner.revision === 1) {
          entered.resolve();
          return oldReview.promise;
        }
        return true;
      },
    });
    stage(h.controller, h.requestId);
    const pending = h.controller.finalize();
    await entered.promise;
    h.controller.steer("Use the corrected acceptance condition.");
    h.controller.submit({ requestId: h.requestId, text: "Updated result.", dispositions: [] });
    oldReview.reject(new Error("Old round cancelled"));
    await pending;
    expect(h.controller.current?.phase).toBe("complete");
    expect(h.controller.current?.answer?.text).toBe("Updated result.");
    expect(h.controller.current?.answer?.revision).toBe(2);
  });

  test("a cancelled old reviewer cannot attach its note to a newer revision or queued request", async () => {
    const h = harness();
    stage(h.controller, h.requestId);
    const owner = { requestId: h.requestId, revision: 1 };
    h.controller.invalidateCandidate();
    stage(h.controller, h.requestId);
    await h.controller.finalize();
    const firstAnswer = structuredClone(h.controller.current?.answer);
    const nextRequest = h.controller.create("A separate user request.");
    h.controller.activate(nextRequest);
    stage(h.controller, nextRequest);
    h.controller.finding(
      {
        id: "old-round",
        advisorName: "Reviewer",
        severity: "blocker",
        text: "A note emitted by the old cancelled round.",
      },
      owner,
    );
    expect(h.controller.current?.findings).toEqual([]);
    const original = h.controller.records.get(h.requestId)?.task;
    expect(original?.findings[0]?.revision).toBe(1);
    expect(original?.answer).toEqual(firstAnswer);
    await h.controller.finalize();
    expect(h.controller.current?.answer?.requestId).toBe(nextRequest);
    expect(h.controller.current?.phase).toBe("complete");
  });

  test("replay attributes delayed advisor cards using their persisted source owner, not transcript position", () => {
    const events = replayEventsFromEntries("session", [
      {
        type: "custom",
        customType: "orchestrator.review-owner",
        data: {
          sdkName: "sdk-old-round",
          requestId: "old-request",
          revision: 1,
          advisorId: "advisor:reviewer",
          advisorName: "Reviewer",
        },
      },
      {
        type: "custom_message",
        id: "next-request-entry",
        customType: "orchestrator.request",
        details: { requestId: "new-request" },
      },
      {
        type: "custom_message",
        id: "late-card",
        customType: "advisor",
        timestamp: "2026-09-14T00:00:00.000Z",
        details: {
          notes: [{ advisor: "sdk-old-round", note: "Late concern.", severity: "concern" }],
        },
      },
    ]);
    const note = events.find((event) => event.type === "advisor.message");
    expect(note?.userTurnId).toBe("old-request");
    expect(note?.advisorName).toBe("Reviewer");
  });
});
