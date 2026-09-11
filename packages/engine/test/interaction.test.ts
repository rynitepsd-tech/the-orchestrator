/**
 * INTERACTION BRIDGE TEST — approvals routed through real worker processes.
 *
 * Exercises the upstream ClientBridge permission gate (acp-permission-gate.ts)
 * end to end: a real AgentSession running a real bash tool call blocks on
 * `approval.request`, the host answers over the protocol, and the decision
 * routes back to the right worker. Two sessions prompting concurrently must
 * hold two independent approvals.
 */
import { describe, expect, test } from "bun:test";
import type { ProductEvent } from "@orchestrator/protocol";
import { useHarness, waitFor } from "./harness";

const h = useHarness({ prefix: "orch-appr", modelIds: ["mock-alpha", "mock-bravo", "mock-appr"] });
const { eventsFor, eventsOfType, finishedFor, makeProject } = h;

function approvalsFor(sessionId: string) {
  return eventsOfType(sessionId, "approval.request");
}

describe("approval bridge", () => {
  test("a gated bash call blocks on approval.request and Allow executes it", async () => {
    const s = await h.manager.create({
      projectPath: makeProject("allow"),
      title: "Approve me",
      model: "mockprov/mock-alpha",
      advisors: [],
      approvalMode: "always-ask",
    });

    await h.manager.route(s.sessionId, "session.prompt", {
      sessionId: s.sessionId,
      text: "run the tool",
    });

    // The worker must surface the approval, not silently run the tool.
    expect(await waitFor(() => approvalsFor(s.sessionId).length > 0)).toBe(true);
    const req = approvalsFor(s.sessionId)[0];
    expect(req.toolName).toBe("bash");
    expect(req.options.some((o) => o.kind === "allow")).toBe(true);
    expect(req.options.some((o) => o.kind === "deny")).toBe(true);
    // The exact command is shown to the user before deciding.
    expect(String(req.detail ?? req.summary)).toContain("echo");

    // While pending, the session reports waiting — not fake progress.
    const states = eventsFor(s.sessionId).filter((e) => e.type === "session.state") as any[];
    expect(states.some((e) => e.runState === "waiting")).toBe(true);

    // No tool result may exist before the decision.
    expect(eventsFor(s.sessionId).some((e) => e.type === "tool.end")).toBe(false);

    const res = await h.manager.route<{ ok: boolean }>(s.sessionId, "approval.respond", {
      sessionId: s.sessionId,
      approvalId: req.approvalId,
      optionId: "allow_once",
    });
    expect(res.ok).toBe(true);

    expect(await waitFor(() => finishedFor(s.sessionId).length > 0)).toBe(true);
    const toolEnd = eventsFor(s.sessionId).find((e) => e.type === "tool.end") as any;
    expect(toolEnd?.ok).toBe(true);
    expect(toolEnd?.output).toContain("ALPHA-FROM-TOOL");
    const resolved = eventsFor(s.sessionId).find((e) => e.type === "approval.resolved") as any;
    expect(resolved?.optionId).toBe("allow_once");
    expect(finishedFor(s.sessionId)[0].runState).toBe("completed");
  }, 60_000);

  test("Reject blocks the tool without killing the session", async () => {
    const s = await h.manager.create({
      projectPath: makeProject("deny"),
      title: "Deny me",
      model: "mockprov/mock-bravo",
      advisors: [],
      approvalMode: "always-ask",
    });
    await h.manager.route(s.sessionId, "session.prompt", {
      sessionId: s.sessionId,
      text: "run the tool",
    });

    expect(await waitFor(() => approvalsFor(s.sessionId).length > 0)).toBe(true);
    const req = approvalsFor(s.sessionId)[0];
    await h.manager.route(s.sessionId, "approval.respond", {
      sessionId: s.sessionId,
      approvalId: req.approvalId,
      optionId: "reject_once",
    });

    expect(await waitFor(() => finishedFor(s.sessionId).length > 0)).toBe(true);
    const toolEnd = eventsFor(s.sessionId).find((e) => e.type === "tool.end") as any;
    expect(toolEnd?.ok).toBe(false);
    // The tool result reports the user's rejection to the model…
    expect(String(toolEnd?.error ?? toolEnd?.output)).toMatch(/reject/i);
    // …and the tool NEVER ran.
    expect(String(toolEnd?.output ?? "")).not.toContain("BRAVO-FROM-TOOL");
    // The session finishes normally rather than erroring out.
    expect(finishedFor(s.sessionId)[0].runState).toBe("completed");
  }, 60_000);

  test("two sessions hold two independent approvals; answering one releases only it", async () => {
    const a = await h.manager.create({
      projectPath: makeProject("conA"),
      title: "A",
      model: "mockprov/mock-alpha",
      advisors: [],
      approvalMode: "always-ask",
    });
    const b = await h.manager.create({
      projectPath: makeProject("conB"),
      title: "B",
      model: "mockprov/mock-bravo",
      advisors: [],
      approvalMode: "always-ask",
    });

    await h.manager.route(a.sessionId, "session.prompt", { sessionId: a.sessionId, text: "go" });
    await h.manager.route(b.sessionId, "session.prompt", { sessionId: b.sessionId, text: "go" });

    expect(
      await waitFor(
        () => approvalsFor(a.sessionId).length > 0 && approvalsFor(b.sessionId).length > 0,
      ),
    ).toBe(true);

    const reqA = approvalsFor(a.sessionId)[0];
    const reqB = approvalsFor(b.sessionId)[0];
    expect(reqA.approvalId).not.toBe(reqB.approvalId);

    // Approve A only.
    await h.manager.route(a.sessionId, "approval.respond", {
      sessionId: a.sessionId,
      approvalId: reqA.approvalId,
      optionId: "allow_once",
    });
    expect(await waitFor(() => finishedFor(a.sessionId).length > 0)).toBe(true);

    // B is still pending — no tool result, no finish.
    expect(finishedFor(b.sessionId).length).toBe(0);
    expect(eventsFor(b.sessionId).some((e) => e.type === "tool.end")).toBe(false);

    // Now release B too.
    await h.manager.route(b.sessionId, "approval.respond", {
      sessionId: b.sessionId,
      approvalId: reqB.approvalId,
      optionId: "allow_once",
    });
    expect(await waitFor(() => finishedFor(b.sessionId).length > 0)).toBe(true);
    const toolB = eventsFor(b.sessionId).find((e) => e.type === "tool.end") as any;
    expect(toolB?.output).toContain("BRAVO-FROM-TOOL");
  }, 90_000);

  test("setApprovalMode yolo stops prompting for later turns", async () => {
    const s = await h.manager.create({
      projectPath: makeProject("yolo"),
      title: "Yolo",
      model: "mockprov/mock-appr",
      advisors: [],
      approvalMode: "always-ask",
    });
    const set = await h.manager.route<{ ok: boolean }>(s.sessionId, "session.setApprovalMode", {
      sessionId: s.sessionId,
      mode: "yolo",
    });
    expect(set.ok).toBe(true);

    await h.manager.route(s.sessionId, "session.prompt", { sessionId: s.sessionId, text: "go" });
    expect(await waitFor(() => finishedFor(s.sessionId).length > 0)).toBe(true);
    expect(approvalsFor(s.sessionId).length).toBe(0);
    const toolEnd = eventsFor(s.sessionId).find((e) => e.type === "tool.end") as any;
    expect(toolEnd?.ok).toBe(true);
  }, 60_000);
});

describe("transcript replay", () => {
  test("session.transcript rebuilds the full event history, incrementally", async () => {
    const s = await h.manager.create({
      projectPath: makeProject("replay"),
      title: "Replay",
      model: "mockprov/mock-alpha",
      advisors: [],
    });
    await h.manager.route(s.sessionId, "session.prompt", { sessionId: s.sessionId, text: "hello" });
    expect(await waitFor(() => finishedFor(s.sessionId).length > 0)).toBe(true);

    const full = await h.manager.route<{ events: ProductEvent[]; sequence: number }>(
      s.sessionId,
      "session.transcript",
      { sessionId: s.sessionId },
    );
    const types = full.events.map((e) => e.type);
    expect(types).toContain("user.message");
    expect(types).toContain("assistant.text");
    expect(types).toContain("tool.end");
    expect(types).toContain("session.finished");
    expect(full.sequence).toBe(full.events.length);

    // Incremental fetch from the tip returns nothing new.
    const tail = await h.manager.route<{ events: ProductEvent[]; sequence: number }>(
      s.sessionId,
      "session.transcript",
      { sessionId: s.sessionId, sinceSequence: full.sequence },
    );
    expect(tail.events.length).toBe(0);
    expect(tail.sequence).toBe(full.sequence);
  }, 60_000);
});
