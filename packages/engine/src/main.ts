/**
 * Engine entrypoint.
 *
 * Runs as a sidecar under the Tauri app, speaking NDJSON on stdin/stdout.
 * Also runnable directly for diagnostics:  bun packages/engine/src/main.ts
 */
import { logger, protectStdout } from "./logging";
import { EngineServer } from "./server";

// Must happen before anything else can log.
protectStdout();

const server = new EngineServer({
  agentDir: process.env.ORCHESTRATOR_AGENT_DIR || undefined,
  testMode: process.env.ORCHESTRATOR_TEST_MODE === "1",
});

async function main(): Promise<void> {
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

await main();
