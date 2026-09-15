import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, readlinkSync, realpathSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type { ProductEvent, ToolCompleted, VerificationEvidence } from "@orchestrator/protocol";
import { sanitizeOutput } from "@orchestrator/protocol";

const MAX_OUTPUT = 8 * 1024;
const MAX_FILES = 10_000;
const MAX_SCAN_MS = 1_000;
const REVISION_PREFIX = "workspace-meta-v2:";
const SCOPE =
  "Coverage uses a metadata change token for non-ignored Git workspace files, not a content hash. Ignored files, submodule contents, external/browser state, and changes preserving all observed metadata are not covered.";
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

function commandResult(
  result: ToolCompleted,
  explicitExitCode: number | undefined,
): {
  status: VerificationEvidence["status"];
  exitCode?: number;
  outcome: string;
} {
  const details = result.ompResult?.details;
  const asynchronous = details?.async !== undefined;
  const timedOut = details?.timedOut === true;
  const failed =
    !result.ok ||
    result.ompResult?.isError === true ||
    timedOut ||
    object(details?.async)?.state === "failed";
  if (timedOut || asynchronous) {
    return {
      status: failed ? "failed" : "unknown",
      outcome: timedOut
        ? "Command timed out; no successful completion was observed."
        : "Background execution is not a completed synchronous command; its eventual outcome is not established here.",
    };
  }
  // Pinned OMP 18.1.11 BashTool.#buildCompletedResult omits exitCode for zero.
  // All completed routes include wallTimeMs and the effective timeout setting;
  // missing exit status and aborts throw, timeouts/error exits are error results,
  // and background launches carry details.async. Do not extend this inference
  // to generic invocation success, prose, or result-less legacy records.
  const completedBash =
    result.detail?.kind === "bash" &&
    details !== undefined &&
    typeof details.wallTimeMs === "number" &&
    Number.isFinite(details.wallTimeMs) &&
    details.wallTimeMs >= 0 &&
    (details.timeoutDisabled === true ||
      (typeof details.timeoutSeconds === "number" &&
        Number.isFinite(details.timeoutSeconds) &&
        details.timeoutSeconds > 0)) &&
    details.exitCode === undefined;
  const code = explicitExitCode ?? (!failed && completedBash ? 0 : undefined);
  return {
    status:
      failed || (code !== undefined && code !== 0) ? "failed" : code === 0 ? "passed" : "unknown",
    exitCode: code,
    outcome:
      code === undefined
        ? failed
          ? "Command invocation failed without a completed process exit status."
          : "Command exit status was not exposed by the tool. Invocation success is not verification success."
        : `Observed process exit ${code}; this does not establish that tests or assertions ran.`,
  };
}

/** Observes the SDK's tools. Git is queried for revision metadata, never to run checks. */
export class EvidenceTracker {
  readonly #cwd: string;
  // Capture synchronously in the SDK's event callback: tool execution does not
  // await observe(), so queuing an asynchronous baseline can capture AFTER a
  // fast command has already finished. Only metadata is read at this boundary.
  #pending = new Map<string, Observation>();
  #active = new Set<string>();
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
        // Older content hashes have a different coverage contract and cannot
        // establish a baseline under the metadata scheme, even before refresh.
        stale: record.stale || !record.revision?.startsWith(REVISION_PREFIX),
      });
    }
  }

  async observe(event: ProductEvent, requestId: string): Promise<void> {
    if (event.type !== "tool.start" && event.type !== "tool.update" && event.type !== "tool.end") {
      return;
    }
    const at = new Date().toISOString();
    const key = `${requestId}:${event.callId}`;
    if (event.type === "tool.start") {
      const overlapping = this.#active.size > 0;
      this.#active.add(key);
      // A concurrently executing tool can mutate the workspace between
      // samples. Do not assign either call a stable starting baseline.
      if (overlapping) {
        for (const observation of this.#pending.values()) {
          observation.before = {
            detail: "Concurrent tool execution prevents a stable starting workspace baseline.",
          };
        }
      }
      const name = event.toolName.toLowerCase();
      const code = typeof event.args.code === "string" ? event.args.code : "";
      const browser =
        /(?:^|[._/-])browser(?:$|[._/-])/.test(name) ||
        ((name === "eval" || name === "execute") && /\bbrowser\s*\./.test(code));
      const command = /^(?:bash|command|shell|exec|execute_command)$/.test(name);
      if (!browser && !command) return;
      const before = overlapping
        ? { detail: "Concurrent tool execution prevents a stable starting workspace baseline." }
        : this.#fingerprint();
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
    this.#active.delete(key);
    this.#pending.delete(key);
    // Bash's normalized detail can recover a missed start without inventing a baseline.
    if (!pending && event.detail?.kind !== "bash") return;
    const observation: Observation = pending ?? {
      requestId,
      kind: "command",
      label: bounded(event.detail?.kind === "bash" ? event.detail.command || "Command" : "Command"),
      startedAt: at,
      before: {
        detail: "Tool start was not observed; start time and starting revision are unavailable.",
      },
      output: "",
    };
    const after: Fingerprint = observation.before.revision ? this.#fingerprint() : {};
    const raw = structured(event);
    const command = commandResult(event, raw.exitCode);
    const invocationFailed = !event.ok || event.ompResult?.isError === true;
    let status: VerificationEvidence["status"];
    let outcome: string;
    if (observation.kind === "command") {
      status = command.status;
      outcome = command.outcome;
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
    const revision = observation.before.revision;
    const detail = [
      outcome,
      observation.before.detail,
      after.detail,
      changed
        ? "Workspace changed during execution; this evidence does not cover the resulting revision."
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
      exitCode: observation.kind === "command" ? command.exitCode : undefined,
      output: bounded(event.output || event.error || observation.output) || undefined,
      artifactPaths: raw.artifacts.length ? raw.artifacts : undefined,
      startedAt: observation.startedAt,
      finishedAt: at,
      revision,
      stale: !revision || !after.revision || changed,
      detail,
    });
  }

  async refresh(requestId: string): Promise<VerificationEvidence[]> {
    let result: VerificationEvidence[] = [];
    const current = this.#fingerprint();
    for (const [id, evidence] of this.#records) {
      const stale =
        evidence.stale ||
        !current.revision ||
        !evidence.revision ||
        evidence.revision !== current.revision;
      if (stale !== evidence.stale) this.#records.set(id, { ...evidence, stale });
    }
    result = [...this.#records.values()]
      .filter((evidence) => evidence.requestId === requestId)
      .map((evidence) => ({ ...evidence, artifactPaths: evidence.artifactPaths?.slice() }));
    if (!current.revision) {
      const note = current.detail;
      result = result.map((evidence) => ({
        ...evidence,
        detail: `${evidence.detail ?? ""} Refresh: ${note}`.trim(),
      }));
    }
    return result;
  }

  #inventory(deadline: number): string[] {
    const options = {
      cwd: this.#cwd,
      encoding: "utf8" as const,
      timeout: Math.max(1, deadline - Date.now()),
      maxBuffer: 2 * 1024 * 1024,
      stdio: "pipe" as const,
    };
    const listed = execFileSync(
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
    );
    if (Date.now() >= deadline) throw new Error("time limit");
    const ignored = execFileSync(
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
      { ...options, timeout: Math.max(1, deadline - Date.now()) },
    );
    const excluded = new Set(ignored.split("\0"));
    const paths = [
      ...new Set(listed.split("\0").filter((path) => path && !excluded.has(path))),
    ].sort();
    if (paths.length > MAX_FILES) throw new Error("file limit");
    return paths;
  }

  #fingerprint(): Fingerprint {
    try {
      const deadline = Date.now() + MAX_SCAN_MS;
      const root = realpathSync(this.#cwd);
      const scan = () => {
        const digest = createHash("sha256").update(root).update("\0");
        const parents = new Set<string>();
        for (const path of this.#inventory(deadline)) {
          if (Date.now() >= deadline) throw new Error("time limit");
          const absolute = resolve(root, path);
          const local = relative(root, absolute);
          if (
            isAbsolute(local) ||
            local === ".." ||
            local.startsWith(`..${sep}`) ||
            local.split(sep).includes(".git")
          )
            throw new Error("unsafe path");
          // Never traverse a symlinked directory into an external workspace.
          const parent = resolve(absolute, "..");
          if (!parents.has(parent)) {
            try {
              const parentRelative = relative(root, realpathSync(parent));
              if (
                isAbsolute(parentRelative) ||
                parentRelative === ".." ||
                parentRelative.startsWith(`..${sep}`)
              )
                throw new Error("external path");
            } catch (error) {
              if (object(error)?.code !== "ENOENT") throw error;
            }
            parents.add(parent);
          }
          let metadata: string;
          try {
            const stat = lstatSync(absolute, { bigint: true });
            if (!stat.isFile() && !stat.isSymbolicLink())
              throw new Error("unsupported workspace entry");
            metadata = `${stat.dev}:${stat.ino}:${stat.mode}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
            if (stat.isSymbolicLink()) metadata += `:${readlinkSync(absolute)}`;
          } catch (error) {
            if (object(error)?.code !== "ENOENT") throw error;
            metadata = "missing";
          }
          digest.update(JSON.stringify([path, metadata])).update("\0");
        }
        if (Date.now() >= deadline || realpathSync(this.#cwd) !== root)
          throw new Error("workspace changed");
        return digest.digest("hex");
      };
      // Two bounded metadata passes detect inventory and entry changes during
      // capture, including additions, deletions and symlink replacement. This
      // is not an atomic filesystem snapshot or protection against metadata-
      // preserving edits; refresh compares the token again before submission.
      const first = scan();
      if (first !== scan()) throw new Error("workspace changed");
      return { revision: `${REVISION_PREFIX}${first}` };
    } catch {
      return {
        detail:
          "Workspace change token unavailable: requires stable metadata in a Git workspace within the scan limits (10,000 files, 2 MiB inventory, 1 second); inaccessible paths and submodules are not covered.",
      };
    }
  }
}
