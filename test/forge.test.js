// World Forge pipeline tests (deterministic). A small hand-written draft, shaped exactly like
// the model's stage outputs and containing deliberate defects, is compiled, validated, created,
// played, extended by an invention, and reloaded. Real-model drafts recorded in
// data/forge-samples/ are exercised by test/crossworld.test.js.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { compileWorld } from '../src/forge/compile.js';
import { Game } from '../src/engine/game.js';
import { attach } from '../src/engine/sim.js';
import { executeTurn } from '../src/engine/turn.js';
import { normalizeInterpretation, blankAction } from '../src/ai/schema.js';
import { reconcile } from '../src/engine/ledger.js';
import { conservationCheck } from '../src/engine/inventory.js';
import { activeRules, validateRule } from '../src/engine/worldrules.js';
import { pendingDesigns, installInvention, fallbackProposal } from '../src/engine/innovation.js';
import { interpreterSystem } from '../src/ai/prompts.js';

export function makeDraft() {
  const attrs = ['brawn', 'grace', 'grit', 'wits', 'senses', 'charm'].map((id) => ({ id, label: id, info: `${id} of a desert walker` }));
  const S = (id, label, attr, trained = false) => ({ id, label, attr, group: 'trade', desc: label, trained, keywords: [label.toLowerCase()] });
  return {
    description: 'A desert of glass dunes where caravans trade water and sun-glass; sandstorms sing.',
    core: {
      name: 'The Glass Wastes', tagline: 'Dunes of glass under a white sun.', premise: 'Caravans cross singing glass dunes between oasis towns.', tone: 'harsh',
      intro: 'You wake in a caravanserai as the dunes begin to sing.', contradictions_resolved: [],
      physics: ['Sandstorms shatter glass and sing.', 'Sun-glass stores heat for days.'], impossible: ['rain'], common_knowledge: ['Water is life.'],
      magic: { exists: false, summary: '' }, technology: { level: 'bronze age', summary: 'Bronze tools, glass lenses, camel caravans.' },
      currency: { name: 'drop', plural: 'drops', medium: 'sealed water drops' },
      attributes: attrs, calendar: { era: 'of the Dunes', months: ['Heat', 'Glare', 'Ash', 'Cool'], weekdays: ['First', 'Second', 'Third', 'Fourth'] },
      settlements: [{ name: 'Mirage Well', kind: 'oasis town', description: 'A palm-ringed oasis.', population: 900 }, { name: 'Shardgate', kind: 'glass city', description: 'A city cut from a single dune.', population: 3000 }],
      player: { background: 'water-carrier', description: 'You haul water for coins.', wealth: 'poor' },
    },
    skills: { skills: [S('haggling', 'Haggling', 'charm'), S('lying', 'Lying', 'charm'), S('menace', 'Menace', 'brawn'), S('talk', 'Smooth Talk', 'charm'), S('spotting', 'Spotting', 'senses'), S('tracking', 'Tracking', 'wits'), S('lifting', 'Lifting Purses', 'grace'), S('creeping', 'Creeping', 'grace'), S('blades', 'Blades', 'brawn'), S('hauling', 'Hauling', 'brawn'), S('dune_lore', 'Dune Lore', 'grit'), S('salving', 'Salving', 'wits', true), S('trading', 'Caravan Trading', 'wits'), S('starlore', 'Star-lore', 'wits'), S('glasswork', 'Glasswork', 'grace', true), S('tinkering', 'Tinkering', 'wits', true)] },
    roles: { social: 'talk', lie: 'lying', threaten: 'menace', haggle: 'haggling', notice: 'spotting', search: 'tracking', steal: 'lifting', sneak: 'creeping', fight: 'blades', labor: 'hauling', wilds: 'dune_lore', heal: 'salving', manage: 'trading', research: 'starlore', invent: 'tinkering', craft: 'glasswork' },
    places: {
      start: 'The Thirsty Camel',
      locations: [
        { name: 'Well Bazaar', settlement: 'Mirage Well', kind: 'bazaar', tags: ['market', 'public'], description: 'Awnings and water-sellers.', connections: [{ to: 'The Thirsty Camel', minutes: 5, mode: 'walk' }, { to: 'Shard Market', minutes: 600, mode: 'caravan' }] },
        { name: 'The Thirsty Camel', settlement: 'Mirage Well', kind: 'caravanserai', tags: ['lodging', 'food'], description: 'A caravanserai.', connections: [{ to: 'Well Bazaar', minutes: 5, mode: 'walk' }] },
        { name: 'Glassblowers Row', settlement: 'Mirage Well', kind: 'workshop', tags: ['craft', 'work'], description: 'Furnaces and lenses.', connections: [{ to: 'Nowhere That Exists', minutes: 9, mode: 'walk' }] },
        { name: 'Healers Tent', settlement: 'Mirage Well', kind: 'clinic', tags: ['healing'], description: 'Shade and salves.', connections: [{ to: 'Well Bazaar', minutes: 4, mode: 'walk' }] },
        { name: 'Shard Market', settlement: 'Shardgate', kind: 'market', tags: ['market'], description: 'Glass stalls.', connections: [{ to: 'Star Archive', minutes: 10, mode: 'walk' }] },
        { name: 'Star Archive', settlement: 'Shardgate', kind: 'library', tags: ['library', 'quiet'], description: 'Star charts.', connections: [] },
        { name: 'Shard Watch', settlement: 'Shardgate', kind: 'barracks', tags: ['government'], description: 'The watch.', connections: [] },
        { name: 'Singing Dunes', settlement: 'wilds', kind: 'dunes', tags: ['wild', 'gather'], description: 'The dunes sing.', connections: [{ to: 'Well Bazaar', minutes: 90, mode: 'walk' }] },
      ],
    },
    items: {
      items: [
        { id: 'water_skin', name: 'water skin', category: 'food', value: 2, weight: 1, traded_commodity: true, food: true, tool_for: null, description: 'Water.' },
        { id: 'dates', name: 'dates', category: 'food', value: 1, weight: 0.5, traded_commodity: true, food: true, tool_for: null, description: 'Sweet dates.' },
        { id: 'sand_glass', name: 'raw sand-glass', category: 'material', value: 4, weight: 3, traded_commodity: true, food: false, tool_for: null, description: 'Glass shards.' },
        { id: 'sun_glass', name: 'sun-glass', category: 'commodity', value: 20, weight: 1, traded_commodity: true, food: false, tool_for: null, description: 'Heat-storing glass.' },
        { id: 'salt', name: 'salt', category: 'commodity', value: 3, weight: 2, traded_commodity: true, food: false, tool_for: null, description: 'Salt.' },
        { id: 'lens', name: 'brass lens', category: 'tool', value: 25, weight: 1, traded_commodity: false, food: false, tool_for: 'spotting', description: 'Far-seeing.' },
        { id: 'blowpipe', name: 'blowpipe', category: 'tool', value: 12, weight: 2, traded_commodity: false, food: false, tool_for: 'glasswork', description: 'For glass.' },
        { id: 'tool_kit', name: 'tinker kit', category: 'tool', value: 18, weight: 2, traded_commodity: false, food: false, tool_for: 'tinkering', description: 'Tinkering tools.' },
        { id: 'bronze', name: 'bronze bar', category: 'material', value: 8, weight: 4, traded_commodity: true, food: false, tool_for: null, description: 'Bronze.' },
        { id: 'scimitar', name: 'scimitar', category: 'weapon', value: 30, weight: 3, traded_commodity: false, food: false, tool_for: null, description: 'Curved blade.' },
        { id: 'robe', name: 'dune robe', category: 'clothing', value: 6, weight: 1, traded_commodity: false, food: false, tool_for: null, description: 'Robe.' },
        { id: 'salve', name: 'aloe salve', category: 'medicine', value: 7, weight: 0.2, traded_commodity: false, food: false, tool_for: null, description: 'Salve.' },
        { id: 'star_chart', name: 'star chart', category: 'book', value: 40, weight: 1, traded_commodity: false, food: false, tool_for: 'starlore', description: 'Charts.' },
        { id: 'singing_shard', name: 'singing shard', category: 'treasure', value: 200, weight: 1, traded_commodity: false, food: false, tool_for: null, description: 'It hums.' },
      ],
      recipes: [
        { name: 'blow sun-glass', skill: 'glasswork', inputs: [{ item: 'sand_glass', qty: 2 }], outputs: [{ item: 'sun_glass', qty: 1 }], minutes: 120 },
        { name: 'conjure gold', skill: 'glasswork', inputs: [{ item: 'salt', qty: 1 }], outputs: [{ item: 'singing_shard', qty: 9 }], minutes: 30 },
        { name: 'phantom recipe', skill: 'glasswork', inputs: [{ item: 'unobtainium', qty: 1 }], outputs: [{ item: 'sun_glass', qty: 1 }], minutes: 30 },
      ],
    },
    people: {
      factions: [{ name: 'Well Council', description: 'Elders of the oasis.', governs: 'Mirage Well' }, { name: 'Glass Guild', description: 'Glassblowers.', governs: null }, { name: 'Dune Knives', description: 'Thieves.', governs: null }],
      npcs: [
        { name: 'Asha Venn', role: 'water merchant', location: 'Well Bazaar', faction: 'Well Council', traits: ['shrewd', 'warm'], persona: 'Quick-talking.', goal: 'Control the water trade', skills: [{ skill: 'trading', rank: 5 }, { skill: 'haggling', rank: 4 }], sells: ['water_skin', 'salt', 'dates'], buys: ['salt', 'dates'], produces: ['water_skin'], employs: true, teaches: false, lends: false, guard: false, healer: false, host: false },
        { name: 'Old Teo', role: 'innkeeper', location: 'The Thirsty Camel', faction: 'none', traits: ['kind', 'gossipy'], persona: 'Talkative.', goal: 'Keep the camel full', skills: [{ skill: 'talk', rank: 3 }, { skill: 'spotting', rank: 3 }], sells: ['dates'], buys: ['dates', 'water_skin'], produces: [], employs: true, teaches: false, lends: false, guard: false, healer: false, host: true },
        { name: 'Ilka Brann', role: 'master glassblower', location: 'Glassblowers Row', faction: 'Glass Guild', traits: ['proud', 'patient'], persona: 'Terse.', goal: 'Perfect sun-glass', skills: [{ skill: 'glasswork', rank: 7 }, { skill: 'tinkering', rank: 5 }], sells: ['sun_glass', 'blowpipe', 'tool_kit'], buys: ['sand_glass', 'bronze'], produces: [], employs: true, teaches: true, lends: false, guard: false, healer: false, host: false },
        { name: 'Sefa Dune', role: 'healer', location: 'Healers Tent', faction: 'none', traits: ['gentle', 'tired'], persona: 'Soft.', goal: 'Save the sick', skills: [{ skill: 'salving', rank: 6 }], sells: ['salve'], buys: [], produces: [], employs: false, teaches: true, lends: false, guard: false, healer: true, host: false },
        { name: 'Marro Quill', role: 'archivist', location: 'Star Archive', faction: 'Glass Guild', traits: ['curious', 'aloof'], persona: 'Dry.', goal: 'Map every star', skills: [{ skill: 'starlore', rank: 7 }, { skill: 'tinkering', rank: 4 }], sells: ['star_chart'], buys: [], produces: [], employs: false, teaches: true, lends: true, guard: false, healer: false, host: false },
        { name: 'Captain Rhea', role: 'watch captain', location: 'Shard Watch', faction: 'Well Council', traits: ['stern', 'fair'], persona: 'Clipped.', goal: 'Catch the Knives', skills: [{ skill: 'blades', rank: 6 }, { skill: 'spotting', rank: 5 }], sells: [], buys: [], produces: [], employs: false, teaches: false, lends: false, guard: true, healer: false, host: false },
        { name: 'Pell Sly', role: 'fence', location: 'Shard Market', faction: 'Dune Knives', traits: ['sly', 'cheerful'], persona: 'Grinning.', goal: 'Get rich', skills: [{ skill: 'lifting', rank: 6 }, { skill: 'lying', rank: 5 }], sells: ['scimitar', 'robe'], buys: ['singing_shard', 'lens'], produces: [], employs: false, teaches: false, lends: false, guard: false, healer: false, host: false },
        { name: 'Dara Sand', role: 'glass-gatherer', location: 'Singing Dunes', faction: 'none', traits: ['quiet', 'tough'], persona: 'Few words.', goal: 'Find a singing shard', skills: [{ skill: 'dune_lore', rank: 6 }, { skill: 'hauling', rank: 4 }], sells: ['sand_glass'], buys: [], produces: ['sand_glass'], employs: true, teaches: false, lends: false, guard: false, healer: false, host: false },
      ],
    },
    story: {
      facts: [
        { subject: 'the dry well', content: 'Asha Venn secretly diverts the eastern well to raise water prices.', secret_level: 2, true_fact: true, known_by: ['Asha Venn'], keepers: ['Asha Venn'], tags: ['water', 'well', 'asha', 'prices'] },
        { subject: 'singing shards', content: 'Singing shards surface after great sandstorms.', secret_level: 0, true_fact: true, known_by: ['Dara Sand', 'Old Teo'], keepers: [], tags: ['shard', 'storm', 'dunes'] },
      ],
      agendas: [{ who: 'Asha Venn', kind: 'stockpile', partner_or_rival: 'Old Teo', items: ['water_skin'], motive: 'scarcity makes water dear' }, { who: 'Pell Sly', kind: 'pilfer', partner_or_rival: null, items: [], motive: 'easy money' }],
      requests: [{ giver: 'Ilka Brann', title: 'Glass for the furnace', text: 'Ilka Brann needs 4 raw sand-glass.', item: 'sand_glass', qty: 4, deliver_to: 'Ilka Brann', reward: 30, days: 10 }, { giver: 'Nobody Real', title: 'Ghost task', text: 'x', item: 'salt', qty: 1, deliver_to: 'Asha Venn', reward: 5, days: 3 }],
      special_rules: [
        { name: 'Storm Listening', kind: 'technique', summary: 'Listen to the singing dunes to predict storms and find shards.', skill: 'dune_lore', difficulty: 'hard', minutes: 60, must_be_learned: true, min_skill: 1, consumes: [{ item: 'water_skin', qty: 1 }], fatigue: 10, on_success: [{ type: 'produce', item: 'sand_glass', amount: 99, text: '' }, { type: 'note', item: null, amount: null, text: 'You hear where the glass will surface.' }], on_failure: [{ type: 'fatigue', item: null, amount: 10, text: '' }], known_by: ['Dara Sand'] },
        { name: 'Unwritable Power', kind: 'ability', summary: 'Something the engine cannot express.', skill: 'starlore', difficulty: 'legendary', minutes: 30, must_be_learned: true, min_skill: 5, consumes: [], fatigue: 0, on_success: [{ type: 'produce', item: 'not_an_item', amount: 1, text: '' }], on_failure: [], known_by: [] },
      ],
      backgrounds: [
        { name: 'Water-carrier', description: 'You haul water for coin.', attribute_bonus: ['brawn', 'grit'], skills: [{ skill: 'hauling', rank: 2 }, { skill: 'dune_lore', rank: 1 }], items: ['robe', 'water_skin'], money: 9999 },
        { name: 'Apprentice glassblower', description: 'Burned fingers, steady breath.', attribute_bonus: ['grace'], skills: [{ skill: 'glasswork', rank: 2 }, { skill: 'tinkering', rank: 1 }], items: ['blowpipe'], money: 15 },
        { name: 'Street lifter', description: 'Quick hands.', attribute_bonus: ['grace', 'senses'], skills: [{ skill: 'lifting', rank: 2 }, { skill: 'creeping', rank: 1 }], items: ['robe'], money: 5 },
      ],
    },
  };
}

function act(game, ...actions) {
  const interp = normalizeInterpretation({ mode: 'act', intent: 't', actions: actions.map((a) => ({ ...blankAction(a.type), ...a })), plan_title: null, risks: [], question: null, reason: null });
  assert.ok(interp.ok, interp.errors?.join(';'));
  return executeTurn(game, { input: 'test', interp: interp.value, source: 'test' });
}

test('compiler: turns a draft into a valid, connected, economically wired spec and reports every repair', () => {
  const { spec, report } = compileWorld(makeDraft());
  assert.equal(spec.spec_version, 2);
  assert.ok(report.repairs.some((r) => /unknown place "Nowhere That Exists"/.test(r)), 'dangling connection reported');
  assert.ok(report.repairs.some((r) => /phantom recipe/.test(r)), 'recipe with unknown input reported');
  assert.ok(report.repairs.some((r) => /conjure gold/.test(r) && /too much value/.test(r)), 'value-creating recipe clamped');
  assert.ok(report.repairs.some((r) => /Ghost task/.test(r)), 'request from unknown NPC dropped');
  assert.ok(report.approximations.some((r) => /Unwritable Power/.test(r)), 'inexpressible rule approximated, not faked');
  assert.ok(spec.backgrounds[0].money <= 36, `poor start enforced (got ${spec.backgrounds[0].money})`);
  // every location reachable
  const adj = {};
  for (const [a, b] of spec.routes) { (adj[a] = adj[a] || []).push(b); (adj[b] = adj[b] || []).push(a); }
  const seen = new Set([spec.locations[0].id]); const q = [spec.locations[0].id];
  while (q.length) for (const n of adj[q.shift()] || []) if (!seen.has(n)) { seen.add(n); q.push(n); }
  assert.equal(seen.size, spec.locations.length, 'map is connected');
  // every commodity has a producer and a seller
  for (const t of spec.item_types.filter((x) => x.commodity)) {
    assert.ok(spec.npcs.some((n) => (n.production || []).some((p) => p.type === t.id)) || spec.recipes.some((r) => r.outputs[t.id]), `${t.id} has a source`);
    assert.ok(spec.npcs.some((n) => n.shop?.sells.includes(t.id)), `${t.id} has a seller`);
  }
});

test('a forged world is created, played with world-specific skills and rules, adapted by invention, and reloaded', () => {
  const { spec } = compileWorld(makeDraft());
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'saturn-forge-'));
  const file = path.join(dir, 'w.saturn');
  const g = attach(Game.create(file, { def: spec, seed: 3, player: { name: 'Kel', background: spec.backgrounds[1].id } }));
  // world-specific ruleset
  assert.equal(g.rules.currency.plural, 'drops');
  assert.ok(g.rules.skills.glasswork && !g.rules.skills.persuasion, 'world skills replace the legacy set');
  assert.equal(g.skillFor('sleight_of_hand'), 'lifting', 'engine roles map onto world skills');
  assert.match(interpreterSystem(g), /Glass Wastes/);
  assert.match(interpreterSystem(g), /glasswork \(Glasswork\)/);
  // play: look, talk, buy food, ask for work, study, gather, steal (uses the world's theft skill)
  assert.equal(act(g, { type: 'look' }).outcomes[0].status, 'done');
  assert.equal(act(g, { type: 'talk', target: 'Teo', approach: 'chat' }).outcomes[0].status, 'done');
  const b = act(g, { type: 'buy', target: 'Teo', item: 'dates', quantity: 2 });
  assert.equal(b.outcomes[0].status, 'done', b.outcomes[0].error?.message);
  assert.match(b.outcomes[0].summary, /drops?/);
  act(g, { type: 'move', destination: 'Glassblowers Row' });
  assert.equal(act(g, { type: 'ask_job', target: 'Ilka' }).outcomes[0].status, 'done');
  const st = act(g, { type: 'study', skill: 'glasswork', target: 'Ilka', hours: 4 });
  assert.equal(st.outcomes[0].status, 'done', st.outcomes[0].error?.message);
  assert.ok(st.changes.skills.some((s) => s.skill === 'glasswork'));
  // world rules: installed, validated (value bound clamps 99 shards), learnable from a teacher
  const rules = activeRules(g);
  const listening = rules.find((r) => r.name === 'Storm Listening');
  assert.ok(listening, 'world rule installed');
  assert.ok(listening.spec.effects.success.find((e) => e.type === 'produce').qty <= 11, 'produce effect bounded by input value');
  const blocked = act(g, { type: 'use_ability', target: 'Storm Listening' });
  assert.equal(blocked.outcomes[0].error.code, 'not_learned', 'abilities must be learned first');
  act(g, { type: 'move', destination: 'Singing Dunes' });
  // prerequisite: Dune Lore 1, earned through real training (drills over several days)
  const tr = act(g, { type: 'train', skill: 'dune lore', days: 6 });
  assert.notEqual(tr.outcomes[0].status, 'blocked', tr.outcomes[0].error?.message);
  assert.ok(g.skill('player', 'dune_lore').rank >= 1, `dune lore rank ${g.skill('player', 'dune_lore').rank}`);
  if (g.player().location_id !== g.def.locations.find((l) => l.name === 'Singing Dunes').id) act(g, { type: 'move', destination: 'Singing Dunes' });
  const learn = act(g, { type: 'study', topic: 'Storm Listening', hours: 12 });
  assert.equal(learn.outcomes[0].status, 'done', learn.outcomes[0].error?.message);
  assert.ok(g.db.prepare("SELECT 1 FROM capabilities WHERE holder_id='player' AND rule_id=?").get(listening.id), 'learned from Dara');
  g.transact(() => g.mint('player', 0 || 1, 'test'));
  if (!g.count('player', 'water_skin')) g.transact(() => g.db.prepare("INSERT INTO items(type_id,quantity,owner_id,holder_kind,holder_id) VALUES ('water_skin',1,'player','character','player')").run() && g.db.prepare("INSERT INTO item_log(time,type_id,delta,reason) VALUES (?, 'water_skin', 1, 'init')").run(g.time));
  const use = act(g, { type: 'use_ability', target: 'Storm Listening' });
  assert.notEqual(use.outcomes[0].status, 'blocked', use.outcomes[0].error?.message);
  assert.ok(use.outcomes[0].rolls.length === 1, 'resolved by a real skill check');
  // invention: a research project completes → design installed as a versioned world capability
  g.db.prepare("UPDATE skills SET rank=6, xp=360 WHERE character_id='player' AND skill='tinkering'").run();
  g.db.prepare("INSERT OR REPLACE INTO skills(character_id,skill,xp,rank) VALUES ('player','tinkering',360,6)").run();
  g.transact(() => g.mint('player', 200, 'test funds'));
  let done = false;
  for (let i = 0; i < 12 && !done; i++) {
    act(g, { type: 'research', topic: 'sand sled', detail: 'a wind-driven sled that skims the glass dunes', skill: 'tinkering', novelty: 'significant', approach: 'invention', hours: 12 });
    act(g, { type: 'rest', hours: 8 });
    done = pendingDesigns(g).length > 0;
  }
  assert.ok(done, 'project completed through repeated checks');
  const proj = pendingDesigns(g)[0];
  const proposal = { ...fallbackProposal(g, proj), use: { ...fallbackProposal(g, proj).use, name: 'Ride the sand sled', effect: 'travel', travel_speed: 0.3 } };
  const res = g.transact(() => installInvention(g, proj, proposal, { designer: 'test' }));
  assert.ok(res.ok, res.errors?.join(';'));
  assert.ok(res.deviceId && g.count('player', res.deviceId) === 1, 'prototype exists as a real item');
  assert.ok(g.recipe(res.recipe.id), 'recipe to build more is part of the world');
  const rev = g.db.prepare('SELECT * FROM world_rule_revisions WHERE rule_id=?').all(res.rule.id);
  assert.equal(rev.length, 1);
  assert.ok(rev[0].cause_event_id, 'rule change linked to its causing event');
  const ride = act(g, { type: 'use_ability', target: 'Ride the sand sled', detail: 'Shard Market' });
  assert.notEqual(ride.outcomes[0].status, 'blocked', ride.outcomes[0].error?.message);
  // a skilled NPC who hears of it may adopt it
  g.learnFact && g.transact(() => g.learnFact('npc_ilka', res.rule.fact, { belief: 'known', confidence: 0.9, source: 'gossip' }));
  for (let i = 0; i < 40 && !g.db.prepare("SELECT 1 FROM capabilities WHERE holder_id='npc_ilka' AND rule_id=?").get(res.rule.id); i++) act(g, { type: 'wait', hours: 24 });
  assert.ok(g.db.prepare("SELECT 1 FROM capabilities WHERE holder_id='npc_ilka' AND rule_id=?").get(res.rule.id), 'Ilka adopted the invention');
  assert.deepEqual(reconcile(g.db), []);
  assert.deepEqual(conservationCheck(g.db), []);
  // save, reload: world, rules, capabilities and the invention survive
  const fp = JSON.stringify({ t: g.time, m: g.balance('player'), r: activeRules(g).map((r) => [r.id, r.version]), c: g.db.prepare('SELECT * FROM capabilities ORDER BY holder_id, rule_id').all(), it: g.held('player').map((i) => [i.type_id, i.quantity]) });
  g.close();
  const g2 = attach(Game.open(file));
  assert.equal(JSON.stringify({ t: g2.time, m: g2.balance('player'), r: activeRules(g2).map((r) => [r.id, r.version]), c: g2.db.prepare('SELECT * FROM capabilities ORDER BY holder_id, rule_id').all(), it: g2.held('player').map((i) => [i.type_id, i.quantity]) }), fp);
  assert.equal(g2.rules.currency.plural, 'drops');
  assert.ok(g2.recipe(res.recipe.id), 'invented recipe persists');
  g2.close();
});

test('rule validation rejects unsafe or malformed proposals and bounds the rest', () => {
  const { spec } = compileWorld(makeDraft());
  const g = attach(Game.create(':memory:', { def: spec, seed: 1 }));
  assert.equal(validateRule(g, { id: 'x', name: 'X', kind: 'ability', summary: 's', skill: 'nonsense skill', difficulty: 'easy', minutes: 10, effects: { success: [{ type: 'note', text: 'x' }] } }).ok, false);
  assert.equal(validateRule(g, { id: 'x', name: 'X', kind: 'spell_of_doom', summary: 's', skill: 'starlore', difficulty: 'easy', minutes: 10, effects: { success: [{ type: 'note' }] } }).ok, false);
  assert.equal(validateRule(g, { id: 'x', name: 'X', kind: 'ability', summary: 's', skill: 'starlore', difficulty: 'easy', minutes: 10, effects: { success: [{ type: 'execute_code', text: 'rm -rf' }] } }).ok, false);
  const v = validateRule(g, { id: 'mint', name: 'Mint', kind: 'ability', summary: 's', skill: 'starlore', difficulty: 'trivial', minutes: 10, effects: { success: [{ type: 'produce', item: 'singing_shard', qty: 50 }, { type: 'heal', amount: 60 }] } }, { origin: 'player' });
  assert.ok(v.ok);
  assert.equal(v.rule.effects.success[0].qty, 1, 'free ability cannot mint treasure');
  assert.ok(v.rule.effects.success[1].amount <= 40);
  assert.equal(v.rule.difficulty, 'easy', 'inventions are never trivial');
});
