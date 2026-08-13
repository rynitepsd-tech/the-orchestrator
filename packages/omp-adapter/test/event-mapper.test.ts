/**
 * EventMapper unit tests.
 *
 * The mapper is the single most upstream-fragile file in the adapter: every
 * fixture below was captured from a live OMP 17.3.1 session, so an upstream
 * shape change surfaces here as a failing fixture rather than a blank UI.
 */
import { describe, expect, test } from "bun:test";
import type { ProductEvent } from "@orchestrator/protocol";
import { EventMapper } from "../src/event-mapper";

function mapAll(events: any[]): ProductEvent[] {
  const mapper = new EventMapper({ sessionId: "S1" });
  return events.flatMap((e) => mapper.map(e));
}

describe("assistant turn mapping", () => {
  test("full turn produces user message, deltas, completion, and tool events", () => {
    const out = mapAll([
      { type: "agent_start" },
      { type: "turn_start" },
      { type: "message_start", message: { role: "user", content: [{ type: "text", text: "hi" }] } },
      { type: "message_start", message: { role: "assistant" } },
      {
        type: "message_update",
        assistantMessageEvent: { type: "text_delta", delta: "Hello" },
      },
      {
        type: "message_update",
        assistantMessageEvent: { type: "text_delta", delta: " world" },
      },
      {
        type: "message_end",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "Hello world" }],
          model: "m1",
        },
      },
      { type: "tool_execution_start", toolCallId: "c1", toolName: "bash", args: { command: "ls" } },
      {
        type: "tool_execution_end",
        toolCallId: "c1",
        toolName: "bash",
        isError: false,
        result: { content: [{ type: "text", text: "file.txt" }], details: { exitCode: 0 } },
      },
      { type: "turn_end", message: {} },
      { type: "agent_end", isTerminal: true },
    ]);

    const types = out.map((e) => e.type);
    expect(types).toContain("user.message");
    expect(types).toContain("assistant.text");
    expect(types).toContain("assistant.message.end");
    expect(types).toContain("tool.start");
    expect(types).toContain("tool.end");

    const end = out.find((e) => e.type === "assistant.message.end") as any;
    expect(end.text).toBe("Hello world");
    expect(end.model).toBe("m1");

    const toolEnd = out.find((e) => e.type === "tool.end") as any;
    expect(toolEnd.ok).toBe(true);
    expect(toolEnd.output).toContain("file.txt");
    expect(toolEnd.detail).toEqual({ kind: "bash", command: "ls", exitCode: 0 });

    // Deltas share the message id with the completion event.
    const deltas = out.filter((e) => e.type === "assistant.text") as any[];
    expect(new Set(deltas.map((d) => d.messageId)).size).toBe(1);
    expect(deltas[0].messageId).toBe(end.messageId);
  });

  test("thinking deltas map to assistant.thinking", () => {
    const out = mapAll([
      { type: "message_start", message: { role: "assistant" } },
      { type: "message_update", assistantMessageEvent: { type: "thinking_delta", delta: "hmm" } },
      {
        type: "message_update",
        assistantMessageEvent: { type: "reasoning_delta", delta: " more" },
      },
    ]);
    const thinks = out.filter((e) => e.type === "assistant.thinking") as any[];
    expect(thinks.map((t) => t.delta).join("")).toBe("hmm more");
  });

  test("unknown upstream events degrade to nothing, never throw", () => {
    expect(mapAll([{ type: "totally_new_event", data: 1 }, { type: "message_update" }])).toEqual(
      [],
    );
  });
});

describe("advisor note mapping", () => {
  test("batched advisor custom message yields one advisor.message per note", () => {
    const out = mapAll([
      {
        type: "message_end",
        message: {
          role: "custom",
          customType: "advisor",
          content: [{ type: "text", text: "<advisory>…</advisory>" }],
          details: {
            notes: [
              { note: "Consider a lock here.", severity: "concern", advisor: "Architecture" },
              { note: "Rename this.", severity: "nit", advisor: "Reviewer" },
            ],
          },
          timestamp: 1786650000000,
        },
      },
    ]);
    expect(out.length).toBe(2);
    const [a, b] = out as any[];
    expect(a.type).toBe("advisor.message");
    expect(a.advisorName).toBe("Architecture");
    expect(a.severity).toBe("concern");
    expect(a.text).toBe("Consider a lock here.");
    expect(b.advisorName).toBe("Reviewer");
    expect(b.severity).toBe("nit");
  });

  test("unknown severity degrades to 'unknown', not dropped", () => {
    const out = mapAll([
      {
        type: "message_end",
        message: {
          role: "custom",
          customType: "advisor",
          details: { notes: [{ note: "Something.", severity: "catastrophic", advisor: "A" }] },
        },
      },
    ]) as any[];
    expect(out.length).toBe(1);
    expect(out[0].severity).toBe("unknown");
  });

  test("noteless advisor message falls back to raw text", () => {
    const out = mapAll([
      {
        type: "message_end",
        message: {
          role: "custom",
          customType: "advisor",
          content: [{ type: "text", text: "raw advisory body" }],
        },
      },
    ]) as any[];
    expect(out.length).toBe(1);
    expect(out[0].text).toBe("raw advisory body");
  });

  test("non-advisor custom messages are ignored", () => {
    expect(
      mapAll([
        { type: "message_end", message: { role: "custom", customType: "other", content: [] } },
      ]),
    ).toEqual([]);
  });
});

describe("tool detail mapping", () => {
  test("edit tools carry diff stats", () => {
    const out = mapAll([
      {
        type: "tool_execution_end",
        toolCallId: "c9",
        toolName: "edit",
        isError: false,
        result: {
          content: [{ type: "text", text: "ok" }],
          details: { additions: 4, deletions: 2, diff: "+a\n-b" },
        },
        args: { path: "src/x.ts" },
      },
    ]) as any[];
    const end = out.find((e) => e.type === "tool.end");
    expect(end.detail).toEqual({
      kind: "edit",
      path: "src/x.ts",
      additions: 4,
      deletions: 2,
      diff: "+a\n-b",
    });
  });

  test("secrets in tool args are redacted before leaving the adapter", () => {
    const out = mapAll([
      {
        type: "tool_execution_start",
        toolCallId: "c2",
        toolName: "bash",
        args: { command: "curl", apiKey: "sk-super-secret-value" },
      },
    ]) as any[];
    const start = out.find((e) => e.type === "tool.start");
    expect(JSON.stringify(start.args)).not.toContain("sk-super-secret-value");
  });
});
