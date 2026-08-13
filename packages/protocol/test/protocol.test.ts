/**
 * Protocol-layer unit tests: framing, validation, redaction, selectors.
 *
 * The FrameDecoder and redaction functions sit on the only path between the
 * agent runtime and the UI; a regression here corrupts every session at once.
 */
import { describe, expect, test } from "bun:test";
import {
  encodeFrame,
  FrameDecoder,
  fromOmpAdvisorSelector,
  isEngineEventFrame,
  isEngineRequest,
  isEngineResponse,
  isProtocolCompatible,
  PROTOCOL_VERSION,
  redactText,
  redactValue,
  sanitizeOutput,
  toOmpAdvisorSelector,
} from "../src";

describe("FrameDecoder", () => {
  test("decodes complete NDJSON lines", () => {
    const d = new FrameDecoder();
    const { frames, errors } = d.push('{"a":1}\n{"b":2}\n');
    expect(frames).toEqual([{ a: 1 }, { b: 2 }]);
    expect(errors).toEqual([]);
  });

  test("tolerates partial reads across chunk boundaries", () => {
    const d = new FrameDecoder();
    expect(d.push('{"a"').frames).toEqual([]);
    expect(d.push(':1}\n{"b"').frames).toEqual([{ a: 1 }]);
    expect(d.push(":2}\n").frames).toEqual([{ b: 2 }]);
  });

  test("reports malformed lines without dying", () => {
    const d = new FrameDecoder();
    const { frames, errors } = d.push('not json\n{"ok":true}\n');
    expect(frames).toEqual([{ ok: true }]);
    expect(errors.length).toBe(1);
    expect(errors[0]).toContain("malformed frame");
  });

  test("resets when a line exceeds the byte ceiling", () => {
    const d = new FrameDecoder(64);
    const { errors } = d.push("x".repeat(200));
    expect(errors.length).toBe(1);
    // Subsequent complete frames still decode after the reset.
    expect(d.push('{"a":1}\n').frames).toEqual([{ a: 1 }]);
  });

  test("skips blank lines", () => {
    const d = new FrameDecoder();
    expect(d.push('\n\n{"a":1}\n\n').frames).toEqual([{ a: 1 }]);
  });
});

describe("frame guards", () => {
  const req = {
    protocolVersion: PROTOCOL_VERSION,
    requestId: "r1",
    type: "engine.hello",
    payload: {},
  };
  test("isEngineRequest", () => {
    expect(isEngineRequest(req)).toBe(true);
    expect(isEngineRequest({ ...req, requestId: 5 })).toBe(false);
    expect(isEngineRequest(null)).toBe(false);
    expect(isEngineRequest("x")).toBe(false);
  });
  test("isEngineResponse", () => {
    expect(isEngineResponse({ requestId: "r", ok: true, result: {} })).toBe(true);
    expect(isEngineResponse({ requestId: "r" })).toBe(false);
  });
  test("isEngineEventFrame", () => {
    expect(isEngineEventFrame({ sequence: 1, event: { type: "x" } })).toBe(true);
    expect(isEngineEventFrame({ event: { type: "x" } })).toBe(false);
  });
  test("protocol compatibility", () => {
    expect(isProtocolCompatible(PROTOCOL_VERSION)).toBe(true);
    expect(isProtocolCompatible(0)).toBe(false);
  });
  test("encodeFrame emits one newline-terminated line", () => {
    expect(encodeFrame({ a: 1 })).toBe('{"a":1}\n');
  });
});

describe("redaction", () => {
  test("api keys, tokens, and headers are removed from text", () => {
    const text = [
      "Authorization: Bearer abc123secrettoken",
      "key sk-ant-api03-superduper-secret-value-here",
      "ghp_0123456789abcdef0123456789abcdef1234",
      "AKIAIOSFODNN7EXAMPLE",
    ].join("\n");
    const red = redactText(text);
    expect(red).not.toContain("abc123secrettoken");
    expect(red).not.toContain("superduper");
    expect(red).not.toContain("ghp_0123456789abcdef");
    expect(red).not.toContain("AKIAIOSFODNN7EXAMPLE");
  });

  test("redactValue scrubs sensitive keys deeply but keeps env names", () => {
    const v: any = redactValue({
      apiKey: "secret",
      nested: { authToken: "tok", fine: "ok" },
      env: { MY_SECRET_KEY: "value", PATH: "/usr/bin" },
    });
    expect(v.apiKey).not.toBe("secret");
    expect(v.nested.authToken).not.toBe("tok");
    expect(v.nested.fine).toBe("ok");
    expect(Object.keys(v.env)).toContain("MY_SECRET_KEY");
    expect(v.env.MY_SECRET_KEY).not.toBe("value");
  });

  test("sanitizeOutput truncates and reports it", () => {
    const { output, truncated } = sanitizeOutput("x".repeat(1000), 100);
    expect(truncated).toBe(true);
    expect(output.length).toBeLessThanOrEqual(200); // truncation marker allowed
    const small = sanitizeOutput("hello");
    expect(small.truncated).toBe(false);
    expect(small.output).toBe("hello");
  });
});

describe("advisor model selector", () => {
  test("round-trips model + thinking level", () => {
    expect(toOmpAdvisorSelector("x-ai/grok-code-fast", "high")).toBe("x-ai/grok-code-fast:high");
    expect(fromOmpAdvisorSelector("x-ai/grok-code-fast:high")).toEqual({
      model: "x-ai/grok-code-fast",
      thinkingLevel: "high",
    });
  });
  test("model without level survives", () => {
    expect(fromOmpAdvisorSelector("anthropic/claude-fable-5")).toEqual({
      model: "anthropic/claude-fable-5",
    });
  });
  test("colon inside a path-like segment is not a level", () => {
    expect(fromOmpAdvisorSelector("weird:provider/model")).toEqual({
      model: "weird:provider/model",
    });
  });
  test("undefined stays undefined", () => {
    expect(toOmpAdvisorSelector(undefined, "high")).toBeUndefined();
    expect(fromOmpAdvisorSelector(undefined)).toEqual({});
  });
});
