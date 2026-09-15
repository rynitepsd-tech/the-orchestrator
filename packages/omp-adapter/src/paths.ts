/**
 * Path containment on REAL paths.
 *
 * Lexical prefix checks pass through symlinks; every containment decision in
 * the engine resolves the filesystem first and compares the result against a
 * realpath'd root.
 */
import { realpathSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

/**
 * Resolve the parent directory through symlinks, keeping the final segment
 * lexical so a path that does not exist yet (a file about to be written) can
 * still be checked. Falls back to the input when the parent cannot be
 * resolved — the lexical path is all there is to check.
 */
export function realParentPath(absPath: string): string {
  try {
    return join(realpathSync(dirname(absPath)), basename(absPath));
  } catch {
    return absPath;
  }
}

/** Stable project identity through symlink aliases, including a missing leaf folder. */
export function canonicalPath(path: string): string {
  const absolute = resolve(path);
  try {
    return realpathSync(absolute);
  } catch {
    return realParentPath(absolute);
  }
}

/** Whether a real path is `root` itself or lies beneath it. */
export function isInsideRoot(realPath: string, root: string): boolean {
  return realPath === root || realPath.startsWith(`${root}/`);
}
