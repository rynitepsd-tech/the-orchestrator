/**
 * Stress matrix — measured, not guessed. Feeds docs/PERFORMANCE.md.
 *
 * Spawns N concurrent sessions against the local mock provider (so no API
 * credit is spent) and measures per-worker RSS, aggregate memory, spawn
 * latency, and request round-trip latency at each step of the matrix.
 *
 * Usage: bun run scripts/stress-matrix.ts [maxSessions=8]
 */
import { RuntimeManager } from "../packages/engine/src/runtime-manager";
import { startMockProvider } from "../packages/engine/test/mock-provider";
import { ompAgentDir } from "../packages/omp-adapter/src";
import type { ProductEvent } from "../packages/protocol/src";
import { makeProject, removeProjects, waitFor } from "./lib";

const MAX = Number(process.argv[2] ?? 8);
const mock = startMockProvider();
const finished = new Set<string>();

const manager = new RuntimeManager({
  agentDir: ompAgentDir(),
  testMode: true,
  workerEnv: {
    testProviders: [
      {
        name: "mockprov",
        baseUrl: mock.url,
        apiKey: "mock-key",
        modelIds: ["mock-a", "mock-slow"],
      },
    ],
  },
  emit: (e: ProductEvent) => {
    if (e.type === "session.finished") finished.add(e.sessionId);
  },
});
await manager.init();

interface Row {
  n: number;
  spawnMs: number;
  pingMs: number;
  workerRssMb: number[];
  totalWorkerRssMb: number;
  supervisorRssMb: number;
}
const rows: Row[] = [];
const ids: string[] = [];

console.log("sessions | spawn ms | ping ms | worker RSS (MB) | total workers | supervisor RSS");
console.log("---------|----------|---------|-----------------|---------------|---------------");

for (let n = 1; n <= MAX; n++) {
  const t0 = performance.now();
  const s = await manager.create({
    projectPath: makeProject(`orch-stress-s${n}-`, { "M.txt": `s${n}` }),
    title: `Stress ${n}`,
    model: "mockprov/mock-a",
    advisors: [],
  });
  const spawnMs = performance.now() - t0;
  ids.push(s.sessionId);

  // One completed turn per session so workers hold realistic state.
  await manager.route(s.sessionId, "session.prompt", { sessionId: s.sessionId, text: "go" });
  await waitFor(() => finished.has(s.sessionId), 60_000);

  // Round-trip latency to a busy-ish supervisor (simulates a session switch).
  const t1 = performance.now();
  await manager.route(ids[0], "usage.session", { sessionId: ids[0] });
  const pingMs = performance.now() - t1;

  const stats = await manager.workerStats();
  const rss = stats.map((w) => Math.round((w.rssBytes ?? 0) / 1024 / 1024));
  const row: Row = {
    n,
    spawnMs: Math.round(spawnMs),
    pingMs: Math.round(pingMs * 10) / 10,
    workerRssMb: rss,
    totalWorkerRssMb: rss.reduce((a, b) => a + b, 0),
    supervisorRssMb: Math.round(process.memoryUsage().rss / 1024 / 1024),
  };
  rows.push(row);
  console.log(
    `${String(n).padStart(8)} | ${String(row.spawnMs).padStart(8)} | ${String(row.pingMs).padStart(7)} | ${rss.join(", ").padEnd(15)} | ${String(row.totalWorkerRssMb).padStart(13)} | ${row.supervisorRssMb}`,
  );
}

// Streaming under load: run all sessions simultaneously against the slow model.
console.log("\nAll sessions streaming simultaneously (mock-slow)…");
finished.clear();
const t0 = performance.now();
for (const id of ids) {
  await manager.route(id, "session.setModel", { sessionId: id, model: "mockprov/mock-slow" });
  await manager.route(id, "session.prompt", { sessionId: id, text: "go" });
}
await waitFor(() => finished.size === ids.length, 240_000);
console.log(
  `all ${ids.length} streamed to completion in ${Math.round(performance.now() - t0)}ms total`,
);
const statsAfter = await manager.workerStats();
console.log(
  `worker RSS after streaming: ${statsAfter.map((w) => Math.round((w.rssBytes ?? 0) / 1024 / 1024)).join(", ")} MB`,
);

await manager.shutdown();
mock.stop();
removeProjects();

console.log("\nJSON:", JSON.stringify(rows));
process.exit(0);
