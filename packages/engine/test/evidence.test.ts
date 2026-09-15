import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EvidenceTracker } from "../src/worker/evidence";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

function workspace() {
  const cwd = mkdtempSync(join(tmpdir(), "orchestrator-evidence-"));
  directories.push(cwd);
  execFileSync("git", ["init", "--quiet", cwd]);
  writeFileSync(join(cwd, "source.ts"), "export const value = 1;\n");
  writeFileSync(join(cwd, ".gitignore"), "artifacts/\nignored.log\n");
  return { cwd, tracker: new EvidenceTracker(cwd) };
}

const sessionId = "evidence-session";
const requestId = "request-a";

describe("observed verification evidence", () => {
  test("tool success and optimistic output cannot invent a command exit status", async () => {
    const { tracker } = workspace();
    await tracker.observe(
      {
        type: "tool.start",
        sessionId,
        callId: "unknown",
        toolName: "bash",
        args: { command: "bun test" },
      },
      requestId,
    );
    await tracker.observe(
      {
        type: "tool.end",
        sessionId,
        callId: "unknown",
        ok: true,
        output: "All tests passed!",
        detail: { kind: "bash", command: "bun test" },
      },
      requestId,
    );
    const [record] = await tracker.refresh(requestId);
    expect(record?.status).toBe("unknown");
    expect(record?.exitCode).toBeUndefined();
    expect(record?.output).toBe("All tests passed!");
  });

  test("saved evidence survives ignored edits but goes stale after a same-size uncommitted edit", async () => {
    const { cwd, tracker } = workspace();
    await tracker.observe(
      {
        type: "tool.start",
        sessionId,
        callId: "check",
        toolName: "bash",
        args: { command: "bun test" },
      },
      requestId,
    );
    await tracker.observe(
      {
        type: "tool.end",
        sessionId,
        callId: "check",
        ok: true,
        detail: { kind: "bash", command: "bun test", exitCode: 0 },
      },
      requestId,
    );
    const saved = await tracker.refresh(requestId);
    expect(saved[0]?.stale).toBe(false);
    const restored = new EvidenceTracker(cwd);
    restored.restore(saved);
    writeFileSync(join(cwd, "ignored.log"), "private ignored output");
    expect((await restored.refresh(requestId))[0]?.stale).toBe(false);
    writeFileSync(join(cwd, "source.ts"), "export const value = 2;\n");
    const [stale] = await restored.refresh(requestId);
    expect(stale?.stale).toBe(true);
    expect(stale?.revision).toBe(saved[0]?.revision);
    expect(stale?.status).toBe("passed");
  });

  test("changes during verification cannot certify the resulting revision", async () => {
    const { cwd, tracker } = workspace();
    await tracker.observe(
      {
        type: "tool.start",
        sessionId,
        callId: "mutating",
        toolName: "bash",
        args: { command: "bun test --update-snapshots" },
      },
      requestId,
    );
    writeFileSync(join(cwd, "source.ts"), "export const value = 9;\n");
    await tracker.observe(
      {
        type: "tool.end",
        sessionId,
        callId: "mutating",
        ok: true,
        detail: { kind: "bash", command: "bun test --update-snapshots", exitCode: 0 },
      },
      requestId,
    );
    const [record] = await tracker.refresh(requestId);
    expect(record?.status).toBe("passed");
    expect(record?.stale).toBe(true);
    const restored = new EvidenceTracker(cwd);
    restored.restore(record ? [record] : []);
    expect((await restored.refresh(requestId))[0]?.stale).toBe(true);
  });

  test("browser artifacts are observations, not assertions; structured failures override successful invocation", async () => {
    const { tracker } = workspace();
    await tracker.observe(
      {
        type: "tool.start",
        sessionId,
        callId: "browser",
        toolName: "browser",
        args: { action: "screenshot" },
      },
      requestId,
    );
    await tracker.observe(
      {
        type: "tool.end",
        sessionId,
        callId: "browser",
        ok: true,
        ompResult: {
          content: [],
          details: { success: true, screenshotPath: "artifacts/screen.png" },
        },
      },
      requestId,
    );
    await tracker.observe(
      {
        type: "tool.start",
        sessionId,
        callId: "assertion",
        toolName: "eval",
        args: { code: "await browser.tab('app').title()" },
      },
      requestId,
    );
    await tracker.observe(
      {
        type: "tool.end",
        sessionId,
        callId: "assertion",
        ok: true,
        ompResult: { content: [], details: { results: [{ type: "assertion", passed: false }] } },
      },
      requestId,
    );
    const records = await tracker.refresh(requestId);
    expect(records[0]?.status).toBe("observed");
    expect(records[0]?.artifactPaths).toEqual(["artifacts/screen.png"]);
    expect(records[1]?.status).toBe("failed");
  });

  test("refresh drains queued output and completion without assigning a late start snapshot", async () => {
    const { tracker } = workspace();
    const start = tracker.observe(
      {
        type: "tool.start",
        sessionId,
        callId: "fast",
        toolName: "bash",
        args: { command: "check" },
      },
      requestId,
    );
    const update = tracker.observe(
      { type: "tool.update", sessionId, callId: "fast", outputDelta: "observed output" },
      requestId,
    );
    const end = tracker.observe(
      {
        type: "tool.end",
        sessionId,
        callId: "fast",
        ok: true,
        detail: { kind: "bash", command: "check", exitCode: 7 },
      },
      requestId,
    );
    const records = await tracker.refresh(requestId);
    await Promise.all([start, update, end]);
    expect(records.map((record) => record.callId)).toEqual(["fast"]);
    expect(records[0]?.output).toBe("observed output");
    expect(records[0]?.exitCode).toBe(7);
    expect(records[0]?.status).toBe("failed");
    expect(records[0]?.revision).toBeUndefined();
    expect(records[0]?.stale).toBe(true);
  });
});
