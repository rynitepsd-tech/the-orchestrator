# Third-Party Notices

The Orchestrator is distributed under the MIT licence (see [LICENSE](LICENSE)). The
distributed application — `The Orchestrator.app`, packaged as
`The Orchestrator_0.1.0_aarch64.dmg` — is not composed solely of Orchestrator source.
It bundles third-party software, chiefly OhMyPi (OMP), the Bun runtime, and a native
Rust addon, all compiled into or copied alongside the shipped engine binary.

These notices cover the components that are redistributed inside the `.app`, plus the
build-time toolchain used to produce it. Nothing is downloaded at runtime: every
third-party component listed as *bundled* is present in the application bundle at
install time.

Related documents: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md),
[docs/OMP_COMPATIBILITY.md](docs/OMP_COMPATIBILITY.md),
[docs/USAGE_MODEL.md](docs/USAGE_MODEL.md).

---

## 1. OhMyPi (OMP)

The Orchestrator is a harness around OhMyPi. OMP does the agent work; The Orchestrator
supervises processes, routes a protocol, and draws a user interface. OMP is embedded
via the published npm SDK, not vendored source and not a fork.

- Project: OhMyPi (OMP)
- Upstream: <https://github.com/can1357/oh-my-pi>
- Version embedded: **18.1.1**
- Licence: MIT
- Copyright (c) 2025 Mario Zechner
- Copyright (c) 2025-2026 Can Bölük
- Copyright (c) 2026 Stencil Labs, Inc.

The direct dependency is `@oh-my-pi/pi-coding-agent@18.1.1`. That package pulls in
sibling packages from the same upstream project and the same release train, all at
version 18.1.1 and all under the same MIT licence. The set resolved for this build is:

| Package | Version |
| --- | --- |
| `@oh-my-pi/pi-coding-agent` | 18.1.1 |
| `@oh-my-pi/pi-agent-core` | 18.1.1 |
| `@oh-my-pi/pi-ai` | 18.1.1 |
| `@oh-my-pi/pi-catalog` | 18.1.1 |
| `@oh-my-pi/pi-mnemopi` | 18.1.1 |
| `@oh-my-pi/pi-tui` | 18.1.1 |
| `@oh-my-pi/pi-utils` | 18.1.1 |
| `@oh-my-pi/pi-wire` | 18.1.1 |
| `@oh-my-pi/omptype` | 18.1.1 |
| `@oh-my-pi/omp-stats` | 18.1.1 |
| `@oh-my-pi/hashline` | 18.1.1 |
| `@oh-my-pi/snapcompact` | 18.1.1 |
| `@oh-my-pi/pi-natives` | 18.1.1 |
| `@oh-my-pi/pi-natives-darwin-arm64` | 18.1.1 |

Because this code is redistributed inside the `.app`, the full licence text is
reproduced below.

```
MIT License

Copyright (c) 2025 Mario Zechner
Copyright (c) 2025-2026 Can Bölük
Copyright (c) 2026 Stencil Labs, Inc.

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

### 1.1 pi-natives (Rust N-API addon)

OMP ships a compiled Rust N-API addon. On Apple Silicon this is
`pi_natives.darwin-arm64.node` (approximately 155 MB), taken from
`@oh-my-pi/pi-natives-darwin-arm64@18.1.1`. It is published by the same upstream
project under the same MIT licence. Its own `LICENSE` names two of the three
holders above — Copyright (c) 2025-2026 Can Bölük and Copyright (c) 2026
Stencil Labs, Inc. — and that notice is reproduced by the MIT text above.

The addon is copied into the application bundle and **must sit in the same directory as
the engine binary**, because the addon loader's final search path is the executable's
own directory. It is not fetched at runtime.

---

## 2. Bun runtime

The Orchestrator engine is produced with `bun build --compile`, which emits a
single-file executable of roughly 85 MB. That executable statically contains the Bun
runtime, so Bun is redistributed as part of the shipped application.

- Project: Bun
- Publisher: Oven
- Upstream: <https://github.com/oven-sh/bun>
- Licence: MIT

Bun is also the development toolchain: the repository is a Bun workspace and OMP
requires Bun >= 1.3.14.

---

## 3. Direct dependencies

"Bundled" means the component's code is present in the distributed `.app`.
"Build-time only" means it is used to produce the app but is not shipped inside it.

| Component | Licence | Shipped in the `.app`? |
| --- | --- | --- |
| `@oh-my-pi/pi-coding-agent` and siblings (18.1.1) | MIT | Bundled — compiled into the engine binary |
| `@oh-my-pi/pi-natives-darwin-arm64` (18.1.1) | MIT | Bundled — `.node` addon beside the engine binary |
| Bun runtime (Oven) | MIT | Bundled — inside the `bun --compile` executable |
| `@tauri-apps/api` | Apache-2.0 OR MIT | Bundled — in the built frontend |
| `@tauri-apps/plugin-dialog` | Apache-2.0 OR MIT | Bundled |
| `@tauri-apps/plugin-notification` | Apache-2.0 OR MIT | Bundled |
| `@tauri-apps/plugin-opener` | Apache-2.0 OR MIT | Bundled |
| Tauri 2 Rust crates (`tauri`, plugin crates, and their dependency tree) | Apache-2.0 OR MIT | Bundled — linked into the native binary |
| `env_logger` / `log` | Apache-2.0 OR MIT | Bundled — linked into the native binary |
| `react` | MIT | Bundled — in the built frontend |
| `react-dom` | MIT | Bundled — in the built frontend |
| `zustand` | MIT | Bundled — in the built frontend |
| `@tauri-apps/cli` | Apache-2.0 OR MIT | Build-time only |
| `vite` and `@vitejs/plugin-react` | MIT | Build-time only |
| `typescript` | Apache-2.0 | Build-time only |
| `@biomejs/biome` | MIT OR Apache-2.0 | Build-time only |
| `@types/react`, `@types/react-dom`, `@types/bun` | MIT (DefinitelyTyped) | Build-time only — type declarations, no runtime code |

Where a licence is expressed as a choice ("Apache-2.0 OR MIT"), The Orchestrator makes
no election on the recipient's behalf; either licence may be relied upon under its own
terms.

The Rust crate graph pulled in by Tauri 2 is large and is resolved by Cargo at build
time. It is predominantly Apache-2.0 OR MIT dual-licensed, with some MIT-only and
BSD-family crates. The authoritative list for any given build is the resolved
`Cargo.lock` in `apps/desktop/src-tauri`, and the resolved JavaScript graph is
`bun.lock` at the repository root.

Three modules are deliberately excluded from the compiled engine via
`--external omp-legacy-pi-modules`, `--external fastembed` and
`--external onnxruntime-node`; their code is therefore not redistributed in the `.app`.

---

## 4. Platform scope

The only artifacts built and tested today are Apple Silicon (`aarch64`):
`The Orchestrator_0.1.0_aarch64.dmg` and `The Orchestrator.app`. The build script
accepts `--target=x64` for Intel, but no Intel artifact has been built or tested, and
the corresponding `@oh-my-pi/pi-natives-darwin-x64` addon has not been exercised.
Windows and Linux are not supported, and the Linux and Windows `pi-natives` packages
present in the lockfile are not redistributed.

Distributed builds are ad-hoc signed (`codesign --sign -`); the maintainer has no paid
Apple Developer account.

---

## 5. Trademarks and branding

The Orchestrator uses original branding: its own name, icon, and interface design. It
is an **unofficial** harness and is not affiliated with, endorsed by, or sponsored by
the OhMyPi project or its authors, by OpenAI, or by Anthropic.

The application bundle contains no OhMyPi, OpenAI, or Anthropic logos, wordmarks as
brand assets, or other trademarked imagery. Provider and model names appear in the
interface only as factual identifiers of the services a user has connected through
OMP's own credential store. No such reference implies endorsement.

The names "OhMyPi", "OMP", "Bun", "Tauri", "React", "OpenAI" and "Anthropic" are the
property of their respective owners and are used here nominatively, for identification.

---

## 6. Corrections

If an attribution here is incomplete or incorrect, please open an issue against this
repository. Licence and copyright statements were taken from the published package
metadata and upstream repositories at the time of the 0.1.0 build.
