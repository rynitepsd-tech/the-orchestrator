import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { execFile } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import * as filesystem from "node:fs/promises";
import { chmod, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { commitSelectedChanges } from "../src/ship";
import { createWorkspace, integrateWorkspace, workspaceForSession } from "../src/workspace";

const exec = promisify(execFile);
const owned: string[] = [];
async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await exec("git", args, {
    cwd,
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1" },
  });
  return stdout.trim();
}
async function fixture() {
  const dir = realpathSync(await mkdtemp(join(tmpdir(), "orch-workspace-")));
  owned.push(dir);
  const project = join(dir, "project");
  const storage = join(dir, "worktrees");
  await mkdir(project);
  await git(project, "init", "-b", "main");
  await git(project, "config", "user.name", "Workspace Test");
  await git(project, "config", "user.email", "workspace@example.invalid");
  await git(project, "config", "commit.gpgsign", "false");
  await git(project, "config", "core.hooksPath", join(project, ".git", "hooks"));
  await writeFile(join(project, "same.txt"), "base\n");
  await writeFile(join(project, "other.txt"), "other base\n");
  await git(project, "add", ".");
  await git(project, "commit", "-m", "base");
  return { project, storage, dir };
}
afterEach(async () => {
  for (const dir of owned.splice(0)) await rm(dir, { recursive: true, force: true });
});

describe("managed workspaces", () => {
  test("independent sessions edit the same path without touching dirty root work, and resume retains checkout", async () => {
    const { project, storage, dir } = await fixture();
    await writeFile(join(project, "same.txt"), "root dirty\n");
    await writeFile(join(project, ".env"), "SECRET=local\n");
    await mkdir(join(project, "node_modules"));
    await writeFile(join(project, "node_modules", "local"), "installed");
    const [a, b] = await Promise.all([
      createWorkspace(project, "isolated", storage),
      createWorkspace(project, "isolated", storage),
    ]);
    expect(a.workspacePath).not.toBe(b.workspacePath);
    expect(await readFile(join(a.workspacePath, "same.txt"), "utf8")).toBe("base\n");
    expect(existsSync(join(a.workspacePath, ".env"))).toBe(false);
    expect(existsSync(join(a.workspacePath, "node_modules"))).toBe(false);
    await writeFile(join(a.workspacePath, "same.txt"), "session a\n");
    await writeFile(join(b.workspacePath, "same.txt"), "session b\n");
    expect(await readFile(join(project, "same.txt"), "utf8")).toBe("root dirty\n");
    expect(await readFile(join(a.workspacePath, "same.txt"), "utf8")).toBe("session a\n");
    expect(await readFile(join(b.workspacePath, "same.txt"), "utf8")).toBe("session b\n");
    const transcript = join(dir, "session.jsonl");
    await writeFile(
      transcript,
      `${JSON.stringify({ type: "title", title: "retained" })}\n${JSON.stringify({ type: "session", cwd: a.workspacePath })}\n`,
    );
    const resumed = await workspaceForSession(transcript, project, storage);
    expect(resumed.workspacePath).toBe(a.workspacePath);
    expect(resumed.projectPath).toBe(project);
    expect(await readFile(join(resumed.workspacePath, "same.txt"), "utf8")).toBe("session a\n");
  });

  test("integration preflights conflicts without changing either checkout", async () => {
    const { project, storage } = await fixture();
    const workspace = await createWorkspace(project, "isolated", storage);
    await writeFile(join(workspace.workspacePath, "same.txt"), "isolated commit\n");
    await commitSelectedChanges(workspace.workspacePath, ["same.txt"], "isolated change");
    await writeFile(join(project, "same.txt"), "project commit\n");
    await commitSelectedChanges(project, ["same.txt"], "project change");
    const rootHead = await git(project, "rev-parse", "HEAD");
    const isolatedHead = await git(workspace.workspacePath, "rev-parse", "HEAD");
    const result = await integrateWorkspace(workspace.workspacePath, storage);
    expect(result.integrated).toBe(false);
    expect(result.conflicts).toContain("same.txt");
    expect(await git(project, "rev-parse", "HEAD")).toBe(rootHead);
    expect(await git(workspace.workspacePath, "rev-parse", "HEAD")).toBe(isolatedHead);
    expect(await readFile(join(project, "same.txt"), "utf8")).toBe("project commit\n");
    expect(await readFile(join(workspace.workspacePath, "same.txt"), "utf8")).toBe(
      "isolated commit\n",
    );
    expect(await git(project, "status", "--porcelain")).toBe("");
  });

  test("clean committed isolated changes integrate, but a dirty logical root is preserved", async () => {
    const { project, storage } = await fixture();
    const workspace = await createWorkspace(project, "isolated", storage);
    await writeFile(join(workspace.workspacePath, "same.txt"), "ready\n");
    await commitSelectedChanges(workspace.workspacePath, ["same.txt"], "ready");
    await writeFile(join(project, "other.txt"), "precious local work\n");
    await expect(integrateWorkspace(workspace.workspacePath, storage)).rejects.toThrow(
      "local or staged changes",
    );
    expect(await readFile(join(project, "other.txt"), "utf8")).toBe("precious local work\n");
    await commitSelectedChanges(project, ["other.txt"], "keep local work");
    const result = await integrateWorkspace(workspace.workspacePath, storage);
    expect(result.integrated).toBe(true);
    expect(await readFile(join(project, "same.txt"), "utf8")).toBe("ready\n");
    expect(await readFile(join(project, "other.txt"), "utf8")).toBe("precious local work\n");
  });
});

describe("selected-path commits", () => {
  test("a competing writer's lock survives after our index lock is published", async () => {
    const { project } = await fixture();
    await writeFile(join(project, "same.txt"), "selected\n");
    const indexPath = join(project, ".git", "index");
    const lockPath = `${indexPath}.lock`;
    const originalRename = filesystem.rename;
    // Deterministically place the other writer at the release boundary; all Git
    // work and both lock files are real, without scheduler-dependent polling.
    const publish = spyOn(filesystem, "rename").mockImplementation(async (from, to) => {
      await originalRename(from, to);
      if (from === lockPath && to === indexPath) {
        await writeFile(lockPath, "another writer owns this lock", { flag: "wx" });
      }
    });
    try {
      await commitSelectedChanges(project, ["same.txt"], "selected");
      expect(await readFile(lockPath, "utf8")).toBe("another writer owns this lock");
      expect(await git(project, "show", "HEAD:same.txt")).toBe("selected");
    } finally {
      publish.mockRestore();
    }
  });

  test("custom executable commit hooks require a terminal commit without changing HEAD or index", async () => {
    const { project } = await fixture();
    await mkdir(join(project, ".repo-hooks"));
    const hook = join(project, ".repo-hooks", "pre-commit");
    await writeFile(hook, "#!/bin/sh\nexit 0\n");
    await chmod(hook, 0o755);
    await git(project, "config", "core.hooksPath", ".repo-hooks");
    await writeFile(join(project, "same.txt"), "selected\n");
    await writeFile(join(project, "other.txt"), "unrelated staged\n");
    await git(project, "add", "other.txt");
    const before = await git(project, "rev-parse", "HEAD");
    const index = await readFile(join(project, ".git", "index"));
    await expect(commitSelectedChanges(project, ["same.txt"], "selected")).rejects.toThrow(
      "terminal",
    );
    expect(await git(project, "rev-parse", "HEAD")).toBe(before);
    expect(await readFile(join(project, ".git", "index"))).toEqual(index);
    expect(await readFile(join(project, "same.txt"), "utf8")).toBe("selected\n");
  });

  test("commit signing policy is never silently replaced with an unsigned commit", async () => {
    const { project } = await fixture();
    await git(project, "config", "commit.gpgsign", "true");
    await writeFile(join(project, "same.txt"), "must be signed\n");
    const before = await git(project, "rev-parse", "HEAD");
    await expect(commitSelectedChanges(project, ["same.txt"], "signed")).rejects.toThrow(
      "commit.gpgsign",
    );
    expect(await git(project, "rev-parse", "HEAD")).toBe(before);
    expect(await readFile(join(project, "same.txt"), "utf8")).toBe("must be signed\n");
    expect(existsSync(join(project, ".git", "index.lock"))).toBe(false);
  });

  test("unrelated staged contents stay staged and never enter selected commit", async () => {
    const { project } = await fixture();
    await writeFile(join(project, "same.txt"), "selected\n");
    await writeFile(join(project, "other.txt"), "unrelated staged\n");
    await git(project, "add", "other.txt");
    await writeFile(join(project, "other.txt"), "unrelated unstaged\n");
    await commitSelectedChanges(project, ["same.txt"], "selected only");
    expect(await git(project, "diff-tree", "--no-commit-id", "--name-only", "-r", "HEAD")).toBe(
      "same.txt",
    );
    expect(await git(project, "show", "HEAD:other.txt")).toBe("other base");
    expect(await git(project, "show", ":other.txt")).toBe("unrelated staged");
    expect(await readFile(join(project, "other.txt"), "utf8")).toBe("unrelated unstaged\n");
    expect(await git(project, "diff", "--cached", "--name-only")).toBe("other.txt");
  });

  test("rename selection must include both paths and literal metacharacters cannot stage neighbors", async () => {
    const { project } = await fixture();
    await rename(join(project, "same.txt"), join(project, "renamed.txt"));
    await git(project, "add", "-A");
    const head = await git(project, "rev-parse", "HEAD");
    await expect(commitSelectedChanges(project, ["renamed.txt"], "incomplete")).rejects.toThrow(
      "both sides",
    );
    expect(await git(project, "rev-parse", "HEAD")).toBe(head);
    await commitSelectedChanges(project, ["same.txt", "renamed.txt"], "rename");
    expect(await git(project, "show", "HEAD:renamed.txt")).toBe("base");
    await writeFile(join(project, "*.txt"), "literal filename\n");
    await writeFile(join(project, "other.txt"), "not selected\n");
    await commitSelectedChanges(project, ["*.txt"], "literal");
    expect(await git(project, "diff-tree", "--no-commit-id", "--name-only", "-r", "HEAD")).toBe(
      "*.txt",
    );
    expect(await git(project, "show", "HEAD:other.txt")).toBe("other base");
    await expect(commitSelectedChanges(project, ["../outside"], "escape")).rejects.toThrow(
      "Invalid selected file path",
    );
  });
});
