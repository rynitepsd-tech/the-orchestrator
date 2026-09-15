import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { canonicalPath, resolveSessionSource } from "@orchestrator/omp-adapter";
import type { DiscoveredSession, ProjectDecision } from "@orchestrator/protocol";
import { redactText } from "@orchestrator/protocol";
import { appSupportDir } from "./logging";

export type DecisionInput = Pick<ProjectDecision, "title" | "text" | "source"> & { id?: string };

function isDecision(value: unknown): value is ProjectDecision {
  if (!value || typeof value !== "object") return false;
  if (
    !("id" in value) ||
    typeof value.id !== "string" ||
    !value.id ||
    !("projectPath" in value) ||
    typeof value.projectPath !== "string" ||
    !isAbsolute(value.projectPath) ||
    !("title" in value) ||
    typeof value.title !== "string" ||
    !("text" in value) ||
    typeof value.text !== "string" ||
    !("createdAt" in value) ||
    typeof value.createdAt !== "string" ||
    !("updatedAt" in value) ||
    typeof value.updatedAt !== "string" ||
    !("source" in value) ||
    !value.source ||
    typeof value.source !== "object"
  )
    return false;
  return (
    "sessionPath" in value.source &&
    typeof value.source.sessionPath === "string" &&
    "entryId" in value.source &&
    typeof value.source.entryId === "string" &&
    Boolean(value.source.entryId)
  );
}

function projectKey(path: string): string {
  if (typeof path !== "string" || !isAbsolute(path))
    throw new Error("Choose an absolute project folder.");
  return canonicalPath(path);
}

/** User-maintained notes only: never injected into model context automatically. */
export class ProjectDecisionStore {
  readonly #directory: string;
  readonly #path: string;

  constructor(directory = appSupportDir()) {
    this.#directory = directory;
    this.#path = join(directory, "project-decisions.json");
  }

  #read(): ProjectDecision[] {
    if (!existsSync(this.#path)) return [];
    const value: unknown = JSON.parse(readFileSync(this.#path, "utf8"));
    if (!Array.isArray(value) || !value.every(isDecision)) {
      // Never replace an unreadable store with an empty one on the next save.
      throw new Error(
        "Saved project decisions could not be read. Restore project-decisions.json from a backup before editing.",
      );
    }
    return value;
  }

  #write(decisions: ProjectDecision[]): void {
    mkdirSync(this.#directory, { recursive: true });
    const temporary = `${this.#path}.${randomUUID()}.tmp`;
    try {
      writeFileSync(temporary, JSON.stringify(decisions, null, 2), { mode: 0o600 });
      renameSync(temporary, this.#path);
    } finally {
      rmSync(temporary, { force: true });
    }
  }

  list(path: string): ProjectDecision[] {
    const key = projectKey(path);
    return this.#read()
      .filter((decision) => projectKey(decision.projectPath) === key)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .map((decision) => ({
        ...decision,
        title: redactText(decision.title),
        text: redactText(decision.text),
      }));
  }

  async save(
    path: string,
    input: DecisionInput,
    sessions: DiscoveredSession[],
  ): Promise<ProjectDecision> {
    const key = projectKey(path);
    if (
      !input ||
      typeof input.title !== "string" ||
      !input.title.trim() ||
      input.title.length > 160
    ) {
      throw new Error("Enter a decision title of 1–160 characters.");
    }
    if (typeof input.text !== "string" || !input.text.trim() || input.text.length > 16000) {
      throw new Error("Enter a decision of 1–16,000 characters.");
    }
    if (input.id !== undefined && (typeof input.id !== "string" || !input.id))
      throw new Error("Invalid decision ID.");
    const source = await resolveSessionSource(sessions, input.source, key);
    // Read only AFTER source validation awaits; the synchronous read/replace
    // sequence prevents concurrent saves in this engine from losing updates.
    const decisions = this.#read();
    const index =
      input.id === undefined ? -1 : decisions.findIndex((decision) => decision.id === input.id);
    const previous = index === -1 ? undefined : decisions[index];
    if (input.id !== undefined && (!previous || projectKey(previous.projectPath) !== key)) {
      throw new Error(
        "This decision no longer exists in the selected project. Refresh the list before editing.",
      );
    }
    const now = new Date().toISOString();
    const decision: ProjectDecision = {
      id: previous?.id ?? randomUUID(),
      projectPath: key,
      title: redactText(input.title.trim()),
      text: redactText(input.text.trim()),
      source: { sessionPath: source.sessionPath, entryId: source.entryId },
      createdAt: previous?.createdAt ?? now,
      updatedAt: now,
    };
    if (index === -1) decisions.push(decision);
    else decisions[index] = decision;
    this.#write(decisions);
    return decision;
  }

  delete(path: string, id: string): boolean {
    const key = projectKey(path);
    if (typeof id !== "string" || !id) throw new Error("Invalid decision ID.");
    const decisions = this.#read();
    const next = decisions.filter(
      (decision) => decision.id !== id || projectKey(decision.projectPath) !== key,
    );
    if (next.length === decisions.length) return false;
    this.#write(next);
    return true;
  }
}
