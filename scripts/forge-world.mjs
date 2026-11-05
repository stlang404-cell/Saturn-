#!/usr/bin/env node
// Generate a world from a description with the real local model, compile and validate it.
//   node scripts/forge-world.mjs <out-prefix> "<description>"
// Writes <out-prefix>.draft.json (raw AI draft), <out-prefix>.spec.json (compiled spec) and
// <out-prefix>.report.json (timings, repairs, approximations).
import fs from 'node:fs';
import path from 'node:path';
import { LocalLLM, findModels, MODEL_PROFILES } from '../src/ai/llm.js';
import { WorldForge } from '../src/forge/forge.js';

const [out, ...rest] = process.argv.slice(2);
const description = rest.join(' ');
if (!out || !description) { console.error('usage: forge-world.mjs <out-prefix> "<description>"'); process.exit(2); }
const profile = MODEL_PROFILES.find((p) => p.id === (process.env.SATURN_PROFILE || 'standard'));
const model = findModels().find((m) => m.file === profile.file) || findModels()[0];
const llm = new LocalLLM({ modelPath: model.path, contextSize: 8192 });
const t0 = Date.now();
await llm.load();
console.log(`model ${model.file} loaded in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
const forge = new WorldForge({ llm, log: (m) => console.log('  !', m) });
let last = '';
const t1 = Date.now();
const draft = await forge.generate(description, {
  onProgress: (p) => { if (p.stage !== last) { last = p.stage; console.log(`[${p.index + 1}/${p.total}] ${p.label} (${((Date.now() - t1) / 1000).toFixed(0)}s)`); } },
});
const genMs = Date.now() - t1;
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(`${out}.draft.json`, JSON.stringify(draft, null, 2));
const { spec, report, summary } = WorldForge.compile(draft);
fs.writeFileSync(`${out}.spec.json`, JSON.stringify(spec, null, 2));
fs.writeFileSync(`${out}.report.json`, JSON.stringify({ model: model.file, generation_seconds: Math.round(genMs / 1000), timings: draft._timings, report }, null, 2));
console.log(`\n${summary.name} — ${summary.tagline}\n${summary.premise}`);
console.log(`skills: ${summary.skills.map((s) => s.label).join(', ')}`);
console.log(`places: ${summary.places.map((p) => p.name).join(', ')}`);
console.log(`people: ${summary.people.join('; ')}`);
console.log(`rules: ${summary.rules.join(' | ')}`);
console.log(`repairs: ${report.repairs.length}, approximations: ${report.approximations.length}, warnings: ${report.warnings.length}`);
console.log(`generated in ${(genMs / 1000).toFixed(0)}s`);
await llm.dispose();
