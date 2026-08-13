/**
 * Rebuild product events from a persisted OMP session's entries.
 *
 * Used on resume/fork: the worker seeds its transcript-replay buffer from
 * `SessionManager.getBranch()` so the UI can show the conversation that
 * happened before this process existed. Synthesized events mirror what the
 * live mapper would have emitted for the same turns.
 *
 * Entry shapes (verified on-disk, OMP 17.3.1):
 *   { type: "message", message: { role: "user" | "assistant", content: [...] } }
 *   { type: "message", message: { role: "toolResult", toolCallId, toolName,
 *       content, isError, details } }
 *   { type: "message", message: { role: "custom", customType: "advisor",
 *       details: { notes: [...] } } }
 *   assistant content parts: { type: "text" | "thinking" | "toolCall", ... }
 */
import { type ProductEvent, redactValue, sanitizeOutput } from "@orchestrator/protocol";
import { textOf, thinkingOf } from "./event-mapper";

export function replayEventsFromEntries(sessionId: string, entries: any[]): ProductEvent[] {
  const out: ProductEvent[] = [];
  let seq = 0;
  const toolNames = new Map<string, string>();

  for (const entry of entries ?? []) {
    if (entry?.type !== "message") continue;
    const msg = entry.message;
    if (!msg) continue;

    if (msg.role === "user") {
      const text = textOf(msg);
      if (text) {
        out.push({ type: "user.message", sessionId, messageId: `${sessionId}:ru${++seq}`, text });
      }
      continue;
    }

    if (msg.role === "assistant") {
      const messageId = `${sessionId}:rm${++seq}`;
      const text = textOf(msg);
      const thinking = thinkingOf(msg);
      if (text || thinking) {
        out.push({
          type: "assistant.message.end",
          sessionId,
          messageId,
          text,
          thinking: thinking || undefined,
          model: msg.model ? String(msg.model) : undefined,
        });
      }
      // Tool calls are content parts of the assistant message; results follow
      // as separate toolResult messages keyed by call id.
      for (const part of Array.isArray(msg.content) ? msg.content : []) {
        if (part?.type !== "toolCall") continue;
        const callId = String(part.id ?? `${sessionId}:rc${++seq}`);
        toolNames.set(callId, String(part.name ?? "unknown"));
        out.push({
          type: "tool.start",
          sessionId,
          callId,
          toolName: String(part.name ?? "unknown"),
          args: redactValue((part.arguments ?? {}) as Record<string, unknown>),
        });
      }
      continue;
    }

    if (msg.role === "toolResult") {
      const callId = String(msg.toolCallId ?? "");
      const raw = textOf(msg);
      const { output, truncated } = sanitizeOutput(raw);
      const isError = msg.isError === true;
      out.push({
        type: "tool.end",
        sessionId,
        callId,
        ok: !isError,
        output,
        truncated,
        error: isError ? output.slice(0, 2000) : undefined,
        durationMs:
          typeof msg.details?.wallTimeMs === "number" ? msg.details.wallTimeMs : undefined,
        detail: { kind: "other" },
      });
      toolNames.delete(callId);
      continue;
    }

    if (msg.role === "custom" && msg.customType === "advisor") {
      const notes: any[] = Array.isArray(msg.details?.notes) ? msg.details.notes : [];
      const at =
        typeof msg.timestamp === "number"
          ? new Date(msg.timestamp).toISOString()
          : new Date().toISOString();
      for (const n of notes) {
        const text = typeof n?.note === "string" ? n.note : "";
        if (!text) continue;
        const name = typeof n?.advisor === "string" && n.advisor ? n.advisor : "Advisor";
        out.push({
          type: "advisor.message",
          sessionId,
          advisorId: `advisor:${name}`,
          advisorName: name,
          severity:
            n?.severity === "nit" || n?.severity === "concern" || n?.severity === "blocker"
              ? n.severity
              : "unknown",
          text,
          messageId: `${sessionId}:ra${++seq}`,
          at,
        });
      }
    }
  }
  return out;
}
