/**
 * The engine's NDJSON protocol server.
 *
 * Discipline enforced here:
 *  - stdout carries protocol frames ONLY. `console.log` is rebound to stderr at
 *    startup so a stray log from any dependency cannot corrupt the stream.
 *  - every response carries the request id it answers.
 *  - events carry a monotonic sequence so the host can detect gaps after a crash.
 *  - malformed input is reported, never fatal.
 */

import { ompVersion } from "@orchestrator/omp-adapter";
import {
  type EngineErrorPayload,
  type EngineEventFrame,
  type EngineInfo,
  type EngineRequest,
  type EngineResponse,
  encodeFrame,
  FrameDecoder,
  isEngineRequest,
  isProtocolCompatible,
  PROTOCOL_VERSION,
  type ProductEvent,
  redactValue,
} from "@orchestrator/protocol";
import { handleRequest } from "./handlers";
import { logger } from "./logging";
import { RuntimeManager } from "./runtime-manager";

export interface EngineServerOptions {
  agentDir?: string;
  testMode?: boolean;
  /** Defaults to process.stdout.write. */
  write?: (chunk: string) => void;
}

export class EngineServer {
  #sequence = 0;
  readonly #decoder = new FrameDecoder();
  readonly #write: (chunk: string) => void;
  readonly #opts: EngineServerOptions;
  manager!: RuntimeManager;
  #shuttingDown = false;

  /** Set by the entrypoint so a shutdown request can end the read loop. */
  onStopped: (() => void) | null = null;

  constructor(opts: EngineServerOptions) {
    this.#opts = opts;
    this.#write = opts.write ?? ((c) => process.stdout.write(c));
  }

  info(): EngineInfo {
    return {
      protocolVersion: PROTOCOL_VERSION,
      // The shell injects the real app version at spawn; a hardcoded fallback
      // here went ten releases stale, so a direct run honestly says "dev".
      engineVersion: process.env.ORCHESTRATOR_VERSION ?? "dev",
      ompVersion: ompVersion(),
      bunVersion: typeof Bun !== "undefined" ? Bun.version : "n/a",
      arch: process.arch,
      platform: process.platform,
      agentDir: this.manager?.agentDir ?? "",
    };
  }

  async start(): Promise<void> {
    this.emitLifecycle({ type: "engine.status", stage: "starting" });

    this.manager = new RuntimeManager({
      agentDir: this.#opts.agentDir,
      testMode: this.#opts.testMode,
      emit: (e) => this.emitEvent(e),
    });

    this.emitLifecycle({ type: "engine.status", stage: "loading-config" });
    await this.manager.init();

    this.emitLifecycle({ type: "engine.status", stage: "loading-models" });
    // Model listing is lazy; surfacing the stage keeps startup legible rather
    // than showing an opaque spinner.

    this.emitLifecycle({ type: "engine.status", stage: "ready" });
    this.emitLifecycle({ type: "engine.ready", info: this.info() });
  }

  /** Feed raw stdin text. Returns once every complete frame is handled. */
  async ingest(chunk: string): Promise<void> {
    const { frames, errors } = this.#decoder.push(chunk);
    for (const err of errors) {
      logger.warn("protocol", err);
      this.emitLifecycle({
        type: "engine.error",
        error: { kind: "protocol", message: "Malformed protocol frame ignored.", detail: err },
      });
    }
    for (const frame of frames) await this.#dispatch(frame);
  }

  async #dispatch(frame: unknown): Promise<void> {
    if (!isEngineRequest(frame)) {
      this.emitLifecycle({
        type: "engine.error",
        error: { kind: "protocol", message: "Frame was not a valid engine request." },
      });
      return;
    }
    const req = frame as EngineRequest;

    if (!isProtocolCompatible(req.protocolVersion)) {
      this.respond({
        protocolVersion: PROTOCOL_VERSION,
        requestId: req.requestId,
        ok: false,
        error: {
          kind: "protocol",
          message: `Protocol version ${req.protocolVersion} is not supported by this engine (expects ${PROTOCOL_VERSION}).`,
          detail: "The app and its bundled engine are out of step. Reinstall The Orchestrator.",
        },
      });
      return;
    }

    try {
      const result = await handleRequest(this, req);
      this.respond({
        protocolVersion: PROTOCOL_VERSION,
        requestId: req.requestId,
        ok: true,
        result: result as never,
      });
    } catch (e) {
      const error = toEngineError(e);
      logger.error("request", `${req.type} failed: ${error.message}`, { detail: error.detail });
      this.respond({
        protocolVersion: PROTOCOL_VERSION,
        requestId: req.requestId,
        ok: false,
        error,
      });
    }
  }

  respond(res: EngineResponse): void {
    this.#write(encodeFrame(redactValue(res)));
  }

  emitEvent(event: ProductEvent): void {
    // Redaction covers events like every other boundary. The two streaming
    // delta types are exempt for throughput — they carry model prose, and the
    // complete message is redacted again when it lands in a response replay.
    const redacted =
      event.type === "assistant.text" || event.type === "assistant.thinking"
        ? event
        : redactValue(event);
    const frame: EngineEventFrame = {
      protocolVersion: PROTOCOL_VERSION,
      sequence: ++this.#sequence,
      sessionId: (redacted as { sessionId?: string }).sessionId,
      event: redacted,
    };
    this.#write(encodeFrame(frame));
  }

  emitLifecycle(event: EngineEventFrame["event"]): void {
    // Lifecycle errors carry auth failure text and worker stderr tails —
    // exactly the strings most likely to embed a credential.
    const frame: EngineEventFrame = {
      protocolVersion: PROTOCOL_VERSION,
      sequence: ++this.#sequence,
      event: redactValue(event),
    };
    this.#write(encodeFrame(frame));
  }

  get shuttingDown(): boolean {
    return this.#shuttingDown;
  }

  /** True when the approval-disabling test hooks are armed — never silent. */
  get testMode(): boolean {
    return this.#opts.testMode === true;
  }

  async shutdown(): Promise<void> {
    if (this.#shuttingDown) return;
    this.#shuttingDown = true;
    this.emitLifecycle({ type: "engine.status", stage: "stopping" });
    // Dispose every session worker before signalling the entrypoint, so no
    // agent process outlives the engine.
    await this.manager?.shutdown();
    this.onStopped?.();
  }
}

export function toEngineError(e: unknown): EngineErrorPayload {
  const err = e as { message?: string; kind?: string; stack?: string };
  const message = String(err?.message ?? e);
  return {
    kind: (err?.kind as EngineErrorPayload["kind"]) ?? "unknown",
    message,
    detail: err?.stack ? String(err.stack).slice(0, 4000) : undefined,
  };
}
