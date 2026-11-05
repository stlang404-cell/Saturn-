# Packaging the offline Windows build

SATURN ships as a self-contained desktop application: the Electron runtime (window only), a
standalone Node.js runtime (`resources/node`) that runs the game server, the game, the SQLite
engine, the llama.cpp inference backends (CPU and Vulkan) and the language model. The player
installs nothing else, and the game makes no network requests.

### Why two processes
The prebuilt llama.cpp addon crashes when loaded inside Electron's embedded runtime
("Illegal instruction"; reproduced on Linux with Electron 38, both in the main process and in
`ELECTRON_RUN_AS_NODE` mode), while it runs correctly under standard Node 22. SATURN therefore
runs the GameService in a child process on the bundled Node runtime. The Electron main process
talks to it over HTTP on 127.0.0.1 with a per-launch random token; the sandboxed renderer only
talks to the main process over a whitelisted IPC channel. A model crash cannot corrupt the save
(every turn is a transaction) or take down the window.

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
3. downloads the standalone Node runtime (default 22.22.0) for the target, verified against
   nodejs.org's SHASUMS256, and installs the **better-sqlite3 prebuilt for that Node ABI**;
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

Cross-building from Linux works for `--target dir` (verified: correct PE32+ binaries for
SATURN.exe, node.exe, the SQLite addon and the llama.cpp CPU/Vulkan backends; 2.9 GB with the
model). Building the NSIS installer on Linux requires a full 32-bit Wine, which was not
available in the development container; both installers are built natively on Windows. `.github/workflows/windows-release.yml` performs the whole release
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
