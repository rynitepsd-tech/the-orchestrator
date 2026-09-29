/**
 * MODEL CATALOG — what the picker offers, read from the pinned OMP's real
 * registry.
 *
 * OMP 18.2 started listing role-specific runners (embedding, rerank, speech,
 * image, video, judge, search, tiny title models) alongside chat models. A
 * session cannot converse with them, so they must not reach the picker.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuthStorage } from "@oh-my-pi/pi-ai";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent";
import { listModels, slowModeAvailable } from "../src";

describe("model catalog against the real OMP registry", () => {
  const dir = mkdtempSync(join(tmpdir(), "orch-catalog-"));
  let models: ReturnType<typeof listModels> = [];
  let raw: any[] = [];

  test("builds from the bundled catalogue", async () => {
    const auth = await AuthStorage.create(join(dir, "agent.db"));
    const registry = new ModelRegistry(auth as never);
    raw = registry.getAll() as any[];
    models = listModels(registry as never, auth as never);
    auth.close();
    rmSync(dir, { recursive: true, force: true });
    expect(models.length).toBeGreaterThan(100);
  });

  test("no non-chat runner reaches the picker", () => {
    const nonChat = raw
      .filter((m) => m.kind && m.kind !== "chat")
      .map((m) => `${m.provider}/${m.id}`);
    const keys = new Set(models.map((m) => m.key));
    for (const key of nonChat) expect(keys.has(key)).toBe(false);
  });

  test("new frontier models are present with their effort ladders", () => {
    const opus = models.find((m) => m.key === "anthropic/claude-opus-5-5");
    expect(opus).toBeDefined();
    expect(opus?.thinking?.efforts.length ?? 0).toBeGreaterThan(0);
  });

  test("extended windows are only reported when larger than the standard one", () => {
    const extended = models.filter((m) => m.extendedContextWindow !== undefined);
    expect(extended.length).toBeGreaterThan(0);
    for (const m of extended) expect(m.extendedContextWindow!).toBeGreaterThan(m.contextWindow);
  });

  test("slow mode is offered on direct Anthropic and OpenAI, not everywhere", () => {
    expect(
      slowModeAvailable({
        provider: "anthropic",
        id: "claude-opus-5-5",
        api: "anthropic-messages",
      }),
    ).toBe(true);
    expect(models.some((m) => m.provider === "openai" && m.slowMode)).toBe(true);
    expect(models.some((m) => !m.slowMode)).toBe(true);
    expect(slowModeAvailable(undefined)).toBe(false);
  });
});

describe("chat-only filter", () => {
  test("embedding, speech and other runners are dropped; plain and kind=chat models stay", () => {
    const base = {
      api: "openai-completions",
      contextWindow: 128_000,
      maxTokens: 8_000,
      input: ["text"],
    };
    const registry = {
      getAll: () => [
        { ...base, provider: "p", id: "chat-a" },
        { ...base, provider: "p", id: "chat-b", kind: "chat" },
        { ...base, provider: "p", id: "embed", kind: "embedding" },
        { ...base, provider: "p", id: "voice", kind: "tts" },
        { ...base, provider: "p", id: "titles", kind: "tiny" },
      ],
    };
    const auth = { keys: { source: () => undefined, keyless: () => false } };
    const keys = listModels(registry as never, auth as never).map((m) => m.key);
    expect(keys).toEqual(["p/chat-a", "p/chat-b"]);
  });
});
