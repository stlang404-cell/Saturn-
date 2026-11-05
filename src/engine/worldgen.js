// Populate a new save from a data-driven world definition.
import { J } from './db.js';
import * as ledger from './ledger.js';
import * as inv from './inventory.js';
import { xpForRank, MINUTES_PER_DAY, buildRuleset } from './rules.js';
import { RuleError } from './ledger.js';
import { addMemory } from './memory.js';
import { learn } from './knowledge.js';
import { adjustRel } from './relationships.js';
import { updatePrices } from './economy.js';

export const CREATION_POINTS = 3;

export function validatePlayerSpec(def, spec = {}) {
  const ATTRIBUTES = buildRuleset(def).attrIds;
  const name = String(spec.name || 'Wren').trim().slice(0, 40) || 'Wren';
  const bg = def.backgrounds.find((b) => b.id === (spec.background || def.backgrounds[0].id));
  if (!bg) throw new RuleError('bad_background', `Unknown background ${spec.background}`);
  const attrs = Object.fromEntries(ATTRIBUTES.map((a) => [a, 2]));
  for (const [a, v] of Object.entries(bg.attributes || {})) attrs[a] += v;
  const alloc = spec.allocation || {};
  let spent = 0;
  for (const [a, v] of Object.entries(alloc)) {
    if (!ATTRIBUTES.includes(a)) throw new RuleError('bad_attribute', `Unknown attribute ${a}`);
    if (!Number.isInteger(v) || v < 0) throw new RuleError('bad_allocation', 'Allocation must be non-negative integers');
    attrs[a] += v;
    spent += v;
  }
  if (spent > CREATION_POINTS) throw new RuleError('bad_allocation', `You may allocate at most ${CREATION_POINTS} points (got ${spent}).`);
  for (const a of ATTRIBUTES) if (attrs[a] > 5) throw new RuleError('bad_allocation', `${a} cannot exceed 5 at creation.`);
  return { name, bg, attrs };
}

export function populateWorld(game, playerSpec) {
  const { db, def } = game;
  const ctx = game.ctx;
  ledger.ensureSystemAccounts(db);

  for (const l of def.locations) {
    const data = { ...(l.data || {}) };
    if (l.hidden) data.hidden = true;
    db.prepare('INSERT INTO locations(id,name,settlement,region,kind,description,tags,art,x,y,data) VALUES (?,?,?,?,?,?,?,?,?,?,?)')
      .run(l.id, l.name, l.settlement, l.region || l.settlement, l.kind, l.description, J.str(l.tags || []), l.art || null, l.x, l.y, J.str(data));
  }
  for (const [a, b, minutes, opt = {}] of def.routes) {
    for (const [f, t] of [[a, b], [b, a]]) {
      db.prepare('INSERT INTO routes(from_id,to_id,minutes,mode,risk,cost) VALUES (?,?,?,?,?,?)').run(f, t, minutes, opt.mode || 'walk', opt.risk || 0, opt.cost || 0);
    }
  }
  for (const t of def.item_types) {
    db.prepare('INSERT INTO item_types(id,name,category,base_value,weight,stackable,commodity,slot,tags,description,data) VALUES (?,?,?,?,?,?,?,?,?,?,?)')
      .run(t.id, t.name, t.category, t.base_value, t.weight ?? 1, t.stackable === false ? 0 : 1, t.commodity ? 1 : 0, t.slot || null, J.str(t.tags || []), t.description || '', J.str(t.data || {}));
  }
  for (const f of def.factions) {
    db.prepare('INSERT INTO factions(id,name,description) VALUES (?,?,?)').run(f.id, f.name, f.description);
    ledger.ensureAccount(db, f.id, { owner: f.id, kind: 'faction', name: `${f.name} treasury` });
  }
  ledger.mint(ctx, { to: 'fac_council', amount: 150, memo: 'Town treasury at world creation' });
  ledger.mint(ctx, { to: 'fac_guild', amount: 300, memo: 'Guild reserves at world creation' });

  for (const s of def.settlements) {
    const acct = `pop_${s.id}`;
    ledger.ensureAccount(db, acct, { owner: acct, kind: 'population', name: `Townsfolk of ${s.name}` });
    ledger.mint(ctx, { to: acct, amount: Math.round(s.population / 6), memo: `Savings of ${s.name}'s townsfolk at world creation` });
  }
  for (const f of def.facts) {
    db.prepare('INSERT INTO facts(id,subject,content,truth,secrecy,tags,data) VALUES (?,?,?,?,?,?,?)').run(f.id, f.subject, f.content, f.truth, f.secrecy, J.str(f.tags || []), J.str(f.data || {}));
  }
  for (const [settlement, types] of Object.entries(def.markets)) {
    for (const [typeId, [target, demand]] of Object.entries(types)) {
      const base = def.market_base?.[settlement]?.[typeId] ?? def.item_types.find((t) => t.id === typeId).base_value;
      db.prepare('INSERT INTO markets(settlement,type_id,target_stock,daily_demand,price) VALUES (?,?,?,?,?)').run(settlement, typeId, target, demand, base);
    }
  }

  // NPCs
  for (const n of def.npcs) {
    db.prepare(`INSERT INTO characters(id,kind,name,role,tier,location_id,attributes,traits,goals,schedule,persona,data,last_meal)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(n.id, 'npc', n.name, n.role, 1, n.location, J.str(n.attributes), J.str(n.traits || []), J.str(n.goals || []), J.str(n.schedule || {}), n.persona || '', J.str({}), game.time);
    ledger.ensureAccount(db, n.id, { owner: n.id, kind: 'character', name: n.name });
    if (n.money) ledger.mint(ctx, { to: n.id, amount: n.money, memo: `${n.name}'s savings at world creation` });
    for (const [typeId, qty] of Object.entries(n.inventory || {})) inv.createItems(ctx, { typeId, qty, holderKind: 'character', holderId: n.id, ownerId: n.id, reason: 'init', memo: 'world creation' });
    for (const [skill, rank] of Object.entries(n.skills || {})) {
      if (!game.rules.skills[skill]) continue;
      db.prepare('INSERT INTO skills(character_id,skill,xp,rank) VALUES (?,?,?,?)').run(n.id, skill, xpForRank(rank), rank);
    }
    for (const [factId, belief = 'known', conf] of n.knows || []) {
      learn(db, n.id, factId, { belief, confidence: conf ?? (belief === 'known' ? 1 : 0.5), source: 'background', time: game.time });
    }
    for (const [fid, rank] of n.factions || []) db.prepare('INSERT INTO faction_members(faction_id,character_id,rank) VALUES (?,?,?)').run(fid, n.id, rank);
    for (const [to, dims] of n.relationships || []) adjustRel(ctx, n.id, to, dims, 'history');
    for (const req of n.requests || []) {
      db.prepare(`INSERT INTO contracts(kind,party_a,party_b,title,terms,status,created_at,due_at,data) VALUES ('request',?,?,?,?,'offered',?,NULL,?)`)
        .run(n.id, 'player', req.title, J.str({ objective: req.objective, reward: req.reward, days: req.days, rel: req.rel, text: req.text }), game.time, J.str({ request_id: req.id, known: false }));
    }
  }
  for (const [from, to, dims] of def.npc_relationships || []) adjustRel(ctx, from, to, dims, 'history');
  // common knowledge spreads to everyone in a settlement
  const common = def.facts.filter((f) => f.secrecy === 0 && f.truth === 1);
  for (const n of def.npcs) {
    if (!n.location.startsWith('bm_')) continue; // only Brindlemarch folk share Brindlemarch common knowledge
    for (const f of common) {
      if (!db.prepare('SELECT 1 FROM knowledge WHERE holder_id=? AND fact_id=?').get(n.id, f.id)) {
        learn(db, n.id, f.id, { belief: 'known', confidence: 0.9, source: 'common knowledge', time: game.time });
      }
    }
  }

  for (const h of def.hidden_stores || []) {
    for (const [typeId, qty] of Object.entries(h.items)) inv.createItems(ctx, { typeId, qty, holderKind: 'hidden', holderId: h.id, ownerId: h.owner, reason: 'init', memo: h.name });
    if (h.evidence) inv.createItems(ctx, { typeId: h.evidence.item, qty: 1, holderKind: 'hidden', holderId: `${h.id}:evidence`, ownerId: h.owner, reason: 'init', memo: 'evidence' });
  }
  for (const s of def.secrets_at || []) {
    if (s.item) inv.createItems(ctx, { typeId: s.item, qty: 1, holderKind: 'hidden', holderId: `secret:${s.location_id}`, ownerId: 'nobody', reason: 'init', memo: 'lost treasure' });
  }

  createPlayer(game, playerSpec);
  updatePrices(game);
}

export function createPlayer(game, spec) {
  const { db, def } = game;
  const ctx = game.ctx;
  const { name, bg, attrs } = validatePlayerSpec(def, spec);
  const start = 'bm_inn';
  db.prepare(`INSERT INTO characters(id,kind,name,role,tier,location_id,attributes,traits,goals,schedule,persona,data,last_meal,fatigue)
    VALUES ('player','player',?,?,0,?,?,'[]','[]','{}','',?,?,10)`).run(name, bg.name, start, J.str(attrs), J.str({ background: bg.id, visited: [start], pronouns: spec.pronouns || 'they' }), game.time);
  ledger.ensureAccount(db, 'player', { owner: 'player', kind: 'character', name });
  if (bg.money) ledger.mint(ctx, { to: 'player', amount: bg.money, memo: 'Your savings on arrival' });
  for (const [typeId, qty] of Object.entries(bg.items || {})) inv.createItems(ctx, { typeId, qty, holderKind: 'character', holderId: 'player', ownerId: 'player', reason: 'init', memo: 'starting possessions' });
  for (const it of inv.listHeld(db, 'character', 'player')) if (it.slot && it.slot === 'clothes') db.prepare('UPDATE items SET equipped=? WHERE id=?').run(it.slot, it.id);
  for (const [skill, rank] of Object.entries(bg.skills || {})) db.prepare('INSERT INTO skills(character_id,skill,xp,rank) VALUES (?,?,?,?)').run('player', skill, xpForRank(rank), rank);
  for (const f of ['f_mayor', 'f_bread_prices']) if (db.prepare('SELECT 1 FROM facts WHERE id=?').get(f)) learn(db, 'player', f, { belief: 'known', confidence: 0.9, source: 'common knowledge', time: game.time });
  if (bg.debt) {
    const d = bg.debt;
    db.prepare(`INSERT INTO contracts(kind,party_a,party_b,title,terms,status,created_at,due_at,data) VALUES ('loan',?,?,?,?,'active',?,?,?)`)
      .run(d.lender, 'player', 'Family debt to the Guild of Weights', J.str({ principal: d.amount, rate: 0, owed: d.amount }), game.time, game.time + d.days * MINUTES_PER_DAY, J.str({ repaid: 0 }));
    game.journal('note', 'An old debt', `Your family owes the Guild of Weights ${d.amount} marks, due within ${d.days} days. Aurel Vance at the Guildhall holds the note.`, 'bg_debt');
  }
  addMemory(db, { ownerId: 'player', time: game.time, summary: `Arrived in Brindlemarch with ${bg.money} marks, a ${bg.name.toLowerCase()} looking for a new start.`, importance: 6, topic: 'arrival brindlemarch', source: 'experienced', pinned: true });
  game.journal('note', 'A new start', def.intro.split('\n')[0], 'intro');
  game.journal('opportunity', 'Find work', 'Odile Varne (Guildhall), Piet Lunder (docks), Brannoc Hale (forge), Mirela Tosk (the Lantern) and Wenna Cobb (the fields) all hire help. Ask them for work.', 'find_work');
  game.journal('opportunity', 'Why is bread so dear?', 'Bread and flour prices have climbed for weeks. Someone in Brindlemarch must know why.', 'bread_mystery');
}
