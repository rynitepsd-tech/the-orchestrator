/**
 * ENTRY DISPATCH — the engine entrypoint must hand OMP's re-entries to OMP.
 *
 * OMP re-launches `process.execPath` for its helper processes (the per-user
 * daemon, shell services, eval kernels…) and for plain CLI commands: since
 * OMP 19 the bash tool rewrites an agent's `git worktree add` into
 * `<execPath> worktree add …`. In the packaged app execPath is the engine, so
 * `packages/engine/src/main.ts` routes every invocation that carries arguments
 * to OMP's CLI. The old dispatch matched a list of known selectors; anything
 * it had not heard of booted a second supervisor instead, which hangs on stdin
 * or exits 0 having done nothing.
 *
 * This drives the source entrypoint; `scripts/smoke-packaged.ts` asserts the
 * same thing against the compiled binary.
 */
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "../../..");
const ENTRY = join(ROOT, "packages/engine/src/main.ts");
const PIN = JSON.parse(readFileSync(join(ROOT, "packages/engine/package.json"), "utf8"))
  .dependencies["@oh-my-pi/pi-coding-agent"] as string;

test("an invocation with arguments runs OMP's CLI, not a second supervisor", async () => {
  const proc = Bun.spawn([process.execPath, ENTRY, "--version"], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
  expect(code).toBe(0);
  // OMP's own stdout, verbatim — not a protocol frame, not a log record.
  expect(out.trim()).toBe(`omp/${PIN}`);
}, 60_000);
