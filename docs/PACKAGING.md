# Packaging the offline Windows build

SATURN ships as a self-contained desktop application: the Electron runtime, the game, the
SQLite engine, the llama.cpp inference backends (CPU and Vulkan) and the language model. The
player installs nothing else, and the game makes no network requests.

## Pipeline

```
npm ci
node scripts/fetch-model.mjs standard          # pinned revision + SHA-256 verified (build machine only)
node scripts/package.mjs --platform win32 --arch x64 --target dir    # dist/win32-x64/win-unpacked (app + model)
```

`scripts/package.mjs`:

1. stages a clean copy of `src/` and `data/` in `out/stage-win32-x64/` (the developer's
   `node_modules` is never touched, so `npm test` keeps working);
2. installs production dependencies for the *target* OS/CPU (`npm install --os=win32 --cpu=x64`);
3. installs the **better-sqlite3 prebuilt for Electron 38 on win32-x64** (`prebuild-install`;
   better-sqlite3 is pinned to 12.11.1 because 13.x does not publish Electron prebuilts);
4. keeps only node-llama-cpp's `win-x64` (CPU) and `win-x64-vulkan` backends and removes the
   llama.cpp sources (SATURN never compiles at runtime; `getLlama({ build: 'never' })`);
5. adds the model and licence texts as extra resources (`resources/models`, `resources/licenses`);
6. runs electron-builder.

At runtime the model is found in `process.resourcesPath/models` (or `SATURN_MODELS`).

## Installers

The standard model is ~2.5 GB. NSIS installers cannot embed payloads above ~2 GB, so there are
two supported formats:

| Format | Command | Result |
|---|---|---|
| **NSIS + model folder** | `node scripts/package.mjs --platform win32 --arch x64 --target nsis` | `dist/win32-x64/SATURN-0.1.0-offline/` containing `SATURN-Setup-0.1.0.exe` and `models/*.gguf`. The installer (with `build/installer.nsh`) copies the model into the install directory and creates desktop and Start-menu shortcuts. Distribute the folder as one zip. |
| **Inno Setup (single installer, disk-spanning)** | build `--target dir`, then on Windows `iscc /DAppVersion=0.1.0 installer\saturn.iss` | `dist/installer/SATURN-Setup-0.1.0.exe` + `.bin` volumes |

Cross-building from Linux works for `dir` and `nsis` (NSIS needs Wine for the uninstaller stub).
Inno Setup runs on Windows. `.github/workflows/windows-release.yml` performs the whole release
on a Windows runner: tests, model fetch, packaging, **smoke tests of the packaged
`SATURN.exe`** (offline-parser path and real-model path), and the Inno Setup installer.

## Offline guarantees

- No code path downloads anything at runtime. Model fetching exists only in
  `scripts/fetch-model.mjs` (build time).
- The Electron session cancels every renderer request that is not `file://`, `data:` or
  `devtools://` (`src/app/main.cjs`), and the UI has a strict Content-Security-Policy.
- node-llama-cpp is invoked with `build: 'never'` so it never attempts to fetch or compile
  binaries.
- `scripts/offline-check.sh` runs a scripted session with the real model inside a Linux
  network namespace with no network (`unshare -n`).

## Hardware profiles

| Profile | Model | Size | Target hardware |
|---|---|---|---|
| light | Qwen3.5-2B Q4_K_M | 1.3 GB | 8 GB RAM, older 4-core CPUs |
| **standard (default, bundled)** | Qwen3-4B-Instruct-2507 Q4_K_M | 2.5 GB | 8–16 GB RAM; any Vulkan GPU recommended |
| high | Qwen3.5-9B Q4_K_M (not bundled) | 5.7 GB | discrete GPU with 8 GB+ VRAM |

The profile is selectable in Settings; GPU offload is automatic (Vulkan) with CPU fallback.
