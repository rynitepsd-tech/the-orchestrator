import { beforeAll, describe, expect, test } from "bun:test";
import type { ProductEvent } from "@orchestrator/protocol";
import type * as StoreModule from "../src/store";

if (!globalThis.localStorage)
  Object.defineProperty(globalThis, "localStorage", {
    value: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
    configurable: true,
  });
if (!globalThis.window)
  Object.defineProperty(globalThis, "window", {
    value: { addEventListener: () => {} },
    configurable: true,
  });
if (!globalThis.document)
  Object.defineProperty(globalThis, "document", {
    value: { hasFocus: () => true, addEventListener: () => {} },
    configurable: true,
  });

let store: typeof StoreModule;
beforeAll(async () => {
  store = await import("../src/store");
});

const SID = "model-modes";
function boot() {
  store.useStore.getState().addSession(
    {
      sessionId: SID,
      projectId: "p",
      projectPath: "/tmp/p",
      title: "Modes",
      runState: "idle",
      advisorCount: 0,
      messageCount: 0,
      unread: false,
    },
    [],
  );
}
function emit(event: Record<string, unknown>) {
  store.useStore.getState().apply({ sessionId: SID, ...event } as ProductEvent);
}
const view = () => store.useStore.getState().sessions[SID]!;
const notes = () =>
  view().transcript.filter((t) => t.kind === "system" && t.text.startsWith("Served by"));
let n = 0;
const reply = (servedModel?: string) =>
  emit({
    type: "assistant.message.end",
    messageId: `m${++n}`,
    text: "ok",
    model: "anthropic/claude-opus-5-5",
    servedModel,
  });

describe("model modes in the store", () => {
  test("slow mode, extended context and auto effort land on the session", () => {
    boot();
    emit({
      type: "session.slowMode",
      enabled: true,
      available: true,
      label: "low priority until 14:30",
    });
    emit({ type: "session.extendedContext", enabled: true, contextWindow: 1_000_000 });
    emit({ type: "session.thinkingLevel", level: "auto", resolved: "high" });
    const v = view();
    expect(v.summary.slowMode).toBe(true);
    expect(v.slowModeAvailable).toBe(true);
    expect(v.slowModeLabel).toBe("low priority until 14:30");
    expect(v.summary.extendedContext).toBe(true);
    expect(v.liveContextWindow).toBe(1_000_000);
    expect(v.summary.thinkingLevel).toBe("auto");
    expect(v.summary.thinkingResolved).toBe("high");
  });

  test("a substitute model is announced once per change, and again after a return", () => {
    boot();
    reply("claude-sonnet-5");
    reply("claude-sonnet-5");
    expect(notes().length).toBe(1);
    reply(undefined);
    reply("claude-sonnet-5");
    expect(notes().length).toBe(2);
    expect(view().transcript.filter((t) => t.kind === "assistant").length).toBe(4);
  });
});
