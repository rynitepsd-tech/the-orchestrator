/**
 * Upstream OMP event -> normalized product event.
 *
 * Event shapes below were captured from a live OMP 17.3.1 session
 * (see docs/OMP_COMPATIBILITY.md for the capture method). Upstream emits:
 *
 *   agent_start          { type }
 *   turn_start           { type }
 *   message_start        { type, message }
 *   message_update       { type, assistantMessageEvent: { type, contentIndex, delta, partial }, message }
 *   message_end          { type, message }
 *   tool_execution_start { type, toolCallId, toolName, args }
 *   tool_execution_update{ type, toolCallId, toolName, args, partialResult: { content[], details } }
 *   tool_execution_end   { type, toolCallId, toolName, result: { content[], details }, isError }
 *   turn_end             { type, message, toolResults[] }
 *   agent_end            { type, messages[], isTerminal }
 *
 * Anything unrecognised returns [] rather than throwing, so a new upstream
 * event degrades to "not displayed" instead of breaking the session.
 */
import {
  type ProductEvent,
  type RunState,
  redactValue,
  sanitizeOutput,
  type ToolDetail,
} from "@orchestrator/protocol";

/** Loose view of an upstream event; upstream types are not re-exported wholesale. */
type OmpEvent = Record<string, any>;

export interface MapperContext {
  sessionId: string;
  /** Called when the mapper infers a run-state transition. */
  onRunState?: (state: RunState, activity?: string) => void;
}

/** Tracks per-message identity so deltas can be attributed to a message. */
export class EventMapper {
  #messageSeq = 0;
  #currentMessageId: string | null = null;
  readonly #toolStartedAt = new Map<string, number>();
  /**
   * Args live on tool_execution_start; end events may omit them upstream.
   * Remembered per call id so tool cards can always show what actually ran.
   */
  readonly #toolArgs = new Map<string, Record<string, unknown>>();
  readonly #ctx: MapperContext;

  constructor(ctx: MapperContext) {
    this.#ctx = ctx;
  }

  /** Stable id for the assistant message currently streaming. */
  #messageId(): string {
    if (!this.#currentMessageId) {
      this.#currentMessageId = `${this.#ctx.sessionId}:m${++this.#messageSeq}`;
    }
    return this.#currentMessageId;
  }

  map(ev: OmpEvent): ProductEvent[] {
    const sessionId = this.#ctx.sessionId;
    const type = ev?.type as string | undefined;
    if (!type) return [];

    switch (type) {
      case "agent_start":
        this.#ctx.onRunState?.("starting");
        return [{ type: "session.state", sessionId, runState: "starting" }];

      case "turn_start":
        this.#ctx.onRunState?.("thinking");
        return [{ type: "session.state", sessionId, runState: "thinking" }];

      case "message_start": {
        const role = ev.message?.role;
        if (role === "user") {
          return [
            {
              type: "user.message",
              sessionId,
              messageId: `${sessionId}:u${++this.#messageSeq}`,
              text: textOf(ev.message),
            },
          ];
        }
        // A new assistant message begins; allocate a fresh id.
        this.#currentMessageId = `${sessionId}:m${++this.#messageSeq}`;
        return [];
      }

      case "message_update":
        return this.#mapMessageUpdate(ev);

      case "message_end": {
        const msg = ev.message;
        // Advisor notes arrive as batched custom messages injected by the
        // watchdog runtime (session-advisors.ts upstream):
        //   { role: "custom", customType: "advisor",
        //     details: { notes: [{ note, severity, advisor? }] } }
        if (msg?.role === "custom" && msg?.customType === "advisor") {
          return this.#mapAdvisorNotes(msg);
        }
        if (msg?.role !== "assistant") return [];
        const id = this.#messageId();
        this.#currentMessageId = null;
        return [
          {
            type: "assistant.message.end",
            sessionId,
            messageId: id,
            text: textOf(msg),
            thinking: thinkingOf(msg) || undefined,
            model: msg?.model,
          },
        ];
      }

      case "tool_execution_start": {
        const callId = String(ev.toolCallId ?? "");
        this.#toolStartedAt.set(callId, Date.now());
        if (ev.args && typeof ev.args === "object") this.#toolArgs.set(callId, ev.args);
        this.#ctx.onRunState?.("tool", `${ev.toolName}`);
        return [
          {
            type: "session.state",
            sessionId,
            runState: "tool",
            activity: String(ev.toolName ?? ""),
          },
          {
            type: "tool.start",
            sessionId,
            callId,
            toolName: String(ev.toolName ?? "unknown"),
            args: redactValue((ev.args ?? {}) as Record<string, unknown>),
          },
        ];
      }

      case "tool_execution_update": {
        const partial = contentText(ev.partialResult);
        if (!partial) return [];
        return [
          {
            type: "tool.update",
            sessionId,
            callId: String(ev.toolCallId ?? ""),
            outputDelta: sanitizeOutput(partial, 32 * 1024).output,
          },
        ];
      }

      case "tool_execution_end": {
        const callId = String(ev.toolCallId ?? "");
        const startedAt = this.#toolStartedAt.get(callId);
        this.#toolStartedAt.delete(callId);
        const rememberedArgs = this.#toolArgs.get(callId);
        this.#toolArgs.delete(callId);
        const raw = contentText(ev.result);
        const { output, truncated } = sanitizeOutput(raw);
        const isError = ev.isError === true;
        const events: ProductEvent[] = [
          {
            type: "tool.end",
            sessionId,
            callId,
            ok: !isError,
            output,
            truncated,
            error: isError ? output.slice(0, 2000) : undefined,
            durationMs:
              typeof ev.result?.details?.wallTimeMs === "number"
                ? ev.result.details.wallTimeMs
                : startedAt
                  ? Date.now() - startedAt
                  : undefined,
            detail: toolDetail(String(ev.toolName ?? ""), ev, rememberedArgs),
          },
        ];
        // The todo tool's result carries the full post-op list; surface it as
        // its own event so the UI can pin live progress.
        const phases = ev.result?.details?.phases;
        if (String(ev.toolName) === "todo" && !isError && Array.isArray(phases)) {
          events.push({ type: "todo.update", sessionId, phases });
        }
        return events;
      }

      case "turn_end": {
        // Usage lives on turn_end.message.usage and is authoritative for the turn.
        this.#ctx.onRunState?.("idle");
        return [];
      }

      case "agent_end": {
        // Deliberately does NOT emit `session.finished`. Only the caller that
        // drove the turn knows how it actually ended — an aborted run reaches
        // agent_end too, and reporting "completed" here would clobber the
        // real outcome. The mapper reports activity; the runtime reports fate.
        this.#ctx.onRunState?.(ev.isTerminal !== false ? "completed" : "idle");
        return [];
      }

      default:
        return [];
    }
  }

  #mapAdvisorNotes(msg: OmpEvent): ProductEvent[] {
    const sessionId = this.#ctx.sessionId;
    const notes: any[] = Array.isArray(msg?.details?.notes) ? msg.details.notes : [];
    const at =
      typeof msg?.timestamp === "number"
        ? new Date(msg.timestamp).toISOString()
        : new Date().toISOString();
    const out: ProductEvent[] = [];
    for (const n of notes) {
      const text = typeof n?.note === "string" ? n.note : "";
      if (!text) continue;
      const name = typeof n?.advisor === "string" && n.advisor ? n.advisor : "Advisor";
      const sev = n?.severity;
      out.push({
        type: "advisor.message",
        sessionId,
        advisorId: `advisor:${name}`,
        advisorName: name,
        // Unknown future severities degrade to "unknown" instead of vanishing.
        severity: sev === "nit" || sev === "concern" || sev === "blocker" ? sev : "unknown",
        text,
        messageId: `${sessionId}:adv${++this.#messageSeq}`,
        at,
      });
    }
    // The batched note body is also rendered to the model as an <advisory>
    // block; the per-note cards above are the product-facing form. If upstream
    // ships a shape without `details.notes`, fall back to the raw text so the
    // advisory is never silently dropped.
    if (out.length === 0) {
      const raw = textOf(msg);
      if (raw) {
        out.push({
          type: "advisor.message",
          sessionId,
          advisorId: "advisor:unknown",
          advisorName: "Advisor",
          severity: "unknown",
          text: raw,
          messageId: `${sessionId}:adv${++this.#messageSeq}`,
          at,
        });
      }
    }
    return out;
  }

  #mapMessageUpdate(ev: OmpEvent): ProductEvent[] {
    const sessionId = this.#ctx.sessionId;
    const ame = ev.assistantMessageEvent;
    const sub = ame?.type as string | undefined;
    if (!sub) return [];

    switch (sub) {
      case "text_delta": {
        const delta = String(ame.delta ?? "");
        if (!delta) return [];
        this.#ctx.onRunState?.("streaming");
        return [{ type: "assistant.text", sessionId, messageId: this.#messageId(), delta }];
      }
      // Upstream uses distinct names across providers for reasoning output.
      case "thinking_delta":
      case "reasoning_delta": {
        const delta = String(ame.delta ?? ame.thinking ?? "");
        if (!delta) return [];
        this.#ctx.onRunState?.("thinking");
        return [{ type: "assistant.thinking", sessionId, messageId: this.#messageId(), delta }];
      }
      default:
        return [];
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Concatenate text parts of an OMP message's content array. */
export function textOf(message: any): string {
  const content = message?.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((p: any) => p?.type === "text" && typeof p.text === "string")
    .map((p: any) => p.text)
    .join("");
}

/** Concatenate thinking/reasoning parts of an OMP message. */
export function thinkingOf(message: any): string {
  const content = message?.content;
  if (!Array.isArray(content)) return "";
  return content
    .filter(
      (p: any) => (p?.type === "thinking" || p?.type === "reasoning") && typeof p.text === "string",
    )
    .map((p: any) => p.text)
    .join("");
}

/** Extract text from a tool result/partialResult `{ content: [{type,text}] }`. */
function contentText(result: any): string {
  const content = result?.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((p: any) => p?.type === "text" && typeof p.text === "string")
    .map((p: any) => p.text)
    .join("");
}

/** Structured detail so the UI can render native cards instead of raw text. */
function toolDetail(
  toolName: string,
  ev: OmpEvent,
  rememberedArgs?: Record<string, unknown>,
): ToolDetail {
  const args: any = ev.args ?? rememberedArgs ?? {};
  const details = ev.result?.details ?? {};
  switch (toolName) {
    case "bash":
      return {
        kind: "bash",
        command: String(args.command ?? ""),
        exitCode: typeof details.exitCode === "number" ? details.exitCode : undefined,
      };
    case "edit":
    case "ast_edit":
      return {
        kind: "edit",
        path: String(args.path ?? args.file ?? ""),
        additions: numberOr(details.additions ?? details.added, 0),
        deletions: numberOr(details.deletions ?? details.removed, 0),
        diff: typeof details.diff === "string" ? details.diff : undefined,
      };
    case "write":
      return {
        kind: "write",
        path: String(args.path ?? args.file ?? ""),
        bytes: numberOr(details.bytes ?? String(args.content ?? "").length, 0),
        created: details.created !== false,
      };
    case "read":
      return { kind: "read", path: String(args.path ?? ""), lines: numberOr(details.lines, 0) };
    case "grep":
    case "ast_grep":
    case "glob":
      return {
        kind: "search",
        query: String(args.pattern ?? args.query ?? ""),
        matches: numberOr(details.matches ?? details.count, 0),
        files: numberOr(details.files, 0),
      };
    default:
      return { kind: "other" };
  }
}

function numberOr(v: unknown, fallback: number): number {
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}
