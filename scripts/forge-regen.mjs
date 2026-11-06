#!/usr/bin/env node
// Regenerate one stage (and everything after it) of a recorded world draft with the real model.
//   node scripts/forge-regen.mjs data/forge-samples/floating story "optional feedback"
import fs from 'node:fs';
import { LocalLLM, findModels } from '../src/ai/llm.js';
import { WorldForge } from '../src/forge/forge.js';

const [prefix, stage, ...fb] = process.argv.slice(2);
const draft = JSON.parse(fs.readFileSync(`${prefix}.draft.json`, 'utf8'));
const model = findModels().find((m) => m.profile === 'standard') || findModels()[0];
const llm = new LocalLLM({ modelPath: model.path, contextSize: 8192 });
await llm.load();
const t0 = Date.now();
const forge = new WorldForge({ llm, log: (m) => console.log('  !', m) });
await forge.generate(draft.description, { draft, fromStage: stage, feedback: fb.join(' ') || null, onProgress: (p) => process.stdout.write(`\r[${p.index + 1}/${p.total}] ${p.label}   `) });
console.log(`\nregenerated from "${stage}" in ${Math.round((Date.now() - t0) / 1000)}s`);
fs.writeFileSync(`${prefix}.draft.json`, JSON.stringify(draft, null, 2));
const { spec, report, summary } = WorldForge.compile(draft);
fs.writeFileSync(`${prefix}.spec.json`, JSON.stringify(spec, null, 2));
const rep = JSON.parse(fs.readFileSync(`${prefix}.report.json`, 'utf8'));
rep.report = report;
rep.regenerated = [...(rep.regenerated || []), { stage, feedback: fb.join(' ') || null, seconds: Math.round((Date.now() - t0) / 1000) }];
fs.writeFileSync(`${prefix}.report.json`, JSON.stringify(rep, null, 2));
console.log(`rules: ${summary.rules.join(' | ')}`);
await llm.dispose();
