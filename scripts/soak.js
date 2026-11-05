// Long-campaign soak test: a scripted "player" takes thousands of varied actions
// through the deterministic interpreter while the world simulates. Verifies integrity
// continuously and reports timing and storage growth.
//   node scripts/soak.js [turns=2000] [seed=1]
import { Game } from '../src/engine/game.js';
import { attach } from '../src/engine/sim.js';
import { executeTurn } from '../src/engine/turn.js';
import { fallbackInterpret } from '../src/ai/fallback-parser.js';
import { normalizeInterpretation } from '../src/ai/schema.js';
import { reconcile } from '../src/engine/ledger.js';
import { conservationCheck } from '../src/engine/inventory.js';
import { AuditRng } from '../src/engine/rng.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TURNS = Number(process.argv[2] || 2000);
const seed = Number(process.argv[3] || 1);
const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'saturn-soak-')), 'soak.saturn');
const g = attach(Game.create(file, { seed, player: { name: 'Soak', background: 'dockhand' } }));
const r = new AuditRng(seed * 7919);
const places = ['the square', 'the inn', 'the docks', 'the guild', 'the archive', 'the forge', 'the temple', 'the hall', 'the narrows', 'the mill', 'the fields', 'the whisperwood'];
const verbs = [
  () => `go to ${r.pick(places)}`, () => 'look', () => 'eat', () => 'work', () => 'ask for work',
  () => `talk to ${r.pick(g.charactersAt(g.player().location_id).filter((c) => c.kind === 'npc').map((c) => c.name.split(' ')[0])) || 'nobody'}`,
  () => `ask ${r.pick(g.charactersAt(g.player().location_id).filter((c) => c.kind === 'npc').map((c) => c.name.split(' ')[0])) || 'nobody'} about ${r.pick(['grain', 'salt', 'the mayor', 'the observatory', 'work', 'Odile'])}`,
  () => `buy ${r.int(1, 3)} ${r.pick(['bread', 'salt', 'ale', 'fish', 'rope'])}`, () => `sell 1 ${r.pick(['salt', 'fish', 'bread', 'silverleaf'])}`,
  () => 'gather silverleaf', () => `train ${r.pick(['athletics', 'stealth', 'melee'])} for 2 hours`, () => `study ${r.pick(['commerce', 'medicine', 'scholarship'])} for 3 hours`,
  () => 'investigate', () => `rest for ${r.int(4, 9)} hours`, () => `wait ${r.int(1, 12)} hours`,
  () => `steal ${r.pick(['money', 'bread', 'salt'])} from ${r.pick(g.charactersAt(g.player().location_id).filter((c) => c.kind === 'npc').map((c) => c.name.split(' ')[0])) || 'nobody'}`,
];
const t0 = Date.now();
let lastBlockedEat = false;
let stall = 0, lastTime = -1;
const stats = { done: 0, failed: 0, blocked: 0, clarify: 0, maxMs: 0 };
for (let i = 1; i <= TURNS; i++) {
  if (!g.player().alive) { console.log(`player died at turn ${i}`); break; }
  const p = g.player();
  const hungry = g.time - p.last_meal > 20 * 60;
  stall = g.time === lastTime ? stall + 1 : 0;
  lastTime = g.time;
  const text = stall >= 4 ? 'wait 12 hours' : lastBlockedEat ? (g.balance('player') >= 3 ? 'go to the inn' : 'rest for 8 hours') : hungry ? (g.balance('player') < 3 ? (p.location_id === 'bm_temple' ? 'eat' : 'go to the temple') : 'eat') : p.fatigue > 85 ? 'rest for 8 hours' : r.pick(verbs)();
  const n = normalizeInterpretation(fallbackInterpret(text));
  if (!n.ok || !['act', 'plan'].includes(n.value.mode)) { stats.clarify++; continue; }
  const ts = Date.now();
  const res = executeTurn(g, { input: text, interp: n.value, source: 'soak' });
  stats.maxMs = Math.max(stats.maxMs, Date.now() - ts);
  for (const o of res.outcomes) stats[o.status] = (stats[o.status] || 0) + 1;
  lastBlockedEat = text === 'eat' && res.outcomes[0]?.status === 'blocked';
  if (i % 500 === 0) {
    const problems = [...reconcile(g.db), ...conservationCheck(g.db)];
    const size = fs.statSync(file).size + (fs.existsSync(file + '-wal') ? fs.statSync(file + '-wal').size : 0);
    console.log(`turn ${i}: ${g.calendar().short} y${g.calendar().year} · money ${g.balance('player')} · memories ${g.db.prepare('SELECT COUNT(*) n FROM memories').get().n} · events ${g.db.prepare('SELECT COUNT(*) n FROM events').get().n} · db ${(size / 1e6).toFixed(1)} MB · rss ${(process.memoryUsage().rss / 1e6).toFixed(0)} MB · problems ${problems.length}`);
    if (problems.length) { console.error(problems.slice(0, 5)); process.exit(1); }
  }
}
console.log(JSON.stringify({ turns: TURNS, seconds: (Date.now() - t0) / 1000, ...stats, integrity: g.db.pragma('integrity_check', { simple: true }) }));
g.close();
