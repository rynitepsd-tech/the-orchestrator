import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import type { Stats } from "node:fs";
import { constants } from "node:fs";
import { lstat, open, readlink, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import type { ProductEvent, ToolCompleted, VerificationEvidence } from "@orchestrator/protocol";
import { sanitizeOutput } from "@orchestrator/protocol";

const exec = promisify(execFile);
const MAX_OUTPUT = 8 * 1024;
const MAX_FILES = 10_000;
const MAX_FILE_BYTES = 4 * 1024 * 1024;
const MAX_SCAN_BYTES = 64 * 1024 * 1024;
const MAX_SCAN_MS = 5_000;
const SCOPE =
  "Revision covers non-ignored Git workspace files. Sensitive files use metadata only; ignored files and external/browser state are not covered.";
const SENSITIVE_PATH =
  /(?:^|\/)(?:\.env(?:\.[^/]*)?|\.npmrc|\.netrc|credentials(?:\.[^/]*)?|secrets?(?:\.[^/]*)?|id_(?:rsa|ed25519)|[^/]+\.(?:pem|key|p12|pfx))(?:\/|$)/i;

interface Fingerprint {
  revision?: string;
  detail?: string;
}

interface Observation {
  requestId: string;
  kind: VerificationEvidence["kind"];
  label: string;
  startedAt: string;
  before: Fingerprint;
  output: string;
}

function bounded(text: string): string {
  return sanitizeOutput(text, MAX_OUTPUT).output;
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function exitCode(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) ? value : undefined;
}

/** Read only explicitly structured result fields, never infer success from prose. */
function structured(result: ToolCompleted): {
  exitCode?: number;
  assertions: boolean[];
  artifacts: string[];
} {
  const details = result.ompResult?.details;
  const assertions: boolean[] = [];
  const artifacts = new Set<string>();
  let visited = 0;
  const visit = (value: unknown, depth: number) => {
    if (++visited > 300 || depth > 5) return;
    if (Array.isArray(value)) {
      for (const entry of value.slice(0, 40)) visit(entry, depth + 1);
      return;
    }
    const record = object(value);
    if (!record) return;
    // A typed assertion result is evidence; a generic `success`/`ok` is not.
    if (record.type === "assertion" || record.kind === "assertion") {
      if (typeof record.passed === "boolean") assertions.push(record.passed);
      else if (record.status === "passed" || record.status === "failed") {
        assertions.push(record.status === "passed");
      }
    }
    for (const [key, field] of Object.entries(record).slice(0, 40)) {
      if (
        /^(?:artifactPath|screenshotPath|recordingPath|tracePath)$/.test(key) &&
        typeof field === "string"
      ) {
        if (field.length <= 2048 && !SENSITIVE_PATH.test(field)) artifacts.add(bounded(field));
      } else if (key === "artifactPaths" && Array.isArray(field)) {
        for (const path of field.slice(0, 20)) {
          if (typeof path === "string" && path.length <= 2048 && !SENSITIVE_PATH.test(path))
            artifacts.add(bounded(path));
        }
      } else if (
        (record.type === "artifact" || record.kind === "artifact") &&
        key === "path" &&
        typeof field === "string"
      ) {
        if (field.length <= 2048 && !SENSITIVE_PATH.test(field)) artifacts.add(bounded(field));
      }
      if (field !== null && typeof field === "object") visit(field, depth + 1);
    }
  };
  visit(details, 0);
  visit(result.ompResult?.content, 0);
  return {
    exitCode:
      result.detail?.kind === "bash"
        ? (exitCode(result.detail.exitCode) ?? exitCode(details?.exitCode))
        : exitCode(details?.exitCode),
    assertions,
    artifacts: [...artifacts].slice(0, 20),
  };
}

/** Observes the SDK's tools. Git is queried for revision metadata, never to run checks. */
export class EvidenceTracker {
  readonly #cwd: string;
  #queue: Promise<void> = Promise.resolve();
  #sequence = 0;
  #pending = new Map<string, Observation>();
  #records = new Map<string, VerificationEvidence>();

  constructor(cwd: string) {
    this.#cwd = resolve(cwd);
  }

  restore(evidence: VerificationEvidence[]): void {
    for (const record of evidence) {
      this.#records.set(record.id, {
        ...record,
        label: bounded(record.label),
        output: record.output === undefined ? undefined : bounded(record.output),
        detail: record.detail === undefined ? undefined : bounded(record.detail),
        artifactPaths: record.artifactPaths
          ?.slice(0, 20)
          .filter((path) => !SENSITIVE_PATH.test(path))
          .map(bounded),
        // Refresh compares the saved fingerprint with this workspace; no baseline reset.
        stale: record.stale || !record.revision,
      });
    }
  }

  observe(event: ProductEvent, requestId: string): Promise<void> {
    if (event.type !== "tool.start" && event.type !== "tool.update" && event.type !== "tool.end") {
      return this.#queue;
    }
    const at = new Date().toISOString();
    // Receipt sequence detects a tool boundary arriving while an asynchronous scan runs.
    const sequence = event.type === "tool.update" ? this.#sequence : ++this.#sequence;
    return this.#enqueue(async () => {
      const key = `${requestId}:${event.callId}`;
      if (event.type === "tool.start") {
        const name = event.toolName.toLowerCase();
        const code = typeof event.args.code === "string" ? event.args.code : "";
        const browser =
          /(?:^|[._/-])browser(?:$|[._/-])/.test(name) ||
          ((name === "eval" || name === "execute") && /\bbrowser\s*\./.test(code));
        const command = /^(?:bash|command|shell|exec|execute_command)$/.test(name);
        if (!browser && !command) return;
        let before = await this.#fingerprint();
        if (this.#sequence !== sequence) {
          before = {
            detail:
              "Tool activity overlapped the initial revision capture; starting revision is unavailable.",
          };
        }
        const label = browser
          ? typeof event.args.title === "string"
            ? event.args.title
            : event.toolName
          : typeof event.args.command === "string"
            ? event.args.command
            : event.toolName;
        this.#pending.set(key, {
          requestId,
          kind: browser ? "browser" : "command",
          label: bounded(label),
          startedAt: at,
          before,
          output: "",
        });
        return;
      }
      const pending = this.#pending.get(key);
      if (event.type === "tool.update") {
        if (pending && event.outputDelta)
          pending.output = bounded(pending.output + event.outputDelta.slice(0, MAX_OUTPUT));
        return;
      }
      this.#pending.delete(key);
      // Bash's normalized detail can recover a missed start without inventing a baseline.
      if (!pending && event.detail?.kind !== "bash") return;
      const observation: Observation = pending ?? {
        requestId,
        kind: "command",
        label: bounded(
          event.detail?.kind === "bash" ? event.detail.command || "Command" : "Command",
        ),
        startedAt: at,
        before: {
          detail: "Tool start was not observed; start time and starting revision are unavailable.",
        },
        output: "",
      };
      const after = await this.#fingerprint();
      const raw = structured(event);
      const invocationFailed = !event.ok || event.ompResult?.isError === true;
      let status: VerificationEvidence["status"];
      let outcome: string;
      if (observation.kind === "command") {
        status =
          raw.exitCode === undefined
            ? invocationFailed
              ? "failed"
              : "unknown"
            : raw.exitCode === 0 && !invocationFailed
              ? "passed"
              : "failed";
        outcome =
          raw.exitCode === undefined
            ? "Command exit status was not exposed by the tool. Invocation success is not verification success."
            : `Observed process exit ${raw.exitCode}; this does not establish that tests or assertions ran.`;
      } else {
        status =
          invocationFailed || raw.assertions.some((passed) => !passed)
            ? "failed"
            : raw.assertions.length > 0
              ? "passed"
              : "observed";
        outcome =
          raw.assertions.length > 0
            ? `${raw.assertions.length} structured browser assertion result(s) observed.`
            : "Browser execution observed without an objective assertion result; behavior remains unverified.";
      }
      const changed =
        observation.before.revision !== undefined &&
        after.revision !== undefined &&
        observation.before.revision !== after.revision;
      const captureOverlapped = this.#sequence !== sequence;
      const revision = observation.before.revision;
      const detail = [
        outcome,
        observation.before.detail,
        after.detail,
        changed
          ? "Workspace changed during execution; this evidence does not cover the resulting revision."
          : undefined,
        captureOverlapped
          ? "Later tool activity overlapped the ending revision capture."
          : undefined,
        event.truncated ? "Tool output was truncated upstream." : undefined,
        SCOPE,
      ]
        .filter(Boolean)
        .join(" ");
      const id = `evidence:${requestId}:${event.callId}`;
      this.#records.set(id, {
        id,
        requestId: observation.requestId,
        callId: event.callId,
        kind: observation.kind,
        label: observation.label,
        status,
        exitCode: observation.kind === "command" ? raw.exitCode : undefined,
        output: bounded(event.output || event.error || observation.output) || undefined,
        artifactPaths: raw.artifacts.length ? raw.artifacts : undefined,
        startedAt: observation.startedAt,
        finishedAt: at,
        revision,
        stale: !revision || !after.revision || changed || captureOverlapped,
        detail,
      });
    });
  }

  async refresh(requestId: string): Promise<VerificationEvidence[]> {
    let result: VerificationEvidence[] = [];
    const sequence = this.#sequence;
    await this.#enqueue(async () => {
      const current = await this.#fingerprint();
      const overlapped = sequence !== this.#sequence;
      for (const [id, evidence] of this.#records) {
        const stale =
          evidence.stale ||
          !current.revision ||
          !evidence.revision ||
          evidence.revision !== current.revision ||
          overlapped;
        if (stale !== evidence.stale) this.#records.set(id, { ...evidence, stale });
      }
      result = [...this.#records.values()]
        .filter((evidence) => evidence.requestId === requestId)
        .map((evidence) => ({ ...evidence, artifactPaths: evidence.artifactPaths?.slice() }));
      if (!current.revision || overlapped) {
        const note =
          current.detail ??
          "Tool activity overlapped refresh; current revision could not be confirmed.";
        result = result.map((evidence) => ({
          ...evidence,
          detail: `${evidence.detail ?? ""} Refresh: ${note}`.trim(),
        }));
      }
    });
    return result;
  }

  #enqueue(operation: () => Promise<void>): Promise<void> {
    const next = this.#queue.then(operation);
    // Preserve the queue even if the caller encounters an unexpected event error.
    this.#queue = next.catch(() => {});
    return next;
  }

  async #inventory(): Promise<string[]> {
    const options = {
      cwd: this.#cwd,
      encoding: "utf8" as const,
      timeout: MAX_SCAN_MS,
      maxBuffer: 2 * 1024 * 1024,
    };
    const [listed, ignored] = await Promise.all([
      exec(
        "git",
        [
          "-c",
          "core.fsmonitor=false",
          "ls-files",
          "--cached",
          "--others",
          "--exclude-standard",
          "-z",
          "--",
          ".",
        ],
        options,
      ),
      exec(
        "git",
        [
          "-c",
          "core.fsmonitor=false",
          "ls-files",
          "--cached",
          "--ignored",
          "--exclude-standard",
          "-z",
          "--",
          ".",
        ],
        options,
      ),
    ]);
    const excluded = new Set(ignored.stdout.split("\0"));
    const paths = [
      ...new Set(listed.stdout.split("\0").filter((path) => path && !excluded.has(path))),
    ].sort();
    if (paths.length > MAX_FILES) throw new Error("file limit");
    return paths;
  }

  async #fingerprint(): Promise<Fingerprint> {
    try {
      const started = Date.now();
      const root = await realpath(this.#cwd);
      const paths = await this.#inventory();
      const digest = createHash("sha256");
      let bytes = 0;
      const stamps = new Map<string, string>();
      const stamp = (stat: Stats) =>
        `${stat.dev}:${stat.ino}:${stat.mode}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
      for (const path of paths) {
        if (Date.now() - started > MAX_SCAN_MS) throw new Error("time limit");
        const absolute = resolve(root, path);
        const local = relative(root, absolute);
        if (
          isAbsolute(local) ||
          local === ".." ||
          local.startsWith(`..${sep}`) ||
          local.split(sep).includes(".git")
        )
          throw new Error("unsafe path");
        digest.update(JSON.stringify(path));
        let stat: Stats;
        try {
          stat = await lstat(absolute);
        } catch (error) {
          if (object(error)?.code !== "ENOENT") throw error;
          digest.update("missing");
          stamps.set(absolute, "missing");
          continue;
        }
        const parent = await realpath(resolve(absolute, ".."));
        const parentRelative = relative(root, parent);
        if (
          isAbsolute(parentRelative) ||
          parentRelative === ".." ||
          parentRelative.startsWith(`..${sep}`)
        )
          throw new Error("external path");
        stamps.set(absolute, stamp(stat));
        digest.update(String(stat.mode));
        if (SENSITIVE_PATH.test(path)) {
          digest.update(stamp(stat));
        } else if (stat.isSymbolicLink()) {
          digest.update(await readlink(absolute));
        } else if (stat.isFile()) {
          bytes += stat.size;
          if (stat.size > MAX_FILE_BYTES || bytes > MAX_SCAN_BYTES)
            throw new Error("content limit");
          const file = await open(absolute, constants.O_RDONLY | constants.O_NOFOLLOW);
          try {
            if (stamp(await file.stat()) !== stamp(stat)) throw new Error("file changed");
            // Never read beyond the observed size cap if the file grows concurrently.
            const buffer = Buffer.allocUnsafe(stat.size + 1);
            let length = 0;
            while (length < buffer.length) {
              const read = await file.read(buffer, length, buffer.length - length, length);
              if (!read.bytesRead) break;
              length += read.bytesRead;
            }
            if (length !== stat.size || stamp(await file.stat()) !== stamp(stat))
              throw new Error("file changed");
            digest.update(buffer.subarray(0, length));
          } finally {
            await file.close();
          }
        } else {
          // In particular, do not pretend the gitlink hash covers a submodule's worktree.
          throw new Error("unsupported workspace entry");
        }
        digest.update("\0");
      }
      // Detect files added/removed or edited elsewhere while this bounded scan ran.
      if (JSON.stringify(paths) !== JSON.stringify(await this.#inventory()))
        throw new Error("inventory changed");
      for (const [path, expected] of stamps) {
        if (Date.now() - started > MAX_SCAN_MS) throw new Error("time limit");
        let actual = "missing";
        try {
          actual = stamp(await lstat(path));
        } catch (error) {
          if (object(error)?.code !== "ENOENT") throw error;
        }
        if (actual !== expected) throw new Error("workspace changed");
      }
      return { revision: `workspace-v1:${digest.digest("hex")}` };
    } catch {
      return {
        detail:
          "Workspace fingerprint unavailable: requires a stable Git workspace within the scan limits (10,000 files, 4 MiB/file, 64 MiB total, 5 seconds); unreadable entries and submodules are not covered.",
      };
    }
  }
}
