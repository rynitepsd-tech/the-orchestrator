/**
 * Rebuild product events from a persisted OMP session's entries.
 *
 * Used on resume/fork: the worker seeds its transcript-replay buffer from
 * `SessionManager.getBranch()` so the UI can show the conversation that
 * happened before this process existed. Synthesized events mirror what the
 * live mapper would have emitted for the same turns.
 *
 * Entry shapes (verified on-disk against the pinned OMP version):
 *   { type: "message", message: { role: "user" | "assistant", content: [...] } }
 *   { type: "message", message: { role: "toolResult", toolCallId, toolName,
 *       content, isError, details } }
 *   { type: "message", message: { role: "custom", customType: "advisor",
 *       details: { notes: [...] } } }
 *   assistant content parts: { type: "text" | "thinking" | "toolCall", ... }
 */
import { type ProductEvent, redactValue } from "@orchestrator/protocol";
import { advisorEventsFromCard, textOf, thinkingOf, toolEndEvent } from "./event-mapper";

export function replayEventsFromEntries(sessionId: string, entries: any[]): ProductEvent[] {
  const out: ProductEvent[] = [];
  let seq = 0;
  const toolNames = new Map<string, string>();
  const toolArgs = new Map<string, Record<string, unknown>>();

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
        const toolName = String(part.name ?? "unknown");
        toolNames.set(callId, toolName);
        if (part.arguments && typeof part.arguments === "object") {
          toolArgs.set(callId, part.arguments as Record<string, unknown>);
        }
        out.push({
          type: "tool.start",
          sessionId,
          callId,
          toolName,
          args: redactValue((part.arguments ?? {}) as Record<string, unknown>),
        });
        // Subagent runs live in their own session files, but the parent's
        // task call is enough to restore the card the user saw — a resumed
        // session must not pretend its fan-out never happened.
        if (toolName === "task") {
          const a: any = part.arguments ?? {};
          out.push({
            type: "subagent.start",
            sessionId,
            subagentId: `replay:${callId}`,
            label: String(a.description ?? a.prompt ?? "Subagent").slice(0, 200),
            agent: a.subagent_type ? String(a.subagent_type) : undefined,
            parentToolCallId: callId,
            startedAt:
              typeof msg.timestamp === "number"
                ? new Date(msg.timestamp).toISOString()
                : new Date(0).toISOString(),
          });
        }
      }
      continue;
    }

    if (msg.role === "toolResult") {
      const callId = String(msg.toolCallId ?? "");
      const isError = msg.isError === true;
      const toolName = toolNames.get(callId) ?? String(msg.toolName ?? "unknown");
      // Same output and structured detail as the live mapper — the diff, exit
      // code, and match count are sitting right there in the persisted row.
      const end = toolEndEvent(sessionId, callId, toolName, { result: msg }, isError, {
        rememberedArgs: toolArgs.get(callId),
      });
      out.push(end);
      if (toolName === "task") {
        out.push({
          type: "subagent.end",
          sessionId,
          subagentId: `replay:${callId}`,
          ok: !isError,
          durationMs: typeof msg.details?.wallTimeMs === "number" ? msg.details.wallTimeMs : 0,
          toolCalls: 0,
          error: isError ? end.output?.slice(0, 500) : undefined,
        });
      }
      // Mirror the live mapper: replayed todo results restore the checklist.
      if (
        (toolNames.get(callId) === "todo" || msg.toolName === "todo") &&
        !isError &&
        Array.isArray(msg.details?.phases)
      ) {
        out.push({ type: "todo.update", sessionId, phases: msg.details.phases });
      }
      toolNames.delete(callId);
      toolArgs.delete(callId);
      continue;
    }

    if (msg.role === "custom" && msg.customType === "advisor") {
      out.push(...advisorEventsFromCard(sessionId, msg, () => `${sessionId}:ra${++seq}`));
    }
  }
  return out;
}
