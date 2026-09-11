/**
 * Helpers shared by the operational scripts (packaged smoke, live validation,
 * stress matrix). Deliberately tiny: the scripts are the product here.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface CheckResult {
  name: string;
  ok: boolean;
  detail?: string;
}

/**
 * Pass/fail recorder. Each check prints as it lands; `results` is the tally
 * the caller summarises at the end. `indent` prefixes every printed line.
 */
export function checker(indent = "") {
  const results: CheckResult[] = [];
  const check = (name: string, ok: boolean, detail?: string): void => {
    results.push({ name, ok, detail });
    console.log(`${indent}${ok ? "✓" : "✗"} ${name}${detail ? ` — ${detail}` : ""}`);
  };
  return { results, check };
}

/** Poll `pred` every 50ms until it holds or `timeoutMs` elapses. */
export async function waitFor(pred: () => boolean, timeoutMs: number): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (pred()) return true;
    await Bun.sleep(50);
  }
  return false;
}

const projects: string[] = [];

/** Throwaway project directory under the OS tmpdir, seeded with `files`. */
export function makeProject(prefix: string, files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  for (const [name, body] of Object.entries(files)) writeFileSync(join(dir, name), body);
  projects.push(dir);
  return dir;
}

/** Delete every directory `makeProject` created. */
export function removeProjects(): void {
  for (const dir of projects.splice(0)) rmSync(dir, { recursive: true, force: true });
}
