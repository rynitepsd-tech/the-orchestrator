import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import type { DiscoveredSession, SessionSearchHit } from "@orchestrator/protocol";
import { redactText } from "@orchestrator/protocol";
import { canonicalPath } from "./paths";

const MAX_LINE_LENGTH = 4 * 1024 * 1024;
const SNIPPET_LENGTH = 360;

type Source = { sessionPath: string; entryId: string };
type TextEntry = { id: string; role: "user" | "assistant"; text: string; at?: string };

function sameProject(session: DiscoveredSession, projectKey: string): boolean {
  return canonicalPath(session.projectPath ?? session.cwd) === projectKey;
}

function textEntry(entry: unknown): TextEntry | undefined {
  if (
    !entry ||
    typeof entry !== "object" ||
    !("type" in entry) ||
    entry.type !== "message" ||
    !("id" in entry) ||
    typeof entry.id !== "string" ||
    !entry.id ||
    !("message" in entry)
  )
    return;
  const message = entry.message;
  if (
    !message ||
    typeof message !== "object" ||
    !("role" in message) ||
    (message.role !== "user" && message.role !== "assistant") ||
    !("content" in message)
  )
    return;
  const text =
    typeof message.content === "string"
      ? message.content
      : Array.isArray(message.content)
        ? message.content
            .flatMap((part: unknown) =>
              part &&
              typeof part === "object" &&
              "type" in part &&
              part.type === "text" &&
              "text" in part &&
              typeof part.text === "string"
                ? [part.text]
                : [],
            )
            .join("\n")
        : "";
  if (!text.trim()) return;
  return {
    id: entry.id,
    role: message.role,
    text,
    at: "timestamp" in entry && typeof entry.timestamp === "string" ? entry.timestamp : undefined,
  };
}

function committedAnswer(entry: unknown): TextEntry | undefined {
  if (
    !entry ||
    typeof entry !== "object" ||
    !("type" in entry) ||
    entry.type !== "custom" ||
    !("customType" in entry) ||
    entry.customType !== "orchestrator.task" ||
    !("data" in entry) ||
    !entry.data ||
    typeof entry.data !== "object" ||
    !("task" in entry.data)
  )
    return;
  const task = entry.data.task;
  if (
    !task ||
    typeof task !== "object" ||
    !("answer" in task) ||
    !task.answer ||
    typeof task.answer !== "object"
  )
    return;
  const answer = task.answer;
  if (
    !("messageId" in answer) ||
    typeof answer.messageId !== "string" ||
    !answer.messageId ||
    !("text" in answer) ||
    typeof answer.text !== "string" ||
    !answer.text.trim()
  )
    return;
  return {
    id: answer.messageId,
    role: "assistant",
    text: answer.text,
    at: "at" in answer && typeof answer.at === "string" ? answer.at : undefined,
  };
}

/** Only paths from engine discovery enter this reader, never client-supplied paths. */
async function scanSession(
  session: DiscoveredSession,
  visit: (entry: TextEntry) => boolean,
): Promise<boolean> {
  const input = createReadStream(session.path, { encoding: "utf8" });
  const lines = createInterface({ input, crlfDelay: Number.POSITIVE_INFINITY });
  let verified = false;
  let incomplete = false;
  const candidates = new Set<string>();
  const published = new Set<string>();
  try {
    for await (const line of lines) {
      if (!line.trim()) continue;
      if (line.length > MAX_LINE_LENGTH) {
        incomplete = true;
        continue;
      }
      let entry: unknown;
      try {
        entry = JSON.parse(line);
      } catch {
        // A writer may still be appending its final record.
        incomplete = true;
        continue;
      }
      if (entry && typeof entry === "object" && "type" in entry && entry.type === "session") {
        if (!("id" in entry) || entry.id !== session.ompSessionId) return true;
        verified = true;
        continue;
      }
      if (!verified) continue;
      // Candidate custom messages are not publications. A durable task answer
      // must select an existing candidate entry before it becomes a source.
      if (
        entry &&
        typeof entry === "object" &&
        "type" in entry &&
        entry.type === "custom_message" &&
        "customType" in entry &&
        entry.customType === "orchestrator.answer" &&
        "id" in entry &&
        typeof entry.id === "string"
      ) {
        candidates.add(entry.id);
        continue;
      }
      const answer = committedAnswer(entry);
      if (answer && candidates.has(answer.id) && !published.has(answer.id)) {
        published.add(answer.id);
        if (!visit(answer)) break;
        continue;
      }
      const text = textEntry(entry);
      if (text && !visit(text)) break;
    }
    return incomplete || !verified;
  } finally {
    lines.close();
    input.destroy();
  }
}

function hitFor(session: DiscoveredSession, entry: TextEntry, query = ""): SessionSearchHit {
  // Redact BEFORE taking a window: a window boundary must not cut a secret in
  // half and turn its remaining characters into an unrecognizable credential.
  const text = redactText(entry.text).replace(/\s+/g, " ").trim();
  const match = query ? text.toLowerCase().indexOf(query) : 0;
  const start = Math.max(0, match - 100);
  const end = Math.min(text.length, start + SNIPPET_LENGTH);
  return {
    sessionPath: session.path,
    ompSessionId: session.ompSessionId,
    projectPath: session.projectPath ?? session.cwd,
    title: redactText(session.title),
    entryId: entry.id,
    role: entry.role,
    snippet: `${start ? "… " : ""}${text.slice(start, end)}${end < text.length ? " …" : ""}`,
    at: entry.at,
  };
}

/** Literal, case-insensitive content search across persisted message entries. */
export async function searchSessions(
  sessions: DiscoveredSession[],
  query: string,
  options: { projectPath?: string; limit?: number } = {},
): Promise<{ hits: SessionSearchHit[]; truncated: boolean }> {
  if (typeof query !== "string" || query.length > 1000)
    throw new Error("Search text must be at most 1,000 characters.");
  const needle = query.trim().replace(/\s+/g, " ").toLowerCase();
  if (!needle) return { hits: [], truncated: false };
  const limit = Number.isFinite(options.limit)
    ? Math.max(1, Math.min(200, Math.floor(options.limit!)))
    : 50;
  const hits: SessionSearchHit[] = [];
  let truncated = false;
  const seen = new Set<string>();
  const projectKey = options.projectPath ? canonicalPath(options.projectPath) : undefined;
  const ordered = sessions
    .filter((session) => !projectKey || sameProject(session, projectKey))
    .sort(
      (a, b) => (b.modified ?? "").localeCompare(a.modified ?? "") || a.path.localeCompare(b.path),
    );
  for (const session of ordered) {
    if (seen.has(session.path)) continue;
    seen.add(session.path);
    let overflow = false;
    try {
      const incomplete = await scanSession(session, (entry) => {
        if (!entry.text.replace(/\s+/g, " ").toLowerCase().includes(needle)) return true;
        if (hits.length === limit) {
          overflow = true;
          return false;
        }
        hits.push(hitFor(session, entry, needle));
        return true;
      });
      truncated ||= incomplete;
    } catch {
      // One moved/unreadable file must not hide matches in the other sessions.
      truncated = true;
    }
    if (overflow) return { hits, truncated: true };
  }
  return { hits, truncated };
}

/** Validate a source against discovery and the exact persisted message entry. */
export async function resolveSessionSource(
  sessions: DiscoveredSession[],
  source: Source,
  projectPath: string,
): Promise<SessionSearchHit> {
  if (
    !source ||
    typeof source.sessionPath !== "string" ||
    typeof source.entryId !== "string" ||
    !source.entryId
  ) {
    throw new Error("Choose an existing transcript message as the source.");
  }
  const projectKey = canonicalPath(projectPath);
  const session = sessions.find(
    (item) => item.path === source.sessionPath && sameProject(item, projectKey),
  );
  if (!session)
    throw new Error(
      "The source session does not belong to this project or is no longer available.",
    );
  return (await readSessionSource([session], source.sessionPath, source.entryId)).hit;
}

/** Read an exact source without changing the active OMP branch or prompting. */
export async function readSessionSource(
  sessions: DiscoveredSession[],
  sessionPath: string,
  entryId: string,
): Promise<{ hit: SessionSearchHit; text: string }> {
  if (typeof sessionPath !== "string" || typeof entryId !== "string" || !entryId) {
    throw new Error("Choose an existing transcript message as the source.");
  }
  const session = sessions.find((item) => item.path === sessionPath);
  if (!session) throw new Error("The source session is no longer available.");
  let found: { hit: SessionSearchHit; text: string } | undefined;
  await scanSession(session, (entry) => {
    if (entry.id !== entryId) return true;
    const redacted = redactText(entry.text);
    const maxCharacters = 256 * 1024;
    found = {
      hit: hitFor(session, entry),
      text:
        redacted.length > maxCharacters
          ? `${redacted.slice(0, maxCharacters)}\n\n… source preview truncated …`
          : redacted,
    };
    return false;
  });
  if (!found)
    throw new Error(
      "The source message is no longer available or exceeds the readable size limit. Choose another search result.",
    );
  return found;
}
