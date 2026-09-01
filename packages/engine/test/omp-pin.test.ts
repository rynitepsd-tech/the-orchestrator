/**
 * OMP PIN COHERENCE — every place that names the embedded OMP must agree.
 *
 * `docs/RELEASE.md` already requires this, but nothing enforced it, so the
 * numbers drifted apart: the code moved 17.3.1 → 17.3.4 → 17.3.8 while
 * `THIRD_PARTY_NOTICES.md` still said 17.3.1 and the docs still said 17.3.4.
 * That notice is redistributed inside the `.app`, so a stale version there
 * misstates what is actually shipped.
 *
 * `packages/engine/package.json` is the single source of truth; everything
 * else is checked against it.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "../../..");
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8");

/** Read one dependency version out of a package.json, narrowing as we go. */
function dependencyVersion(manifestPath: string, pkg: string): string {
  const parsed: unknown = JSON.parse(read(manifestPath));
  if (!parsed || typeof parsed !== "object" || !("dependencies" in parsed)) {
    throw new Error(`${manifestPath} has no dependencies block`);
  }
  const deps = parsed.dependencies;
  if (!deps || typeof deps !== "object" || !(pkg in deps)) {
    throw new Error(`${manifestPath} does not depend on ${pkg}`);
  }
  const version = (deps as Record<string, unknown>)[pkg];
  if (typeof version !== "string")
    throw new Error(`${manifestPath}: ${pkg} version is not a string`);
  return version;
}

const PIN = dependencyVersion("packages/engine/package.json", "@oh-my-pi/pi-coding-agent");

describe("OMP pin coherence", () => {
  test("the pin is an exact version, never a range", () => {
    // A caret would let a rebuild embed a different OMP than the one tested,
    // which is the mismatch the whole runbook exists to prevent.
    expect(PIN).toMatch(/^\d+\.\d+\.\d+$/);
  });

  test("the adapter package agrees with the engine", () => {
    const manifest = "packages/omp-adapter/package.json";
    expect(dependencyVersion(manifest, "@oh-my-pi/pi-coding-agent")).toBe(PIN);
    expect(dependencyVersion(manifest, "@oh-my-pi/pi-ai")).toBe(PIN);
  });

  test("the build constant and the smoke assertion agree", () => {
    expect(read("scripts/build-engine.ts")).toContain(`const OMP_VERSION = "${PIN}"`);
    expect(read("scripts/smoke-packaged.ts")).toContain(`info.ompVersion === "${PIN}"`);
  });

  test("the redistribution notice states the version that actually ships", () => {
    const notice = read("THIRD_PARTY_NOTICES.md");
    expect(notice).toContain(`Version embedded: **${PIN}**`);
    // Every `| @oh-my-pi/... | <version> |` row must name the pin; one stale
    // row understates what is redistributed inside the .app.
    const rows = [...notice.matchAll(/^\|\s*`@oh-my-pi\/[a-z0-9-]+`\s*\|\s*([\d.]+)\s*\|$/gm)];
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(`${row[1]} :: ${row[0].trim()}`).toBe(`${PIN} :: ${row[0].trim()}`);
    }
    // Prose and the addon section use `@pkg@version` instead of a table row.
    for (const match of notice.matchAll(/@oh-my-pi\/[a-z0-9-]+@([\d.]+)/g)) {
      expect(`${match[1]} :: ${match[0]}`).toBe(`${PIN} :: ${match[0]}`);
    }
    // The bundled-components table writes the version parenthetically after
    // the package name — a third form, and exactly how two stale 17.3.1 rows
    // survived the first correction of this file.
    const parenthetical = [...notice.matchAll(/`@oh-my-pi\/[a-z0-9-]+`[^|\n]*?\((\d[\d.]*)\)/g)];
    expect(parenthetical.length).toBeGreaterThan(0);
    for (const match of parenthetical) {
      expect(`${match[1]} :: ${match[0]}`).toBe(`${PIN} :: ${match[0]}`);
    }
    // Backstop for a fourth form nobody has invented yet: no OMP-train
    // version string anywhere in this file may disagree with the pin.
    for (const match of notice.matchAll(/\b1[78]\.\d+\.\d+\b/g)) {
      expect(match[0]).toBe(PIN);
    }
  });

  test("the compatibility table states the version that actually ships", () => {
    const doc = read("docs/OMP_COMPATIBILITY.md");
    expect(doc).toContain(`| **OMP version** | \`${PIN}\` |`);
    expect(doc).toContain(`| **Tag** | \`v${PIN}\` |`);
  });
});
