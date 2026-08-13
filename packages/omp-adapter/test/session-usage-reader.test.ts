/**
 * Session-file usage reader: parses OMP's persisted JSONL into authoritative
 * usage records. Fixture lines mirror the real on-disk shape (OMP 17.3.1).
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readSessionFileUsage } from "../src/session-usage-reader";

const dirs: string[] = [];
function fixture(lines: unknown[]): string {
  const dir = mkdtempSync(join(tmpdir(), "orch-reader-"));
  dirs.push(dir);
  const p = join(dir, "s.jsonl");
  writeFileSync(
    p,
    lines.map((l) => (typeof l === "string" ? l : JSON.stringify(l))).join("\n") + "\n",
  );
  return p;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const header = { type: "session", version: 3, id: "omp-123", cwd: "/proj" };
const assistantMsg = (responseId: string, input: number) => ({
  type: "message",
  id: "e1",
  message: {
    role: "assistant",
    content: [{ type: "text", text: "hi" }],
    provider: "anthropic",
    model: "claude-fable-5",
    responseId,
    timestamp: 1786656890810,
    usage: {
      input,
      output: 50,
      cacheRead: 10,
      cacheWrite: 5,
      totalTokens: input + 65,
      cost: { input: 0.001, output: 0.0002, cacheRead: 0, cacheWrite: 0, total: 0.0012 },
    },
  },
});

describe("readSessionFileUsage", () => {
  test("extracts one omp-session record per assistant response", async () => {
    const p = fixture([
      { type: "title", title: "My session" },
      header,
      {
        type: "message",
        id: "u1",
        message: { role: "user", content: [{ type: "text", text: "go" }] },
      },
      assistantMsg("resp-A", 1000),
      assistantMsg("resp-B", 2000),
    ]);
    const res = await readSessionFileUsage(p);
    expect(res).not.toBeNull();
    expect(res!.ompSessionId).toBe("omp-123");
    expect(res!.cwd).toBe("/proj");
    expect(res!.title).toBe("My session");
    expect(res!.records.length).toBe(2);
    const [a] = res!.records;
    expect(a.source).toBe("omp-session");
    expect(a.inputTokens).toBe(1000);
    expect(a.cost).toBeCloseTo(0.0012);
    expect(a.ompSessionId).toBe("omp-123");
    expect(a.key).toContain("resp-A");
  });

  test("assistant messages without usage produce no records", async () => {
    const p = fixture([
      header,
      { type: "message", id: "e2", message: { role: "assistant", content: [] } },
    ]);
    const res = await readSessionFileUsage(p);
    expect(res!.records).toEqual([]);
  });

  test("a torn final line (crashed writer) is skipped, earlier records survive", async () => {
    const p = fixture([header, assistantMsg("resp-A", 500), '{"type":"message","id":"tor']);
    const res = await readSessionFileUsage(p);
    expect(res!.records.length).toBe(1);
  });

  test("missing file returns null instead of throwing", async () => {
    expect(await readSessionFileUsage("/nonexistent/nope.jsonl")).toBeNull();
  });
});
