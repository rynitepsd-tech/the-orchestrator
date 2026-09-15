import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createReadStream, existsSync, readFileSync, realpathSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { promisify } from "node:util";
import { canonicalPath } from "./paths";

const exec = promisify(execFile);

export interface Workspace {
  projectPath: string;
  workspacePath: string;
  workspaceMode: "shared" | "isolated";
  workspaceBranch?: string;
}

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await exec("git", args, { cwd, timeout: 60_000, maxBuffer: 16 * 1024 * 1024 });
  return stdout.trim();
}

/** Metadata lives outside the checkout; no files or secrets are copied from the project. */
export function workspaceForPath(path: string, storageDir: string): Workspace {
  const actual = canonicalPath(path);
  const storage = canonicalPath(storageDir);
  if (actual.startsWith(`${storage}/`) && dirname(dirname(actual)) === storage) {
    const recordPath = join(dirname(actual), "workspace.json");
    if (existsSync(recordPath)) {
      const record: unknown = JSON.parse(readFileSync(recordPath, "utf8"));
      if (
        !record ||
        typeof record !== "object" ||
        !("workspacePath" in record) ||
        record.workspacePath !== actual ||
        !("workspaceMode" in record) ||
        record.workspaceMode !== "isolated" ||
        !("projectPath" in record) ||
        typeof record.projectPath !== "string" ||
        !record.projectPath
      ) {
        throw new Error(
          "Managed workspace metadata is invalid; refusing to substitute another checkout.",
        );
      }
      return {
        workspacePath: actual,
        projectPath: record.projectPath,
        workspaceMode: "isolated",
        workspaceBranch:
          "workspaceBranch" in record && typeof record.workspaceBranch === "string"
            ? record.workspaceBranch
            : undefined,
      };
    }
    throw new Error(
      "Managed workspace metadata is missing; restore it before resuming this session.",
    );
  }
  return { projectPath: actual, workspacePath: actual, workspaceMode: "shared" };
}

/** The OMP header remains authoritative for resumed/forked transcript tool cwd. */
export async function workspaceForSession(
  path: string,
  fallback: string,
  storageDir: string,
): Promise<Workspace> {
  const stream = createReadStream(path, { encoding: "utf8" });
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      if (!line.trim()) continue;
      const entry: unknown = JSON.parse(line);
      if (entry && typeof entry === "object" && "type" in entry && entry.type === "session") {
        if (!("cwd" in entry) || typeof entry.cwd !== "string") {
          throw new Error(
            "The session header has no workspace path; refusing to resume in another checkout.",
          );
        }
        return workspaceForPath(entry.cwd, storageDir);
      }
    }
    throw new Error(`No session header found; refusing to resume in ${fallback}.`);
  } finally {
    lines.close();
    stream.destroy();
  }
}

export async function createWorkspace(
  projectPath: string,
  mode: "shared" | "isolated",
  storageDir: string,
): Promise<Workspace> {
  const project = workspaceForPath(projectPath, storageDir).projectPath;
  if (mode === "shared")
    return { projectPath: project, workspacePath: project, workspaceMode: mode };
  let head: string;
  try {
    const root = await git(project, ["rev-parse", "--show-toplevel"]);
    if (realpathSync(root) !== realpathSync(project)) {
      throw new Error("Select the repository root, not a subfolder, for an isolated workspace.");
    }
    head = await git(project, ["rev-parse", "--verify", "HEAD^{commit}"]);
  } catch (error) {
    throw Object.assign(
      new Error(
        `An isolated workspace requires a git repository root with a committed HEAD. Choose Shared folder or make an initial commit. ${String((error as Error).message)}`,
      ),
      { kind: "configuration" },
    );
  }
  await mkdir(storageDir, { recursive: true });
  const owned = await mkdtemp(join(realpathSync(storageDir), "session-"));
  const workspacePath = join(owned, "checkout");
  const branch = `orch/session-${randomUUID()}`;
  let created = false;
  try {
    await git(project, ["worktree", "add", "-b", branch, workspacePath, head]);
    created = true;
    const workspace: Workspace = {
      projectPath: project,
      workspacePath,
      workspaceMode: mode,
      workspaceBranch: branch,
    };
    await writeFile(join(owned, "workspace.json"), JSON.stringify(workspace), {
      flag: "wx",
      mode: 0o600,
    });
    return workspace;
  } catch (error) {
    // Only this invocation's freshly allocated checkout/ref may be cleaned up.
    // Never force-remove a worktree: unexpected edits must survive even failed setup.
    if (created) {
      try {
        await git(project, ["worktree", "remove", workspacePath]);
      } catch {
        throw error;
      }
    }
    try {
      await git(project, ["update-ref", "-d", `refs/heads/${branch}`, head]);
    } catch {
      /* ref was never created or changed */
    }
    await rm(owned, { recursive: true, force: true });
    throw error;
  }
}

export interface WorkspaceIntegrationResult {
  integrated: boolean;
  commit?: string;
  conflicts: string[];
  note?: string;
}

/** Integrate only committed work, never stash/reset/overwrite the logical project. */
export async function integrateWorkspace(
  path: string,
  storageDir: string,
): Promise<WorkspaceIntegrationResult> {
  const workspace = workspaceForPath(path, storageDir);
  if (workspace.workspaceMode !== "isolated")
    throw new Error("Only a managed isolated workspace can be integrated.");
  const source = workspace.workspacePath;
  const target = workspace.projectPath;
  const sourceRepository = await git(source, [
    "rev-parse",
    "--path-format=absolute",
    "--git-common-dir",
  ]);
  const targetRepository = await git(target, [
    "rev-parse",
    "--path-format=absolute",
    "--git-common-dir",
  ]);
  if (realpathSync(sourceRepository) !== realpathSync(targetRepository)) {
    throw new Error("The workspace and logical project no longer belong to the same repository.");
  }
  try {
    await git(target, ["symbolic-ref", "--quiet", "HEAD"]);
  } catch {
    throw new Error(
      "Check out the destination project branch before integrating; its HEAD is detached.",
    );
  }
  if (await git(source, ["status", "--porcelain"]))
    throw new Error("Commit or ship workspace changes before integrating.");
  if (await git(target, ["status", "--porcelain"]))
    throw new Error(
      "The project folder has local or staged changes. Preserve them and make the folder clean before integrating.",
    );
  for (const cwd of [source, target]) {
    for (const ref of [
      "MERGE_HEAD",
      "CHERRY_PICK_HEAD",
      "REVERT_HEAD",
      "rebase-merge",
      "rebase-apply",
    ]) {
      if (existsSync(resolve(cwd, await git(cwd, ["rev-parse", "--git-path", ref]))))
        throw new Error("Finish the existing git operation before integrating.");
    }
  }
  const commit = await git(source, ["rev-parse", "HEAD"]);
  const before = await git(target, ["rev-parse", "HEAD"]);
  try {
    await git(target, ["merge-tree", "--write-tree", before, commit]);
  } catch (error) {
    const output =
      error && typeof error === "object" && "stdout" in error ? String(error.stdout ?? "") : "";
    const conflicts = [
      ...output.matchAll(/^CONFLICT .*?: (?:Merge conflict in |.*? in )(.+)$/gm),
    ].map((match) => match[1]);
    return {
      integrated: false,
      commit,
      conflicts,
      note: output || String((error as Error).message),
    };
  }
  if (
    (await git(target, ["rev-parse", "HEAD"])) !== before ||
    (await git(target, ["status", "--porcelain"]))
  ) {
    throw new Error(
      "The project changed during integration. Nothing was reset; retry when work has stopped.",
    );
  }
  try {
    await git(target, ["merge", "--no-edit", commit]);
    return { integrated: true, commit, conflicts: [] };
  } catch (error) {
    const conflicts = (await git(target, ["diff", "--name-only", "--diff-filter=U"]))
      .split("\n")
      .filter(Boolean);
    return {
      integrated: false,
      commit,
      conflicts,
      note: `Integration stopped; all work is retained. Resolve the git operation in ${target}. ${String((error as Error).message)}`,
    };
  }
}
