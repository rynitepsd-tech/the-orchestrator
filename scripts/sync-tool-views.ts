/**
 * Copy OMP's <omp-tool-view> web-component bundle into the desktop app.
 *
 * The bundle is auto-generated upstream and versioned with the OMP pin; the
 * vendored copy is checked in (so editors and tsc see it) and refreshed on
 * every vite dev/build so it can never drift from the installed OMP.
 */

import { copyFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const src = join(
  root,
  "packages/engine/node_modules/@oh-my-pi/pi-coding-agent/src/export/html/tool-views.generated.js",
);
const dstDir = join(root, "apps/desktop/src/vendor");
const dst = join(dstDir, "tool-views.generated.js");

// Sanity: refuse to vendor something that is not the expected bundle.
const head = readFileSync(src, "utf8").slice(0, 200);
if (!head.includes("build-tool-views")) {
  throw new Error(`Unexpected tool-views bundle header at ${src}`);
}

mkdirSync(dstDir, { recursive: true });
copyFileSync(src, dst);
console.log(`synced omp-tool-view bundle -> ${dst}`);
