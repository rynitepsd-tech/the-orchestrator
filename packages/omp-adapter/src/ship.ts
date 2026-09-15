/** Explicit path-scoped shipping. Shared-tree selection does not isolate same-file hunks. */
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { accessSync, constants, existsSync, lstatSync, realpathSync } from "node:fs";
import { copyFile, mkdtemp, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);

interface ShipOptions {
  /** PR/commit title, typically the session title. */
  title: string;
  body?: string;
  files: string[];
}

interface ShipResult {
  branch: string;
  /** True when we branched off the default branch to avoid committing to it. */
  createdBranch: boolean;
  committed: boolean;
  pushed: boolean;
  prUrl?: string;
  /** Human-readable caveat, e.g. "gh is not installed — commit pushed, no PR". */
  note?: string;
}

async function git(cwd: string, args: string[], timeout = 15_000): Promise<string> {
  const { stdout } = await exec("git", args, { cwd, timeout, maxBuffer: 8 * 1024 * 1024 });
  return stdout.trim();
}

function slugify(s: string): string {
  return (
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "changes"
  );
}

/**
 * Plumbing preserves path scope but cannot safely reproduce arbitrary commit hooks
 * or interactive signing. Refuse those repositories rather than silently bypass policy.
 */
async function assertScopedCommitPolicy(cwd: string): Promise<void> {
  let sign = false;
  try {
    sign = (await git(cwd, ["config", "--bool", "--get", "commit.gpgsign"])) === "true";
  } catch (error) {
    if (!error || typeof error !== "object" || !("code" in error) || error.code !== 1) throw error;
  }
  if (sign) {
    throw new Error(
      "Signed commits are enabled (commit.gpgsign). Commit the selected files in a terminal so your signing policy is honored, then push or integrate the committed work.",
    );
  }
  const hooksPath = resolve(cwd, await git(cwd, ["rev-parse", "--git-path", "hooks"]));
  for (const hook of ["pre-commit", "prepare-commit-msg", "commit-msg", "post-commit"]) {
    try {
      accessSync(join(hooksPath, hook), constants.X_OK);
    } catch (error) {
      if (
        error &&
        typeof error === "object" &&
        "code" in error &&
        ["ENOENT", "ENOTDIR", "EACCES"].includes(String(error.code))
      )
        continue;
      throw error;
    }
    throw new Error(
      `An active ${hook} hook is configured. Commit the selected files in a terminal so repository hooks are honored, then push or integrate the committed work.`,
    );
  }
}

/** Commit exactly selected working-copy paths while preserving unrelated real-index entries. */
export async function commitSelectedChanges(
  cwd: string,
  files: string[],
  message: string,
): Promise<boolean> {
  if (!Array.isArray(files) || files.length === 0) throw new Error("Select the files to commit.");
  const root = realpathSync(await git(cwd, ["rev-parse", "--show-toplevel"]));
  if (realpathSync(cwd) !== root) throw new Error("Shipping requires the repository root.");
  await assertScopedCommitPolicy(root);
  const selected = [...new Set(files)];
  for (const file of selected) {
    if (
      typeof file !== "string" ||
      !file ||
      isAbsolute(file) ||
      file.includes("\0") ||
      file
        .split("/")
        .some((part) => !part || part === "." || part === ".." || part.toLowerCase() === ".git")
    ) {
      throw new Error(`Invalid selected file path: ${String(file)}`);
    }
    const absolute = resolve(root, file);
    let parent = dirname(absolute);
    while (!existsSync(parent)) parent = dirname(parent);
    const realParent = realpathSync(parent);
    if (realParent !== root && !realParent.startsWith(`${root}/`))
      throw new Error(`Selected path escapes the workspace: ${file}`);
    if (existsSync(absolute) && lstatSync(absolute).isDirectory())
      throw new Error(`Select files, not directories: ${file}`);
  }
  const { stdout } = await exec(
    "git",
    ["status", "--porcelain=v1", "-z", "--untracked-files=all"],
    {
      cwd: root,
      timeout: 15_000,
      maxBuffer: 8 * 1024 * 1024,
    },
  );
  const entries = stdout.split("\0");
  const changed = new Set<string>();
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    if (!entry) continue;
    const status = entry.slice(0, 2);
    const path = entry.slice(3);
    changed.add(path);
    if (status.includes("U") || status === "AA" || status === "DD")
      throw new Error("Resolve merge conflicts before shipping.");
    if (status.includes("R") || status.includes("C")) {
      const source = entries[++i];
      if (!source) throw new Error("Git returned an incomplete rename.");
      changed.add(source);
      if (status.includes("R") && selected.includes(path) !== selected.includes(source)) {
        throw new Error(`Select both sides of the rename: ${source} → ${path}`);
      }
    }
  }
  for (const file of selected)
    if (!changed.has(file))
      throw new Error(`Selected file is no longer changed: ${file}. Refresh changes.`);
  const head = await git(root, ["rev-parse", "HEAD"]);
  const branch = await git(root, ["symbolic-ref", "HEAD"]);
  for (const ref of [
    "MERGE_HEAD",
    "CHERRY_PICK_HEAD",
    "REVERT_HEAD",
    "rebase-merge",
    "rebase-apply",
  ]) {
    if (existsSync(resolve(root, await git(root, ["rev-parse", "--git-path", ref]))))
      throw new Error("Finish the existing git operation before shipping.");
  }
  const indexPath = resolve(root, await git(root, ["rev-parse", "--git-path", "index"]));
  // Hold the normal index lock across commit publication. Other Git writers fail safely.
  const lockPath = `${indexPath}.lock`;
  const lock = await open(lockPath, "wx");
  let ownsIndexLock = true;
  let temp: string | undefined;
  try {
    temp = await mkdtemp(join(tmpdir(), "orchestrator-ship-"));
    const commitIndex = join(temp, "commit-index");
    const preservedIndex = join(temp, "preserved-index");
    const run = async (index: string, args: string[]) => {
      const result = await exec("git", ["--literal-pathspecs", ...args], {
        cwd: root,
        env: { ...process.env, GIT_INDEX_FILE: index },
        timeout: 30_000,
        maxBuffer: 16 * 1024 * 1024,
      });
      return result.stdout.trim();
    };
    await run(commitIndex, ["read-tree", head]);
    await run(commitIndex, ["add", "-A", "--", ...selected]);
    const tree = await run(commitIndex, ["write-tree"]);
    if (tree === (await git(root, ["rev-parse", `${head}^{tree}`]))) return false;
    const commit = await run(commitIndex, ["commit-tree", tree, "-p", head, "-m", message]);
    if (existsSync(indexPath)) await copyFile(indexPath, preservedIndex);
    else await run(preservedIndex, ["read-tree", head]);
    await run(preservedIndex, ["reset", commit, "--", ...selected]);
    await writeFile(lockPath, await readFile(preservedIndex));
    if ((await git(root, ["symbolic-ref", "HEAD"])) !== branch)
      throw new Error("The branch changed during shipping; no commit was published.");
    await git(root, ["update-ref", "-m", "Orchestrator: selected files", branch, commit, head]);
    await rename(lockPath, indexPath);
    ownsIndexLock = false;
    return true;
  } finally {
    await lock.close();
    if (ownsIndexLock) await rm(lockPath, { force: true });
    if (temp) await rm(temp, { recursive: true, force: true });
  }
}

export async function shipChanges(cwd: string, opts: ShipOptions): Promise<ShipResult> {
  if (!Array.isArray(opts.files))
    throw new Error("Shipping requires an explicit list of selected file paths.");
  const dirty = opts.files.length > 0;
  if (!dirty && (await git(cwd, ["status", "--porcelain"])))
    throw new Error("Select the files to ship.");
  // Refuse unsupported repository policy before even creating a shipping branch.
  if (dirty) await assertScopedCommitPolicy(cwd);
  let branch = await git(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]);
  if (branch === "HEAD") {
    throw Object.assign(new Error("Detached HEAD — check out a branch before shipping."), {
      kind: "configuration",
    });
  }

  // Ahead-of-upstream commits count as shippable work even with a clean tree.
  let ahead = 0;
  try {
    ahead = Number(await git(cwd, ["rev-list", "--count", "@{upstream}..HEAD"]));
  } catch {
    ahead = Number.NaN; // no upstream yet — pushing will create it
  }
  if (!dirty && ahead === 0) {
    throw Object.assign(new Error("Nothing to ship — the working tree is clean and pushed."), {
      kind: "configuration",
    });
  }

  // Never commit straight to the default branch: branch off first.
  let defaultBranch = branch === "master" ? "master" : "main";
  try {
    const head = await git(cwd, ["symbolic-ref", "refs/remotes/origin/HEAD"]);
    defaultBranch = head.replace("refs/remotes/origin/", "");
  } catch {
    /* No remote default: protect either conventional primary branch. */
  }
  let createdBranch = false;
  // Anything shippable on the default branch moves to a new branch first —
  // including the clean-but-ahead case, which used to push straight to main.
  if (branch === defaultBranch) {
    branch = `orch/${slugify(opts.title)}-${randomUUID()}`;
    await git(cwd, ["checkout", "-b", branch]);
    createdBranch = true;
  }

  let committed = false;
  if (dirty) {
    const message = `${opts.title}\n\n${opts.body ?? "Shipped from The Orchestrator."}`;
    committed = await commitSelectedChanges(cwd, opts.files, message);
  }

  await git(cwd, ["push", "-u", "origin", branch], 120_000);

  // PR via gh; every failure path downgrades to a note, not an error — the
  // commit and push above are already real.
  try {
    await exec("gh", ["--version"], { timeout: 5000 });
  } catch {
    return {
      branch,
      createdBranch,
      committed,
      pushed: true,
      note: "gh CLI not found — pushed the branch, but no PR was created.",
    };
  }
  try {
    const { stdout } = await exec(
      "gh",
      [
        "pr",
        "create",
        "--head",
        branch,
        "--title",
        opts.title,
        "--body",
        `${opts.body ?? ""}\n\nShipped from The Orchestrator`.trim(),
      ],
      { cwd, timeout: 60_000 },
    );
    const url = stdout.trim().split("\n").pop() ?? "";
    return { branch, createdBranch, committed, pushed: true, prUrl: url || undefined };
  } catch (e) {
    // A PR for this branch may already exist — surface it instead of failing.
    try {
      const { stdout } = await exec("gh", ["pr", "view", branch, "--json", "url", "-q", ".url"], {
        cwd,
        timeout: 15_000,
      });
      const url = stdout.trim();
      if (url) {
        return {
          branch,
          createdBranch,
          committed,
          pushed: true,
          prUrl: url,
          note: "This branch already had an open PR — pushed to it.",
        };
      }
    } catch {
      /* fall through to the note below */
    }
    return {
      branch,
      createdBranch,
      committed,
      pushed: true,
      note: `Pushed, but PR creation failed: ${String((e as Error).message ?? e).slice(0, 200)}`,
    };
  }
}
