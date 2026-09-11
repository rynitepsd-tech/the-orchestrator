/**
 * PERMANENT REGRESSIONS — bugs found once, encoded forever.
 *
 * 1. Paths with spaces: this repo itself lives under "Desktop/The Orchestrator";
 *    worker spawning must never percent-encode paths (new URL().pathname bug).
 * 2. Duplicate completion: a turn yields exactly ONE authoritative
 *    session.finished, and an aborted turn can never become "completed".
 * 3. Worker crash: a killed worker interrupts only its own session, is removed
 *    from routing, and later routing errors are actionable.
 * 4. Fork: upstream forkFrom semantics — history preserved, new identity,
 *    original untouched, both immediately runnable.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { useHarness, waitFor } from "./harness";

const h = useHarness({
  prefix: "orch-reg",
  modelIds: ["mock-alpha", "mock-bravo", "mock-one", "mock-slow"],
});
const { eventsFor, finishedFor, textFor, makeProject } = h;

describe("path handling", () => {
  test("a project path containing spaces runs tools in the right directory", async () => {
    const base = mkdtempSync(join(tmpdir(), "orch-reg-space-"));
    h.roots.push(base);
    const dir = join(base, "My Project With Spaces");
    mkdirSync(dir);
    writeFileSync(join(dir, "MARKER.txt"), "spaces\n");

    const s = await h.manager.create({
      projectPath: dir,
      title: "Spaces",
      model: "mockprov/mock-alpha",
      advisors: [],
    });
    await h.manager.route(s.sessionId, "session.prompt", { sessionId: s.sessionId, text: "go" });
    expect(await waitFor(() => finishedFor(s.sessionId).length > 0)).toBe(true);

    const toolEnd = eventsFor(s.sessionId).find((e) => e.type === "tool.end") as any;
    expect(toolEnd?.ok).toBe(true);
    // pwd output proves the tool ran inside the spaced path, un-mangled.
    expect(String(toolEnd?.output ?? "")).toContain("My Project With Spaces");
    expect(String(toolEnd?.output ?? "")).not.toContain("%20");

    // The mock tool prints a Vite-style "Local:" line; the worker must
    // surface it as a normalized dev-server preview origin.
    const preview = eventsFor(s.sessionId).find((e) => e.type === "session.preview") as any;
    expect(preview?.url).toBe("http://localhost:5199/");
  }, 60_000);
});

describe("completion authority", () => {
  test("an aborted turn finishes exactly once, as interrupted, never completed", async () => {
    const s = await h.manager.create({
      projectPath: makeProject("abort"),
      title: "Abort",
      model: "mockprov/mock-slow",
      advisors: [],
    });
    await h.manager.route(s.sessionId, "session.prompt", { sessionId: s.sessionId, text: "go" });
    expect(await waitFor(() => textFor(s.sessionId).length > 0)).toBe(true);
    await h.manager.route(s.sessionId, "session.abort", { sessionId: s.sessionId });

    expect(await waitFor(() => finishedFor(s.sessionId).length > 0)).toBe(true);
    // Let any racing emitter fire before asserting exact-once.
    await new Promise((r) => setTimeout(r, 500));
    expect(finishedFor(s.sessionId).length).toBe(1);
    expect(finishedFor(s.sessionId)[0].runState).toBe("interrupted");

    // A later state event must never claim completion for the aborted turn.
    const states = eventsFor(s.sessionId).filter((e) => e.type === "session.state") as any[];
    const afterFinish = states.slice(states.findIndex((e) => e.runState === "interrupted"));
    expect(afterFinish.every((e) => e.runState !== "completed")).toBe(true);
  }, 60_000);

  test("a normal turn also finishes exactly once", async () => {
    const s = await h.manager.create({
      projectPath: makeProject("once"),
      title: "Once",
      model: "mockprov/mock-bravo",
      advisors: [],
    });
    await h.manager.route(s.sessionId, "session.prompt", { sessionId: s.sessionId, text: "go" });
    expect(await waitFor(() => finishedFor(s.sessionId).length > 0)).toBe(true);
    await new Promise((r) => setTimeout(r, 500));
    expect(finishedFor(s.sessionId).length).toBe(1);
    expect(finishedFor(s.sessionId)[0].runState).toBe("completed");
  }, 60_000);
});

describe("worker crash containment", () => {
  test("killing one worker interrupts only that session and unregisters it", async () => {
    const victim = await h.manager.create({
      projectPath: makeProject("victim"),
      title: "Victim",
      model: "mockprov/mock-slow",
      advisors: [],
    });
    const bystander = await h.manager.create({
      projectPath: makeProject("bystander"),
      title: "Bystander",
      model: "mockprov/mock-one",
      advisors: [],
    });

    await h.manager.route(victim.sessionId, "session.prompt", {
      sessionId: victim.sessionId,
      text: "go",
    });
    expect(await waitFor(() => textFor(victim.sessionId).length > 0)).toBe(true);

    const stats = await h.manager.workerStats();
    const pid = stats.find((w) => w.sessionId === victim.sessionId)?.pid;
    expect(pid).toBeGreaterThan(0);
    process.kill(pid!, "SIGKILL");

    // The crash is reported as interruption with a preserved-transcript note…
    expect(
      await waitFor(() =>
        eventsFor(victim.sessionId).some(
          (e) => e.type === "session.failed" && (e as any).error?.kind === "engine",
        ),
      ),
    ).toBe(true);
    expect(await waitFor(() => finishedFor(victim.sessionId).length > 0)).toBe(true);
    expect(finishedFor(victim.sessionId)[0].runState).toBe("interrupted");

    // …the dead worker no longer routes, with an actionable error…
    expect(h.manager.has(victim.sessionId)).toBe(false);
    await expect(
      h.manager.route(victim.sessionId, "session.prompt", {
        sessionId: victim.sessionId,
        text: "again",
      }),
    ).rejects.toThrow(/resume/i);

    // …and the bystander is untouched.
    await h.manager.route(bystander.sessionId, "session.prompt", {
      sessionId: bystander.sessionId,
      text: "go",
    });
    expect(await waitFor(() => finishedFor(bystander.sessionId).length > 0)).toBe(true);
    expect(finishedFor(bystander.sessionId)[0].runState).toBe("completed");
  }, 90_000);
});

describe("session fork", () => {
  test("fork preserves history, gets a new identity, and both sides keep working", async () => {
    const project = makeProject("fork");
    const original = await h.manager.create({
      projectPath: project,
      title: "Original",
      model: "mockprov/mock-alpha",
      advisors: [],
    });
    await h.manager.route(original.sessionId, "session.prompt", {
      sessionId: original.sessionId,
      text: "first turn",
    });
    expect(await waitFor(() => finishedFor(original.sessionId).length > 0)).toBe(true);

    const sourcePath = h.manager
      .list()
      .find((s) => s.sessionId === original.sessionId)?.ompSessionPath;
    expect(sourcePath).toBeTruthy();
    const originalBytes = readFileSync(sourcePath!, "utf8");

    const fork = await h.manager.fork({
      sourcePath: sourcePath!,
      projectPath: project,
      title: "Forked",
      model: "mockprov/mock-bravo",
    });
    expect(fork.sessionId).not.toBe(original.sessionId);

    const forkPath = h.manager.list().find((s) => s.sessionId === fork.sessionId)?.ompSessionPath;
    expect(forkPath).toBeTruthy();
    expect(forkPath).not.toBe(sourcePath);
    expect(existsSync(forkPath!)).toBe(true);

    // The fork carries the original's history and records its lineage.
    const forkBytes = readFileSync(forkPath!, "utf8");
    expect(forkBytes).toContain("ALPHA-FROM-TOOL");
    const header = JSON.parse(
      forkBytes.split("\n").find((l) => l.includes('"type":"session"')) ?? "{}",
    );
    expect(header.parentSession).toBeTruthy();

    // Fork runs on its own model without disturbing the original…
    await h.manager.route(fork.sessionId, "session.prompt", {
      sessionId: fork.sessionId,
      text: "fork turn",
    });
    expect(await waitFor(() => finishedFor(fork.sessionId).length > 0)).toBe(true);
    expect(textFor(fork.sessionId)).toContain("BRAVO");

    // …whose file is byte-identical until IT is prompted again.
    expect(readFileSync(sourcePath!, "utf8")).toBe(originalBytes);

    // The original continues independently; histories diverge safely.
    await h.manager.route(original.sessionId, "session.prompt", {
      sessionId: original.sessionId,
      text: "second original turn",
    });
    expect(await waitFor(() => finishedFor(original.sessionId).length >= 2)).toBe(true);
    expect(readFileSync(forkPath!, "utf8")).not.toContain("second original turn");
  }, 90_000);
});

describe("provider auth gate", () => {
  // 2026-08-25 incident: a session on a provider whose OAuth grant died kept
  // running on the stale access token, and the provider billed the org's
  // prepaid API credits instead of the subscription. The engine must refuse
  // inference-triggering actions for providers with no usable credentials.
  test("refuses to create a session on an unauthenticated provider", async () => {
    const dir = makeProject("authgate");
    await expect(
      h.manager.create({
        projectPath: dir,
        title: "gated",
        model: "no-such-provider-xyz/some-model",
        advisors: [],
      }),
    ).rejects.toThrow(/no usable credentials|sign-in has expired/i);
  });

  test("refuses an enabled advisor on an unauthenticated provider", async () => {
    const dir = makeProject("authgate-adv");
    await expect(
      h.manager.create({
        projectPath: dir,
        title: "gated-advisor",
        model: "mockprov/mock-alpha",
        advisors: [
          {
            id: "advisor:Ghost",
            name: "Ghost",
            enabled: true,
            model: "no-such-provider-xyz/some-model",
            origin: "session",
          },
        ],
      }),
    ).rejects.toThrow(/no usable credentials|sign-in has expired/i);
  });

  test("test-double providers stay exempt and disabled advisors are ignored", async () => {
    const dir = makeProject("authgate-ok");
    const s = await h.manager.create({
      projectPath: dir,
      title: "not gated",
      model: "mockprov/mock-alpha",
      advisors: [
        {
          id: "advisor:Ghost",
          name: "Ghost",
          enabled: false,
          model: "no-such-provider-xyz/some-model",
          origin: "session",
        },
      ],
    });
    expect(s.sessionId).toBeTruthy();
    await h.manager.close(s.sessionId);
  });
});
