import { beforeAll, describe, expect, test } from "bun:test";
import type { ProductEvent, TaskSnapshot } from "@orchestrator/protocol";
import type * as StoreModule from "../src/store";

// Browser globals must exist before loading the store; this test intentionally
// delays the module-load boundary rather than statically importing its runtime.
if (!globalThis.localStorage)
  Object.defineProperty(globalThis, "localStorage", {
    value: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
    configurable: true,
  });
if (!globalThis.window)
  Object.defineProperty(globalThis, "window", {
    value: { addEventListener: () => {} },
    configurable: true,
  });
if (!globalThis.document)
  Object.defineProperty(globalThis, "document", {
    value: { hasFocus: () => true, addEventListener: () => {} },
    configurable: true,
  });

let store: typeof StoreModule;
beforeAll(async () => {
  store = await import("../src/store");
});

const SID = "task-continuation";
const at = "2026-09-14T12:00:00.000Z";
const later = "2026-09-14T12:00:01.000Z";
function boot() {
  store.useStore.getState().addSession(
    {
      sessionId: SID,
      projectId: "p",
      projectPath: "/tmp/p",
      title: "Task publication",
      runState: "idle",
      advisorCount: 1,
      messageCount: 0,
      unread: false,
    },
    [],
  );
}
function task(patch: Partial<TaskSnapshot> = {}): TaskSnapshot {
  return {
    requestId: "request-1",
    prompt: "Fix the bug",
    phase: "reviewing",
    revision: 0,
    reviewStatus: "pending",
    findings: [],
    evidence: [],
    startedAt: at,
    updatedAt: at,
    ...patch,
  };
}
function emit(event: Omit<ProductEvent, "sessionId"> | Record<string, unknown>) {
  store.useStore.getState().apply({ sessionId: SID, ...event } as ProductEvent);
}

function committed(): TaskSnapshot {
  return task({
    phase: "complete",
    revision: 1,
    reviewStatus: "passed",
    updatedAt: later,
    answer: {
      id: "answer-1",
      requestId: "request-1",
      messageId: "published-entry",
      text: "Fixed.",
      at: later,
      revision: 1,
      reviewStatus: "passed",
    },
  });
}

describe("explicit task publication", () => {
  test("a pending run end and optimistic steer cannot publish or close review", () => {
    boot();
    emit({ type: "task.updated", task: task() });
    emit({ type: "session.state", runState: "streaming" });
    emit({
      type: "assistant.message.end",
      userTurnId: "request-1",
      messageId: "draft",
      text: "Long draft\n\nStill being reviewed.",
    });
    emit({ type: "session.finished", runState: "completed", userTurnId: "request-1" });
    emit({ type: "user.message", messageId: "u100", text: "Also check the edge case" });
    emit({ type: "advisor.review", active: false });
    const view = store.useStore.getState().sessions[SID];
    expect(store.publishedAnswer(view)).toBeUndefined();
    expect(store.activeTask(view)?.phase).toBe("reviewing");
    expect(store.activeTask(view)?.reviewStatus).toBe("pending");
  });

  test("publication is canonical despite trailing reviewer replies and duplicate snapshots", () => {
    boot();
    const snapshot = committed();
    emit({ type: "task.updated", task: snapshot });
    emit({
      type: "assistant.message.end",
      userTurnId: "request-1",
      messageId: "review-reply",
      text: "Thanks for reviewing.",
    });
    emit({ type: "task.updated", task: structuredClone(snapshot) });
    emit({ type: "task.updated", task: task() });
    const view = store.useStore.getState().sessions[SID];
    expect(store.publishedAnswer(view)).toEqual(snapshot.answer);
    expect(store.activeTask(view)?.phase).toBe("complete");
    expect(view.transcript.find((item) => item.id === "review-reply")).toMatchObject({
      text: "Thanks for reviewing.",
    });
  });

  test("later snapshots cannot silently replace or unpublish a committed answer", () => {
    boot();
    const published = committed();
    emit({ type: "task.updated", task: published });
    emit({
      type: "task.updated",
      task: task({
        phase: "revising",
        revision: 2,
        updatedAt: "2026-09-14T12:00:02.000Z",
      }),
    });
    expect(store.publishedAnswer(store.useStore.getState().sessions[SID])?.text).toBe("Fixed.");
    emit({
      type: "task.updated",
      task: task({
        phase: "complete",
        revision: 3,
        updatedAt: "2026-09-14T12:00:03.000Z",
        answer: { ...published.answer!, id: "replacement", text: "A silently different answer." },
      }),
    });
    const view = store.useStore.getState().sessions[SID];
    expect(store.publishedAnswer(view)?.text).toBe("Fixed.");
    expect(store.activeTask(view)?.phase).toBe("complete");
  });

  test("replay preserves the canonical answer and exact source identity across end events", () => {
    boot();
    const events = [
      {
        type: "assistant.text",
        messageId: "draft-entry",
        userTurnId: "request-1",
        turnId: "run-1",
        sourceEntryId: "omp-entry",
        delta: "Draft",
      },
      { type: "assistant.message.end", messageId: "draft-entry", text: "Draft completed" },
      { type: "task.updated", task: committed() },
    ].map((event) => ({ sessionId: SID, ...event }) as ProductEvent);
    store.useStore.getState().hydrateTranscript(SID, events);
    store.useStore.getState().hydrateTranscript(SID, events);
    const view = store.useStore.getState().sessions[SID];
    expect(store.publishedAnswer(view)?.id).toBe("answer-1");
    expect(view.transcript.find((item) => item.id === "draft-entry")).toMatchObject({
      userTurnId: "request-1",
      turnId: "run-1",
      sourceEntryId: "omp-entry",
      text: "Draft completed",
      streaming: false,
    });
  });

  test("new requests do not inherit a prior published answer", () => {
    boot();
    emit({ type: "task.updated", task: committed() });
    emit({
      type: "task.updated",
      task: task({ requestId: "request-2", phase: "working", startedAt: later, updatedAt: later }),
    });
    emit({ type: "task.updated", task: { ...committed(), updatedAt: "2026-09-14T12:00:02.000Z" } });
    const view = store.useStore.getState().sessions[SID];
    expect(store.activeTask(view)?.requestId).toBe("request-2");
    expect(store.publishedAnswer(view)).toBeUndefined();
    expect(view.tasks["request-1"].answer?.id).toBe("answer-1");
  });

  test("a lost worker during post-run review retains work without publishing it", () => {
    boot();
    emit({ type: "task.updated", task: task() });
    emit({ type: "session.finished", runState: "completed" });
    emit({
      type: "assistant.message.end",
      userTurnId: "request-1",
      messageId: "draft",
      text: "Saved work",
    });
    store.useStore.getState().markAllInterrupted("Worker disconnected");
    const view = store.useStore.getState().sessions[SID];
    expect(store.activeTask(view)?.phase).toBe("interrupted");
    expect(store.activeTask(view)?.reviewStatus).toBe("incomplete");
    expect(store.publishedAnswer(view)).toBeUndefined();
    expect(view.transcript.find((item) => item.id === "draft")).toMatchObject({
      text: "Saved work",
    });
  });
});
