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
import { EngineServer } from "./server";

// Must happen before anything else can log, in either role.
protectStdout();

// Long prompt-cache retention: providers that support it (Anthropic's 1-hour
// TTL) keep the conversation-prefix cache warm across the pauses typical of
// interactive desktop use, where the default 5-minute window routinely
// expires between messages and the next prompt re-reads the whole history at
// full price. OMP gates this per provider/model and adds any required beta
// header itself; providers without long retention are unaffected. `??=` so an
// explicit user override (including "short"/"none") always wins. Workers
// inherit it via spawn env and also run this line themselves.
process.env.PI_CACHE_RETENTION ??= "long";

// --- worker role -----------------------------------------------------------
// Checked first, and before any supervisor state is constructed.
// OMP re-enters `process.execPath` for its subprocess helpers: hidden
// `__omp_worker_*` selectors (daemon broker, LSP mux, tiny title model, …)
// and the one plain CLI command it daemonizes, `browser-relay` (the broker
// spawns `resolveWorkerSpawnCmd("browser-relay")` for authenticated browser
// tooling). In a compiled build execPath is THIS binary, so route those to
// OMP's CLI — otherwise a supervisor boots in their place, dies on its closed
// stdin, and OMP respawns it every ~10s forever.
const cliArgs = process.argv.slice(2);
const ompReentry =
  cliArgs.some((a) => a.startsWith("__omp_worker_")) || cliArgs[0] === "browser-relay";
if (process.argv.includes("--orchestrator-worker")) {
  // The worker module takes over the process and exits on its own.
  await import("./worker/main");
} else if (ompReentry) {
  // The compiled build defines PI_COMPILED, so the import itself
  // self-dispatches `runCli(process.argv.slice(2))`; dev builds need the
  // explicit call (the define also compiles this branch away there).
  const cli = await import("@oh-my-pi/pi-coding-agent/cli");
  if (process.env.PI_COMPILED !== "true") {
    await cli.runCli(cliArgs);
  }
} else {
  await runSupervisor();
}

// --- supervisor role -------------------------------------------------------

async function runSupervisor(): Promise<void> {
  const server = new EngineServer({
    agentDir: process.env.ORCHESTRATOR_AGENT_DIR || undefined,
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
