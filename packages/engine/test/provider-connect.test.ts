/**
 * Provider connect classification against OMP's real registry.
 *
 * The product runs on subscriptions: the Providers panel leads with real
 * OAuth sign-ins and groups key-based providers separately. These pin the
 * registry-derived classification for the providers that anchor each group.
 */
import { describe, expect, test } from "bun:test";
import { providerConnectKind } from "@orchestrator/omp-adapter";

describe("providerConnectKind", () => {
  test("subscription sign-ins (OAuth with refresh)", () => {
    for (const p of ["anthropic", "openai-codex", "github-copilot", "google-gemini-cli"]) {
      expect(providerConnectKind(p)).toBe("subscription");
    }
  });

  test("key-based interactive flows (key console + pasted key)", () => {
    for (const p of ["aiand", "alibaba-token-plan", "xai", "perplexity"]) {
      expect(providerConnectKind(p)).toBe("interactive");
    }
  });

  test("no login flow at all — direct API-key storage", () => {
    expect(providerConnectKind("aimlapi")).toBe("api-key");
    expect(providerConnectKind("definitely-not-a-provider")).toBe("api-key");
  });
});
