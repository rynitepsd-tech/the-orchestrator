/**
 * Error taxonomy: an upstream failure must reach the UI as something the user
 * can act on, never a raw provider blob.
 *
 * The version-gate case is not hypothetical. OMP discovers models from each
 * provider's live endpoint, so a model released after the pinned OMP shows up
 * in the picker and fails only when first used. Captured verbatim from
 * Anthropic on the 17.3.8 pin.
 */
import { describe, expect, test } from "bun:test";
import { classifyError } from "../src/worker/classify-error";

const VERSION_GATED_400 =
  '400 {"type":"error","error":{"type":"invalid_request_error","message":"Claude Code 2.1.220 does not support this model; version 2.1.251 or newer is required. Run \'claude update\', or update the Claude desktop app, then try again.","details":{"error_code":"claude_code_version_too_old"}},"request_id":"req_011CedDS1a7VeN4U42h37gte"}';

describe("classifyError", () => {
  test("a version-gated model reads as unavailable, not as an unknown 400", () => {
    const err = classifyError(new Error(VERSION_GATED_400));
    expect(err.kind).toBe("model-unavailable");
    expect(err.retryable).toBe(false);
  });

  test("it never tells the user to update a product this app does not use", () => {
    const err = classifyError(new Error(VERSION_GATED_400));
    // The provider's own advice ("run claude update") is misdirection here.
    expect(err.message).not.toMatch(/claude update/i);
    expect(err.message).toMatch(/omp|orchestrator/i);
    // The raw text stays reachable under disclosure for debugging.
    expect(err.detail).toContain("claude_code_version_too_old");
  });

  test("the generic model-missing case still classifies", () => {
    expect(classifyError(new Error("unknown model: gpt-9")).kind).toBe("model-unavailable");
  });

  test("auth and quota keep their kinds and retryability", () => {
    expect(classifyError(new Error("401 unauthorized")).kind).toBe("auth");
    const quota = classifyError(new Error("429 rate limit exceeded"));
    expect(quota.kind).toBe("provider-quota");
    expect(quota.retryable).toBe(true);
  });

  test("an unrecognised failure stays unknown and is truncated, not dropped", () => {
    const err = classifyError(new Error("x".repeat(5000)));
    expect(err.kind).toBe("unknown");
    expect(err.message.length).toBe(300);
    expect(err.detail?.length).toBe(4000);
  });
});
