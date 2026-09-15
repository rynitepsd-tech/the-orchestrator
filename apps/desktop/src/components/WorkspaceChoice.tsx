import type { JSX } from "react";
import { useEffect, useId, useState } from "react";
import { engine } from "../engine-client";

interface WorkspaceSelection {
  mode: "shared" | "isolated";
  setChoice: (mode: "shared" | "isolated") => void;
  git: boolean | null;
  error?: string;
  ready: boolean;
}

export function useWorkspaceChoice(projectPath: string, disabled = false): WorkspaceSelection {
  const [choice, setChoice] = useState<"shared" | "isolated" | null>(null);
  const [capability, setCapability] = useState<{
    path: string;
    git: boolean;
    error?: string;
  } | null>(null);
  const git = capability?.path === projectPath ? capability.git : null;
  const error = capability?.path === projectPath ? capability.error : undefined;
  const mode = choice ?? (git ? "isolated" : "shared");
  useEffect(() => {
    let cancelled = false;
    setCapability(null);
    setChoice(null);
    if (!projectPath.trim() || disabled) return;
    const timer = setTimeout(() => {
      void engine
        .request("project.open", { path: projectPath.trim() })
        .then(({ project }) => {
          if (!cancelled) setCapability({ path: projectPath, git: Boolean(project.git) });
        })
        .catch((failure: unknown) => {
          if (!cancelled)
            setCapability({
              path: projectPath,
              git: false,
              error: failure instanceof Error ? failure.message : String(failure),
            });
        });
    }, 200);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [projectPath, disabled]);
  return { mode, setChoice, git, error, ready: git !== null && !error };
}

export function WorkspaceChoice({
  workspace,
  disabled,
}: {
  workspace: WorkspaceSelection;
  disabled?: boolean;
}): JSX.Element {
  const explanationId = useId();
  return (
    <label
      className="field"
      style={{ display: "grid", gap: 6, width: "min(720px, 100%)", marginBottom: 12 }}
    >
      <span>Workspace</span>
      <select
        className="input"
        value={workspace.mode}
        disabled={workspace.git === null || disabled}
        onChange={(event) =>
          workspace.setChoice(event.target.value === "isolated" ? "isolated" : "shared")
        }
        aria-describedby={explanationId}
      >
        <option value="isolated" disabled={!workspace.git}>
          Isolated git worktree
        </option>
        <option value="shared">Shared project folder</option>
      </select>
      <span className="hint" id={explanationId}>
        {workspace.git === null
          ? "Checking project…"
          : workspace.mode === "isolated"
            ? "Starts from committed HEAD in a separate checkout. Dirty files, untracked secrets and installed dependencies are not copied. A repository with no commits must use Shared. The worktree is retained when you close the session."
            : "Uses the project folder as-is, including local changes. Sessions share files; selecting paths for shipping does not isolate another session’s edits in the same file."}
        {workspace.git === false && !workspace.error
          ? " Isolation requires a git repository with an initial commit."
          : ""}
      </span>
      {workspace.error && (
        <span className="banner" role="alert">
          {workspace.error}
        </span>
      )}
    </label>
  );
}
