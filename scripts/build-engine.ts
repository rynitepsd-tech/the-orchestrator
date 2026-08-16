/**
 * Build the engine sidecar into `resources/engine/`.
 *
 * Produces a Bun single-file executable plus the OMP native addon it needs.
 *
 * Why the addon ships beside the binary
 * -------------------------------------
 * `@oh-my-pi/pi-natives` is a Rust N-API `cdylib` loaded by `require()` of an
 * absolute path. Nothing is downloaded at runtime. Under `bun build --compile`
 * the loader detects a compiled binary and searches, in order:
 *   ~/.omp/natives/<version>/ -> ~/.local/bin/ -> bunfs nativeDir -> execDir
 * The last entry, `path.dirname(process.execPath)`, is the escape hatch: place
 * the `.node` next to the sidecar and the app is fully self-contained and
 * offline, with no writes into the user's ~/.omp.
 *
 * Verified: without the addon the compiled engine dies with
 * "Failed to load pi_natives native addon"; with it, the engine reaches
 * `engine.ready`.
 *
 * Usage:
 *   bun run scripts/build-engine.ts [--target=arm64|x64|both]
 */
import { copyFileSync, existsSync, mkdirSync, rmSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..");
const OUT = join(ROOT, "resources", "engine");
const ENTRY = join(ROOT, "packages", "engine", "src", "main.ts");

/** OMP version this build is pinned to. Must match package.json exactly. */
const OMP_VERSION = "17.3.4";

interface Target {
  key: "arm64" | "x64";
  bunTarget: string;
  nativePkg: string;
  nativeFile: string;
}

const TARGETS: Target[] = [
  {
    key: "arm64",
    bunTarget: "bun-darwin-arm64",
    nativePkg: "@oh-my-pi/pi-natives-darwin-arm64",
    nativeFile: "pi_natives.darwin-arm64.node",
  },
  {
    key: "x64",
    bunTarget: "bun-darwin-x64",
    nativePkg: "@oh-my-pi/pi-natives-darwin-x64",
    nativeFile: "pi_natives.darwin-x64-baseline.node",
  },
];

const arg = process.argv.find((a) => a.startsWith("--target="))?.split("=")[1] ?? "host";
const wanted =
  arg === "both"
    ? TARGETS
    : arg === "host"
      ? TARGETS.filter((t) => t.key === (process.arch === "x64" ? "x64" : "arm64"))
      : TARGETS.filter((t) => t.key === arg);

if (wanted.length === 0) {
  console.error(`unknown --target=${arg} (use arm64, x64, both, or host)`);
  process.exit(1);
}

/** Locate a file inside an installed package, tolerating bun's store layout. */
function findInPackage(pkg: string, file: string): string | null {
  const direct = join(ROOT, "node_modules", pkg, file);
  if (existsSync(direct)) return direct;

  // bun's isolated store: node_modules/.bun/<pkg>@<ver>/node_modules/<pkg>/<file>
  const storeDir = join(ROOT, "node_modules", ".bun");
  if (!existsSync(storeDir)) return null;
  const flat = pkg.replace("/", "+");
  const glob = new Bun.Glob(`${flat}@*/node_modules/${pkg}/${file}`);
  for (const hit of glob.scanSync({ cwd: storeDir, onlyFiles: true })) {
    return join(storeDir, hit);
  }
  return null;
}

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

let failed = false;

for (const t of wanted) {
  const binName = wanted.length > 1 ? `orchestrator-engine-${t.key}` : "orchestrator-engine";
  const outfile = join(OUT, binName);

  console.log(`\n▸ building engine for ${t.bunTarget}`);

  const build = Bun.spawnSync(
    [
      "bun",
      "build",
      "--compile",
      `--target=${t.bunTarget}`,
      // Optional heavy deps that are not needed by the desktop engine and
      // cannot be resolved at bundle time.
      "--external",
      "omp-legacy-pi-modules",
      "--external",
      "fastembed",
      "--external",
      "onnxruntime-node",
      "--define",
      'process.env.PI_COMPILED="true"',
      "--define",
      'process.env.ORCHESTRATOR_COMPILED="1"',
      "--outfile",
      outfile,
      ENTRY,
    ],
    {
      cwd: ROOT,
      env: {
        ...process.env,
        // Bun emits a truncated Mach-O signature on darwin; sign explicitly below.
        BUN_NO_CODESIGN_MACHO_BINARY: "1",
      },
      stdout: "inherit",
      stderr: "inherit",
    },
  );

  if (build.exitCode !== 0) {
    console.error(`  ✗ bun build failed for ${t.bunTarget}`);
    failed = true;
    continue;
  }

  // Ad-hoc sign so the binary is loadable on modern macOS. A Developer ID
  // identity replaces the "-" here without any other change (see docs/RELEASE.md).
  const identity = process.env.MACOS_SIGN_IDENTITY ?? "-";
  const sign = Bun.spawnSync(["codesign", "--force", "--sign", identity, outfile], {
    stdout: "inherit",
    stderr: "inherit",
  });
  if (sign.exitCode !== 0) {
    console.error("  ✗ codesign failed");
    failed = true;
    continue;
  }

  // The native addon must sit beside the executable (see header).
  const src = findInPackage(t.nativePkg, t.nativeFile);
  if (!src) {
    console.error(
      `  ✗ ${t.nativePkg}/${t.nativeFile} not found.\n` +
        `    Install it for cross-target builds:  bun add -d ${t.nativePkg}@${OMP_VERSION}`,
    );
    failed = true;
    continue;
  }
  copyFileSync(src, join(OUT, t.nativeFile));

  const mb = (p: string) => (statSync(p).size / 1024 / 1024).toFixed(1);
  console.log(`  ✓ ${binName} (${mb(outfile)} MB)`);
  console.log(`  ✓ ${t.nativeFile} (${mb(join(OUT, t.nativeFile))} MB)`);
}

if (failed) {
  console.error("\nengine build FAILED");
  process.exit(1);
}

console.log(`\nengine built into ${OUT}`);
console.log(`pinned OMP: ${OMP_VERSION}`);
