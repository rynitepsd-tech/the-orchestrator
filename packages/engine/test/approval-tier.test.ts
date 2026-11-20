/**
 * APPROVAL TIER — "always ask" must gate OMP's own tool tiers, not just bash,
 * and must ASK rather than refuse.
 *
 * The client bridge only prompts for bash and destructive file operations.
 * Every other tool (write, eval, browser, MCP…) is gated by OMP's tier system,
 * which reads `tools.approvalMode` and defaults to "yolo". The worker overrides
 * that setting per session. Both gates have silently broken on an OMP bump:
 *
 *  - 18.4 changed the override API and the old probe skipped, so a write in an
 *    "always ask" session would have run unprompted.
 *  - 19.0 resolves bash's approval before consulting the bridge, so the
 *    worker's `tools.approval.bash: allow` (there to stop a second prompt)
 *    made every shell command run unprompted; and the tier gate started
 *    asking through `ui.approve()` / a three-option select, which the old
 *    two-option matcher did not recognise.
 *
 * These drive a real worker and real `write` / `bash` tool calls.
 */
import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { useHarness, waitFor } from "./harness";

const h = useHarness({ prefix: "orch-tier", modelIds: ["mock-write", "mock-alpha"] });
const { eventsFor, makeProject } = h;

/** A blocking interaction: a bridge approval or an extension confirm. */
function blockingRequests(sessionId: string) {
  return eventsFor(sessionId).filter(
    (e) => e.type === "approval.request" || e.type === "extension.ui.request",
  ) as any[];
}

/** Start an always-ask session, prompt the write, and wait for its approval card. */
async function pendingWrite(tag: string) {
  const project = makeProject(tag);
  const s = await h.manager.create({
    projectPath: project,
    title: `Tier ${tag}`,
    model: "mockprov/mock-write",
    advisors: [],
    approvalMode: "always-ask",
  });
  await h.manager.route(s.sessionId, "session.prompt", {
    sessionId: s.sessionId,
    text: "write the file",
  });
  // The tier gate must ASK — not refuse, and never run unprompted.
  expect(await waitFor(() => blockingRequests(s.sessionId).length > 0, 30_000)).toBe(true);
  expect(existsSync(join(project, "gated.txt"))).toBe(false);
  const req = blockingRequests(s.sessionId)[0];
  return { project, sessionId: s.sessionId, req };
}

async function answer(sessionId: string, req: any, kind: "allow" | "deny") {
  if (req.type === "approval.request") {
    const opt = req.options.find((o: any) => o.kind === kind);
    expect(opt).toBeDefined();
    await h.manager.route(sessionId, "approval.respond", {
      sessionId,
      approvalId: req.approvalId,
      optionId: opt.id,
    });
  } else {
    await h.manager.route(sessionId, "extension.ui.respond", {
      sessionId,
      requestId: req.requestId,
      cancelled: kind === "deny",
      value: kind === "allow" ? "Approve" : undefined,
    });
  }
}

describe("approval tier gate", () => {
  test("always-ask asks before a write; the card names the tool and path", async () => {
    const { sessionId, req } = await pendingWrite("tier-card");
    // Rendered as the app's approval card, not a generic picker.
    expect(req.type).toBe("approval.request");
    expect(req.toolName).toBe("write");
    expect(String(req.detail)).toContain("gated.txt");
    // OMP's own choices, in the app's words: this call, the rest of the
    // session, or no.
    expect(req.options.map((o: any) => o.id)).toEqual(["once", "session", "deny"]);
    expect(req.options.map((o: any) => o.kind)).toEqual(["allow", "allow-always", "deny"]);
    expect(req.options[1].label).toBe("Allow write for this session");
    // Asked exactly once — no second prompter for the same call.
    expect(blockingRequests(sessionId).length).toBe(1);
    await answer(sessionId, req, "deny");
  }, 60_000);

  test("an aborted turn settles its approval card instead of leaving it open", async () => {
    const { project, sessionId, req } = await pendingWrite("tier-abort");
    await h.manager.route(sessionId, "session.abort", { sessionId });
    expect(await waitFor(() => h.finishedFor(sessionId).length > 0, 30_000)).toBe(true);
    const resolved = eventsFor(sessionId).find(
      (e: any) => e.type === "approval.resolved" && e.approvalId === req.approvalId,
    ) as any;
    expect(resolved?.optionId).toBe("cancelled");
    expect(existsSync(join(project, "gated.txt"))).toBe(false);
  }, 60_000);

  test("Approve runs the write", async () => {
    const { project, sessionId, req } = await pendingWrite("tier-allow");
    await answer(sessionId, req, "allow");
    expect(await waitFor(() => h.finishedFor(sessionId).length > 0, 30_000)).toBe(true);
    expect(existsSync(join(project, "gated.txt"))).toBe(true);
    const end = eventsFor(sessionId).find(
      (e: any) => e.type === "tool.end" && e.callId?.startsWith("call_write"),
    ) as any;
    expect(end?.ok).toBe(true);
  }, 60_000);

  test("Deny keeps the write off the disk", async () => {
    const { project, sessionId, req } = await pendingWrite("tier-deny");
    await answer(sessionId, req, "deny");
    expect(await waitFor(() => h.finishedFor(sessionId).length > 0, 30_000)).toBe(true);
    expect(existsSync(join(project, "gated.txt"))).toBe(false);
  }, 60_000);

  test("bash is still asked exactly once (bridge only, no second tier prompt)", async () => {
    const project = makeProject("tier-bash");
    const s = await h.manager.create({
      projectPath: project,
      title: "Bash once",
      model: "mockprov/mock-alpha",
      advisors: [],
      approvalMode: "always-ask",
    });
    await h.manager.route(s.sessionId, "session.prompt", {
      sessionId: s.sessionId,
      text: "run the tool",
    });
    expect(await waitFor(() => blockingRequests(s.sessionId).length > 0, 30_000)).toBe(true);
    const req = blockingRequests(s.sessionId)[0];
    expect(req.toolName).toBe("bash");
    await answer(s.sessionId, req, "allow");
    expect(await waitFor(() => h.finishedFor(s.sessionId).length > 0, 30_000)).toBe(true);
    expect(blockingRequests(s.sessionId).length).toBe(1);
  }, 60_000);

  test("auto-accept edits writes without asking but still asks for a shell command", async () => {
    const writer = await h.manager.create({
      projectPath: makeProject("tier-write-mode"),
      title: "Write mode",
      model: "mockprov/mock-write",
      advisors: [],
      approvalMode: "write",
    });
    await h.manager.route(writer.sessionId, "session.prompt", {
      sessionId: writer.sessionId,
      text: "write the file",
    });
    expect(await waitFor(() => h.finishedFor(writer.sessionId).length > 0, 30_000)).toBe(true);
    expect(blockingRequests(writer.sessionId).length).toBe(0);

    const shell = await h.manager.create({
      projectPath: makeProject("tier-write-mode-bash"),
      title: "Write mode bash",
      model: "mockprov/mock-alpha",
      advisors: [],
      approvalMode: "write",
    });
    await h.manager.route(shell.sessionId, "session.prompt", {
      sessionId: shell.sessionId,
      text: "run the tool",
    });
    expect(await waitFor(() => blockingRequests(shell.sessionId).length > 0, 30_000)).toBe(true);
    const req = blockingRequests(shell.sessionId)[0];
    expect(req.toolName).toBe("bash");
    await answer(shell.sessionId, req, "deny");
  }, 90_000);

  test("leaving full access makes a shell command ask again", async () => {
    const s = await h.manager.create({
      projectPath: makeProject("tier-yolo-back"),
      title: "Back to manual",
      model: "mockprov/mock-alpha",
      advisors: [],
      approvalMode: "yolo",
    });
    const set = await h.manager.route<{ ok: boolean }>(s.sessionId, "session.setApprovalMode", {
      sessionId: s.sessionId,
      mode: "always-ask",
    });
    expect(set.ok).toBe(true);
    await h.manager.route(s.sessionId, "session.prompt", {
      sessionId: s.sessionId,
      text: "run the tool",
    });
    expect(await waitFor(() => blockingRequests(s.sessionId).length > 0, 30_000)).toBe(true);
    const req = blockingRequests(s.sessionId)[0];
    expect(req.type).toBe("approval.request");
    expect(req.toolName).toBe("bash");
    await answer(s.sessionId, req, "deny");
  }, 60_000);

  test("full access lets the same write through without asking", async () => {
    const project = makeProject("tier-yolo");
    const s = await h.manager.create({
      projectPath: project,
      title: "Tier open",
      model: "mockprov/mock-write",
      advisors: [],
      approvalMode: "yolo",
    });
    await h.manager.route(s.sessionId, "session.prompt", {
      sessionId: s.sessionId,
      text: "write the file",
    });
    expect(await waitFor(() => h.finishedFor(s.sessionId).length > 0, 30_000)).toBe(true);
    expect(existsSync(join(project, "gated.txt"))).toBe(true);
    expect(blockingRequests(s.sessionId).length).toBe(0);
  }, 60_000);
});
