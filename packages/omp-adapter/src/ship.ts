/**
 * One-click "Commit, Push & PR".
 *
 * The whole exit ramp from agent-work to merged-work in one engine call:
 * branch off the default if needed, commit whatever is in the working tree,
 * push with upstream, and open a PR via the gh CLI. Degrades honestly — no
 * gh, no GitHub remote, or an existing PR all produce a useful result with a
 * `note`, never a half-done mystery state.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);

export interface ShipOptions {
  /** PR/commit title, typically the session title. */
  title: string;
  body?: string;
}

export interface ShipResult {
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

export async function shipChanges(cwd: string, opts: ShipOptions): Promise<ShipResult> {
  const dirty = (await git(cwd, ["status", "--porcelain"])) !== "";
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
  let defaultBranch = "main";
  try {
    const head = await git(cwd, ["symbolic-ref", "refs/remotes/origin/HEAD"]);
    defaultBranch = head.replace("refs/remotes/origin/", "");
  } catch {
    /* no origin/HEAD ref — assume main */
  }
  let createdBranch = false;
  if (branch === defaultBranch && dirty) {
    const stamp = new Date().toISOString().slice(5, 16).replace(/[-T:]/g, "");
    branch = `orch/${slugify(opts.title)}-${stamp}`;
    await git(cwd, ["checkout", "-b", branch]);
    createdBranch = true;
  }

  let committed = false;
  if (dirty) {
    await git(cwd, ["add", "-A"]);
    const message = `${opts.title}\n\n${opts.body ?? "Shipped from The Orchestrator."}`;
    await git(cwd, ["commit", "-m", message], 30_000);
    committed = true;
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
        `${opts.body ?? ""}\n\n🤖 Shipped from The Orchestrator`.trim(),
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
