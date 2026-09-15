import { describe, expect, test } from "bun:test";
import { readSessionSource, searchSessions } from "@orchestrator/omp-adapter";
import type { ProductEvent, ResponsePayloads, TaskSnapshot } from "@orchestrator/protocol";
import { useHarness, waitFor } from "./harness";

const h = useHarness({
  prefix: "orch-publication",
  modelIds: ["mock-publication", "mock-review", "mock-concern"],
});

function latestTasks(events: ProductEvent[]): TaskSnapshot[] {
  const tasks = new Map<string, TaskSnapshot>();
  for (const event of events) {
    if (event.type === "task.updated") tasks.set(event.task.requestId, event.task);
  }
  return [...tasks.values()];
}

describe("real worker answer publication", () => {
  test("a real advisor concern is adjudicated by the primary before a revised answer publishes", async () => {
    const session = await h.manager.create({
      projectPath: h.makeProject("revision"),
      title: "Reviewed revision",
      model: "mockprov/mock-publication",
      advisors: [
        {
          id: "reviewer",
          name: "Reviewer",
          enabled: true,
          model: "mockprov/mock-concern",
          origin: "session",
          tools: [],
        },
      ],
    });
    await h.manager.route(session.sessionId, "session.prompt", {
      sessionId: session.sessionId,
      text: "Address the original request after assessing reviewer advice.",
    });
    expect(await waitFor(() => h.finishedFor(session.sessionId).length === 1, 45_000)).toBe(true);
    const task = latestTasks(h.eventsFor(session.sessionId))[0];
    expect({ phase: task.phase, detail: task.reviewDetail }).toEqual({
      phase: "complete",
      detail: undefined,
    });
    expect(task.answer?.revision).toBe(2);
    expect(task.answer?.reviewStatus).toBe("passed");
    expect(
      task.findings.map((finding) => ({
        advisor: finding.advisorName,
        revision: finding.revision,
        resolution: finding.resolution,
      })),
    ).toEqual([{ advisor: "Reviewer", revision: 1, resolution: "accepted" }]);
    const ompSessionId = h.manager
      .list()
      .find((item) => item.sessionId === session.sessionId)!.ompSessionId;
    const advisorRecords = () =>
      h.manager
        .usageIndex()
        .records()
        .filter((record) => record.ompSessionId === ompSessionId && record.actorType === "advisor");
    expect(await waitFor(() => advisorRecords().length > 0)).toBe(true);
    expect(new Set(advisorRecords().map((record) => record.actorId))).toEqual(
      new Set(["advisor:reviewer"]),
    );
    expect(new Set(advisorRecords().map((record) => record.actorName))).toEqual(
      new Set(["Reviewer"]),
    );
  }, 60_000);

  test("a configured SDK reviewer must complete its candidate round before publication", async () => {
    const session = await h.manager.create({
      projectPath: h.makeProject("review"),
      title: "Reviewed publication",
      model: "mockprov/mock-publication",
      advisors: [
        {
          id: "reviewer",
          name: "Reviewer",
          enabled: true,
          model: "mockprov/mock-review",
          origin: "session",
          tools: [],
        },
      ],
    });
    await h.manager.route(session.sessionId, "session.prompt", {
      sessionId: session.sessionId,
      text: "Publish this answer only after reviewer catchup.",
    });
    expect(await waitFor(() => h.finishedFor(session.sessionId).length === 1, 45_000)).toBe(true);
    const task = latestTasks(h.eventsFor(session.sessionId))[0];
    expect({ phase: task.phase, detail: task.reviewDetail }).toEqual({
      phase: "complete",
      detail: undefined,
    });
    expect(task.answer?.reviewStatus).toBe("passed");
    expect(task.answer?.text).toBe(`Canonical answer for request ${task.requestId}.`);
  }, 60_000);

  test("queued requests retain distinct canonical answers through close, replay, and exact-source search", async () => {
    const projectPath = h.makeProject("queue");
    const session = await h.manager.create({
      projectPath,
      title: "Publication regression",
      model: "mockprov/mock-publication",
      advisors: [],
    });
    await h.manager.route(session.sessionId, "session.prompt", {
      sessionId: session.sessionId,
      text: "First distinct user request.",
    });
    const queued = (await h.manager.route(session.sessionId, "session.prompt", {
      sessionId: session.sessionId,
      text: "Second distinct user request.",
      whenBusy: "queue",
    })) as ResponsePayloads["session.prompt"];
    expect(queued.mode).toBe("queued");
    expect(await waitFor(() => h.finishedFor(session.sessionId).length === 2, 45_000)).toBe(true);
    const tasks = latestTasks(h.eventsFor(session.sessionId));
    expect(
      tasks.map((task) => ({ prompt: task.prompt, phase: task.phase, detail: task.reviewDetail })),
    ).toEqual([
      { prompt: "First distinct user request.", phase: "complete", detail: undefined },
      { prompt: "Second distinct user request.", phase: "complete", detail: undefined },
    ]);
    expect(tasks[0].requestId).not.toBe(tasks[1].requestId);
    for (const task of tasks) {
      expect(task.answer?.text).toBe(`Canonical answer for request ${task.requestId}.`);
      expect(task.answer?.reviewStatus).toBe("not-required");
      expect(task.evidence.some((item) => item.output?.includes("PUBLICATION-CHECK"))).toBe(true);
    }
    expect(h.textFor(session.sessionId)).toContain("Post-submission progress");

    const sessionPath = h.manager
      .list()
      .find((item) => item.sessionId === session.sessionId)?.ompSessionPath;
    expect(sessionPath).toBeDefined();
    await h.manager.close(session.sessionId);
    const restored = await h.manager.create({
      projectPath,
      resumeSessionPath: sessionPath,
      model: "mockprov/mock-publication",
      advisors: [],
    });
    const replay = (await h.manager.route(restored.sessionId, "session.transcript", {
      sessionId: restored.sessionId,
    })) as ResponsePayloads["session.transcript"];
    expect(latestTasks(replay.events).map((task) => task.answer)).toEqual(
      tasks.map((task) => task.answer),
    );
    expect(h.finishedFor(restored.sessionId)).toEqual([]);

    const discovered = await h.manager.discoverSessions();
    const result = await searchSessions(discovered, tasks[0].answer!.text, { projectPath });
    const hit = result.hits.find((item) => item.entryId === tasks[0].answer!.messageId);
    expect(hit?.sessionPath).toBe(sessionPath);
    const source = await readSessionSource(discovered, sessionPath!, tasks[0].answer!.messageId);
    expect(source.text).toBe(tasks[0].answer!.text);
  }, 90_000);
});
