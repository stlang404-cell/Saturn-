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
import { runAgendas, runReaction, getFlags, decision } from './agendas.js';

export const sim = {
  hourly(game) {
    moveNpcs(game);
    approachPlayer(game);
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

// ---------------------------------------------------------------- NPC-initiated encounters
/**
 * NPCs with something to ask take the initiative when they share a place with the
 * player: a merchant with a delivery, a healer short of herbs. The offer becomes known
 * to the player (journal + world digest) without the player having to ask.
 */
export function approachPlayer(game) {
  const p = game.player();
  if (!p?.alive) return;
  const here = game.charactersAt(p.location_id, { excludeId: p.id }).filter((c) => c.kind === 'npc' && !c.data.jailed);
  for (const npc of here) {
    const req = game.db.prepare("SELECT * FROM contracts WHERE kind='request' AND party_a=? AND party_b=? AND status='offered'").get(npc.id, p.id);
    if (!req) continue;
    const data = J.parse(req.data, {});
    if (data.known || data.approached) continue;
    if (game.rel(npc.id, p.id).trust < -20 || !game.rng.chance(0.35)) continue;
    data.known = true;
    data.approached = true;
    game.db.prepare('UPDATE contracts SET data=? WHERE id=?').run(J.str(data), req.id);
    const terms = J.parse(req.terms, {});
    game.journal('opportunity', req.title, `${terms.text} Reward: ${game.money(terms.reward)}. (Say you accept it while ${npc.name} is present.)`, `req:${req.id}`);
    game.recordEvent({ kind: 'approach', actor: npc.id, target: p.id, summary: `${npc.name} approached ${p.name} with a request: ${terms.text}`, visibility: 'private', importance: 4, data: { request: req.id } });
    game.digest.push({ time: game.time, kind: 'approach', summary: `${npc.name} approaches you: "${terms.text.replace(/^.*?\b(needs|wants|will pay well for)\b/, 'I need')}" (reward ${game.money(terms.reward)})`, importance: 5 });
    decision(game, npc.id, 'approach the newcomer with a request', [`needs: ${req.title}`, 'the newcomer is here'], 'offer made');
    return;
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

// ---------------------------------------------------------------- fact reactions & agendas (generic, data-driven)
export function factReaction(game, holderId, factId, record) {
  runReaction(game, holderId, factId, record);
}
export { getFlags };

function npcAgendas(game) {
  runAgendas(game);
}

// ---------------------------------------------------------------- contracts
function contractsDaily(game) {
  const db = game.db;
  for (const c of db.prepare("SELECT * FROM contracts WHERE status IN ('active','offered') AND due_at IS NOT NULL AND due_at < ?").all(game.time)) {
    const terms = J.parse(c.terms, {});
    if (c.kind === 'loan' && c.status === 'active') {
      db.prepare("UPDATE contracts SET status='defaulted' WHERE id=?").run(c.id);
      const lender = game.char(c.party_a);
      const ev = game.recordEvent({ kind: 'default', actor: c.party_b, target: c.party_a, location: lender?.location_id, summary: `${game.char(c.party_b).name} defaulted on a loan of ${game.money(terms.owed)} owed to ${lender?.name}.`, visibility: 'private', importance: 7, data: { hearsay: { trust: -20 } } });
      game.adjustRel(c.party_a, c.party_b, { trust: -45, respect: -25 }, 'defaulted on a loan', ev.eventId);
      const fac = db.prepare('SELECT faction_id FROM faction_members WHERE character_id=?').get(c.party_a)?.faction_id;
      if (fac) db.prepare('INSERT INTO reputation(faction_id, character_id, value) VALUES (?,?,?) ON CONFLICT(faction_id, character_id) DO UPDATE SET value=MAX(-100, value-30)').run(fac, c.party_b, -30);
      game.journal('consequence', 'Loan in default', `You failed to repay ${lender?.name}.${fac ? ` ${db.prepare('SELECT name FROM factions WHERE id=?').get(fac).name} will remember.` : ''}`, `default:${c.id}`);
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
    game.journal('consequence', 'Loan due soon', `${game.money(terms.owed)} are due to ${game.char(c.party_a).name} by ${game.calendar(c.due_at).short}.`, `due:${c.id}`);
  }
}

function playerNeedsDaily(game) {
  const p = game.player();
  if (game.time - p.last_meal > 3 * MINUTES_PER_DAY) {
    game.hurt(p.id, 6, 'starvation');
    game.digest.push({ time: game.time, kind: 'hunger', summary: 'You are starving. Hunger is wearing you down.', importance: 6 });
    const charity = game.db.prepare("SELECT name, tags FROM locations").all().find((l) => J.parse(l.tags, []).includes('charity') || J.parse(l.tags, []).includes('healing'));
    if (game.balance(p.id) < 3 && charity) game.journal('opportunity', 'Charity', `You are starving and penniless. ${charity.name} feeds the destitute once a day.`, 'alms');
  }
  if (p.health < 100 && p.health > 0 && game.time - p.last_meal < MINUTES_PER_DAY) game.heal(p.id, 3);
}

// ---------------------------------------------------------------- opportunities
function refreshOpportunities(game) {
  // Facts may carry an opportunity that appears in the journal once the player knows them.
  // Text may reference live prices: {price:<settlement>:<item>}.
  for (const f of game.db.prepare("SELECT f.id, f.data FROM knowledge k JOIN facts f ON f.id=k.fact_id WHERE k.holder_id=?").all(game.playerId)) {
    const opp = J.parse(f.data, {}).opportunity;
    if (!opp) continue;
    if (opp.unless_flag && getFlags(game)[opp.unless_flag]) continue;
    const text = String(opp.text).replace(/\{price:([a-z0-9_]+):([a-z0-9_]+)\}/g, (_, s, t) => game.money(marketPrice(game, s, t)));
    game.journal('opportunity', opp.title, text, `fact:${f.id}`);
  }
}
