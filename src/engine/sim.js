// World simulation ticks. Runs without the language model: NPC schedules, gossip,
// autonomous goals, contracts and the economy are all rule-driven and recorded.
import { J } from './db.js';
import { timeBlock, MINUTES_PER_DAY, clamp } from './rules.js';
import { dailyEconomy, marketPrice, homeSettlement } from './economy.js';
import * as inv from './inventory.js';
import { addMemory, consolidateMemories } from './memory.js';
import { belief } from './knowledge.js';
import { disposition } from './relationships.js';
import { businessDaily } from './business.js';

export const sim = {
  hourly(game) {
    moveNpcs(game);
    const cal = game.calendar();
    if (cal.hour === 20) gossip(game);
  },
  daily(game) {
    dailyEconomy(game);
    npcAgendas(game);
    contractsDaily(game);
    businessDaily(game);
    playerNeedsDaily(game);
    if (game.day % 7 === 0) {
      for (const c of game.db.prepare('SELECT id FROM characters').all()) consolidateMemories(game.db, { ownerId: c.id, now: game.time });
    }
    refreshOpportunities(game);
  },
};

export function attach(game) {
  game.attachSim(sim);
  game._npcLearned = (holderId, factId, record) => factReaction(game, holderId, factId, record);
  return game;
}

function decision(game, npcId, text, reasons, outcome = null) {
  game.db.prepare('INSERT INTO npc_decisions(time,npc_id,decision,reasons,outcome) VALUES (?,?,?,?,?)').run(game.time, npcId, text, J.str(reasons), outcome);
}

// ---------------------------------------------------------------- schedules
export function moveNpcs(game) {
  const block = timeBlock(game.time % MINUTES_PER_DAY);
  for (const c of game.db.prepare("SELECT id, location_id, schedule, busy_until, data FROM characters WHERE kind='npc' AND alive=1").all()) {
    const data = J.parse(c.data, {});
    if (data.jailed) continue;
    if (c.busy_until > game.time) continue;
    const sched = J.parse(c.schedule, {});
    const dest = sched[block];
    if (dest && dest !== c.location_id) game.db.prepare('UPDATE characters SET location_id=? WHERE id=?').run(dest, c.id);
  }
}

// ---------------------------------------------------------------- gossip
/**
 * NPCs who share a location in the evening exchange what they know. Rumours lose
 * confidence as they travel. Secrets (secrecy 2) are only shared between people who
 * trust each other deeply and are never volunteered by the person they concern.
 * NPCs also pass on hearsay about the player's notable deeds, which shifts how the
 * listener regards the player.
 */
export function gossip(game) {
  const byLoc = new Map();
  for (const c of game.db.prepare("SELECT id, location_id, traits, data FROM characters WHERE kind='npc' AND alive=1").all()) {
    if (J.parse(c.data, {}).jailed) continue;
    if (!byLoc.has(c.location_id)) byLoc.set(c.location_id, []);
    byLoc.get(c.location_id).push({ id: c.id, traits: J.parse(c.traits, []) });
  }
  for (const [loc, people] of byLoc) {
    if (people.length < 2) continue;
    for (const speaker of people) {
      const chatty = speaker.traits.includes('gossipy') ? 0.6 : speaker.traits.includes('talkative') ? 0.45 : 0.2;
      for (const listener of people) {
        if (listener.id === speaker.id) continue;
        const rel = game.rel(speaker.id, listener.id);
        if (disposition(rel) < -20) continue;
        if (!game.rng.chance(chatty)) continue;
        // share one fact
        const facts = game.db.prepare(`SELECT k.*, f.secrecy, f.subject, f.tags FROM knowledge k JOIN facts f ON f.id=k.fact_id WHERE k.holder_id=?`).all(speaker.id);
        const shareable = facts.filter((f) => {
          if (belief(game.db, listener.id, f.fact_id)) return false;
          if (f.secrecy === 2) return rel.trust >= 60 && !J.parse(f.tags, []).some((t) => speaker.id.includes(t));
          return true;
        });
        const pick = game.rng.pick(shareable);
        if (pick) {
          const conf = clamp(pick.confidence * 0.6, 0.1, 0.9);
          game.learnFact(listener.id, pick.fact_id, { belief: 'rumor', confidence: conf, source: 'gossip', sourceId: speaker.id });
          if (pick.secrecy >= 1) decision(game, speaker.id, `told ${listener.id} about ${pick.subject}`, [`evening at ${loc}`, `trust ${rel.trust}`], 'rumour spread');
        }
        // pass on hearsay about the player
        const deeds = game.db.prepare(`SELECT m.*, e.data AS edata, e.kind AS ekind FROM memories m JOIN events e ON e.id=m.event_id
          WHERE m.owner_id=? AND m.importance>=5 AND m.participants LIKE '%"player"%' AND m.time > ? ORDER BY m.time DESC LIMIT 3`).all(speaker.id, game.time - 20 * MINUTES_PER_DAY);
        for (const d of deeds) {
          const already = game.db.prepare('SELECT 1 FROM memories WHERE owner_id=? AND event_id=?').get(listener.id, d.event_id);
          if (already || !game.rng.chance(0.5)) continue;
          const speakerName = game.char(speaker.id).name;
          addMemory(game.db, { ownerId: listener.id, time: game.time, eventId: d.event_id, summary: `Heard from ${speakerName}: ${d.summary}`, participants: ['player', speaker.id], locationId: loc, importance: Math.max(2, d.importance - 2), valence: d.valence * 0.6, confidence: 0.6, topic: d.topic, source: 'hearsay' });
          const effect = J.parse(d.edata, {}).hearsay;
          if (effect) game.adjustRel(listener.id, 'player', Object.fromEntries(Object.entries(effect).map(([k, v]) => [k, Math.round(v * 0.5)])), `hearsay from ${speakerName}`, d.event_id);
          break;
        }
      }
    }
  }
}

// ---------------------------------------------------------------- fact reactions
export function factReaction(game, holderId, factId, record) {
  const f = game.db.prepare('SELECT * FROM facts WHERE id=?').get(factId);
  if (!f) return;
  const reaction = J.parse(f.data, {}).reactions?.[holderId];
  if (!reaction || record.confidence < 0.7) return;
  const flags = game.db.prepare("SELECT value FROM meta WHERE key='world_flags'").get();
  const wf = flags ? JSON.parse(flags.value) : {};
  if (wf[reaction]) return;
  if (reaction === 'expose_hoard') exposeHoard(game, holderId, record);
  if (reaction === 'arrest_jory') arrestJory(game, holderId, record);
}

function setFlag(game, key, value = true) {
  const r = game.db.prepare("SELECT value FROM meta WHERE key='world_flags'").get();
  const wf = r ? JSON.parse(r.value) : {};
  wf[key] = value;
  game.db.prepare("INSERT INTO meta(key,value) VALUES('world_flags',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(JSON.stringify(wf));
}
export function getFlags(game) {
  const r = game.db.prepare("SELECT value FROM meta WHERE key='world_flags'").get();
  return r ? JSON.parse(r.value) : {};
}

function exposeHoard(game, heddaId, record) {
  setFlag(game, 'expose_hoard', game.day);
  const store = 'bm_mill_granary';
  const moved = [];
  for (const it of game.db.prepare("SELECT type_id, SUM(quantity) q FROM items WHERE holder_kind='hidden' AND holder_id=? GROUP BY type_id").all(store)) {
    inv.moveItems(game.ctx, { typeId: it.type_id, qty: it.q, from: { kind: 'hidden', id: store }, to: { kind: 'character', id: 'npc_tamsin' }, newOwner: 'npc_tamsin', memo: 'seized hoard released to the market' });
    moved.push(`${it.q} ${it.type_id}`);
  }
  const informant = record.source_id;
  const ev = game.recordEvent({
    kind: 'scandal', actor: heddaId, target: 'npc_corvin', location: 'bm_mill',
    summary: `Captain Hedda Strom broke the chains on the mill's lower granary and found the mayor's hoard (${moved.join(', ')}). The grain is ordered back to market.`,
    visibility: 'public', importance: 9, data: { informant, moved },
  });
  // the truth becomes common knowledge in Brindlemarch
  for (const n of game.db.prepare("SELECT id FROM characters WHERE alive=1").all()) {
    if (homeSettlement(game, n.id) === 'brindlemarch' || n.id === 'player') game.learnFact(n.id, 'f_grain_hoard', { belief: 'known', confidence: 1, source: 'public scandal' });
  }
  for (const n of game.def.npcs) {
    if (n.id === 'npc_corvin' || homeSettlement(game, n.id) !== 'brindlemarch') continue;
    game.adjustRel(n.id, 'npc_corvin', { trust: -40, respect: -30 }, 'the granary scandal', ev.eventId);
  }
  if (informant === 'player') {
    game.adjustRel('npc_corvin', 'player', { trust: -60, affection: -50, rivalry: 60 }, 'exposed his hoard', ev.eventId);
    game.adjustRel('npc_hedda', 'player', { trust: 25, respect: 25 }, 'brought her proof of the hoard', ev.eventId);
    for (const n of ['npc_wenna', 'npc_mirela', 'npc_aldous', 'npc_piet']) game.adjustRel(n, 'player', { respect: 15, affection: 10 }, 'helped expose the mayor', ev.eventId);
    game.db.prepare("UPDATE events SET data=? WHERE id=?").run(J.str({ informant, moved, hearsay: { respect: 15, trust: 10 } }), ev.eventId);
  }
  game.adjustRel('npc_tamsin', 'npc_corvin', { fear: -30, trust: -20 }, 'the scandal', ev.eventId);
  decision(game, heddaId, 'raid the mill granary', ['learned of the hoard', `confidence ${record.confidence.toFixed(2)}`, 'distrusts the mayor'], `released ${moved.join(', ')}`);
  game.closeJournal('opportunity', 'bread_mystery', 'done');
  game.journal('consequence', 'The granary scandal', `Captain Strom has seized the mayor's hidden grain. Bread prices should ease as it returns to market.`, 'scandal');
}

function arrestJory(game, heddaId, record) {
  setFlag(game, 'arrest_jory', game.day);
  game.setCharData('npc_jory', { jailed: true });
  game.updateChar('npc_jory', { location_id: 'bm_hall' });
  const informant = record.source_id;
  const ev = game.recordEvent({ kind: 'arrest', actor: heddaId, target: 'npc_jory', location: 'bm_narrows', summary: 'The watch arrested Jory Pell in the Narrows for receiving stolen goods.', visibility: 'public', importance: 8, data: { informant } });
  decision(game, heddaId, 'arrest Jory Pell', ['learned he fences stolen goods', `confidence ${record.confidence.toFixed(2)}`], 'Jory jailed');
  if (informant === 'player') {
    game.adjustRel('npc_jory', 'player', { trust: -60, affection: -40, rivalry: 50 }, 'informed on him', ev.eventId);
    game.adjustRel('npc_hedda', 'player', { trust: 20, respect: 15 }, 'gave her the fence', ev.eventId);
    game.db.prepare('INSERT INTO reputation(faction_id, character_id, value) VALUES (?,?,?) ON CONFLICT(faction_id, character_id) DO UPDATE SET value=MAX(-100, value-40)').run('fac_narrows', 'player', -40);
  }
}

// ---------------------------------------------------------------- NPC agendas
function npcAgendas(game) {
  const flags = getFlags(game);
  const cal = game.calendar();
  // Mayor's hoard: quietly buys grain and flour from the mill into the chained granary
  const corvin = game.char('npc_corvin');
  if (corvin?.alive && !flags.expose_hoard) {
    const def = game.npcDef('npc_corvin').hoard;
    const hoarded = game.db.prepare("SELECT COALESCE(SUM(quantity),0) q FROM items WHERE holder_kind='hidden' AND holder_id=?").get(def.store).q;
    if (hoarded < 160 && cal.month < 7) {
      for (const t of def.types) {
        const have = inv.countHeld(game.db, 'character', def.partner, t);
        const q = Math.min(def.per_day, Math.max(0, have - 2));
        const price = marketPrice(game, 'brindlemarch', t);
        if (q > 0 && game.balance('npc_corvin') >= q * price) {
          game.pay('npc_corvin', def.partner, q * price, `Mayor buys ${t} for the granary`, 'trade');
          inv.moveItems(game.ctx, { typeId: t, qty: q, from: { kind: 'character', id: def.partner }, to: { kind: 'hidden', id: def.store }, newOwner: 'npc_corvin', memo: 'into the chained granary' });
          decision(game, 'npc_corvin', `hoard ${q} ${t}`, [`granary holds ${hoarded}`, `${t} price ${price}`, 'winter is coming; scarcity will pay'], 'stored secretly');
        }
      }
    } else if (cal.month >= 7 && hoarded > 0 && !flags.hoard_sold) {
      // after harvest the mayor sells the hoard at the high prices he engineered
      setFlag(game, 'hoard_sold', game.day);
      for (const it of game.db.prepare("SELECT type_id, SUM(quantity) q FROM items WHERE holder_kind='hidden' AND holder_id=? GROUP BY type_id").all(def.store)) {
        inv.moveItems(game.ctx, { typeId: it.type_id, qty: it.q, from: { kind: 'hidden', id: def.store }, to: { kind: 'character', id: def.partner }, memo: 'hoard released for sale' });
      }
      decision(game, 'npc_corvin', 'sell the hoard', ['harvest season', 'prices at their peak'], 'grain released through the mill');
    }
  }
  // Sabine undercuts Odile
  const sabineDef = game.npcDef('npc_sabine');
  const sab = game.char('npc_sabine');
  if (sab?.alive && !sab.data.gave_up) {
    const markup = sab.data.markup ?? sabineDef.shop.markup;
    const odileBal = game.balance('npc_odile');
    if (odileBal > 40 && markup > 0.03) {
      const nm = Math.round((markup - 0.01) * 100) / 100;
      game.setCharData('npc_sabine', { markup: nm });
      if (game.day % 5 === 0) decision(game, 'npc_sabine', 'cut prices', [`Odile still has ${odileBal} marks`, 'ruin_odile goal'], `markup now ${nm}`);
    }
  }
  // Odile's debt: she must repay the Guild by Harvestide (month 7)
  const od = game.char('npc_odile');
  if (od?.alive && !od.data.debt_resolved) {
    const owed = od.data.debt ?? game.npcDef('npc_odile').debt ?? 150;
    const bal = game.balance('npc_odile');
    // small instalments from trade; a windfall (investment, a profitable venture) lets her pay a lump sum
    const instalment = bal > 300 ? bal - 150 : bal > 60 ? 3 : 0;
    if (owed > 0 && instalment > 0) {
      const pay = Math.min(owed, instalment);
      if (pay > 0) {
        game.pay('npc_odile', 'fac_guild', pay, 'Odile repays her guild debt', 'loan_repayment');
        game.setCharData('npc_odile', { debt: owed - pay, debt_resolved: owed - pay <= 0 });
        decision(game, 'npc_odile', `repay ${pay} of her debt`, [`owed ${owed}`, 'surplus funds'], `owes ${owed - pay}`);
      }
    } else if (owed > 0 && cal.month >= 7 && !od.data.bankrupt) {
      game.setCharData('npc_odile', { bankrupt: true });
      const seized = [];
      for (const it of game.held('npc_odile')) {
        if (!it.type_data || it.equipped) continue;
        inv.moveItems(game.ctx, { typeId: it.type_id, qty: it.quantity, from: { kind: 'character', id: 'npc_odile' }, to: { kind: 'character', id: 'npc_aurel' }, newOwner: 'npc_aurel', itemId: it.id, memo: 'seized by the Guild for debt' });
        seized.push(it.type_id);
      }
      game.recordEvent({ kind: 'bankruptcy', actor: 'npc_aurel', target: 'npc_odile', location: 'bm_guild', summary: 'The Guild of Weights seized Odile Varne\'s stock for her unpaid debt.', visibility: 'public', importance: 8 });
      decision(game, 'npc_aurel', "seize Odile's stock", [`she owes ${owed}`, 'deadline passed'], seized.join(', '));
      game.setCharData('npc_sabine', { gave_up: true });
    }
  }
  // Jory's crew picks pockets; the watch grows suspicious
  const jory = game.char('npc_jory');
  if (jory?.alive && !jory.data.jailed && game.rng.chance(game.npcDef('npc_jory').thief.chance)) {
    const take = game.rng.int(3, 9);
    if (game.balance('pop_brindlemarch') > take) {
      game.pay('pop_brindlemarch', 'npc_jory', take, 'Purses lifted in the market', 'theft');
      decision(game, 'npc_jory', 'work the market crowds', ['profit goal', 'watch not watching'], `took ${take}`);
      const hb = belief(game.db, 'npc_hedda', 'f_jory_fence');
      if (game.rng.chance(0.15)) game.learnFact('npc_hedda', 'f_jory_fence', { belief: 'suspected', confidence: 0.12, source: 'investigation', sourceId: 'npc_hedda' });
      void hb;
    }
  }
}

// ---------------------------------------------------------------- contracts
function contractsDaily(game) {
  const db = game.db;
  for (const c of db.prepare("SELECT * FROM contracts WHERE status IN ('active','offered') AND due_at IS NOT NULL AND due_at < ?").all(game.time)) {
    const terms = J.parse(c.terms, {});
    if (c.kind === 'loan' && c.status === 'active') {
      db.prepare("UPDATE contracts SET status='defaulted' WHERE id=?").run(c.id);
      const lender = game.char(c.party_a);
      const ev = game.recordEvent({ kind: 'default', actor: c.party_b, target: c.party_a, location: lender?.location_id, summary: `${game.char(c.party_b).name} defaulted on a loan of ${terms.owed} marks owed to ${lender?.name}.`, visibility: 'private', importance: 7, data: { hearsay: { trust: -20 } } });
      game.adjustRel(c.party_a, c.party_b, { trust: -45, respect: -25 }, 'defaulted on a loan', ev.eventId);
      db.prepare('INSERT INTO reputation(faction_id, character_id, value) VALUES (?,?,?) ON CONFLICT(faction_id, character_id) DO UPDATE SET value=MAX(-100, value-30)').run('fac_guild', c.party_b, -30);
      game.journal('consequence', 'Loan in default', `You failed to repay ${lender?.name}. The Guild of Weights will remember.`, `default:${c.id}`);
    }
    if (c.kind === 'request' && c.status === 'active') {
      db.prepare("UPDATE contracts SET status='breached' WHERE id=?").run(c.id);
      game.adjustRel(c.party_a, c.party_b, { trust: -15 }, `did not finish "${c.title}" in time`);
      game.journal('consequence', `Failed: ${c.title}`, `You did not finish "${c.title}" in time. ${game.char(c.party_a).name} is disappointed.`, `req:${c.id}`, 'failed');
    }
    if (c.kind === 'rent' && c.status === 'active') {
      // rent contracts roll daily; handled by business ticks
    }
  }
  // warn about loans due soon
  for (const c of db.prepare("SELECT * FROM contracts WHERE kind='loan' AND status='active' AND party_b='player' AND due_at BETWEEN ? AND ?").all(game.time, game.time + 3 * MINUTES_PER_DAY)) {
    const terms = J.parse(c.terms, {});
    game.journal('consequence', 'Loan due soon', `${terms.owed} marks are due to ${game.char(c.party_a).name} by ${game.calendar(c.due_at).short}.`, `due:${c.id}`);
  }
}

function playerNeedsDaily(game) {
  const p = game.player();
  if (game.time - p.last_meal > 3 * MINUTES_PER_DAY) {
    game.hurt(p.id, 6, 'starvation');
    game.digest.push({ time: game.time, kind: 'hunger', summary: 'You are starving. Hunger is wearing you down.', importance: 6 });
    if (game.balance(p.id) < 3) game.journal('opportunity', 'Alms at the temple', 'You are starving and penniless. The Temple of the Still Ring feeds the destitute once a day.', 'alms');
  }
  if (p.health < 100 && p.health > 0 && game.time - p.last_meal < MINUTES_PER_DAY) game.heal(p.id, 3);
}

// ---------------------------------------------------------------- opportunities
function refreshOpportunities(game) {
  const db = game.db;
  const knows = (f) => !!belief(db, 'player', f);
  if (knows('f_kestrel_salt')) game.journal('opportunity', 'Salt to Kestrel Point', `Salt costs about ${marketPrice(game, 'brindlemarch', 'salt')}m here and fetches about ${marketPrice(game, 'kestrel', 'salt')}m at Kestrel Point. The riverboat from the docks costs 6m.`, 'salt_trade');
  if (knows('f_kestrel_spices')) game.journal('opportunity', 'Spices from Kestrel', `Spices sell for about ${marketPrice(game, 'brindlemarch', 'spices')}m in Brindlemarch but about ${marketPrice(game, 'kestrel', 'spices')}m at Kestrel Point.`, 'spice_trade');
  if (knows('f_observatory') && !getFlags(game).astrolabe_found) game.journal('opportunity', 'The Sunken Observatory', 'A Ring-age observatory is said to lie deep in the Whisperwood beyond Cobb\'s Fields.', 'observatory');
  if (knows('f_grain_hoard') && !getFlags(game).expose_hoard) game.journal('opportunity', 'The mayor\'s hoard', 'You know the mayor is hoarding grain. Who in Brindlemarch would act on that — and would they believe you without proof?', 'hoard_known');
}
