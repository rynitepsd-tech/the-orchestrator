/**
 * Typed client for the engine sidecar.
 *
 * The webview never touches a process. Frames go out through a Tauri command
 * and come back as Tauri events, so the security boundary stays in Rust.
 */
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import {
  encodeFrame,
  isEngineEventFrame,
  isEngineResponse,
  PROTOCOL_VERSION,
  type EngineErrorPayload,
  type EngineEventFrame,
  type ProductEvent,
  type RequestPayloads,
  type RequestType,
  type ResponsePayloads,
} from "@orchestrator/protocol";

type EngineLifecycle = Extract<EngineEventFrame["event"], { type: `engine.${string}` }>;

interface Pending {
  resolve: (v: unknown) => void;
  reject: (e: EngineErrorPayload) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class EngineClient {
  #pending = new Map<string, Pending>();
  #seq = 0;
  #lastSequence = 0;
  #unlisteners: UnlistenFn[] = [];

  onEvent: (e: ProductEvent) => void = () => {};
  onLifecycle: (e: EngineLifecycle) => void = () => {};
  /** Fired when the engine process itself starts, dies, or fails to launch. */
  onSupervisor: (e: { kind: string; code?: number | null; message?: string; detail?: string }) => void =
    () => {};
  /** Fired when the event sequence skips, i.e. frames were lost. */
  onSequenceGap: (expected: number, got: number) => void = () => {};

  async connect(): Promise<void> {
    this.#unlisteners.push(
      await listen<string>("engine://frame", (ev) => this.#onFrame(ev.payload)),
    );
    this.#unlisteners.push(
      await listen<any>("engine://supervisor", (ev) => {
        // A dead engine resets the stream; do not report a false gap after restart.
        if (ev.payload?.kind === "spawning") this.#lastSequence = 0;
        this.onSupervisor(ev.payload);
      }),
    );
  }

  dispose(): void {
    for (const u of this.#unlisteners) u();
    this.#unlisteners = [];
    for (const [, p] of this.#pending) {
      clearTimeout(p.timer);
      p.reject({ kind: "engine", message: "The engine connection closed." });
    }
    this.#pending.clear();
  }

  #onFrame(line: string): void {
    let frame: unknown;
    try {
      frame = JSON.parse(line);
    } catch {
      return; // a malformed frame must never take down the UI
    }

    if (isEngineResponse(frame)) {
      const p = this.#pending.get(frame.requestId);
      if (!p) return;
      this.#pending.delete(frame.requestId);
      clearTimeout(p.timer);
      if (frame.ok) p.resolve(frame.result);
      else p.reject(frame.error);
      return;
    }

    if (isEngineEventFrame(frame)) {
      if (this.#lastSequence && frame.sequence > this.#lastSequence + 1) {
        this.onSequenceGap(this.#lastSequence + 1, frame.sequence);
      }
      this.#lastSequence = frame.sequence;

      const e = frame.event as ProductEvent | EngineLifecycle;
      if (typeof e.type === "string" && e.type.startsWith("engine.")) {
        this.onLifecycle(e as EngineLifecycle);
      } else {
        this.onEvent(e as ProductEvent);
      }
    }
  }

  request<T extends RequestType>(
    type: T,
    payload: RequestPayloads[T],
    timeoutMs = 120_000,
  ): Promise<ResponsePayloads[T]> {
    const requestId = `r${++this.#seq}`;
    const frame = encodeFrame({ protocolVersion: PROTOCOL_VERSION, requestId, type, payload });

    return new Promise<ResponsePayloads[T]>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(requestId);
        reject({ kind: "engine", message: `Request ${type} timed out.`, retryable: true });
      }, timeoutMs);

      this.#pending.set(requestId, {
        resolve: resolve as (v: unknown) => void,
        reject,
        timer,
      });

      invoke("engine_send", { frame }).catch((e) => {
        this.#pending.delete(requestId);
        clearTimeout(timer);
        reject({ kind: "engine", message: String(e) });
      });
    });
  }

  restart(): Promise<void> {
    return invoke("engine_restart");
  }

  running(): Promise<boolean> {
    return invoke("engine_running");
  }
}

export const engine = new EngineClient();
