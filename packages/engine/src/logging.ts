/**
 * Structured engine logging.
 *
 * Never writes to stdout — stdout is the protocol channel. Diagnostics go to
 * stderr and to a rotating file under Application Support.
 */
import { appendFileSync, existsSync, mkdirSync, renameSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { redactValue } from "@orchestrator/protocol";

export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const MAX_BYTES = 5 * 1024 * 1024;

export function appSupportDir(): string {
  return join(homedir(), "Library", "Application Support", "The Orchestrator");
}

export function logDir(): string {
  return join(appSupportDir(), "logs");
}

export function engineLogPath(): string {
  return join(logDir(), "engine.log");
}

class Logger {
  #min: LogLevel = (process.env.ORCHESTRATOR_LOG_LEVEL as LogLevel) ?? "info";
  #fileReady = false;

  setLevel(l: LogLevel): void {
    this.#min = l;
  }

  #ensureFile(): boolean {
    if (this.#fileReady) return true;
    try {
      mkdirSync(logDir(), { recursive: true });
      this.#fileReady = true;
      return true;
    } catch {
      return false;
    }
  }

  #rotate(path: string): void {
    try {
      if (existsSync(path) && statSync(path).size > MAX_BYTES) {
        renameSync(path, `${path}.1`);
      }
    } catch {
      /* rotation is best effort */
    }
  }

  log(level: LogLevel, subsystem: string, message: string, fields?: Record<string, unknown>): void {
    if (LEVEL_ORDER[level] < LEVEL_ORDER[this.#min]) return;

    const line = JSON.stringify(
      redactValue({
        ts: new Date().toISOString(),
        level,
        subsystem,
        message,
        ...(fields ?? {}),
      }),
    );

    // stderr, never stdout.
    process.stderr.write(`${line}\n`);

    if (this.#ensureFile()) {
      const path = engineLogPath();
      this.#rotate(path);
      try {
        appendFileSync(path, `${line}\n`);
      } catch {
        /* disk full or read-only; stderr already has it */
      }
    }
  }

  debug(s: string, m: string, f?: Record<string, unknown>) {
    this.log("debug", s, m, f);
  }
  info(s: string, m: string, f?: Record<string, unknown>) {
    this.log("info", s, m, f);
  }
  warn(s: string, m: string, f?: Record<string, unknown>) {
    this.log("warn", s, m, f);
  }
  error(s: string, m: string, f?: Record<string, unknown>) {
    this.log("error", s, m, f);
  }
}

export const logger = new Logger();

/**
 * Rebind console.* to stderr.
 *
 * A single `console.log` from any transitive dependency would otherwise inject
 * a non-protocol line into stdout and desynchronise the host's decoder.
 */
export function protectStdout(): void {
  const toStderr =
    (level: LogLevel) =>
    (...args: unknown[]) => {
      const msg = args.map((a) => (typeof a === "string" ? a : safeStringify(a))).join(" ");
      logger.log(level, "console", msg);
    };
  console.log = toStderr("info");
  console.info = toStderr("info");
  console.warn = toStderr("warn");
  console.error = toStderr("error");
  console.debug = toStderr("debug");
}

function safeStringify(v: unknown): string {
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}
