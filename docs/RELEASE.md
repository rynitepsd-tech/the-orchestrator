# Release Runbook

Operational procedure for cutting a release of The Orchestrator. This document describes what the
repository actually does today, not a target state. Where something is not implemented, it says so.

Scope of a release today: macOS on Apple Silicon, ad-hoc signed, distributed as a DMG attached to a
GitHub Release, built by a tag-triggered CI workflow. In-app updates are delivered through the Tauri
updater (minisign-verified `latest.json` feed on the GitHub Release — see section 10). There is no
notarization in this build.

Related reading: [ARCHITECTURE.md](./ARCHITECTURE.md), [OMP_COMPATIBILITY.md](./OMP_COMPATIBILITY.md),
[USAGE_MODEL.md](./USAGE_MODEL.md).

---

## 1. Version bump checklist

The version number lives in three files and there is no script that synchronises them. All three
must be changed in the same commit, and they must be identical strings.

| File | Field |
|---|---|
| `package.json` | `"version"` |
| `apps/desktop/src-tauri/tauri.conf.json` | `"version"` |
| `apps/desktop/src-tauri/Cargo.toml` | `[package] version` |

Notes:

- `apps/desktop/package.json` also carries a `version`, but it is a private workspace member and
  does not reach any artifact. Keeping it in step is optional and harmless.
- `tauri.conf.json` `"version"` is what names the DMG: the bundler produces
  `The Orchestrator_<version>_aarch64.dmg`. (GitHub replaces the spaces with dots when the file is
  uploaded as a release asset, so users download `The.Orchestrator_<version>_aarch64.dmg`.)
- After editing `Cargo.toml`, run one Rust build (step 5 below) so `Cargo.lock` records the new
  version; commit the lockfile change with the bump.
- Confirm the bump landed everywhere:

  ```sh
  grep -n '"version"' package.json apps/desktop/src-tauri/tauri.conf.json
  grep -n '^version' apps/desktop/src-tauri/Cargo.toml
  ```

---

## 2. OMP compatibility check

The engine embeds OMP through the published npm SDK and is pinned to one exact upstream version.
Before every release, confirm the pin is still coherent — a silent drift here produces an app that
builds and then fails at runtime inside the packaged bundle.

Check, in order:

1. `@oh-my-pi/pi-coding-agent` in the engine package resolves to the pinned version (`17.3.8` as
   of 0.6.8 — the exact string is in `packages/engine/package.json` and
   `packages/omp-adapter/package.json`, which must agree).
2. `OMP_VERSION` in `scripts/build-engine.ts` matches that version exactly. The constant is what the
   build prints and what the smoke test asserts against.
3. `scripts/smoke-packaged.ts` asserts the same version in its `reports the pinned OMP version`
   check. If you intentionally move the pin, all three change together.
4. The native addon package (`@oh-my-pi/pi-natives-darwin-arm64`, and `-darwin-x64` if building
   Intel) is installed at the same version.
5. Bun is at least `1.3.14` — OMP declares this in `engines.bun`, and the repo pins
   `packageManager: bun@1.3.14`.

If the pin moves, re-read [OMP_COMPATIBILITY.md](./OMP_COMPATIBILITY.md) and re-verify the integration
surface listed there before releasing. Upstream is a fast-moving project and the coupling is tight.

---

## 3. Build sequence

Run from the repository root, in this order. Do not skip ahead on a failure; each step gates the next.

```sh
bun install
bun run typecheck
bun test
bun run build:engine
cd apps/desktop && bunx tauri build
cd ../.. && bun run scripts/smoke-packaged.ts
```

What each step is for:

| Step | Purpose | Expected result |
|---|---|---|
| `bun install` | Restore the workspace from `bun.lock`, including the native addon package. | Clean install, no lockfile churn. |
| `bun run typecheck` | `tsc --build --force` across the workspace. | No errors. |
| `bun test` | Usage de-duplication, concurrency, adapter, and protocol suites. The concurrency suite drives a local mock provider speaking the OpenAI SSE wire format. No real API credits are spent. | All passing, zero failures. |
| `bun run build:engine` | `bun build --compile` of the engine sidecar into `resources/engine/`, then explicit `codesign`, then copies the native addon beside it. | `orchestrator-engine` (~85 MB) and `pi_natives.darwin-arm64.node` (~140 MB) in `resources/engine/`. |
| `bunx tauri build` | Builds the Vite frontend, compiles the Rust binary, and bundles `resources/engine` into the app as `Contents/Resources/engine`. | `The Orchestrator.app` and `The Orchestrator_<version>_aarch64.dmg` under `apps/desktop/src-tauri/target/release/bundle/`. |
| `bun run scripts/smoke-packaged.ts` | Drives the engine **inside the built app**. | 25/25 checks passed. |

The engine build must run before `tauri build`. `tauri.conf.json` declares
`"resources": { "../../../resources/engine": "engine" }`, so the bundler copies whatever is in that
directory at bundle time. A stale or empty `resources/engine` yields an app that launches and then
cannot start a session.

`bun build --compile` is invoked with `--external omp-legacy-pi-modules --external fastembed
--external onnxruntime-node`. These are optional heavy dependencies the desktop engine does not use
and cannot resolve at bundle time; removing the flags breaks the compile.

### The packaged smoke test is not optional

`scripts/smoke-packaged.ts` is the only test that exercises the shipping artifact. It catches the
class of failure that does not exist in a source checkout: a missing native addon, an architecture
mismatch, a bundler-stripped dynamic import, or config discovery that only worked from the repo. Its
25 checks cover engine architecture against the host, addon presence beside the binary, boot to
`engine.ready`, the reported OMP version, OMP agent-directory discovery, model registry load,
provider resolution from existing credentials, project open, session discovery, the approval bridge
(a gated tool call actually stops and waits for `approval.respond`), transcript replay on resume,
session fork, shutdown ack, and clean exit — all driven against the engine binary inside the built
`.app`, not the source tree.

It accepts an app path as its first argument, which is how you test a DMG-installed copy:

```sh
bun run scripts/smoke-packaged.ts "/Applications/The Orchestrator.app"
```

Do this at least once per release against the app mounted from the DMG you are about to publish,
not only against the build tree.

> `package.json` also exposes `"app": "bun run build:engine && cd apps/desktop && bunx tauri build"`
> — `bun run app` does the engine build and the Tauri build in one step, equivalent to running the
> two commands above in order. `bun run release:check` goes one step further and chains
> `check` (lint + typecheck + `bun test`), the engine build, the app build, and the packaged smoke
> test into a single command.

---

## 4. Architecture: Apple Silicon and Intel

`scripts/build-engine.ts` accepts `--target=arm64|x64|both`, defaulting to `host`:

```sh
bun run build:engine                 # host architecture
bun run build:engine -- --target=arm64
bun run build:engine -- --target=x64
bun run build:engine -- --target=both
```

| Target | Bun target | Native addon file |
|---|---|---|
| `arm64` | `bun-darwin-arm64` | `pi_natives.darwin-arm64.node` |
| `x64` | `bun-darwin-x64` | `pi_natives.darwin-x64-baseline.node` |

Cross-target builds need the matching addon package installed at **the pinned OMP version**, for
example `bun add -d @oh-my-pi/pi-natives-darwin-x64@17.3.8`. The script fails loudly with that
exact hint when the addon is missing. The version in that command must match the pin everywhere it
appears in the repo — `@oh-my-pi/pi-coding-agent` in `packages/engine/package.json` and
`packages/omp-adapter/package.json`, the `OMP_VERSION` constant in `scripts/build-engine.ts`, and
the version assertion in `scripts/smoke-packaged.ts` — an addon installed at any other version is
exactly the runtime mismatch section 2 exists to prevent.

**Apple Silicon is the only architecture that has been built and tested.** The x64 path exists in the
build script and has never been exercised end to end. Do not describe an x64 artifact as supported
until someone has run the full sequence, including the packaged smoke test, on Intel hardware.

**Never ship a DMG whose engine architecture differs from the app's.** The Rust binary and the engine
sidecar are compiled independently; nothing in `tauri build` verifies they agree. An arm64 app that
bundles an x64 engine (or the reverse) installs cleanly, launches, and then fails the moment a
session starts. Before publishing, verify both:

```sh
APP="apps/desktop/src-tauri/target/release/bundle/macos/The Orchestrator.app"
file -b "$APP/Contents/MacOS/The Orchestrator"
file -b "$APP/Contents/Resources/engine/orchestrator-engine"
ls "$APP/Contents/Resources/engine"
```

Both `file` lines must name the same architecture, and the addon in that directory must be the
matching `pi_natives.darwin-<arch>.node`. The smoke test's first two checks assert exactly this
against the host, which is why running it on the target machine is the real gate.

Note that `--target=both` names its outputs `orchestrator-engine-arm64` and `orchestrator-engine-x64`,
whereas a single-target build produces `orchestrator-engine`. The app and the smoke test both expect
`Contents/Resources/engine/orchestrator-engine`. Build one architecture at a time for a release.

---

## 5. Signing today: ad-hoc

The maintainer has **no paid Apple Developer account**, so there is no Developer ID certificate to
sign with. Releases are therefore **ad-hoc signed** (`codesign --sign -`). Ad-hoc signing produces a
valid, loadable Mach-O with no signing identity and no notarization ticket; macOS treats the result
as unidentified third-party software.

Two details in `scripts/build-engine.ts` matter:

1. `BUN_NO_CODESIGN_MACHO_BINARY=1` is set in the environment for the `bun build --compile` call.
   Bun emits a truncated Mach-O signature on darwin for compiled binaries; leaving Bun to sign
   produces a binary macOS may refuse to load. The variable turns Bun's own signing off.
2. The script then signs the output explicitly, immediately after the compile:

   ```sh
   codesign --force --sign "${MACOS_SIGN_IDENTITY:--}" resources/engine/orchestrator-engine
   ```

   The identity comes from `MACOS_SIGN_IDENTITY`, defaulting to `-` (ad-hoc). Setting that variable
   to a Developer ID identity is the **only** change needed in the engine build; nothing else in the
   script branches on it.

`tauri.conf.json` sets `bundle.macOS.signingIdentity: null` and `entitlements: null`, so the app
bundle is also ad-hoc signed today.

Verify what you produced:

```sh
codesign -dv --verbose=4 "$APP" 2>&1 | grep -E 'Identifier|Signature|TeamIdentifier'
codesign -dv --verbose=4 "$APP/Contents/Resources/engine/orchestrator-engine" 2>&1 | grep Signature
spctl --assess --type execute --verbose "$APP"   # expects "rejected" for ad-hoc; informational only
```

An ad-hoc build reports `Signature=adhoc`. `spctl` rejecting it is the expected, documented outcome —
it is not a build failure.

---

## 6. Gatekeeper: what users see, and the correct fix

Because the app is ad-hoc signed and not notarized, a **downloaded** copy is blocked on first
launch. Measured behaviour with the real artifact (v0.3.0, Apple Silicon): macOS reports
*"The Orchestrator" is damaged and can't be opened. You should move it to the Trash.* The file is
not damaged — the checksum matches CI's output byte for byte. "Damaged" is what Gatekeeper says
about a quarantined app with no signing identity; there is **no "Open Anyway" entry** in
Privacy & Security for this case (that flow exists only for identified-developer signatures).
Sealing the bundle properly (ad-hoc `signingIdentity: "-"`, which we do) makes `codesign --verify`
pass but does not change the Gatekeeper verdict — only Developer ID + notarization does
(section 8).

The only working approval is removing the quarantine flag from **this one app**:

```sh
xattr -dr com.apple.quarantine "/Applications/The Orchestrator.app"
```

Include this in the release notes (the release workflow's body template already carries it), with
the "damaged is expected, verify the checksum if in doubt" framing so users don't re-download in a
loop.

Scope discipline still applies:

- **Never instruct users to disable Gatekeeper.** No `sudo spctl --master-disable`, ever.
- The `xattr` command is scoped to the single installed app — do not publish blanket
  `~/Downloads`-wide sweeps.
- Local builds never hit this: quarantine is applied by browsers at download time, which is why
  `tauri build` output always launched fine on the build machine.
- In-app updates do not re-trigger it: the updater's own writes are not quarantined, and payloads
  are verified against the baked-in minisign key instead.

This section stops being needed the day the project has Developer ID signing and notarization.

---

## 7. Checksums and the GitHub Release

Compute SHA-256 over every artifact you publish, from the exact files you are about to upload:

```sh
cd apps/desktop/src-tauri/target/release/bundle/dmg
shasum -a 256 "The Orchestrator_<version>_aarch64.dmg" | tee SHA256SUMS.txt
```

**Record checksums against the filenames GitHub will actually serve.** GitHub replaces spaces with
dots in uploaded asset names (`The Orchestrator_…` becomes `The.Orchestrator_…`), so a
`SHA256SUMS.txt` written with the local spaced names fails `shasum -c` for every downloaded file.
The CI workflow renames the artifacts to their dotted, as-served names before checksumming; do the
same if publishing by hand.

Attach to the GitHub Release:

- `The Orchestrator_<version>_aarch64.dmg` — the installer.
- `SHA256SUMS.txt` — checksums for every attached binary artifact.

Put the checksum in the release body as well as in the file, so a reader can verify without
downloading a second artifact. Tell users how to check it:

```sh
shasum -a 256 ~/Downloads/"The.Orchestrator_<version>_aarch64.dmg"
```

Release body should state, at minimum:

- Version, and the pinned OMP version this build embeds (the section 2 pin).
- Architecture: Apple Silicon (`aarch64`). Say plainly that Intel is not built or tested, and that
  Windows and Linux are not supported.
- Signing status: ad-hoc signed, not notarized — with the first-launch instructions from section 6.
- SHA-256 of the DMG.
- Known gaps in this build, so nobody discovers them as bugs: Intel (x64) is untested, no
  notarization, same-session CLI+GUI concurrent writes are unsupported (sequential handoff is
  fine), and an extension's fully custom UI components (outside the standard confirm/select/input/
  editor/notify set) are not renderable and surface an "unsupported interaction" card instead.
- No telemetry, no analytics, no cloud backend, no accounts. Credentials remain in OMP's own store;
  connecting a provider can be done from Settings → Providers, which runs OMP's own OAuth flow.

The `.app` does not need to be attached separately; it is inside the DMG. If you do attach it, ship
it as a zip created with `ditto -c -k --keepParent` so the signature survives, and checksum that too.

---

## 8. Future: Developer ID signing and notarization

None of this is in effect today. It is recorded so the path is unambiguous once a paid Apple
Developer account exists.

### 8.1 Identity

```sh
export MACOS_SIGN_IDENTITY="Developer ID Application: Your Name (TEAMID)"
bun run build:engine
```

The engine build picks the identity up with no other change. For the app bundle, set
`bundle.macOS.signingIdentity` in `tauri.conf.json` (or the equivalent Tauri env var) to the same
identity.

### 8.2 Entitlements

Hardened Runtime is required for notarization, and the app needs an entitlements plist referenced
from `bundle.macOS.entitlements`:

```xml
<key>com.apple.security.cs.allow-jit</key><true/>
<key>com.apple.security.cs.allow-unsigned-executable-memory</key><true/>
<key>com.apple.security.cs.disable-library-validation</key><true/>
```

- `allow-jit` and `allow-unsigned-executable-memory` — the engine is a Bun (JavaScriptCore) runtime
  and JITs.
- `disable-library-validation` — **mandatory, not optional.** The app `dlopen`s
  `pi_natives.darwin-arm64.node`, a native addon signed under a different Team ID than the app. With
  library validation on, the kernel refuses to map it and the engine dies at load. There is no
  workaround short of building and signing the addon yourself.

### 8.3 Order of operations

Signing is inside-out. Sign every nested binary **before** the enclosing app, or sealing the app
invalidates them:

```sh
codesign --force --options runtime --timestamp \
  --entitlements entitlements.plist --sign "$MACOS_SIGN_IDENTITY" \
  "$APP/Contents/Resources/engine/orchestrator-engine"

codesign --force --options runtime --timestamp \
  --sign "$MACOS_SIGN_IDENTITY" \
  "$APP/Contents/Resources/engine/pi_natives.darwin-arm64.node"

codesign --force --options runtime --timestamp \
  --entitlements entitlements.plist --sign "$MACOS_SIGN_IDENTITY" "$APP"

codesign --verify --deep --strict --verbose=2 "$APP"
```

### 8.4 Notarize, then staple

```sh
ditto -c -k --keepParent "$APP" "Orchestrator.zip"

xcrun notarytool submit "Orchestrator.zip" \
  --apple-id "$APPLE_ID" --team-id "$APPLE_TEAM_ID" \
  --password "$APPLE_APP_SPECIFIC_PASSWORD" --wait

xcrun stapler staple "$APP"
xcrun stapler staple "The Orchestrator_<version>_aarch64.dmg"
xcrun stapler validate "$APP"
```

Submit the zip (or the DMG) for notarization; **staple the `.app` and the `.dmg`**, which both accept
a stapled ticket. A zip cannot be stapled — build the distribution DMG from the stapled `.app` and
staple the DMG too, so first launch works offline.

On rejection, read the log rather than guessing:

```sh
xcrun notarytool log <submission-id> --apple-id "$APPLE_ID" \
  --team-id "$APPLE_TEAM_ID" --password "$APPLE_APP_SPECIFIC_PASSWORD"
```

The likely first failures are an unsigned nested binary (the addon) or a missing Hardened Runtime
flag on the engine.

Once notarized and stapled, section 6's first-launch workaround becomes unnecessary and should be
removed from the release notes.

---

## 9. CI secrets (not required today)

`.github/workflows/release.yml` builds and drafts the release on a `v*` tag push. Apple signing is
ad-hoc like every other build path, but the workflow **requires one secret**:

| Secret | Contents |
|---|---|
| `TAURI_SIGNING_PRIVATE_KEY` | Contents of the Tauri updater private key (`~/.tauri/orchestrator-updater.key` on the maintainer's machine). Signs the `.app.tar.gz` updater artifact. The matching public key is committed in `tauri.conf.json`. |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | The key's password. Optional — omit if the key has none. |

Without `TAURI_SIGNING_PRIVATE_KEY` the build fails deliberately: a release without signed updater
artifacts would strand every existing install on its current version. If the private key is ever
lost, generate a new pair, ship one manually-installed release with the new public key, and accept
that older installs must update by hand that once.

If Developer ID signing and notarization are wired into the workflow later, it additionally needs:

| Secret | Contents |
|---|---|
| `MACOS_CERTIFICATE` | Developer ID Application certificate exported as base64 `.p12`. |
| `MACOS_CERTIFICATE_PASSWORD` | Password for that `.p12`. |
| `KEYCHAIN_PASSWORD` | Password for the temporary keychain the job creates and deletes. |
| `MACOS_SIGN_IDENTITY` | The identity string, e.g. `Developer ID Application: Name (TEAMID)`. |
| `APPLE_TEAM_ID` | 10-character Team ID. |
| `APPLE_ID` + `APPLE_APP_SPECIFIC_PASSWORD` | Notarization credentials — or, preferred, the App Store Connect API key trio below. |
| `APPLE_API_KEY_ID`, `APPLE_API_ISSUER_ID`, `APPLE_API_KEY` | App Store Connect key for `notarytool --key`. Avoids storing an Apple ID password. |

Runner requirements: macOS with Xcode command line tools, Bun `>= 1.3.14`, and a Rust toolchain
meeting `rust-version = 1.77.2`. The job must import the certificate into a temporary keychain and
delete it in a cleanup step that runs even on failure. Never echo any of these values into logs.

---

## 10. Updates

**The Tauri updater is enabled.** The app checks
`https://github.com/rynitepsd-tech/the-orchestrator/releases/latest/download/latest.json` silently at
startup and every 4 hours. When the feed advertises a newer version, a chip appears in the titlebar;
clicking it downloads the `.app.tar.gz` from the release, verifies its minisign signature, installs,
and offers a restart. Settings → About also has a manual "Check for Updates" button. A failed or
impossible check (no network, no published release yet, dev build) is silent and changes nothing.

How the chain of trust works:

- The updater public key is committed in `tauri.conf.json` (`plugins.updater.pubkey`) and baked into
  the binary at build time — it is **not** fetched from the update channel.
- CI signs the `.app.tar.gz` with the private key (repo secret `TAURI_SIGNING_PRIVATE_KEY`; the
  maintainer's copy lives at `~/.tauri/orchestrator-updater.key`, generated with
  `bunx tauri signer generate`). The updater refuses any payload whose signature does not verify
  against the baked-in key, so a compromised download channel cannot substitute a payload.
- Apple signing remains ad-hoc; the minisign verification above is what authenticates updates.

Release mechanics (all automated in `release.yml`):

- `tauri.conf.json` sets `bundle.createUpdaterArtifacts: true`, so `tauri build` emits
  `The Orchestrator.app.tar.gz` + `.sig` alongside the DMG.
- The workflow composes `latest.json` (version, pub date, `darwin-aarch64` URL + signature) and
  attaches all three to the release.
- The feed URL only resolves for the **latest published** release — a draft release does not update
  anyone. Publishing the draft is the moment the fleet is offered the update.
- Never delete `latest.json`, the `.app.tar.gz`, or the `.sig` from a published release, and never
  re-tag: existing installs poll that exact URL.

Constraints that must hold:

- The app has no telemetry; the update check sends no identifying payload and must never become a
  usage beacon. It fetches a static JSON file, nothing more.
- If the endpoint repo moves, the `endpoints` URL in `tauri.conf.json` must change in a release that
  still ships from the old URL, or existing installs never see the move.

---

## 11. Pre-publish checklist

- [ ] Version identical in `package.json`, `tauri.conf.json`, `Cargo.toml`; `Cargo.lock` updated.
- [ ] OMP pin coherent across the engine dependency, `scripts/build-engine.ts`, and the smoke test.
- [ ] `bun run typecheck` clean.
- [ ] `bun test` — all passing, zero failures.
- [ ] `bun run build:engine` — engine plus matching `.node` present in `resources/engine/`.
- [ ] `bunx tauri build` — `.app` and `.dmg` produced.
- [ ] `file -b` agrees on architecture for the Rust binary and the engine sidecar.
- [ ] `bun run scripts/smoke-packaged.ts` — 25/25, run against the DMG-installed app.
- [ ] `bun run validate:live` — live validation passes against configured providers (optional but
      recommended before a release: primary/advisor/multi-advisor/subagent/resume/concurrent/fork).
- [ ] `shasum -a 256` computed; `SHA256SUMS.txt` written.
- [ ] Release notes state OMP version, architecture, ad-hoc signing, first-launch steps, known gaps.
- [ ] Git tag matches the version; DMG and checksums attached to the GitHub Release.
- [ ] `TAURI_SIGNING_PRIVATE_KEY` secret present in the repo (updater artifact signing).
- [ ] Release has `latest.json`, `.app.tar.gz`, and `.app.tar.gz.sig` attached before publishing —
      publishing is what triggers in-app update offers.
