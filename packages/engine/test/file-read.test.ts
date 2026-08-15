/**
 * file.read — the inspector preview's read-anything endpoint. It must
 * classify text/image/binary correctly, expand ~, and never throw on
 * missing paths (the UI shows a message instead).
 */

import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { handleRequest } from "../src/handlers";
import type { EngineServer } from "../src/server";

const dir = mkdtempSync(join(tmpdir(), "orch-fileread-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

// file.read never touches the runtime manager; a hollow server is enough.
const server = { manager: undefined } as unknown as EngineServer;

async function read(path: string) {
  return (await handleRequest(server, {
    id: "t",
    type: "file.read",
    payload: { path },
  } as never)) as {
    kind: string;
    content?: string;
    base64?: string;
    mime?: string;
    truncated?: boolean;
  };
}

describe("file.read", () => {
  test("reads a text file with content intact", async () => {
    const p = join(dir, "notes.md");
    writeFileSync(p, "# Title\n\nbody\n");
    const r = await read(p);
    expect(r.kind).toBe("text");
    expect(r.content).toBe("# Title\n\nbody\n");
    expect(r.truncated).toBe(false);
  });

  test("returns images as base64 with a mime type", async () => {
    const p = join(dir, "dot.png");
    // 1x1 transparent PNG
    const png = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
      "base64",
    );
    writeFileSync(p, png);
    const r = await read(p);
    expect(r.kind).toBe("image");
    expect(r.mime).toBe("image/png");
    expect(Buffer.from(r.base64 ?? "", "base64").equals(png)).toBe(true);
  });

  test("returns PDFs as base64 for the embed viewer", async () => {
    const p = join(dir, "doc.pdf");
    const pdf = Buffer.from("%PDF-1.4\n%\x00fake\n%%EOF\n", "latin1");
    writeFileSync(p, pdf);
    const r = await read(p);
    expect(r.kind).toBe("pdf");
    expect(r.mime).toBe("application/pdf");
    expect(Buffer.from(r.base64 ?? "", "base64").equals(pdf)).toBe(true);
  });

  test("flags NUL-bearing files as binary", async () => {
    const p = join(dir, "blob.dat");
    writeFileSync(p, Buffer.from([0x68, 0x69, 0x00, 0x68, 0x69]));
    const r = await read(p);
    expect(r.kind).toBe("binary");
  });

  test("reports missing paths instead of throwing", async () => {
    const r = await read(join(dir, "nope.txt"));
    expect(r.kind).toBe("missing");
  });

  test("identifies directories", async () => {
    const r = await read(dir);
    expect(r.kind).toBe("directory");
  });

  test("expands a leading ~ to the home directory", async () => {
    const r = await read("~");
    expect(r.kind).toBe("directory");
    // and a ~-prefixed file resolves the same as its absolute twin
    const abs = await read(homedir());
    expect(abs.kind).toBe("directory");
  });
});
