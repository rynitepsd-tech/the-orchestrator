/**
 * Engine entrypoint.
 *
 * Runs as a sidecar under the Tauri app, speaking NDJSON on stdin/stdout.
 * Also runnable directly for diagnostics:  bun packages/engine/src/main.ts
 *
 * This one binary has two roles:
 *   - default: the SUPERVISOR (catalogue + routing, one per app)
 *   - `--orchestrator-worker`: a SESSION WORKER (exactly one AgentSession)
 *
 * The dual role exists because `bun --compile` produces a single file, so the
 * supervisor re-execs itself to spawn workers. Without the dispatch below, a
 * packaged build would boot a second supervisor instead of a worker and no
 * session would ever start.
 */
import { logger, protectStdout } from "./logging";

// Long prompt-cache retention: providers that support it (Anthropic's 1-hour
// TTL) keep the conversation-prefix cache warm across the pauses typical of
// interactive desktop use, where the default 5-minute window routinely
// expires between messages and the next prompt re-reads the whole history at
// full price. OMP gates this per provider/model and adds any required beta
// header itself; providers without long retention are unaffected. `??=` so an
// explicit user override (including "short"/"none") always wins. Workers
// inherit it via spawn env and also run this line themselves.
process.env.PI_CACHE_RETENTION ??= "long";

// --- role dispatch ---------------------------------------------------------
// Checked first, and before any supervisor state is constructed.
//
// This binary is launched by the app in exactly two shapes: with no arguments
// (the supervisor) and with `--orchestrator-worker` (a session worker). Every
// OTHER invocation is OMP re-entering `process.execPath`, which in a compiled
// build is THIS binary:
//
//   - hidden `__omp_worker_*` selectors — the per-user daemon, shell services
//     and PTY commands, the JS eval kernel, tiny/speech model workers, and the
//     worker threads those processes start;
//   - plain CLI commands — `browser-relay` (daemonized for authenticated
//     browser tooling) and, since OMP 19, `worktree add`: the bash tool
//     rewrites an agent's `git worktree add` into `<execPath> worktree add …`.
//
// All of them belong to OMP's CLI. Routing by "anything with arguments" rather
// than by a list of known selectors is deliberate: a selector this file has
// never heard of would otherwise boot a second supervisor in its place, which
// dies on its closed stdin (OMP then respawns it every ~10s, forever) or, for
// a one-shot command, exits 0 having done nothing.
const cliArgs = process.argv.slice(2);
if (cliArgs.includes("--orchestrator-worker")) {
  // stdout is protocol-only: must happen before anything else can log.
  protectStdout();
  // The worker module takes over the process and exits on its own.
  await import("./worker/main");
} else if (cliArgs.length > 0) {
  // stdout stays untouched here — it is OMP's (a shell service's output, a
  // command's result), not this engine's protocol channel.
  // The compiled build defines PI_COMPILED, so the import itself
  // self-dispatches `runCli(process.argv.slice(2))`; dev builds need the
  // explicit call (the define also compiles this branch away there).
  const cli = await import("@oh-my-pi/pi-coding-agent/cli");
  if (process.env.PI_COMPILED !== "true") {
    await cli.runCli(cliArgs);
  }
} else {
  protectStdout();
  await runSupervisor();
}

// --- supervisor role -------------------------------------------------------

async function runSupervisor(): Promise<void> {
  // Loaded here, not at the top: OMP's helper processes re-enter this file
  // (see above) and should not pay for the supervisor's module graph.
  const { EngineServer } = await import("./server");
  const server = new EngineServer({
    agentDir: process.env.ORCHESTRATOR_AGENT_DIR || undefined,
    // Test mode disables every approval gate. The GUI can never reach it: the
    // Tauri shell scrubs this var (and ORCHESTRATOR_TEST_PROVIDERS) from the
    // engine's environment at spawn, so a persistent `launchctl setenv` cannot
    // arm it. Direct spawns — bun test, the packaged smoke test — still can.
    testMode: process.env.ORCHESTRATOR_TEST_MODE === "1",
  });

  for (const sig of ["SIGINT", "SIGTERM"] as const) {
    process.on(sig, () => {
      logger.info("engine", `received ${sig}`);
      void server.shutdown().finally(() => process.exit(0));
    });
  }

  process.on("uncaughtException", (e) => {
    logger.error("engine", `uncaught: ${e?.message}`, { stack: e?.stack });
  });
  process.on("unhandledRejection", (e) => {
    logger.error("engine", `unhandled rejection: ${String(e)}`);
  });

  try {
    await server.start();
  } catch (e) {
    logger.error("engine", `startup failed: ${String((e as Error)?.message ?? e)}`);
    server.emitLifecycle({
      type: "engine.error",
      error: {
        kind: "engine",
        message: "The OMP engine failed to start.",
        detail: String((e as Error)?.stack ?? e).slice(0, 4000),
      },
    });
    process.exitCode = 1;
    return;
  }

  const decoder = new TextDecoder();
  const reader = Bun.stdin.stream().getReader();

  // A shutdown request must actually end the process. Without this race the
  // loop stays parked on read() — stdin is still open — and the engine lingers
  // after acknowledging shutdown, orphaning it and its workers.
  const stopped = new Promise<"stopped">((resolve) => {
    server.onStopped = () => resolve("stopped");
  });

  while (!server.shuttingDown) {
    const next = await Promise.race([reader.read(), stopped]);
    if (next === "stopped") break;
    const { done, value } = next;
    if (done) {
      // stdin closed: the host went away. Tear down rather than orphaning agents.
      logger.info("engine", "stdin closed; shutting down");
      await server.shutdown();
      break;
    }
    await server.ingest(decoder.decode(value, { stream: true }));
  }

  // Release the stdin lock so Bun's event loop can drain and the process exits.
  await reader.cancel().catch(() => {});
}
