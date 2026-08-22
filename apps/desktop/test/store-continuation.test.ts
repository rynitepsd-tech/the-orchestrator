/**
 * Advisor-triggered revisions must fold into the user turn they revise.
 *
 * The sequence that produced two full answers back to back: the primary
 * finishes (marker lands), an advisor blocker arrives, OMP starts a
 * continuation turn with no prompt, and the model restates its whole answer.
 * The continuation's `session.finished` (flagged) must MOVE the marker to
 * the tail, so the transcript sees one segment and folds the draft.
 */
import { beforeAll, describe, expect, test } from "bun:test";

// The store touches browser globals at module load and inside apply().
(globalThis as any).localStorage ??= {
  getItem: () => null,
  setItem: () => {},
  removeItem: () => {},
};
(globalThis as any).window ??= { addEventListener: () => {} };
(globalThis as any).document ??= { hasFocus: () => true, addEventListener: () => {} };

let useStore: typeof import("../src/store").useStore;
beforeAll(async () => {
  ({ useStore } = await import("../src/store"));
});

const SID = "s1";
const ev = (e: Record<string, unknown>) =>
  useStore.getState().apply({ sessionId: SID, ...e } as never);

function boot() {
  useStore.getState().addSession(
    {
      sessionId: SID,
      projectId: "p",
      projectPath: "/tmp/p",
      title: "t",
      runState: "idle",
      advisorCount: 1,
      messageCount: 0,
      unread: false,
    },
    [],
  );
}

const kinds = () => useStore.getState().sessions[SID].transcript.map((i) => i.kind);

describe("advisor continuation turns", () => {
  test("the finished marker moves after the revised answer, summing wall time", () => {
    boot();
    ev({ type: "user.message", messageId: "u1", text: "hi", at: "" });
    ev({ type: "assistant.text", messageId: "a1", delta: "first full answer" });
    ev({ type: "session.finished", runState: "completed", durationMs: 1_000 });
    expect(kinds()).toEqual(["user", "assistant", "turn-end"]);

    ev({
      type: "advisor.message",
      advisorId: "advisor:x",
      advisorName: "x",
      severity: "blocker",
      text: "wrong",
      messageId: "adv1",
      at: "",
    });
    ev({ type: "session.state", runState: "starting" });
    ev({ type: "assistant.text", messageId: "a2", delta: "revised full answer" });
    ev({ type: "session.finished", runState: "completed", durationMs: 500, continuation: true });

    expect(kinds()).toEqual(["user", "assistant", "advisor", "assistant", "turn-end"]);
    const marker = useStore.getState().sessions[SID].transcript.at(-1);
    expect(marker?.kind === "turn-end" && marker.durationMs).toBe(1_500);
  });

  test("a queued user message after the marker starts a genuinely new turn", () => {
    boot();
    ev({ type: "assistant.text", messageId: "b1", delta: "answer" });
    ev({ type: "session.finished", runState: "completed", durationMs: 1_000 });
    ev({ type: "user.message", messageId: "u2", text: "next", at: "" });
    ev({ type: "assistant.text", messageId: "b2", delta: "answer two" });
    // The worker can't always tell a queued follow-up from a continuation;
    // the user message between them is what makes it a new turn.
    ev({ type: "session.finished", runState: "completed", durationMs: 500, continuation: true });
    expect(kinds()).toEqual(["assistant", "turn-end", "user", "assistant", "turn-end"]);
  });
});
