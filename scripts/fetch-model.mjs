#!/usr/bin/env node
// BUILD-TIME ONLY. Downloads a pinned, licence-verified GGUF model into ./models and
// verifies its SHA-256. The game itself never downloads anything: models are bundled
// into the installer by scripts/package.mjs.
//
//   node scripts/fetch-model.mjs [standard|light|all]
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';

export const PINNED = {
  standard: {
    file: 'Qwen3-4B-Instruct-2507-Q4_K_M.gguf', repo: 'unsloth/Qwen3-4B-Instruct-2507-GGUF', revision: 'a06e946bb6b655725eafa393f4a9745d460374c9',
    sha256: '3605803b982cb64aead44f6c1b2ae36e3acdb41d8e46c8a94c6533bc4c67e597', size: 2497281120, license: 'Apache-2.0', base: 'Qwen/Qwen3-4B-Instruct-2507',
  },
  light: {
    file: 'Qwen3.5-2B-Q4_K_M.gguf', repo: 'unsloth/Qwen3.5-2B-GGUF', revision: 'f6d5376be1edb4d416d56da11e5397a961aca8ae',
    sha256: 'aaf42c8b7c3cab2bf3d69c355048d4a0ee9973d48f16c731c0520ee914699223', size: 1280835840, license: 'Apache-2.0', base: 'Qwen/Qwen3.5-2B',
  },
};

async function sha256(file) {
  const h = crypto.createHash('sha256');
  await pipeline(fs.createReadStream(file), h);
  return h.digest('hex');
}

async function fetchModel(key) {
  const m = PINNED[key];
  const dir = path.resolve('models');
  fs.mkdirSync(dir, { recursive: true });
  const dest = path.join(dir, m.file);
  if (fs.existsSync(dest) && fs.statSync(dest).size === m.size && (await sha256(dest)) === m.sha256) {
    console.log(`${m.file}: present and verified`);
    return dest;
  }
  const url = `https://huggingface.co/${m.repo}/resolve/${m.revision}/${m.file}`;
  console.log(`Downloading ${url}`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  const tmp = `${dest}.part`;
  await pipeline(Readable.fromWeb(res.body), fs.createWriteStream(tmp));
  const got = await sha256(tmp);
  if (got !== m.sha256) { fs.rmSync(tmp); throw new Error(`Checksum mismatch for ${m.file}: ${got}`); }
  fs.renameSync(tmp, dest);
  console.log(`${m.file}: downloaded and verified (${m.license}, base model ${m.base})`);
  return dest;
}

const which = process.argv[2] || 'standard';
for (const k of which === 'all' ? Object.keys(PINNED) : [which]) await fetchModel(k);
