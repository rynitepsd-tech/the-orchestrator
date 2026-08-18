/**
 * file.read — the inspector preview's read endpoint. It must classify
 * text/image/pdf/binary correctly INSIDE an open project's root, and refuse
 * everything else: absolute paths outside the roots, ~ paths, and symlink
 * escapes. The containment boundary is the point of these tests.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { handleRequest } from "../src/handlers";
import type { EngineServer } from "../src/server";

const dir = mkdtempSync(join(tmpdir(), "orch-fileread-"));
const outside = mkdtempSync(join(tmpdir(), "orch-fileread-outside-"));
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});

// file.read consults the manager's live sessions for its allowlist.
const server = {
  manager: { list: () => [{ projectPath: dir }] },
} as unknown as EngineServer;

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

describe("file.read inside the project", () => {
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

  test("reports in-bounds missing paths as missing (locate-by-name relies on it)", async () => {
    const r = await read(join(dir, "nope.txt"));
    expect(r.kind).toBe("missing");
  });

  test("identifies the project root as a directory", async () => {
    const r = await read(dir);
    expect(r.kind).toBe("directory");
  });
});

describe("file.read containment", () => {
  test("denies absolute paths outside every open project", async () => {
    const p = join(outside, "secret.txt");
    writeFileSync(p, "nope");
    expect((await read(p)).kind).toBe("denied");
    expect((await read("/etc/hosts")).kind).toBe("denied");
  });

  test("denies ~ paths (home is not a project root)", async () => {
    expect((await read("~")).kind).toBe("denied");
    expect((await read(`~/${".ssh/config"}`)).kind).toBe("denied");
    expect((await read(homedir())).kind).toBe("denied");
  });

  test("denies missing paths outside the roots without confirming absence", async () => {
    expect((await read(join(outside, "ghost.txt"))).kind).toBe("denied");
  });

  test("denies symlink escapes: a link inside the project to outside it", async () => {
    const escapeTarget = join(outside, "escape.txt");
    writeFileSync(escapeTarget, "outside contents");
    const link = join(dir, "innocent.txt");
    symlinkSync(escapeTarget, link);
    expect((await read(link)).kind).toBe("denied");
  });

  test("allows symlinks that stay inside the project", async () => {
    const realFile = join(dir, "real.txt");
    writeFileSync(realFile, "inside");
    const link = join(dir, "alias.txt");
    symlinkSync(realFile, link);
    const r = await read(link);
    expect(r.kind).toBe("text");
    expect(r.content).toBe("inside");
  });

  test("with no live sessions, everything is denied", async () => {
    const empty = { manager: { list: () => [] } } as unknown as EngineServer;
    const p = join(dir, "notes.md");
    const r = (await handleRequest(empty, {
      id: "t",
      type: "file.read",
      payload: { path: p },
    } as never)) as { kind: string };
    expect(r.kind).toBe("denied");
  });

  test("root allowlist is symlink-resolved (tmpdir vs /private on macOS)", async () => {
    // realpath(dir) may differ from dir on macOS; reading via the real path
    // must still be allowed.
    const p = join(realpathSync(dir), "notes.md");
    expect((await read(p)).kind).toBe("text");
  });
});
