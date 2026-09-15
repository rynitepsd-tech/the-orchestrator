import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  rmSync,
  statSync,
  symlinkSync,
  truncateSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolCompleted } from "@orchestrator/protocol";
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

async function command(tracker: EvidenceTracker, result: Partial<ToolCompleted> = {}) {
  await tracker.observe(
    {
      type: "tool.start",
      sessionId,
      callId: "command",
      toolName: "bash",
      args: { command: "check" },
    },
    requestId,
  );
  await tracker.observe(
    {
      type: "tool.end",
      sessionId,
      callId: "command",
      ok: true,
      detail: { kind: "bash", command: "check" },
      ...result,
    },
    requestId,
  );
  return tracker.refresh(requestId);
}

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

  test("pinned synchronous bash completion normalizes the omitted zero exit", async () => {
    const { tracker } = workspace();
    const [record] = await command(tracker, {
      ompResult: {
        content: [{ type: "text", text: "(no output)" }],
        details: { timeoutDisabled: true, wallTimeMs: 0.4 },
      },
    });
    expect(record?.status).toBe("passed");
    expect(record?.exitCode).toBe(0);
    expect(record?.stale).toBe(false);
  });

  test.each([
    {
      name: "timeout even with a zero exit",
      ok: true,
      details: { timeoutSeconds: 1, wallTimeMs: 1000, timedOut: true, exitCode: 0 },
      status: "failed",
    },
    {
      name: "explicit background launch",
      ok: true,
      details: { timeoutSeconds: 60, async: { state: "running", jobId: "job", type: "bash" } },
      status: "unknown",
    },
    {
      name: "auto-background result even with a zero exit",
      ok: true,
      details: {
        timeoutSeconds: 60,
        wallTimeMs: 1000,
        exitCode: 0,
        async: { state: "running", jobId: "job", type: "bash" },
      },
      status: "unknown",
    },
    {
      name: "failed background job",
      ok: true,
      details: { async: { state: "failed", jobId: "job", type: "bash" } },
      status: "failed",
    },
    {
      name: "aborted or missing-exit error",
      ok: false,
      details: {},
      status: "failed",
    },
  ])("$name cannot certify successful completion", async ({ ok, details, status }) => {
    const { tracker } = workspace();
    const [record] = await command(tracker, { ok, ompResult: { content: [], details } });
    expect(record?.status).toBe(status);
    expect(record?.exitCode).toBeUndefined();
  });

  test("a raw SDK error overrides successful invocation and completion-shaped details", async () => {
    const { tracker } = workspace();
    const [record] = await command(tracker, {
      ompResult: {
        content: [],
        isError: true,
        details: { timeoutSeconds: 60, wallTimeMs: 2, exitCode: 4 },
      },
    });
    expect(record?.status).toBe("failed");
    expect(record?.exitCode).toBe(4);
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
    const original = statSync(join(cwd, "source.ts"));
    writeFileSync(join(cwd, "source.ts"), "export const value = 2;\n");
    // Restoring mtime must not hide a same-size edit: ctime also participates.
    utimesSync(join(cwd, "source.ts"), original.atime, original.mtime);
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

  test.each(["add", "delete", "symlink"] as const)(
    "a post-command %s invalidates workspace coverage",
    async (change) => {
      const { cwd, tracker } = workspace();
      if (change === "symlink") symlinkSync("source.ts", join(cwd, "link"));
      if (change === "delete") execFileSync("git", ["-C", cwd, "add", "source.ts"]);
      const saved = await command(tracker, {
        detail: { kind: "bash", command: "check", exitCode: 0 },
      });
      expect(saved[0]?.stale).toBe(false);
      if (change === "add") writeFileSync(join(cwd, "added.ts"), "new file");
      else if (change === "delete") unlinkSync(join(cwd, "source.ts"));
      else {
        unlinkSync(join(cwd, "link"));
        symlinkSync("absent.ts", join(cwd, "link"));
      }
      const [record] = await tracker.refresh(requestId);
      expect(record?.stale).toBe(true);
      expect(record?.revision).toBe(saved[0]?.revision);
    },
  );

  test("large files do not exhaust content limits and metadata changes still invalidate coverage", async () => {
    const { cwd, tracker } = workspace();
    const path = join(cwd, "large.bin");
    writeFileSync(path, "");
    truncateSync(path, 128 * 1024 * 1024);
    const [record] = await command(tracker, {
      detail: { kind: "bash", command: "check", exitCode: 0 },
    });
    expect(record?.stale).toBe(false);
    truncateSync(path, 128 * 1024 * 1024 + 1);
    expect((await tracker.refresh(requestId))[0]?.stale).toBe(true);
  });

  test("persisted content fingerprints cannot establish metadata coverage", async () => {
    const { cwd, tracker } = workspace();
    const saved = await command(tracker, {
      detail: { kind: "bash", command: "check", exitCode: 0 },
    });
    const restored = new EvidenceTracker(cwd);
    restored.restore(
      saved.map((record) => ({
        ...record,
        revision: record.revision?.replace("workspace-meta-v2:", "workspace-v1:"),
      })),
    );
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

  test("unawaited fast events retain the synchronous starting baseline", async () => {
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
    expect(records[0]?.stale).toBe(false);
  });

  test("genuinely concurrent tools cannot establish a stable baseline", async () => {
    const { tracker } = workspace();
    await tracker.observe(
      {
        type: "tool.start",
        sessionId,
        callId: "overlapping",
        toolName: "bash",
        args: { command: "still-running" },
      },
      requestId,
    );
    await command(tracker, { detail: { kind: "bash", command: "check", exitCode: 0 } });
    await tracker.observe(
      {
        type: "tool.end",
        sessionId,
        callId: "overlapping",
        ok: true,
        detail: { kind: "bash", command: "still-running", exitCode: 0 },
      },
      requestId,
    );
    const records = await tracker.refresh(requestId);
    expect(records.map((record) => record.status)).toEqual(["passed", "passed"]);
    expect(records.map((record) => record.stale)).toEqual([true, true]);
    expect(records.map((record) => record.revision)).toEqual([undefined, undefined]);
  });
});
