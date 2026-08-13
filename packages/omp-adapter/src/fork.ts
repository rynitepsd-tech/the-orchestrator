/**
 * Session fork via upstream semantics.
 *
 * Uses `SessionManager.forkFrom(sourcePath, cwd)` (session-manager.ts,
 * OMP 17.3.1): copies the source session's entries and artifacts into a brand
 * new session file with `parentSession` set in the header, without ever making
 * the source live. The source file is only READ, so forking a session that is
 * currently open in a worker is safe — the fork is a snapshot at fork time.
 *
 * This is deliberately NOT a hand-rolled JSONL copy: upstream owns entry
 * migration, blob resolution, and header fields (parentSession,
 * providerPromptCacheKey), all of which a naive copy would corrupt.
 */
import { SessionManager } from "@oh-my-pi/pi-coding-agent";

export interface ForkResult {
  /** Path of the new session file. Open it with resumeSessionPath to go live. */
  path: string;
  ompSessionId: string;
}

export async function forkSessionFile(
  sourcePath: string,
  cwd: string,
  agentDir?: string,
  title?: string,
): Promise<ForkResult> {
  const dir = SessionManager.getDefaultSessionDir(cwd, agentDir);
  // forkFrom writes the new file atomically before returning, so the fork is
  // discoverable and resumable even if no prompt is ever sent to it.
  const manager = await SessionManager.forkFrom(sourcePath, cwd, dir);
  if (title) {
    try {
      await (manager as any).setSessionName?.(title, "user");
    } catch {
      /* cosmetic */
    }
  }
  return {
    path: String((manager as any).getSessionFile?.() ?? ""),
    ompSessionId: String((manager as any).getSessionId?.() ?? ""),
  };
}
