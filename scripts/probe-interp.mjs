#!/usr/bin/env node
// Times one LLM interpretation on a given world spec (diagnostic).
//   node scripts/probe-interp.mjs data/forge-samples/floating.spec.json "I look around."
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { GameService } from '../src/service/service.js';
const [specPath, ...t] = process.argv.slice(2);
const svc = new GameService({ dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'saturn-probe-')), log: (m) => console.log('  log:', m) });
await svc.startAI();
const ref = specPath ? svc.saveWorldSpec(JSON.parse(fs.readFileSync(specPath, 'utf8'))).ref : 'bundled:saltwind';
const bg = svc.creationOptions(ref).backgrounds[0];
svc.newGame({ name: 'Ren', background: bg.id, worldRef: ref, seed: 16 });
const sys = svc.gm._prompt(svc.game, 'i');
console.log('system prompt chars:', sys.length);
let n = 0; const t0 = Date.now(); let first = 0;
const r = await svc.gm.interpret(svc.game, t.join(' ') || 'I look around and take in where I am.', { onProgress: () => { if (!n++) first = Date.now() - t0; } });
console.log(`first token ${first}ms, total ${Date.now() - t0}ms, tokens ${n}`, JSON.stringify(r).slice(0, 400));
await svc.stopAI();
