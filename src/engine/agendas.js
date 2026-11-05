// Generic, declarative NPC agendas and fact reactions.
//
// Worlds give NPCs agendas in their World Specification, e.g.
//   "agendas": [{ "type": "stockpile", "partner": "npc_x", "types": ["grain"], "per_day": 3, "store": "secret_store", "until_month": 7 }]
// and give facts reactions, e.g.
//   "reactions": { "npc_guard": { "type": "seize_store", "store": "secret_store", "release_to": "npc_x", "culprit": "npc_y" } }
// The engine implements each type once; worlds (hand-written or AI-generated) only supply data.
// Every decision is logged in npc_decisions with its reasons.
import { J } from './db.js';
import * as inv from './inventory.js';
import { marketPrice, homeSettlement } from './economy.js';

export const AGENDA_TYPES = ['stockpile', 'undercut', 'debt', 'pilfer', 'adopt_innovations'];
export const REACTION_TYPES = ['seize_store', 'arrest', 'publicize'];

export function decision(game, npcId, text, reasons, outcome = null) {
  game.db.prepare('INSERT INTO npc_decisions(time,npc_id,decision,reasons,outcome) VALUES (?,?,?,?,?)').run(game.time, npcId, text, J.str(reasons), outcome);
}

export function getFlags(game) {
  const r = game.db.prepare("SELECT value FROM meta WHERE key='world_flags'").get();
  return r ? JSON.parse(r.value) : {};
}
export function setFlag(game, key, value = true) {
  const wf = getFlags(game);
  wf[key] = value;
  game.db.prepare("INSERT INTO meta(key,value) VALUES('world_flags',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(JSON.stringify(wf));
}

const storeTotal = (game, store) => game.db.prepare("SELECT COALESCE(SUM(quantity),0) q FROM items WHERE holder_kind='hidden' AND holder_id=?").get(store).q;
const alive = (game, id) => !!game.char(id)?.alive && !game.char(id)?.data?.jailed;

// ---------------------------------------------------------------- agendas
const AGENDAS = {
  /** Quietly buy goods from a partner into a hidden store to create scarcity; release them later. */
  stockpile(game, npc, a, flags) {
    if (flags[`seized:${a.store}`]) return;
    const cal = game.calendar();
    const held = storeTotal(game, a.store);
    const settlement = homeSettlement(game, npc.id);
    if (held < (a.max ?? 160) && cal.month < (a.until_month ?? 12)) {
      for (const t of a.types || []) {
        const q = Math.min(a.per_day ?? 2, Math.max(0, inv.countHeld(game.db, 'character', a.partner, t) - 2));
        const price = marketPrice(game, settlement, t);
        if (q > 0 && game.balance(npc.id) >= q * price) {
          game.pay(npc.id, a.partner, q * price, `${npc.name} buys ${t} for a private store`, 'trade');
          inv.moveItems(game.ctx, { typeId: t, qty: q, from: { kind: 'character', id: a.partner }, to: { kind: 'hidden', id: a.store }, newOwner: npc.id, memo: 'into a hidden store' });
          decision(game, npc.id, `stockpile ${q} ${t}`, [`store holds ${held}`, `${t} price ${price}`, a.motive || 'scarcity will pay'], 'stored secretly');
        }
      }
    } else if (held > 0 && cal.month >= (a.until_month ?? 12) && !flags[`released:${a.store}`]) {
      setFlag(game, `released:${a.store}`, game.day);
      for (const it of game.db.prepare("SELECT type_id, SUM(quantity) q FROM items WHERE holder_kind='hidden' AND holder_id=? GROUP BY type_id").all(a.store)) {
        inv.moveItems(game.ctx, { typeId: it.type_id, qty: it.q, from: { kind: 'hidden', id: a.store }, to: { kind: 'character', id: a.partner }, memo: 'stockpile released for sale' });
      }
      decision(game, npc.id, 'release the stockpile', ['season turned', 'prices at their peak'], 'goods released');
    }
  },

  /** Cut one's own markup step by step to drive a rival out of business. */
  undercut(game, npc, a) {
    const me = game.char(npc.id);
    const rival = game.char(a.rival);
    if (!rival || rival.data.bankrupt || me.data.gave_up) return;
    const markup = me.data.markup ?? npc.shop?.markup ?? 0.2;
    if (game.balance(a.rival) > 40 && markup > (a.floor ?? 0.03)) {
      const nm = Math.round((markup - (a.step ?? 0.01)) * 100) / 100;
      game.setCharData(npc.id, { markup: nm });
      if (game.day % 5 === 0) decision(game, npc.id, 'cut prices', [`${rival.name} still trading`, a.motive || 'rivalry'], `markup now ${nm}`);
    }
  },

  /** Owe a creditor; repay in instalments (or a lump sum after a windfall); be ruined at the deadline. */
  debt(game, npc, a) {
    const me = game.char(npc.id);
    if (me.data.debt_resolved || me.data.bankrupt) return;
    const owed = me.data.debt ?? a.amount;
    const bal = game.balance(npc.id);
    const instalment = bal > (a.lump_over ?? 300) ? bal - Math.round((a.lump_over ?? 300) / 2) : bal > 60 ? (a.instalment ?? 3) : 0;
    if (owed > 0 && instalment > 0) {
      const pay = Math.min(owed, instalment);
      game.pay(npc.id, a.creditor, pay, `${npc.name} repays a debt`, 'loan_repayment');
      game.setCharData(npc.id, { debt: owed - pay, debt_resolved: owed - pay <= 0 });
      decision(game, npc.id, `repay ${pay} of a debt`, [`owed ${owed}`], `owes ${owed - pay}`);
    } else if (owed > 0 && game.calendar().month >= (a.due_month ?? 12)) {
      game.setCharData(npc.id, { bankrupt: true });
      const seizeTo = a.seize_to || null;
      const seized = [];
      if (seizeTo && game.char(seizeTo)) {
        for (const it of game.held(npc.id)) {
          if (it.equipped) continue;
          inv.moveItems(game.ctx, { typeId: it.type_id, qty: it.quantity, from: { kind: 'character', id: npc.id }, to: { kind: 'character', id: seizeTo }, newOwner: seizeTo, itemId: it.id, memo: 'seized for debt' });
          seized.push(it.type_id);
        }
      }
      game.recordEvent({ kind: 'bankruptcy', actor: seizeTo || npc.id, target: npc.id, location: game.char(seizeTo || npc.id).location_id, summary: a.ruin_text || `${npc.name} was ruined by an unpaid debt.`, visibility: 'public', importance: 8 });
      decision(game, seizeTo || npc.id, `seize ${npc.name}'s goods`, [`owed ${owed}`, 'deadline passed'], seized.join(', '));
      for (const n of game.def.npcs) for (const ag of n.agendas || []) if (ag.type === 'undercut' && ag.rival === npc.id) game.setCharData(n.id, { gave_up: true });
    }
  },

  /** Petty theft from the townsfolk; a watcher may grow suspicious of a fact over time. */
  pilfer(game, npc, a) {
    if (!game.rng.chance(a.chance ?? 0.2)) return;
    const victim = `pop_${homeSettlement(game, npc.id)}`;
    const take = game.rng.int(a.min ?? 2, a.max ?? 8);
    if (game.balance(victim) <= take) return;
    game.pay(victim, npc.id, take, a.memo || 'Purses lifted in the crowd', 'theft');
    decision(game, npc.id, 'pilfer from the crowds', [a.motive || 'profit'], `took ${take}`);
    const s = a.suspicion;
    if (s && alive(game, s.watcher) && game.rng.chance(s.chance ?? 0.15)) game.learnFact(s.watcher, s.fact, { belief: 'suspected', confidence: s.confidence ?? 0.12, source: 'investigation', sourceId: s.watcher });
  },

  /**
   * Innovation diffusion: an NPC skilled enough in an innovation's skill, who has heard of it,
   * may learn to use it (gaining the capability) and then produce/use it like anyone else.
   */
  adopt_innovations(game, npc, a) {
    const rows = game.db.prepare("SELECT * FROM world_rules WHERE status='active' AND origin<>'world'").all();
    for (const r of rows) {
      const spec = J.parse(r.spec, {});
      if (!spec.fact || game.db.prepare('SELECT 1 FROM capabilities WHERE holder_id=? AND rule_id=?').get(npc.id, r.id)) continue;
      const b = game.db.prepare('SELECT * FROM knowledge WHERE holder_id=? AND fact_id=?').get(npc.id, spec.fact);
      if (!b || b.confidence < 0.5) continue;
      const rank = game.skill(npc.id, game.skillFor(spec.skill)).rank;
      if (rank < (spec.adopt_rank ?? 3) || !game.rng.chance(a.chance ?? 0.1)) continue;
      game.db.prepare('INSERT OR IGNORE INTO capabilities(holder_id, rule_id, acquired_at, source) VALUES (?,?,?,?)').run(npc.id, r.id, game.time, 'adopted');
      const ev = game.recordEvent({ kind: 'adoption', actor: npc.id, summary: `${npc.name} has learned to use ${r.name}.`, visibility: 'public', importance: 6, data: { rule: r.id } });
      decision(game, npc.id, `adopt ${r.name}`, [`heard of it (${Math.round(b.confidence * 100)}%)`, `skill rank ${rank}`], 'capability gained');
      if (r.created_by === 'player') game.adjustRel(npc.id, 'player', { respect: 5 }, `adopted your ${r.name}`, ev.eventId);
    }
  },
};

export function runAgendas(game) {
  const flags = getFlags(game);
  for (const npc of game.def.npcs || []) {
    if (!alive(game, npc.id)) continue;
    for (const a of npc.agendas || []) {
      const fn = AGENDAS[a.type];
      if (fn) fn(game, npc, a, flags);
    }
  }
}

// ---------------------------------------------------------------- reactions
export function runReaction(game, holderId, factId, record) {
  const f = game.db.prepare('SELECT * FROM facts WHERE id=?').get(factId);
  if (!f) return;
  const reaction = J.parse(f.data, {}).reactions?.[holderId];
  if (!reaction || record.confidence < (reaction.min_confidence ?? 0.7)) return;
  const key = `reaction:${factId}:${holderId}`;
  if (getFlags(game)[key]) return;
  setFlag(game, key, game.day);
  const fn = REACTIONS[reaction.type];
  if (fn) fn(game, holderId, f, reaction, record);
}

const REACTIONS = {
  /** Raid a hidden store: release its goods, make the fact public, turn opinion on the culprit. */
  seize_store(game, actorId, fact, r, record) {
    setFlag(game, `seized:${r.store}`, game.day);
    const moved = [];
    for (const it of game.db.prepare("SELECT type_id, SUM(quantity) q FROM items WHERE holder_kind='hidden' AND holder_id=? GROUP BY type_id").all(r.store)) {
      const to = r.release_to || actorId;
      inv.moveItems(game.ctx, { typeId: it.type_id, qty: it.q, from: { kind: 'hidden', id: r.store }, to: { kind: 'character', id: to }, newOwner: to, memo: 'seized store released' });
      moved.push(`${it.q} ${game.itemType(it.type_id)?.name || it.type_id}`);
    }
    const informant = record.source_id;
    const actor = game.char(actorId);
    const ev = game.recordEvent({
      kind: 'scandal', actor: actorId, target: r.culprit || null, location: r.location || actor.location_id,
      summary: r.summary ? `${r.summary} (${moved.join(', ')})` : `${actor.name} raided a hidden store and exposed it (${moved.join(', ') || 'empty'}).`,
      visibility: 'public', importance: 9, data: { informant, moved, ...(informant === 'player' ? { hearsay: { respect: 15, trust: 10 } } : {}) },
    });
    publicize(game, fact.id, homeSettlement(game, actorId));
    if (r.culprit) for (const n of game.def.npcs) if (n.id !== r.culprit && homeSettlement(game, n.id) === homeSettlement(game, actorId)) game.adjustRel(n.id, r.culprit, { trust: -40, respect: -30 }, 'the scandal', ev.eventId);
    if (informant === 'player') {
      if (r.culprit) game.adjustRel(r.culprit, 'player', { trust: -60, affection: -50, rivalry: 60 }, 'exposed me', ev.eventId);
      game.adjustRel(actorId, 'player', { trust: 25, respect: 25 }, 'brought proof', ev.eventId);
    }
    decision(game, actorId, 'raid the hidden store', ['learned the truth', `confidence ${record.confidence.toFixed(2)}`], `released ${moved.join(', ')}`);
    if (r.close_journal) game.closeJournal('opportunity', r.close_journal, 'done');
    game.journal('consequence', r.journal_title || 'A scandal breaks', r.journal_body || ev && `${actor.name} acted on what you revealed.`, `scandal:${fact.id}`);
  },

  /** Arrest a target: they are jailed (stop acting), the informant is remembered. */
  arrest(game, actorId, fact, r, record) {
    const target = game.char(r.target);
    if (!target) return;
    game.setCharData(r.target, { jailed: true });
    if (r.jail_location) game.updateChar(r.target, { location_id: r.jail_location });
    const informant = record.source_id;
    const ev = game.recordEvent({ kind: 'arrest', actor: actorId, target: r.target, location: target.location_id, summary: r.summary || `${game.char(actorId).name} arrested ${target.name}.`, visibility: 'public', importance: 8, data: { informant } });
    decision(game, actorId, `arrest ${target.name}`, [`believes: ${fact.subject}`, `confidence ${record.confidence.toFixed(2)}`], 'jailed');
    if (informant === 'player') {
      game.adjustRel(r.target, 'player', { trust: -60, affection: -40, rivalry: 50 }, 'informed on me', ev.eventId);
      game.adjustRel(actorId, 'player', { trust: 20, respect: 15 }, 'provided information', ev.eventId);
      if (r.faction_penalty) game.db.prepare('INSERT INTO reputation(faction_id, character_id, value) VALUES (?,?,?) ON CONFLICT(faction_id, character_id) DO UPDATE SET value=MAX(-100, value-40)').run(r.faction_penalty, 'player', -40);
    }
  },

  /** Spread the fact as public knowledge. */
  publicize(game, actorId, fact) {
    publicize(game, fact.id, homeSettlement(game, actorId));
    game.recordEvent({ kind: 'announcement', actor: actorId, summary: `${game.char(actorId).name} made it known: ${fact.content}`, visibility: 'public', importance: 6 });
  },
};

export function publicize(game, factId, settlement) {
  for (const n of game.db.prepare('SELECT id FROM characters WHERE alive=1').all()) {
    if (n.id === game.playerId || homeSettlement(game, n.id) === settlement) game.learnFact(n.id, factId, { belief: 'known', confidence: 1, source: 'public knowledge' });
  }
}
