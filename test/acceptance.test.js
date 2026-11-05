// End-to-end acceptance scenario (directive §17), run against the real engine with the
// deterministic interpreter so it is reproducible. The same scenario with the local
// model is exercised by scripts/acceptance-ai.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Game } from '../src/engine/game.js';
import { attach } from '../src/engine/sim.js';
import { retrieveMemories } from '../src/engine/memory.js';
import { reconcile, moneySupply } from '../src/engine/ledger.js';
import { conservationCheck } from '../src/engine/inventory.js';
import { run, say, goTo, waitUntilHour } from './helpers.js';

test('acceptance: from newcomer to merchant venture, across a save and reload', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'saturn-accept-'));
  const file = path.join(dir, 'world.saturn');
  const g = attach(Game.create(file, { seed: 2026, player: { name: 'Wren', background: 'clerk' } }));
  const start = g.balance('player');
  assert.ok(start < 40, 'modest starting resources');

  // 1. Meet a merchant and negotiate employment
  assert.ok(say(g, 'go to the guild').parsed);
  const met = say(g, 'talk to Odile');
  assert.equal(met.outcomes[0].status, 'done');
  const hired = say(g, 'ask Odile for work');
  assert.equal(hired.outcomes[0].status, 'done');
  assert.ok(g.db.prepare("SELECT 1 FROM contracts WHERE kind='employment' AND party_a='npc_odile' AND status='active'").get());

  // 2. Earn money through shifts
  for (let day = 0; day < 5; day++) {
    waitUntilHour(g, 8);
    if (g.player().location_id !== 'bm_guild') goTo(g, 'Guildhall of Weights');
    say(g, 'work');
    run(g, { type: 'eat' });
  }
  const earned = g.db.prepare("SELECT SUM(e.amount) s FROM ledger_entries e JOIN ledger_tx t ON t.id=e.tx_id WHERE e.account_id='player' AND t.kind='wage'").get().s;
  assert.ok(earned >= 10, `earned ${earned} in wages`);

  // 3. Purchase equipment
  goTo(g, "Hale's Forge");
  const bought = say(g, 'buy a lantern from Brannoc');
  assert.equal(bought.outcomes[0].status, 'done', bought.outcomes[0].error?.message);
  assert.equal(g.count('player', 'lantern'), 1);

  // 4. Begin studying a skill (reading room at the archive)
  goTo(g, 'Ringwatch Archive');
  waitUntilHour(g, 9);
  const st = say(g, 'study commerce for 4 hours');
  assert.equal(st.outcomes[0].status, 'done', st.outcomes[0].error?.message);
  assert.ok(st.changes.skills.some((s) => s.skill === 'commerce' && s.xp > 0));

  // 5. An ambitious venture: borrow, found a trading company, bring in a partner
  goTo(g, 'Guildhall of Weights');
  waitUntilHour(g, 10);
  g.db.prepare("UPDATE skills SET rank=6, xp=360 WHERE character_id='player' AND skill='negotiation'").run();
  let loan = null;
  for (let i = 0; i < 4 && !loan; i++) {
    const r = say(g, 'borrow 90 marks from Aurel');
    if (r.outcomes[0].status === 'done') loan = r;
  }
  assert.ok(loan, 'secured a loan');
  // the riverside storehouse is let by the guildmaster, who is here
  const founded = run(g, { type: 'found_business', item: 'trading company for salt', price: 30 });
  assert.equal(founded.outcomes[0].status, 'done', founded.outcomes[0].error?.message);
  const biz = g.db.prepare('SELECT * FROM businesses').get();
  assert.equal(JSON.parse(biz.data).commodity, 'salt');
  // the merchant's interests: Odile invests in trading companies if persuaded
  g.db.prepare("UPDATE skills SET rank=6, xp=360 WHERE character_id='player' AND skill='persuasion'").run();
  if (g.char('npc_odile').location_id !== g.player().location_id) goTo(g, g.location(g.char('npc_odile').location_id).name);
  let pitched = null;
  for (let i = 0; i < 3 && !pitched; i++) { const r = run(g, { type: 'invest', target: 'Odile' }); if (r.outcomes[0].status === 'done') pitched = r; }

  // 6. The merchant remembers
  const mem = retrieveMemories(g.db, { ownerId: 'npc_odile', now: g.time, text: 'work clerk', participants: ['player'] });
  assert.ok(mem.memories.length > 0);
  assert.ok(mem.memories.some((m) => /Wren/.test(m.summary)));

  // 7. Records are exact
  assert.deepEqual(reconcile(g.db), []);
  assert.deepEqual(conservationCheck(g.db), []);

  // 8. Knowledge boundaries: anyone who remembers the founding has a legitimate source
  const bizMem = g.db.prepare("SELECT owner_id, source FROM memories m JOIN events e ON e.id=m.event_id WHERE e.kind='business_founded'").all();
  for (const m of bizMem) assert.ok(['experienced', 'witnessed', 'hearsay'].includes(m.source), JSON.stringify(m));
  const corvinKnows = bizMem.some((m) => m.owner_id === 'npc_corvin');
  assert.equal(corvinKnows, g.db.prepare("SELECT 1 FROM memories m JOIN events e ON e.id=m.event_id WHERE e.kind='business_founded' AND m.owner_id='npc_corvin'").get() != null);

  // 9. Time passes; the business and world evolve
  const before = JSON.parse(g.db.prepare('SELECT data FROM businesses WHERE id=?').get(biz.id).data);
  for (let i = 0; i < 14; i++) run(g, { type: 'wait', hours: 24 });
  const after = JSON.parse(g.db.prepare('SELECT data FROM businesses WHERE id=?').get(biz.id).data);
  assert.ok(after.stats.days > before.stats.days);
  assert.ok(after.stats.revenue > 0 || after.stats.costs > before.stats.costs, 'the business traded');
  const supply = moneySupply(g.db);

  // 10. Save, exit, relaunch, resume
  const snap = {
    money: g.balance('player'), skills: g.db.prepare("SELECT * FROM skills WHERE character_id='player' ORDER BY skill").all(),
    items: g.held('player').map((i) => [i.type_id, i.quantity]), contracts: g.db.prepare('SELECT id, status FROM contracts ORDER BY id').all(),
    mem: g.db.prepare("SELECT COUNT(*) n FROM memories WHERE owner_id='npc_odile'").get().n, time: g.time, biz: g.balance(biz.id),
  };
  g.close();
  const g2 = attach(Game.open(file));
  assert.equal(g2.balance('player'), snap.money);
  assert.deepEqual(g2.db.prepare("SELECT * FROM skills WHERE character_id='player' ORDER BY skill").all(), snap.skills);
  assert.deepEqual(g2.held('player').map((i) => [i.type_id, i.quantity]), snap.items);
  assert.deepEqual(g2.db.prepare('SELECT id, status FROM contracts ORDER BY id').all(), snap.contracts);
  assert.equal(g2.db.prepare("SELECT COUNT(*) n FROM memories WHERE owner_id='npc_odile'").get().n, snap.mem);
  assert.equal(g2.time, snap.time);
  assert.equal(g2.balance(biz.id), snap.biz);
  assert.equal(moneySupply(g2.db), supply);

  // 11. An unexpected creative action is resolved within bounds: no invented money or items
  const m0 = g2.balance('player');
  const items0 = JSON.stringify(g2.held('player').map((i) => [i.type_id, i.quantity]));
  const odd = run(g2, { type: 'attempt', skill: 'persuasion', difficulty: 'hard', detail: 'compose a ballad about the Great Ring to win over the dockhands' });
  assert.notEqual(odd.outcomes[0].status, 'blocked');
  assert.equal(odd.outcomes[0].rolls.length, 1);
  assert.equal(g2.balance('player'), m0);
  assert.equal(JSON.stringify(g2.held('player').map((i) => [i.type_id, i.quantity])), items0);
  assert.deepEqual(reconcile(g2.db), []);
  g2.close();
  void pitched;
});
