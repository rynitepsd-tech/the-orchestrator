/**
 * Shared scaffolding for the worker-process integration tests: one mock
 * provider, one RuntimeManager whose workers register it, per-session event
 * capture, and throwaway project folders removed at teardown.
 *
 * `useHarness` registers the bun:test lifecycle hooks itself; call it once at
 * module scope. `manager` and `mock` are live from `beforeAll` onward.
 */
import { afterAll, beforeAll } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ompAgentDir } from "@orchestrator/omp-adapter";
import type { ProductEvent } from "@orchestrator/protocol";
import { RuntimeManager } from "../src/runtime-manager";
import { type MockServer, startMockProvider } from "./mock-provider";

export interface HarnessOptions {
  /** tmp-dir prefix for `makeProject`, e.g. "orch-reg". */
  prefix: string;
  /** Mock model ids registered in every worker (under provider "mockprov"). */
  modelIds: string[];
  /** Observe every event after it is captured. */
  onEvent?: (e: ProductEvent) => void;
}

type EventOf<T extends ProductEvent["type"]> = Extract<ProductEvent, { type: T }>;

export class Harness {
  /** Assigned by `beforeAll`. */
  manager!: RuntimeManager;
  /** Assigned by `beforeAll`. */
  mock!: MockServer;
  /** Directories removed at `afterAll`. */
  readonly roots: string[] = [];
  readonly #captured = new Map<string, ProductEvent[]>();
  readonly #opts: HarnessOptions;

  constructor(opts: HarnessOptions) {
    this.#opts = opts;
  }

  async start(): Promise<void> {
    this.mock = startMockProvider();
    this.manager = new RuntimeManager({
      agentDir: ompAgentDir(),
      testMode: true,
      // Each worker process registers the mock provider for itself.
      workerEnv: {
        testProviders: [
          {
            name: "mockprov",
            baseUrl: this.mock.url,
            apiKey: "mock-key",
            modelIds: this.#opts.modelIds,
          },
        ],
      },
      emit: (e) => {
        const list = this.#captured.get(e.sessionId);
        if (list) list.push(e);
        else this.#captured.set(e.sessionId, [e]);
        this.#opts.onEvent?.(e);
      },
    });
    await this.manager.init();
  }

  async stop(): Promise<void> {
    await this.manager?.shutdown();
    this.mock?.stop();
    for (const r of this.roots) rmSync(r, { recursive: true, force: true });
  }

  /** Per-session event capture, so tests can prove nothing crosses. */
  eventsFor = (sessionId: string): ProductEvent[] => this.#captured.get(sessionId) ?? [];

  eventsOfType = <T extends ProductEvent["type"]>(sessionId: string, type: T): EventOf<T>[] =>
    this.eventsFor(sessionId).filter((e): e is EventOf<T> => e.type === type);

  textFor = (sessionId: string): string =>
    this.eventsOfType(sessionId, "assistant.text")
      .map((e) => e.delta)
      .join("");

  finishedFor = (sessionId: string): EventOf<"session.finished">[] =>
    this.eventsOfType(sessionId, "session.finished");

  /** A fresh project folder with a MARKER file, removed at teardown. */
  makeProject = (tag: string): string => {
    const dir = mkdtempSync(join(tmpdir(), `${this.#opts.prefix}-${tag}-`));
    writeFileSync(join(dir, "MARKER.txt"), `${tag}\n`);
    this.roots.push(dir);
    return dir;
  };
}

export async function waitFor(pred: () => boolean, timeoutMs = 30_000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (pred()) return true;
    await Bun.sleep(25);
  }
  return false;
}

export function useHarness(opts: HarnessOptions): Harness {
  const h = new Harness(opts);
  beforeAll(() => h.start());
  afterAll(() => h.stop());
  return h;
}
