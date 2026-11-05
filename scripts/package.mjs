#!/usr/bin/env node
// Reproducible packaging for SATURN.
//
//   node scripts/package.mjs --platform win32 --arch x64 [--model Qwen3-4B-Instruct-2507-Q4_K_M.gguf] [--target dir|nsis|zip]
//   node scripts/package.mjs --platform linux --arch x64 --target dir
//
// 1. Stages a clean copy of the app in out/stage-<platform>-<arch>/ (dev node_modules untouched).
// 2. Installs production dependencies there with native binaries for the TARGET platform and the
//    bundled Electron ABI (better-sqlite3 prebuilt for Electron; node-llama-cpp prebuilt
//    CPU/Vulkan/CUDA backends for the target OS).
// 3. Copies the selected GGUF model and licences into extraResources.
// 4. Runs electron-builder on the staged app.
//
// The Windows installer (NSIS) is limited to ~2 GB, smaller than the standard model; see
// installer/saturn.iss (Inno Setup, disk-spanning) and docs/PACKAGING.md for the full release path.
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import crypto from 'node:crypto';

const sha256 = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : d; };
const platform = opt('platform', process.platform);
const arch = opt('arch', 'x64');
const target = opt('target', 'dir');
const model = opt('model', 'Qwen3-4B-Instruct-2507-Q4_K_M.gguf');
const skipModel = args.includes('--no-model');

const NODE_VERSION = opt('node', '22.22.0'); // standalone runtime for the game server (Node ABI 127)
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const electronVersion = JSON.parse(fs.readFileSync(path.join(root, 'node_modules/electron/package.json'), 'utf8')).version;
const stage = path.join(root, 'out', `stage-${platform}-${arch}`);
const sh = (cmd, cwd = stage, env = {}) => { console.log(`$ ${cmd}`); execSync(cmd, { cwd, stdio: 'inherit', env: { ...process.env, ...env } }); };

console.log(`Staging SATURN ${pkg.version} for ${platform}-${arch} (Electron ${electronVersion})`);
fs.rmSync(stage, { recursive: true, force: true });
fs.mkdirSync(stage, { recursive: true });
for (const d of ['src', 'data']) fs.cpSync(path.join(root, d), path.join(stage, d), { recursive: true, filter: (f) => !f.endsWith('.test.js') });
for (const f of ['README.md', 'LICENSE', 'THIRD_PARTY_NOTICES.md']) if (fs.existsSync(path.join(root, f))) fs.copyFileSync(path.join(root, f), path.join(stage, f));

const stagedPkg = {
  name: pkg.name, version: pkg.version, description: pkg.description, main: pkg.main, type: pkg.type, license: pkg.license, author: pkg.author || 'SATURN',
  dependencies: pkg.dependencies,
  devDependencies: { electron: electronVersion },
  build: {
    appId: 'org.saturn.livingworld', productName: 'SATURN', copyright: 'SATURN contributors',
    directories: { output: path.join(root, 'dist', `${platform}-${arch}`) },
    files: ['src/**/*', 'data/**/*', 'package.json', 'node_modules/**/*'],
    asar: false, // native llama.cpp libraries are dlopen()ed by path; asar virtual paths break that

    npmRebuild: false,
    extraResources: [
      // NSIS cannot hold the model (>2 GB): it is shipped beside the installer and copied at install time
      ...(skipModel || target === 'nsis' ? [] : [{ from: path.join(root, 'models', model), to: path.join('models', model) }]),
      ...(fs.existsSync(path.join(root, 'licenses')) ? [{ from: path.join(root, 'licenses'), to: 'licenses' }] : []),
      { from: path.join(root, 'out', `node-${NODE_VERSION}-${platform}-${arch}`), to: 'node' },
    ],
    win: { target: [{ target, arch: [arch] }], signAndEditExecutable: false },
    nsis: { oneClick: false, allowToChangeInstallationDirectory: true, createDesktopShortcut: true, createStartMenuShortcut: true, shortcutName: 'SATURN', include: path.join(root, 'build', 'installer.nsh'), artifactName: 'SATURN-Setup-${version}.${ext}' },
    icon: path.join(root, 'build', 'icon.png'),
    linux: { target: [{ target, arch: [arch] }], category: 'Game' },
  },
};
fs.writeFileSync(path.join(stage, 'package.json'), JSON.stringify(stagedPkg, null, 2));

// Standalone Node runtime for the game server process (see src/app/main.cjs for why).
const nodeDir = path.join(root, 'out', `node-${NODE_VERSION}-${platform}-${arch}`);
if (!fs.existsSync(nodeDir)) {
  fs.mkdirSync(nodeDir, { recursive: true });
  const dist = `https://nodejs.org/dist/v${NODE_VERSION}`;
  const sums = execSync(`curl -fsSL ${dist}/SHASUMS256.txt`).toString();
  const want = (name) => sums.split('\n').find((l) => l.endsWith(`  ${name}`))?.split(' ')[0];
  if (platform === 'win32') {
    const name = `win-${arch}/node.exe`;
    sh(`curl -fsSL -o "${path.join(nodeDir, 'node.exe')}" ${dist}/${name}`, root);
    const got = sha256(path.join(nodeDir, 'node.exe'));
    if (got !== want(name)) throw new Error(`node.exe checksum mismatch`);
  } else {
    const name = `node-v${NODE_VERSION}-${platform}-${arch}.tar.xz`;
    const tmp = path.join(root, 'out', name);
    sh(`curl -fsSL -o "${tmp}" ${dist}/${name}`, root);
    const got = sha256(tmp);
    if (got !== want(name)) throw new Error(`${name} checksum mismatch`);
    sh(`tar -xJf "${tmp}" -C "${nodeDir}" --strip-components=2 node-v${NODE_VERSION}-${platform}-${arch}/bin/node`, root);
  }
  for (const f of ['LICENSE']) try { execSync(`curl -fsSL -o "${path.join(nodeDir, 'NODE_LICENSE.txt')}" https://raw.githubusercontent.com/nodejs/node/v${NODE_VERSION}/${f}`); } catch { /* optional */ }
}

// Production dependencies with native binaries for the target platform + Node ABI.
sh(`npm install --omit=dev --no-audit --no-fund --os=${platform} --cpu=${arch} --ignore-scripts`);
// better-sqlite3: fetch the prebuilt binary for the bundled Node runtime on the target platform
sh(`npx --yes prebuild-install@7 --runtime node --target ${NODE_VERSION} --platform ${platform} --arch ${arch} --tag-prefix v --verbose`, path.join(stage, 'node_modules', 'better-sqlite3'));
// node-llama-cpp ships prebuilt backends as optional packages per platform
const llamaVersion = JSON.parse(fs.readFileSync(path.join(stage, 'node_modules/node-llama-cpp/package.json'), 'utf8')).version;
const backends = platform === 'win32' ? ['win-x64', 'win-x64-vulkan'] : platform === 'linux' ? ['linux-x64'] : [`${platform}-${arch}`];
for (const b of backends) {
  const dir = path.join(stage, 'node_modules', '@node-llama-cpp', b);
  if (fs.existsSync(dir)) continue;
  try { sh(`npm install --no-save --omit=dev --no-audit --no-fund --os=${platform} --cpu=${arch} --ignore-scripts @node-llama-cpp/${b}@${llamaVersion}`); } catch { console.warn(`optional backend ${b} unavailable`); }
}
// electron itself is needed by electron-builder in the stage
sh(`npm install --no-save --no-audit --no-fund --ignore-scripts electron@${electronVersion}`, stage, { ELECTRON_SKIP_BINARY_DOWNLOAD: '1' });
// keep only the inference backends for the target platform (CPU + Vulkan; Vulkan covers NVIDIA, AMD and Intel GPUs)
const keep = new Set(backends);
const nlcDir = path.join(stage, 'node_modules', '@node-llama-cpp');
for (const d of fs.existsSync(nlcDir) ? fs.readdirSync(nlcDir) : []) if (!keep.has(d)) fs.rmSync(path.join(nlcDir, d), { recursive: true, force: true });
// llama.cpp sources are only needed to compile locally; SATURN never compiles at runtime
for (const d of ['llama/llama.cpp', 'llama/gitRelease.bundle']) fs.rmSync(path.join(stage, 'node_modules', 'node-llama-cpp', d), { recursive: true, force: true });
if (!skipModel && !fs.existsSync(path.join(root, 'models', model))) throw new Error(`Model not found: models/${model}. Run scripts/fetch-model.mjs first.`);
const builder = path.join(root, 'node_modules', '.bin', 'electron-builder');
sh(`"${builder}" --projectDir "${stage}" --${platform === 'win32' ? 'win' : platform === 'darwin' ? 'mac' : 'linux'} --${arch} --publish never`, root);
if (target === 'nsis' && !skipModel) {
  // assemble the offline distribution folder: installer + models/<model>.gguf
  const distDir = path.join(root, 'dist', `${platform}-${arch}`);
  const bundle = path.join(distDir, `SATURN-${pkg.version}-offline`);
  fs.rmSync(bundle, { recursive: true, force: true });
  fs.mkdirSync(path.join(bundle, 'models'), { recursive: true });
  fs.copyFileSync(path.join(distDir, `SATURN-Setup-${pkg.version}.exe`), path.join(bundle, `SATURN-Setup-${pkg.version}.exe`));
  fs.linkSync(path.join(root, 'models', model), path.join(bundle, 'models', model));
  fs.writeFileSync(path.join(bundle, 'README.txt'), `SATURN ${pkg.version} — offline installer\r\n\r\nKeep this folder together. Run SATURN-Setup-${pkg.version}.exe; it installs the game and the bundled language model (models\\${model}).\r\nNo internet connection is required or used.\r\n`);
  console.log(`Offline bundle: ${bundle}`);
}
console.log(`\nDone. Output in dist/${platform}-${arch}/`);
