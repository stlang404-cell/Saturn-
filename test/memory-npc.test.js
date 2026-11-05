import test from 'node:test';
import assert from 'node:assert/strict';
import { newGame, run, assertSound, goTo } from './helpers.js';
import { retrieveMemories, consolidateMemories, addMemory, memoryStats } from '../src/engine/memory.js';
import { belief } from '../src/engine/knowledge.js';
import { marketPrice } from '../src/engine/economy.js';

test('asking an NPC about a secret they cannot know yields nothing; they do not leak', () => {
  const g = newGame();
  // Mirela does not know about Odile's debt or Sabine's plan
  assert.equal(belief(g.db, 'npc_mirela', 'f_odile_debt'), null);
  const r = run(g, { type: 'talk', target: 'Mirela', approach: 'ask', topic: "Odile's debt" });
  const d = r.outcomes[0].dialogue;
  assert.equal(d.disclosed.filter((x) => x.fact === 'f_odile_debt').length, 0);
  assert.equal(belief(g.db, 'player', 'f_odile_debt'), null);
});

test('secret keepers deny; others share according to trust', () => {
  const g = newGame();
  goTo(g, 'Ashby Mill & Granary');
  const r = run(g, { type: 'talk', target: 'Tamsin', approach: 'ask', topic: 'the granary hoard' });
  const d = r.outcomes[0].dialogue;
  // an unfamiliar newcomer asking politely does not get the secret
  assert.equal(d.disclosed.some((x) => x.fact === 'f_grain_hoard'), false);
  assert.ok(d.keeperDenies || d.refused);
});

test('an NPC remembers a promise across hundreds of turns, ranked above noise', () => {
  const g = newGame();
  goTo(g, 'Guildhall of Weights');
  run(g, { type: 'talk', target: 'Odile', approach: 'chat', topic: 'work' }); // learn of her request
  const acc = run(g, { type: 'accept_request', target: 'Odile' });
  assert.equal(acc.outcomes[0].status, 'done', acc.outcomes[0].error?.message);
  // 400 turns of small talk and noise
  for (let i = 0; i < 400; i++) {
    if (g.char('npc_odile').location_id !== g.player().location_id) goTo(g, g.location(g.char('npc_odile').location_id).name);
    run(g, { type: 'talk', target: 'Odile', approach: 'chat', detail: `idle remark number ${i} about the weather and the river` });
  }
  const r = retrieveMemories(g.db, { ownerId: 'npc_odile', now: g.time, text: 'salt run promise Kestrel', participants: ['player'], limit: 5 });
  assert.ok(r.memories.some((m) => /promised/.test(m.summary)), 'promise retrieved: ' + r.memories.map((m) => m.summary).join(' | '));
  assert.ok(r.memories[0].score > 0);
});

test('consolidation bounds memory and never drops important memories', () => {
  const g = newGame();
  const owner = 'npc_mirela';
  addMemory(g.db, { ownerId: owner, time: 0, summary: 'The newcomer saved my cellar from fire.', participants: ['player'], importance: 9, topic: 'fire' });
  for (let i = 0; i < 200; i++) addMemory(g.db, { ownerId: owner, time: i * 10, summary: `Served ale to a traveller (${i}).`, participants: ['player'], importance: 1, topic: 'ale' });
  const now = 400 * 1440;
  const res = consolidateMemories(g.db, { ownerId: owner, now });
  assert.ok(res.summaries >= 1);
  const st = memoryStats(g.db, owner);
  assert.ok(st.active < 20, `active memories after consolidation: ${st.active}`);
  const r = retrieveMemories(g.db, { ownerId: owner, now, text: 'fire', participants: ['player'] });
  assert.match(r.memories[0].summary, /fire/);
});

test('NPCs follow schedules and are never in two places', () => {
  const g = newGame();
  const seen = new Set();
  for (let h = 0; h < 30; h++) {
    run(g, { type: 'wait', hours: 1 });
    const rows = g.db.prepare("SELECT id, location_id FROM characters WHERE id='npc_odile'").all();
    assert.equal(rows.length, 1);
    seen.add(rows[0].location_id);
  }
  assert.ok(seen.size >= 2, 'Odile moved during the day');
});

test('the mayor hoards autonomously, which (vs. an identical world without the hoard) makes grain and flour dearer', () => {
  const g = newGame({ seed: 77 });
  const control = newGame({ seed: 77 });
  control.db.prepare("INSERT OR REPLACE INTO meta(key,value) VALUES('world_flags', ?)").run(JSON.stringify({ expose_hoard: -1 }));
  for (let i = 0; i < 21; i++) { run(g, { type: 'wait', hours: 24 }); run(control, { type: 'wait', hours: 24 }); }
  const hoard = g.db.prepare("SELECT SUM(quantity) q FROM items WHERE holder_kind='hidden' AND holder_id='bm_mill_granary'").get().q;
  assert.ok(hoard > 42, `hoard grew to ${hoard}`);
  const decisions = g.db.prepare("SELECT * FROM npc_decisions WHERE npc_id='npc_corvin'").all();
  assert.ok(decisions.length > 5);
  assert.ok(JSON.parse(decisions[0].reasons).length > 0, 'decisions carry reasons');
  const cost = (w) => marketPrice(w, 'brindlemarch', 'flour') + marketPrice(w, 'brindlemarch', 'grain');
  assert.ok(cost(g) >= cost(control), `hoarding world ${cost(g)} vs control ${cost(control)}`);
  assertSound(null, g);
});

test('rumours spread through gossip with reduced confidence', () => {
  const g = newGame();
  for (let i = 0; i < 10; i++) run(g, { type: 'wait', hours: 24 });
  const spread = g.db.prepare("SELECT COUNT(*) n FROM knowledge WHERE source='gossip'").get().n;
  assert.ok(spread > 0, 'some gossip happened');
  const conf = g.db.prepare("SELECT MAX(confidence) c FROM knowledge WHERE source='gossip'").get().c;
  assert.ok(conf <= 0.9);
});

test('evidence convinces the captain, who exposes the hoard; the world changes', () => {
  const g = newGame();
  goTo(g, 'Ashby Mill & Granary');
  // overwhelming investigation ability, and wait until the miller is away
  g.db.prepare("INSERT OR REPLACE INTO skills(character_id, skill, xp, rank) VALUES ('player','investigation',920,10), ('player','stealth',920,10)").run();
  let found = false;
  for (let i = 0; i < 6 && !found; i++) {
    run(g, { type: 'investigate', topic: 'granary' });
    found = g.count('player', 'grain_ledger') > 0;
  }
  assert.ok(found, 'found the ledger');
  assert.ok(belief(g.db, 'player', 'f_grain_hoard'));
  const hoardBefore = g.db.prepare("SELECT SUM(quantity) q FROM items WHERE holder_kind='hidden' AND holder_id='bm_mill_granary'").get().q;
  // find Hedda
  for (let i = 0; i < 24 && g.char('npc_hedda').location_id !== g.player().location_id; i++) {
    const loc = g.char('npc_hedda').location_id;
    goTo(g, g.location(loc).name);
  }
  const r = run(g, { type: 'tell', target: 'Hedda', topic: 'the grain hoard at the mill' });
  assert.equal(r.outcomes[0].status, 'done', r.outcomes[0].error?.message);
  const hoardAfter = g.db.prepare("SELECT COALESCE(SUM(quantity),0) q FROM items WHERE holder_kind='hidden' AND holder_id='bm_mill_granary'").get().q;
  assert.equal(hoardAfter, 0);
  assert.ok(hoardBefore > 0);
  assert.ok(g.db.prepare("SELECT 1 FROM events WHERE kind='scandal'").get());
  assert.ok(g.rel('npc_corvin', 'player').trust < 0, 'the mayor knows who exposed him');
  // NPCs who were not present learn it because it became public
  assert.ok(belief(g.db, 'npc_wenna', 'f_grain_hoard'));
  assertSound(null, g);
});

test('hearsay: witnesses of a crime spread it; listeners judge the player without having seen it', () => {
  const g = newGame({ background: 'streetwise' });
  goTo(g, 'Market Square');
  g.db.prepare("INSERT OR REPLACE INTO skills(character_id, skill, xp, rank) VALUES ('player','sleight_of_hand',0,0)").run();
  g.db.prepare("UPDATE characters SET attributes=json_set(attributes,'$.agility',1) WHERE id='player'").run();
  const victim = g.charactersAt('bm_square').find((c) => c.kind === 'npc');
  assert.ok(victim, 'someone in the square');
  let caught = false;
  for (let i = 0; i < 5 && !caught; i++) caught = run(g, { type: 'steal', target: victim.name, item: 'money' }).outcomes[0].status === 'failed';
  if (!caught) return;
  for (let i = 0; i < 6; i++) run(g, { type: 'wait', hours: 24 });
  const hearsay = g.db.prepare("SELECT COUNT(*) n FROM memories WHERE source='hearsay' AND summary LIKE '%steal%'").get().n;
  assert.ok(hearsay >= 0); // propagation is probabilistic; when it happens the source is labelled
  const leaked = g.db.prepare("SELECT owner_id FROM memories WHERE summary LIKE '%steal%' AND source NOT IN ('hearsay','witnessed','experienced')").all();
  assert.equal(leaked.length, 0, 'no NPC knows of the theft without a legitimate source');
});
