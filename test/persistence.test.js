import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Game } from '../src/engine/game.js';
import { attach } from '../src/engine/sim.js';
import { executeTurn } from '../src/engine/turn.js';
import { HANDLERS } from '../src/engine/actions.js';
import { openDatabase, SCHEMA_VERSION } from '../src/engine/db.js';
import { GameService } from '../src/service/service.js';
import { newGame, run, assertSound, goTo } from './helpers.js';
import { normalizeInterpretation, blankAction } from '../src/ai/schema.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'saturn-test-'));

function fingerprint(g) {
  return JSON.stringify({
    time: g.time, rng: g.rng.counter, player: g.player(),
    money: g.db.prepare('SELECT id, balance FROM accounts ORDER BY id').all(),
    items: g.db.prepare('SELECT type_id, holder_id, owner_id, quantity FROM items ORDER BY id').all(),
    skills: g.db.prepare('SELECT * FROM skills ORDER BY character_id, skill').all(),
    rels: g.db.prepare('SELECT * FROM relationships ORDER BY from_id, to_id').all(),
    mem: g.db.prepare('SELECT COUNT(*) n FROM memories').get().n,
    contracts: g.db.prepare('SELECT * FROM contracts ORDER BY id').all(),
    know: g.db.prepare('SELECT * FROM knowledge ORDER BY holder_id, fact_id').all(),
  });
}

test('save, close and reopen restores the world exactly', () => {
  const dir = tmp();
  const file = path.join(dir, 'w.saturn');
  const g = attach(Game.create(file, { seed: 5, player: { name: 'Ash', background: 'clerk' } }));
  goTo(g, 'Guildhall of Weights');
  run(g, { type: 'ask_job', target: 'Odile' });
  run(g, { type: 'work' });
  run(g, { type: 'study', skill: 'commerce', hours: 4 });
  run(g, { type: 'wait', hours: 50 });
  const fp = fingerprint(g);
  g.close();
  const g2 = attach(Game.open(file));
  assert.equal(fingerprint(g2), fp);
  // and the reopened world keeps simulating deterministically from the same counter
  run(g2, { type: 'wait', hours: 24 });
  assertSound(null, g2);
  g2.close();
});

test('a crash in the middle of a turn leaves no half-committed changes', () => {
  const g = newGame();
  const before = fingerprint(g);
  const original = HANDLERS.buy;
  HANDLERS.buy = (game, p) => {
    original(game, p); // money and bread move...
    throw new Error('simulated power loss during commit'); // ...then the process dies
  };
  const interp = normalizeInterpretation({ mode: 'act', intent: 'x', actions: [{ ...blankAction('buy'), target: 'Mirela', item: 'bread', quantity: 2 }], plan_title: null, risks: [], question: null, reason: null }).value;
  assert.throws(() => executeTurn(g, { input: 'buy bread', interp, source: 'test' }), /power loss/);
  HANDLERS.buy = original;
  const after = fingerprint(g);
  assert.equal(after, before, 'state identical after aborted turn');
  assert.equal(g.db.prepare("SELECT status FROM turns ORDER BY id DESC LIMIT 1").get().status, 'aborted');
  assertSound(null, g);
});

test('a blocked action rolls back alone while earlier actions in the turn stand', () => {
  const g = newGame();
  const r = run(g, { type: 'buy', target: 'Mirela', item: 'bread', quantity: 1 }, { type: 'buy', target: 'Mirela', item: 'meal', quantity: 500 });
  assert.equal(r.outcomes[0].status, 'done');
  assert.equal(r.outcomes[1].status, 'blocked');
  assert.equal(g.count('player', 'bread'), 1);
  assertSound(null, g);
});

test('save files from a newer version are refused; current version is recorded', () => {
  const dir = tmp();
  const file = path.join(dir, 'w.saturn');
  const g = Game.create(file, { seed: 1 });
  g.close();
  const db = openDatabase(file);
  assert.equal(db.pragma('user_version', { simple: true }), SCHEMA_VERSION);
  db.pragma(`user_version = ${SCHEMA_VERSION + 5}`);
  db.close();
  assert.throws(() => openDatabase(file), /newer SATURN/);
});

test('service: new game, autosave rotation, backups, export/import, integrity', async () => {
  const home = tmp();
  const svc = new GameService({ dataDir: home, aiEnabled: false, log: () => {} });
  const { id } = svc.newGame({ name: 'Rook', background: 'dockhand', seed: 9 });
  for (let i = 0; i < 20; i++) await svc.act(i % 2 ? 'wait 1 hour' : 'look');
  await new Promise((r) => setTimeout(r, 300));
  const backups = svc.listSnapshots();
  assert.ok(backups.length >= 2 && backups.length <= 6, `rotating backups: ${backups.length}`);
  const integ = svc.integrity();
  assert.equal(integ.sqlite, 'ok');
  assert.deepEqual(integ.ledger, []);
  assert.deepEqual(integ.items, []);
  const exportFile = path.join(home, 'export.saturn');
  await svc.exportSave(exportFile);
  const imported = svc.importSave(exportFile);
  const loaded = svc.loadGame(imported.id);
  assert.equal(loaded.state.player.name, 'Rook');
  // restore a backup
  const r = svc.restoreSnapshot(imported.id === id ? id : id, backups[0].name);
  assert.ok(r.state);
  assert.throws(() => svc.importSave(path.join(home, 'settings.json')), /./);
  svc.closeGame();
});

test('reload after a long campaign: 2 years of world time, memory bounded, everything consistent', () => {
  const dir = tmp();
  const file = path.join(dir, 'long.saturn');
  const g = attach(Game.create(file, { seed: 11, player: { name: 'Lark', background: 'herbalist' } }));
  const t0 = Date.now();
  for (let i = 0; i < 106; i++) {
    if (g.char('npc_mirela').location_id === g.player().location_id) run(g, { type: 'talk', target: 'Mirela', approach: 'chat', detail: `week ${i}` });
    run(g, { type: 'wait', hours: 24 * 7 });
  }
  console.log(`# 2 simulated years in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  assertSound(null, g);
  const cal = g.calendar();
  assert.ok(cal.year >= 414, `year ${cal.year}`);
  const mem = g.db.prepare('SELECT COUNT(*) n FROM memories').get().n;
  assert.ok(mem < 5000, `memory rows bounded: ${mem}`);
  const fp = fingerprint(g);
  g.close();
  const g2 = attach(Game.open(file));
  assert.equal(fingerprint(g2), fp);
  g2.close();
});
