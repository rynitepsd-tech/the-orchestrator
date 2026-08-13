# Release Runbook

Operational procedure for cutting a release of The Orchestrator. This document describes what the
repository actually does today, not a target state. Where something is not implemented, it says so.

Scope of a release today: macOS on Apple Silicon, ad-hoc signed, distributed as a DMG attached to a
GitHub Release. There is no auto-updater, no notarization, and no CI release pipeline in this build.

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
- `tauri.conf.json` `"version"` is what names the DMG. At `0.1.0` the bundler produces
  `The Orchestrator_0.1.0_aarch64.dmg`.
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

1. `@oh-my-pi/pi-coding-agent` in the engine package resolves to the pinned version (`17.3.1` at
   time of writing).
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
| `bun test` | Usage de-duplication tests plus the concurrency suite, which drives a local mock provider speaking the OpenAI SSE wire format. No real API credits are spent. | 20 passing. |
| `bun run build:engine` | `bun build --compile` of the engine sidecar into `resources/engine/`, then explicit `codesign`, then copies the native addon beside it. | `orchestrator-engine` (~85 MB) and `pi_natives.darwin-arm64.node` (~136 MB) in `resources/engine/`. |
| `bunx tauri build` | Builds the Vite frontend, compiles the Rust binary, and bundles `resources/engine` into the app as `Contents/Resources/engine`. | `The Orchestrator.app` and `The Orchestrator_<version>_aarch64.dmg` under `apps/desktop/src-tauri/target/release/bundle/`. |
| `bun run scripts/smoke-packaged.ts` | Drives the engine **inside the built app**. | 12/12 checks passed. |

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
mismatch, a bundler-stripped dynamic import, or config discovery that only worked from the repo. It
checks engine architecture against the host, addon presence beside the binary, boot to
`engine.ready`, the reported OMP version, OMP agent-directory discovery, model registry load,
provider resolution from existing credentials, project open, session discovery, shutdown ack, and
clean exit.

It accepts an app path as its first argument, which is how you test a DMG-installed copy:

```sh
bun run scripts/smoke-packaged.ts "/Applications/The Orchestrator.app"
```

Do this at least once per release against the app mounted from the DMG you are about to publish,
not only against the build tree.

> Note: `package.json` exposes `"app": "bun run scripts/build-app.ts"`, and the smoke test's error
> hint mentions `bun run app`, but `scripts/build-app.ts` is not present in the repository. Use
> `cd apps/desktop && bunx tauri build` as given above.

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

Cross-target builds need the matching addon package installed, for example
`bun add -d @oh-my-pi/pi-natives-darwin-x64@17.3.1`. The script fails loudly with that exact hint
when the addon is missing.

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

Because the app is ad-hoc signed and not notarized, first launch is blocked. On current macOS the
user double-clicks the app and gets a dialog saying the app was not opened because Apple could not
verify it is free of malware, with buttons to move it to the Trash or cancel. Nothing in that dialog
opens the app.

Include this in the release notes verbatim:

> **First launch**
>
> 1. Drag **The Orchestrator** to `/Applications`.
> 2. Double-click it. macOS will block it and say it cannot verify the developer. Click **Done** (or
>    **Cancel**) — do not move it to the Trash.
> 3. Open **System Settings → Privacy & Security**, scroll to the Security section. A message names
>    The Orchestrator as blocked. Click **Open Anyway**.
> 4. Authenticate, then confirm **Open Anyway** in the dialog that follows.
>
> You only do this once. The app is ad-hoc signed because the project has no paid Apple Developer
> account; it is not notarized, and Gatekeeper reports that accurately.

**Never instruct users to disable Gatekeeper.** Do not publish `sudo spctl --master-disable`, and do
not recommend blanket `xattr -dr com.apple.quarantine` sweeps as the standard path. Those weaken
system-wide protection permanently to solve a one-time, per-app prompt that "Open Anyway" solves
correctly. The "Open Anyway" flow is the supported mechanism and it is sufficient.

If a user reports that "Open Anyway" does not appear, the usual cause is that they never attempted
the launch — the entry only appears in Privacy & Security after macOS has blocked an attempt.

---

## 7. Checksums and the GitHub Release

Compute SHA-256 over every artifact you publish, from the exact files you are about to upload:

```sh
cd apps/desktop/src-tauri/target/release/bundle/dmg
shasum -a 256 "The Orchestrator_0.1.0_aarch64.dmg" | tee SHA256SUMS.txt
```

Attach to the GitHub Release:

- `The Orchestrator_<version>_aarch64.dmg` — the installer.
- `SHA256SUMS.txt` — checksums for every attached binary artifact.

Put the checksum in the release body as well as in the file, so a reader can verify without
downloading a second artifact. Tell users how to check it:

```sh
shasum -a 256 ~/Downloads/"The Orchestrator_0.1.0_aarch64.dmg"
```

Release body should state, at minimum:

- Version, and the pinned OMP version (`17.3.1`) this build embeds.
- Architecture: Apple Silicon (`aarch64`). Say plainly that Intel is not built or tested, and that
  Windows and Linux are not supported.
- Signing status: ad-hoc signed, not notarized — with the first-launch instructions from section 6.
- SHA-256 of the DMG.
- Known gaps in this build, so nobody discovers them as bugs: no session fork, no GUI provider
  sign-in (users run `omp` once in a terminal to connect a provider), no MCP status surfacing, no
  slash-command completion, no extension UI bridge, no global usage centre, no approval UI bridge,
  and the Changes panel is a placeholder.
- No telemetry, no analytics, no cloud backend, no accounts. Credentials remain in OMP's own store.

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

There is no release workflow in this repository, and **local development and local release builds
require no secrets at all**. If a signed, notarized CI pipeline is added later, it needs:

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

The Tauri updater signing keypair is deliberately absent — see section 10.

---

## 10. Updates

"Check for Updates" queries the GitHub Releases API for this repository and opens the release page
in the user's browser. It reports whether a newer version exists and then hands off; it does not
download, verify, install, or execute anything.

**The Tauri updater is not enabled in this build.** `apps/desktop/src-tauri/Cargo.toml` declares no
`tauri-plugin-updater`, `tauri.conf.json` has no `plugins.updater` block, and the window capability
set grants only `dialog`, `notification`, and `opener:allow-open-url`. There is no update endpoint,
no signing keypair, and no silent-install path. Updating is a deliberate user action: download the
new DMG, verify its checksum, replace the app.

Constraints that must hold for any future change here:

- **Never execute unsigned downloaded code.** An in-app updater is only acceptable once artifacts
  are Developer ID signed and notarized, and the updater verifies a signature it did not fetch from
  the same untrusted channel as the payload.
- Enabling the Tauri updater means adding a signing keypair, a CI secret for the private key, and an
  update manifest per release. Until that whole chain exists, opening the release page is the honest
  behaviour.
- The app has no telemetry; an update check must not become a usage beacon. It is user-initiated
  only.

---

## 11. Pre-publish checklist

- [ ] Version identical in `package.json`, `tauri.conf.json`, `Cargo.toml`; `Cargo.lock` updated.
- [ ] OMP pin coherent across the engine dependency, `scripts/build-engine.ts`, and the smoke test.
- [ ] `bun run typecheck` clean.
- [ ] `bun test` — 20 passing.
- [ ] `bun run build:engine` — engine plus matching `.node` present in `resources/engine/`.
- [ ] `bunx tauri build` — `.app` and `.dmg` produced.
- [ ] `file -b` agrees on architecture for the Rust binary and the engine sidecar.
- [ ] `bun run scripts/smoke-packaged.ts` — 12/12, run against the DMG-installed app.
- [ ] `shasum -a 256` computed; `SHA256SUMS.txt` written.
- [ ] Release notes state OMP version, architecture, ad-hoc signing, first-launch steps, known gaps.
- [ ] Git tag matches the version; DMG and checksums attached to the GitHub Release.
