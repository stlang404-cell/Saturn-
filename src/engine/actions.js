// The action catalog. Each action validates its parameters against authoritative
// state, performs any checks through the engine, and commits consequences. Handlers
// throw RuleError when an action is not possible; the turn executor rolls that
// action back cleanly.
import { J } from './db.js';
import { RuleError } from './ledger.js';
import * as inv from './inventory.js';
import { quote, executeTrade, marketPrice, homeSettlement } from './economy.js';
import { factsAbout, belief, getFact, worldFactsAbout } from './knowledge.js';
import { retrieveMemories } from './memory.js';
import { socialMod, attitudeLabel, disposition } from './relationships.js';
import { LEARNING_METHODS, studyXpPerHour, MINUTES_PER_DAY, clamp, xpForRank, round2 } from './rules.js';
import { DIFFICULTY, isSuccess, isAtLeastPartial, DEGREE_LABEL } from './dice.js';
import { resolveCharacter, resolveItemType, resolveLocation, norm } from './resolve.js';
import { foundBusiness, businessesOf, businessOp, addInvestor, premisesList, getBusiness } from './business.js';
import { getFlags, setFlag } from './agendas.js';
import { findRule, useRule, hasCapability, grantCapability } from './worldrules.js';

export const ACTION_TYPES = [
  'look', 'move', 'talk', 'tell', 'ask_job', 'accept_request', 'buy', 'sell', 'give', 'take', 'drop', 'steal', 'work',
  'study', 'train', 'rest', 'wait', 'eat', 'craft', 'gather', 'investigate', 'attack', 'heal', 'loan', 'repay',
  'invest', 'found_business', 'manage_business', 'research', 'attempt', 'equip', 'use', 'status', 'use_ability',
];

// Actions whose consequences warrant explicit confirmation when part of a plan
export const CONSEQUENTIAL = new Set(['steal', 'attack', 'found_business', 'loan', 'invest', 'move_long', 'research', 'manage_business']);

const fail = (code, message, details) => { throw new RuleError(code, message, details); };

function isMoneyWord(game, w) {
  const t = norm(w);
  const c = game.rules.currency;
  return ['money', 'coin', 'coins', 'cash', 'funds', norm(c.name), norm(c.plural)].includes(t);
}

function here(game) { return game.player().location_id; }

function npcsHere(game) {
  return game.charactersAt(here(game), { excludeId: game.playerId }).filter((c) => c.kind === 'npc').map((c) => ({ ...c, aliases: game.npcDef(c.id)?.aliases || [] }));
}

function needNpc(game, name, { purpose = 'do that', allowAbsentKnown = false } = {}) {
  const present = npcsHere(game);
  if (!name) {
    if (present.length === 1) return present[0];
    fail('need_target', present.length ? `Who do you want to ${purpose}? Here: ${present.map((c) => c.name).join(', ')}.` : `There is nobody here to ${purpose}.`);
  }
  const r = resolveCharacter(name, present);
  if (r.match) return r.match;
  const all = game.db.prepare("SELECT id FROM characters WHERE kind='npc'").all().map((x) => game.char(x.id));
  const elsewhere = resolveCharacter(name, all).match;
  if (elsewhere) {
    const met = game.rel(elsewhere.id, game.playerId).familiarity > 0;
    if (allowAbsentKnown) return elsewhere;
    fail('not_here', `${met ? elsewhere.name : 'That person'} is not here.${present.length ? ` Here: ${present.map((c) => c.name).join(', ')}.` : ''}`, { npc: elsewhere.id });
  }
  fail('unknown_person', `You don't see anyone called "${name}" here.${present.length ? ` Here: ${present.map((c) => c.name).join(', ')}.` : ''}`);
}

function itemCandidatesHeld(game, charId) {
  const rows = game.held(charId);
  return [...new Map(rows.map((r) => [r.type_id, { id: r.type_id, name: r.name, aliases: r.type_data?.aliases || [] }])).values()];
}

function needHeldItem(game, name, charId = game.playerId) {
  if (!name) fail('need_item', 'Which item?');
  const id = resolveItemType(name, itemCandidatesHeld(game, charId));
  if (!id) fail('not_held', `You don't have any "${name}".`);
  return id;
}

function qtyOf(p, dflt = 1) {
  const q = p.quantity == null ? dflt : Math.floor(Number(p.quantity));
  if (!Number.isFinite(q) || q <= 0) fail('bad_quantity', 'Quantity must be a positive whole number.');
  if (q > 500) fail('bad_quantity', 'That is far more than can be handled at once.');
  return q;
}

function npcMemoriesOfPlayer(game, npcId, text) {
  return retrieveMemories(game.db, { ownerId: npcId, now: game.time, text, participants: [game.playerId], limit: 5 });
}

function daily(game, key) {
  // returns true the first time `key` is used today (anti-farming guard)
  const p = game.player();
  const d = p.data.daily || {};
  const today = game.day;
  if (d[key] === today) return false;
  game.setCharData(p.id, { daily: { ...d, [key]: today } });
  return true;
}

function markVisited(game, locId) {
  const p = game.player();
  const visited = new Set(p.data.visited || []);
  if (!visited.has(locId)) { visited.add(locId); game.setCharData(p.id, { visited: [...visited] }); return true; }
  return false;
}

// ============================================================================
// look
// ============================================================================
function look(game, p) {
  const loc = game.location(here(game));
  if (p.target) {
    const people = npcsHere(game);
    const who = resolveCharacter(p.target, people).match;
    if (who) {
      const rel = game.rel(who.id, game.playerId);
      return { ok: true, minutes: 1, summary: `You look at ${who.name}.`, facts: [`${who.name}, ${who.role}. ${who.persona}`, `They seem ${attitudeLabel(rel)} toward you.`], subject: { npc: who.id } };
    }
    const itemId = resolveItemType(p.target, itemCandidatesHeld(game, game.playerId));
    if (itemId) {
      const t = game.itemType(itemId);
      return { ok: true, minutes: 1, summary: `You examine the ${t.name}.`, facts: [`${t.name}: ${t.description || t.category}. Worth about ${game.money(t.base_value)}.`] };
    }
  }
  const people = npcsHere(game);
  const exits = game.exits(loc.id);
  const ground = inv.listHeld(game.db, 'location', loc.id);
  return {
    ok: true, minutes: 1, summary: `You take in ${loc.name}.`,
    facts: [loc.description, people.length ? `Present: ${people.map((c) => `${c.name} (${c.role})`).join(', ')}.` : 'Nobody of note is here.',
      `Ways on: ${exits.map((e) => `${e.name} (${fmtMinutes(e.minutes)}${e.cost ? `, ${game.money(e.cost)}` : ''})`).join(', ')}.`,
      ...(ground.length ? [`On the ground: ${ground.map((g) => `${g.quantity} ${g.name}`).join(', ')}.`] : [])],
  };
}

export function fmtMinutes(m) {
  if (m < 60) return `${m} min`;
  if (m < MINUTES_PER_DAY) return `${Math.round(m / 6) / 10} h`;
  return `${Math.round(m / 144) / 10} days`;
}

// ============================================================================
// move
// ============================================================================
export function findPath(game, from, to) {
  // Dijkstra over routes the player knows
  const dist = new Map([[from, 0]]);
  const prev = new Map();
  const visited = new Set();
  while (true) {
    let cur = null, best = Infinity;
    for (const [k, v] of dist) if (!visited.has(k) && v < best) { best = v; cur = k; }
    if (cur == null) break;
    if (cur === to) break;
    visited.add(cur);
    for (const e of game.exits(cur)) {
      const nd = best + e.minutes;
      if (nd < (dist.get(e.to) ?? Infinity)) { dist.set(e.to, nd); prev.set(e.to, { from: cur, edge: e }); }
    }
  }
  if (!dist.has(to)) return null;
  const legs = [];
  let n = to;
  while (n !== from) { const p = prev.get(n); legs.unshift(p.edge); n = p.from; }
  return { legs, minutes: dist.get(to), cost: legs.reduce((s, l) => s + (l.cost || 0), 0) };
}

function move(game, p) {
  const all = game.db.prepare('SELECT id, name, data FROM locations').all().map((l) => ({ ...l, aliases: J.parse(l.data, {}).aliases || [] }));
  let dest = resolveLocation(p.destination || p.target, all);
  if (!dest && p.destination) {
    const npc = resolveCharacter(p.destination, game.db.prepare("SELECT id FROM characters WHERE kind='npc'").all().map((x) => game.char(x.id))).match;
    const sameTown = npc && game.knowsLocation(game.playerId, npc.location_id) && game.location(npc.location_id).settlement === game.location(here(game)).settlement;
    if (npc && (game.rel(npc.id, game.playerId).familiarity > 0 || sameTown)) dest = npc.location_id;
    else if (npc) fail('unknown_place', `You don't know where ${npc.name} is. Ask around.`);
  }
  if (!dest) fail('unknown_place', `You don't know a way to "${p.destination || p.target}".`);
  if (dest === here(game)) return { ok: true, minutes: 0, summary: `You are already at ${game.location(dest).name}.`, facts: [] };
  if (!game.knowsLocation(game.playerId, dest)) fail('unknown_place', `You don't know of any such place.`);
  const path = findPath(game, here(game), dest);
  if (!path) fail('no_route', `You know of no route to ${game.location(dest).name}.`);
  if (path.cost > game.balance(game.playerId)) fail('insufficient_funds', `The journey costs ${game.money(path.cost)} in fares; you have ${game.balance(game.playerId)}.`);
  const facts = [];
  const rolls = [];
  const firstBoat = path.legs.findIndex((l) => l.mode === 'riverboat');
  if (firstBoat >= 0) {
    const pre = path.legs.slice(0, firstBoat).reduce((s, l) => s + l.minutes, 0);
    const h = game.calendar(game.time + pre).hour;
    if (h < 5 || h >= 14) fail('no_boat', 'The riverboat only sails between dawn and early afternoon. Wait until morning (or take the long road through the fields).');
  }
  for (const leg of path.legs) {
    if (leg.cost) {
      const op = (game.def.routes || []).find((r) => ((r[0] === leg.from || r[1] === leg.from) && (r[0] === leg.to || r[1] === leg.to)))?.[3]?.operator;
      const ferryman = op && game.char(op)?.alive ? op : 'system:sink';
      if (ferryman === 'system:sink') game.burn(game.playerId, leg.cost, `Fare to ${leg.name}`);
      else game.pay(game.playerId, ferryman, leg.cost, `Riverboat fare to ${leg.name}`, 'fare');
      facts.push(`Paid ${game.money(leg.cost)} fare for the ${leg.mode}.`);
    }
    game.advance(leg.minutes, 'travel');
    game.addFatigue(game.playerId, leg.mode === 'riverboat' ? leg.minutes / 120 : leg.minutes / 25);
    if (leg.risk > 0 && game.rng.chance(leg.risk * (game.calendar().block === 'night' ? 2 : 1))) {
      const r = game.check(game.playerId, { skill: 'survival', tn: DIFFICULTY.moderate, label: `Hazard on the way to ${leg.name}` });
      rolls.push(r);
      if (!isAtLeastPartial(r.degree)) {
        const dmg = r.degree === 'severe_failure' ? 18 : 8;
        game.hurt(game.playerId, dmg, 'a fall in the wilds');
        game.advance(60, 'travel');
        facts.push(`The path turned treacherous; you took a bad fall (−${dmg} health) and lost an hour.`);
      } else facts.push('The path turned treacherous, but you picked your way through.');
    }
    game.updateChar(game.playerId, { location_id: leg.to });
    const first = markVisited(game, leg.to);
    if (first) game.recordEvent({ kind: 'discovery', actor: game.playerId, summary: `${game.player().name} reached ${leg.name} for the first time.`, visibility: 'private', importance: leg.to === 'ww_observatory' ? 7 : 3 });
  }
  const loc = game.location(dest);
  const people = npcsHere(game);
  facts.push(loc.description);
  if (people.length) facts.push(`Present: ${people.map((c) => `${c.name} (${c.role})`).join(', ')}.`);
  return { ok: true, minutes: path.minutes, summary: `You travel to ${loc.name} (${fmtMinutes(path.minutes)}).`, facts, rolls, moved: dest };
}

// ============================================================================
// talk — conversation, asking about topics, persuasion, intimidation, deception
// ============================================================================
const APPROACHES = ['chat', 'ask', 'persuade', 'intimidate', 'deceive', 'flatter', 'apologize', 'insult', 'propose'];

function talk(game, p) {
  const npc = needNpc(game, p.target, { purpose: 'talk to' });
  const def = game.npcDef(npc.id) || {};
  let approach = APPROACHES.includes(p.approach) ? p.approach : (p.topic ? 'ask' : 'chat');
  const relBefore = game.rel(npc.id, game.playerId);
  const firstMeeting = relBefore.familiarity === 0;
  const facts = [];
  const rolls = [];
  const dialogue = { npc: npc.id, npcName: npc.name, persona: npc.persona, traits: npc.traits, approach, topic: p.topic || null, said: p.detail || null, disclosed: [], unknown: false, refused: false, firstMeeting };
  let minutes = 10;
  let importance = 2, valence = 0;
  const deltas = { familiarity: firstMeeting ? 10 : 3 };
  if (npc.data.jailed) facts.push(`${npc.name} is held in a cell at the Town Hall.`);

  // friendliness grows from conversation, but only once per day per NPC
  if (approach === 'chat' && daily(game, `chat:${npc.id}`)) deltas.affection = 2;

  const smod = socialMod(relBefore);
  const relMods = smod ? [{ label: `Relationship (${attitudeLabel(relBefore)})`, value: smod }] : [];
  let checkDegree = null;
  if (approach === 'persuade' || approach === 'propose') {
    const tnBase = p.difficulty && DIFFICULTY[p.difficulty] ? clamp(DIFFICULTY[p.difficulty], DIFFICULTY.easy, DIFFICULTY.extreme) : DIFFICULTY.moderate;
    const r = game.check(game.playerId, { skill: 'persuasion', tn: tnBase + (npc.traits.includes('stubborn') || npc.traits.includes('cautious') ? 1 : 0), label: `Persuade ${npc.name}`, mods: relMods });
    rolls.push(r); checkDegree = r.degree;
    if (isSuccess(r.degree)) { deltas.respect = 3; importance = 3; }
    else if (r.degree === 'failure' || r.degree === 'severe_failure') { deltas.trust = -2; }
  } else if (approach === 'intimidate') {
    const r = game.check(game.playerId, { skill: 'intimidation', tn: DIFFICULTY.moderate + Math.max(0, game.attr(npc.id, 'presence') - 2) + (npc.traits.includes('incorruptible') ? 4 : 0), label: `Intimidate ${npc.name}`, mods: [] });
    rolls.push(r); checkDegree = r.degree;
    deltas.affection = -6; deltas.trust = -4;
    if (isSuccess(r.degree)) deltas.fear = 15; else deltas.respect = -5;
    importance = 4; valence = -0.5;
  } else if (approach === 'deceive') {
    const r = game.check(game.playerId, { skill: 'deception', label: `Deceive ${npc.name}`, opposedBy: npc.id, opposedSkill: 'perception', opposedMods: npc.traits.includes('suspicious') || npc.traits.includes('observant') ? [{ label: 'Suspicious nature', value: 2 }] : [] });
    rolls.push(r); checkDegree = r.degree;
    if (!isAtLeastPartial(r.degree)) { deltas.trust = -12; importance = 5; valence = -0.6; facts.push(`${npc.name} sees through the lie.`); dialogue.caughtLying = true; }
  } else if (approach === 'flatter') {
    const r = game.check(game.playerId, { skill: 'persuasion', tn: DIFFICULTY.easy + (npc.traits.includes('proud') ? -1 : 1), label: `Flatter ${npc.name}`, mods: relMods });
    rolls.push(r); checkDegree = r.degree;
    if (isSuccess(r.degree) && daily(game, `flatter:${npc.id}`)) deltas.affection = 4;
    else if (!isAtLeastPartial(r.degree)) deltas.respect = -3;
  } else if (approach === 'insult') {
    deltas.affection = -12; deltas.trust = -5; deltas.respect = -4; importance = 5; valence = -0.8;
  } else if (approach === 'apologize') {
    if (relBefore.trust < 0 && daily(game, `apology:${npc.id}`)) { deltas.trust = 4; deltas.affection = 3; }
  }

  // Asking about a topic: the engine decides what this NPC knows and is willing to share.
  if (p.topic && approach !== 'insult') {
    const ranked = factsAbout(game.db, npc.id, p.topic);
    const top = ranked[0]?.score || 0;
    const known = ranked.filter((f) => f.score >= Math.max(2, top * 0.6));
    if (!known.length) {
      dialogue.unknown = true;
      const exists = worldFactsAbout(game.db, p.topic).length > 0;
      facts.push(`${npc.name} does not know anything about "${p.topic}".${exists ? '' : ''}`);
    }
    const disp = disposition(game.rel(npc.id, game.playerId)) + (checkDegree && isSuccess(checkDegree) ? 25 : 0) + (checkDegree === 'critical' ? 20 : 0);
    for (const f of known.slice(0, 3)) {
      const keepers = getFact(game.db, f.fact_id)?.data?.keepers || [];
      const isKeeper = keepers.includes(npc.id) || f.tags.some((t) => npc.name.toLowerCase().split(' ').includes(t));
      let share = false;
      if (f.secrecy === 0) share = true;
      else if (f.secrecy === 1) share = disp >= 5 || (checkDegree && isAtLeastPartial(checkDegree));
      else if (f.secrecy === 2) {
        if (isKeeper) {
          // keepers only crack under strong pressure, and the nervous crack more easily
          const nervous = npc.traits.includes('nervous') || npc.traits.includes('guilty conscience');
          share = (checkDegree === 'critical') || (nervous && (checkDegree === 'strong' || checkDegree === 'critical')) || (approach === 'intimidate' && nervous && isSuccess(checkDegree || 'failure'));
          if (!share) dialogue.keeperDenies = true;
        } else share = disp >= 45 || checkDegree === 'strong' || checkDegree === 'critical';
      }
      if (share) {
        const conf = f.belief === 'known' ? 0.75 : Math.min(0.6, f.confidence);
        const res = game.learnFact(game.playerId, f.fact_id, { belief: f.belief === 'known' ? 'suspected' : 'rumor', confidence: conf, source: `told by ${npc.name}`, sourceId: npc.id });
        dialogue.disclosed.push({ fact: f.fact_id, content: f.content, npcBelief: f.belief, npcConfidence: round2(f.confidence), new: res.isNew });
        if (f.secrecy === 2) { importance = Math.max(importance, 6); }
      } else {
        dialogue.refused = true;
      }
    }
    if (dialogue.refused && !dialogue.disclosed.length) facts.push(`${npc.name} knows something about this but will not say.`);
    minutes += 10;
  }

  // NPCs mention their requests and work
  const reqs = game.db.prepare("SELECT * FROM contracts WHERE kind='request' AND party_a=? AND party_b=? AND status='offered'").all(npc.id, game.playerId);
  const topicN = norm(p.topic || '') + ' ' + norm(p.detail || '');
  const workish = /\b(work|job|help|task|request|need|errand|earn|money|hire|employ|quest|favou?r)\b/.test(topicN);
  for (const r of reqs) {
    const data = J.parse(r.data, {});
    if (!data.known && (workish || game.rel(npc.id, game.playerId).familiarity >= 12 || approach === 'chat')) {
      data.known = true;
      game.db.prepare('UPDATE contracts SET data=? WHERE id=?').run(J.str(data), r.id);
      const terms = J.parse(r.terms, {});
      game.journal('opportunity', r.title, `${terms.text} Reward: ${game.money(terms.reward)}.`, `req:${r.id}`);
      dialogue.request = { id: r.id, title: r.title, text: terms.text, reward: terms.reward };
      facts.push(`${npc.name} mentions a task: ${terms.text} (reward ${game.money(terms.reward)}; say you accept to take it on).`);
    }
  }
  if (workish && def.job) {
    const hasJob = game.db.prepare("SELECT 1 FROM contracts WHERE kind='employment' AND party_a=? AND party_b=? AND status='active'").get(npc.id, game.playerId);
    if (!hasJob) facts.push(`${npc.name} could use a ${def.job.title} (${game.money(def.job.wage)} a shift). Ask for the job to apply.`);
  }
  // pending rewards are paid when you report back in person
  for (const c of game.db.prepare("SELECT * FROM contracts WHERE kind='request' AND party_a=? AND party_b=? AND status='completed'").all(npc.id, game.playerId)) {
    const data = J.parse(c.data, {});
    if (data.reward_pending) {
      const terms = J.parse(c.terms, {});
      const amount = Math.min(terms.reward, game.balance(npc.id));
      if (amount > 0) game.pay(npc.id, game.playerId, amount, `Reward: ${c.title}`, 'reward');
      data.reward_pending = false;
      game.db.prepare('UPDATE contracts SET data=? WHERE id=?').run(J.str(data), c.id);
      facts.push(`${npc.name} pays you ${game.money(amount)} for "${c.title}".`);
      dialogue.paidReward = amount;
    }
  }

  const rel = game.adjustRel(npc.id, game.playerId, deltas, `conversation (${approach})`);
  dialogue.attitude = attitudeLabel(rel);
  dialogue.memories = npcMemoriesOfPlayer(game, npc.id, `${p.topic || ''} ${p.detail || ''}`).memories.map((m) => ({ summary: m.summary, importance: m.importance, why: m.why, score: m.score }));
  dialogue.goals = (npc.goals || []).filter((g) => !g.secret).map((g) => g.text);
  dialogue.checkDegree = checkDegree;
  const pname = game.player().name;
  game.recordEvent({
    kind: 'conversation', actor: game.playerId, target: npc.id,
    summary: `${pname} spoke with ${npc.name}${p.topic ? ` about ${p.topic}` : ''}${approach !== 'chat' && approach !== 'ask' ? ` (${approach})` : ''}${checkDegree ? ` — ${DEGREE_LABEL[checkDegree].toLowerCase()}` : ''}.`,
    memory: (pid) => pid === npc.id
      ? `${firstMeeting ? 'Met' : 'Talked with'} ${pname}${p.topic ? `, who asked about ${p.topic}` : ''}${p.detail ? ` and said: "${String(p.detail).slice(0, 140)}"` : ''}${approach === 'intimidate' ? '. They tried to intimidate me' : ''}${dialogue.caughtLying ? '. They lied to me' : ''}${dialogue.disclosed.length ? `. I told them: ${dialogue.disclosed.map((d) => d.content).join(' ')}` : ''}.`
      : pid === game.playerId ? `Talked with ${npc.name}${p.topic ? ` about ${p.topic}` : ''}.${dialogue.disclosed.length ? ` Learned: ${dialogue.disclosed.map((d) => d.content).join(' ')}` : ''}` : `Saw ${pname} talking with ${npc.name}.`,
    visibility: approach === 'insult' || approach === 'intimidate' ? 'witnessed' : 'private', importance, valence, topic: p.topic || '',
    data: { approach, topic: p.topic, disclosed: dialogue.disclosed.map((d) => d.fact), hearsay: approach === 'intimidate' ? { trust: -4, fear: 4 } : undefined },
  });
  game.advance(minutes, 'talk');
  return { ok: true, minutes, summary: `You talk with ${npc.name}.`, facts, rolls, dialogue };
}

// ============================================================================
// tell — share something you know (or claim) with an NPC
// ============================================================================
function tell(game, p) {
  const npc = needNpc(game, p.target, { purpose: 'tell' });
  if (!p.topic) fail('need_topic', `What do you want to tell ${npc.name}?`);
  const mine = factsAbout(game.db, game.playerId, p.topic);
  const rolls = [], facts = [];
  if (!mine.length) {
    // the player is asserting something they do not actually know: that's a claim, resolved as deception/persuasion
    return talk(game, { ...p, approach: 'persuade', topic: null, detail: p.detail || p.topic });
  }
  const f = mine[0];
  const fact = getFact(game.db, f.fact_id);
  const evidenceItem = game.def.item_types.find((t) => t.data?.proves === f.fact_id);
  const hasEvidence = evidenceItem && game.count(game.playerId, evidenceItem.id) > 0;
  let confidence;
  let presented = false;
  if (hasEvidence) {
    confidence = 1;
    presented = true;
    facts.push(`You show ${npc.name} the ${evidenceItem.name}.`);
    if (fact.data?.reactions?.[npc.id]) {
      inv.moveItems(game.ctx, { typeId: evidenceItem.id, qty: 1, from: { kind: 'character', id: game.playerId }, to: { kind: 'character', id: npc.id }, memo: 'evidence handed to the watch' });
      facts.push(`${npc.name} keeps the ledger as evidence.`);
    }
  } else {
    const rel = game.rel(npc.id, game.playerId);
    const r = game.check(game.playerId, { skill: 'persuasion', tn: DIFFICULTY.moderate + (fact.secrecy === 2 ? 2 : 0), label: `Convince ${npc.name}`, mods: [{ label: `Relationship (${attitudeLabel(rel)})`, value: socialMod(rel) }] });
    rolls.push(r);
    const base = { critical: 0.9, strong: 0.8, success: 0.72, partial: 0.55, failure: 0.35, severe_failure: 0.15, automatic: 0.8, impossible: 0.2 }[r.degree];
    confidence = clamp(base * (f.confidence >= 0.7 ? 1 : 0.8), 0.05, 0.95);
  }
  const before = belief(game.db, npc.id, f.fact_id);
  const res = game.learnFact(npc.id, f.fact_id, { belief: confidence >= 0.85 ? 'known' : 'suspected', confidence, source: `told by ${game.player().name}`, sourceId: game.playerId });
  const after = res.record;
  const believed = after.confidence >= 0.6;
  facts.push(before ? `${npc.name} already ${before.belief === 'known' ? 'knew' : 'suspected'} this; now ${Math.round(after.confidence * 100)}% sure.` : `${npc.name} ${believed ? 'believes you' : 'is not convinced'} (${Math.round(after.confidence * 100)}% sure).`);
  if (fact.truth === 0 && believed) game.adjustRel(npc.id, game.playerId, { trust: 0 }, 'told a falsehood (undiscovered)');
  if (believed) game.adjustRel(npc.id, game.playerId, { trust: 3, familiarity: 3 }, 'shared useful information');
  // request objectives of type inform
  const done = completeRequests(game, { type: 'inform', fact: f.fact_id, to: npc.id }, believed);
  facts.push(...done);
  game.recordEvent({ kind: 'inform', actor: game.playerId, target: npc.id, summary: `${game.player().name} told ${npc.name}: ${fact.content}`, visibility: 'private', importance: fact.secrecy === 2 ? 7 : 4, topic: p.topic, data: { fact: f.fact_id, presented } });
  game.advance(15, 'talk');
  const flags = getFlags(game);
  if (flags[`reaction:${f.fact_id}:${npc.id}`] === game.day && after.confidence >= 0.7) facts.push(`${npc.name} acts on what you told them at once.`);
  return { ok: true, minutes: 15, summary: `You tell ${npc.name} what you know.`, facts, rolls, dialogue: { npc: npc.id, npcName: npc.name, persona: npc.persona, approach: 'tell', topic: p.topic, told: fact.content, believed, attitude: attitudeLabel(game.rel(npc.id, game.playerId)), disclosed: [] } };
}

// ============================================================================
// jobs & requests
// ============================================================================
function askJob(game, p) {
  const npc = needNpc(game, p.target, { purpose: 'ask for work' });
  const def = game.npcDef(npc.id);
  if (!def?.job) fail('no_job', `${npc.name} has no work to offer you.`);
  const existing = game.db.prepare("SELECT * FROM contracts WHERE kind='employment' AND party_a=? AND party_b=? AND status='active'").get(npc.id, game.playerId);
  if (existing) return { ok: true, minutes: 5, summary: `You already work for ${npc.name} as a ${def.job.title}.`, facts: [`Your shift is ${def.job.minutes / 60} hours at ${game.location(def.job.location).name} for ${game.money(def.job.wage)}.`] };
  const rolls = [], facts = [];
  let hired = true;
  for (const [k, v] of Object.entries(def.job.requires || {})) {
    const have = game.rules.skills[game.skillFor(k)] ? game.skill(game.playerId, game.skillFor(k)).rank : game.attr(game.playerId, k);
    if (have < v) {
      const rel = game.rel(npc.id, game.playerId);
      const r = game.check(game.playerId, { skill: 'persuasion', tn: DIFFICULTY.hard, label: `Talk ${npc.name} into a trial`, mods: [{ label: `Relationship (${attitudeLabel(rel)})`, value: socialMod(rel) }] });
      rolls.push(r);
      if (!isSuccess(r.degree)) { hired = false; facts.push(`${npc.name} wants someone with ${game.rules.skills[k]?.label || k} ${v}+; you have ${have}.`); }
      else facts.push(`You lack the usual ${game.rules.skills[k]?.label || k} (${have}/${v}) but talk ${npc.name} into a trial.`);
    }
  }
  if (game.rel(npc.id, game.playerId).trust <= -30) { hired = false; facts.push(`${npc.name} does not trust you enough to hire you.`); }
  if (hired) {
    game.db.prepare(`INSERT INTO contracts(kind,party_a,party_b,title,terms,status,created_at,data) VALUES ('employment',?,?,?,?,'active',?,?)`)
      .run(npc.id, game.playerId, `${def.job.title} for ${npc.name}`, J.str(def.job), game.time, J.str({ shifts: 0 }));
    game.adjustRel(npc.id, game.playerId, { familiarity: 5, trust: 3 }, 'hired');
    game.recordEvent({ kind: 'hired', actor: npc.id, target: game.playerId, summary: `${npc.name} hired ${game.player().name} as a ${def.job.title}.`, visibility: 'witnessed', importance: 5, data: { hearsay: { respect: 2 } } });
    game.closeJournal('opportunity', 'find_work');
    game.journal('plan', `Job: ${def.job.title}`, `${npc.name} pays ${game.money(def.job.wage)} per ${def.job.minutes / 60}-hour shift at ${game.location(def.job.location).name}. Say "work" there to put in a shift.`, `job:${npc.id}`);
    facts.push(`Hired as ${def.job.title}: ${game.money(def.job.wage)} per ${def.job.minutes / 60}-hour shift at ${game.location(def.job.location).name}.`);
  }
  game.advance(10, 'talk');
  return { ok: hired, minutes: 10, summary: hired ? `${npc.name} hires you.` : `${npc.name} turns you down for now.`, facts, rolls, dialogue: { npc: npc.id, npcName: npc.name, persona: npc.persona, approach: 'ask_job', hired, attitude: attitudeLabel(game.rel(npc.id, game.playerId)), disclosed: [] } };
}

function acceptRequest(game, p) {
  const offered = game.db.prepare("SELECT * FROM contracts WHERE kind='request' AND party_b=? AND status='offered'").all(game.playerId).filter((r) => J.parse(r.data, {}).known);
  if (!offered.length) fail('no_request', 'Nobody has offered you a task you could accept.');
  let c = null;
  if (p.target) {
    const npc = resolveCharacter(p.target, offered.map((o) => game.char(o.party_a))).match;
    if (npc) c = offered.find((o) => o.party_a === npc.id);
  }
  if (!c && p.topic) c = offered.find((o) => norm(o.title).includes(norm(p.topic)) || norm(p.topic).split(' ').some((w) => w.length > 3 && norm(o.title).includes(w)));
  if (!c && offered.length === 1) c = offered[0];
  if (!c) fail('which_request', `Which task? ${offered.map((o) => `"${o.title}" (${game.char(o.party_a).name})`).join(', ')}.`);
  const npc = game.char(c.party_a);
  if (npc.location_id !== here(game)) fail('not_here', `You need to see ${npc.name} in person to take that on.`);
  const terms = J.parse(c.terms, {});
  const obj = terms.objective;
  const facts = [];
  if (obj.consign) {
    const have = game.count(npc.id, obj.item);
    if (have < obj.qty) fail('requester_short', `${npc.name} doesn't have ${obj.qty} ${obj.item} to send right now (has ${have}).`);
    inv.moveItems(game.ctx, { typeId: obj.item, qty: obj.qty, from: { kind: 'character', id: npc.id }, to: { kind: 'character', id: game.playerId }, memo: `consigned for "${c.title}"` });
    facts.push(`${npc.name} entrusts you with ${obj.qty} ${game.itemType(obj.item).name} — still ${npc.name}'s property — to deliver to ${game.char(obj.to).name}.`);
  }
  game.db.prepare("UPDATE contracts SET status='active', due_at=? WHERE id=?").run(game.time + terms.days * MINUTES_PER_DAY, c.id);
  game.journal('plan', c.title, `${terms.text} Due by ${game.calendar(game.time + terms.days * MINUTES_PER_DAY).short}. Reward ${game.money(terms.reward)}.`, `req:${c.id}`);
  game.closeJournal('opportunity', `req:${c.id}`);
  game.recordEvent({ kind: 'promise', actor: game.playerId, target: npc.id, summary: `${game.player().name} promised ${npc.name} to see to "${c.title}".`, visibility: 'private', importance: 6, valence: 0.3, topic: c.title });
  game.adjustRel(npc.id, game.playerId, { trust: 3, familiarity: 3 }, 'accepted a task');
  game.advance(5, 'talk');
  facts.push(`Deadline: ${game.calendar(game.time + terms.days * MINUTES_PER_DAY).short}.`);
  return { ok: true, minutes: 5, summary: `You agree to "${c.title}".`, facts, dialogue: { npc: npc.id, npcName: npc.name, persona: npc.persona, approach: 'accept', attitude: attitudeLabel(game.rel(npc.id, game.playerId)), disclosed: [] } };
}

/** Check active requests for completion; returns fact strings. */
function completeRequests(game, evt, valid = true) {
  const out = [];
  if (!valid) return out;
  for (const c of game.db.prepare("SELECT * FROM contracts WHERE kind='request' AND party_b=? AND status='active'").all(game.playerId)) {
    const terms = J.parse(c.terms, {});
    const o = terms.objective;
    let done = false;
    if (o.type === evt.type && o.to === evt.to) {
      if (o.type === 'inform' && o.fact === evt.fact) done = true;
      if (o.type === 'deliver' && o.item === evt.item && evt.qty >= o.qty) done = true;
    }
    if (!done) continue;
    const requester = game.char(c.party_a);
    const data = J.parse(c.data, {});
    game.db.prepare("UPDATE contracts SET status='completed' WHERE id=?").run(c.id);
    const ev = game.recordEvent({ kind: 'promise_kept', actor: game.playerId, target: c.party_a, location: here(game), summary: `${game.player().name} completed "${c.title}" for ${requester.name}.`, visibility: 'witnessed', importance: 6, valence: 0.6, data: { hearsay: { respect: 8, trust: 5 } }, witnesses: [game.playerId, c.party_a, ...npcsHere(game).map((n) => n.id)] });
    game.adjustRel(c.party_a, game.playerId, { trust: terms.rel || 10, affection: Math.round((terms.rel || 10) / 2), respect: Math.round((terms.rel || 10) / 2) }, `completed "${c.title}"`, ev.eventId);
    if (requester.location_id === here(game)) {
      const amount = Math.min(terms.reward, game.balance(c.party_a));
      if (amount > 0) game.pay(c.party_a, game.playerId, amount, `Reward: ${c.title}`, 'reward');
      out.push(`${requester.name} pays you ${game.money(amount)} for "${c.title}".`);
    } else {
      data.reward_pending = true;
      game.db.prepare('UPDATE contracts SET data=? WHERE id=?').run(J.str(data), c.id);
      out.push(`"${c.title}" is complete. ${requester.name} will pay your ${game.money(terms.reward)} when you next see them.`);
    }
    game.closeJournal('plan', `req:${c.id}`, 'done');
  }
  return out;
}

function work(game, p) {
  const jobs = game.db.prepare("SELECT * FROM contracts WHERE kind='employment' AND party_b=? AND status='active'").all(game.playerId);
  if (!jobs.length) fail('no_job', 'You have no job. Ask someone for work first.');
  let c = jobs.find((j) => J.parse(j.terms, {}).location === here(game)) || null;
  if (p.target) { const n = resolveCharacter(p.target, jobs.map((j) => game.char(j.party_a))).match; if (n) c = jobs.find((j) => j.party_a === n.id); }
  if (!c) fail('wrong_place', `You work at ${jobs.map((j) => game.location(J.parse(j.terms, {}).location).name).join(' or ')}. Go there first.`);
  const job = J.parse(c.terms, {});
  if (job.location !== here(game)) fail('wrong_place', `Your ${job.title} job is at ${game.location(job.location).name}.`);
  const h = game.calendar().hour;
  if (h < 5 || h >= 20) fail('wrong_time', 'Nobody is hiring hands at this hour. Come back in the morning.');
  if (game.player().fatigue >= 85) fail('exhausted', 'You are too exhausted to work a shift. Rest first.');
  const employer = game.char(c.party_a);
  const shifts = Math.max(1, Math.min(6, Math.floor(Number(p.quantity) || 1)));
  const facts = [], rolls = [];
  let earned = 0;
  for (let i = 0; i < shifts; i++) {
    if (i > 0) {
      // between shifts: sleep and eat
      const restOut = rest(game, { hours: 8 });
      facts.push(...restOut.facts.slice(0, 1));
      eatIfPossible(game, facts);
      if (game.calendar().hour < 5 || game.calendar().hour >= 20) game.advance(((24 + 6 - game.calendar().hour) % 24) * 60, 'wait');
    }
    const r = game.check(game.playerId, { skill: job.skill || 'athletics', tn: DIFFICULTY.easy + 1, label: `Shift as ${job.title}` });
    rolls.push(r);
    let wage = job.wage;
    if (r.degree === 'critical' || r.degree === 'strong') { wage += 1; game.adjustRel(employer.id, game.playerId, { respect: 2 }, 'good work'); }
    if (r.degree === 'failure') wage = Math.ceil(wage / 2);
    if (r.degree === 'severe_failure') { wage = 0; game.adjustRel(employer.id, game.playerId, { respect: -4, trust: -2 }, 'botched a shift'); }
    game.advance(job.minutes, 'work');
    game.addFatigue(game.playerId, 30);
    if (job.perk === 'meal') { game.updateChar(game.playerId, { last_meal: game.time }); }
    if (wage > 0) {
      if (game.balance(employer.id) < wage) {
        facts.push(`${employer.name} cannot pay your wages today.`);
        game.adjustRel(game.playerId, employer.id, { trust: -10 }, 'unpaid wages');
      } else { game.pay(employer.id, game.playerId, wage, `Wages: ${job.title}`, 'wage', `wage:${c.id}:${game.time}`); earned += wage; }
    }
    const data = J.parse(c.data, {}); data.shifts = (data.shifts || 0) + 1;
    game.db.prepare('UPDATE contracts SET data=? WHERE id=?').run(J.str(data), c.id);
    if (data.shifts % 3 === 0) game.adjustRel(employer.id, game.playerId, { trust: 2, familiarity: 2 }, 'steady work');
    facts.push(`Shift ${i + 1}: ${DEGREE_LABEL[r.degree].toLowerCase()} — paid ${game.money(wage)}.`);
    if (game.player().fatigue >= 85 && i < shifts - 1) { facts.push('You are too worn out to continue.'); break; }
  }
  game.recordEvent({ kind: 'work', actor: game.playerId, target: employer.id, summary: `${game.player().name} worked as ${job.title} for ${employer.name}, earning ${game.money(earned)}.`, visibility: 'witnessed', importance: 2 });
  return { ok: true, minutes: job.minutes * shifts, summary: `You work as ${job.title} and earn ${game.money(earned)}.`, facts, rolls };
}

// ============================================================================
// trade
// ============================================================================
function chooseMerchant(game, p, typeQuery, side) {
  const present = npcsHere(game).filter((n) => game.npcDef(n.id)?.shop && !n.data.jailed && !n.data.bankrupt);
  if (p.target) {
    const m = needNpc(game, p.target, { purpose: 'trade with' });
    if (!game.npcDef(m.id)?.shop) fail('not_merchant', `${m.name} doesn't trade.`);
    return m;
  }
  if (!present.length) fail('no_merchant', 'There is nobody here to trade with.');
  for (const m of present) {
    const shop = game.npcDef(m.id).shop;
    const list = side === 'sell' ? shop.sells : shop.buys;
    const typeIds = side === 'sell' ? list : (list.includes('*') ? itemCandidatesHeld(game, game.playerId).map((c) => c.id) : list);
    const cands = typeIds.map((id) => ({ id, name: game.itemType(id)?.name || id }));
    if (resolveItemType(typeQuery, cands)) return m;
  }
  return present[0];
}

function negotiate(game, merchant, quoted, offer, side) {
  // returns {price, roll}
  if (offer == null || (side === 'buy' && offer >= quoted) || (side === 'sell' && offer <= quoted)) return { price: quoted, roll: null };
  const r = game.check(game.playerId, { skill: 'negotiation', label: `Haggle with ${merchant.name}`, opposedBy: merchant.id, opposedSkill: 'negotiation', mods: [{ label: `Relationship`, value: socialMod(game.rel(merchant.id, game.playerId)) }] });
  const pct = { critical: 0.25, strong: 0.15, success: 0.1, partial: 0.05, failure: 0, severe_failure: 0 }[r.degree] ?? 0;
  let price;
  if (side === 'buy') price = Math.max(offer, Math.round(quoted * (1 - pct)));
  else price = Math.min(offer, Math.round(quoted * (1 + pct)));
  if (r.degree === 'severe_failure') game.adjustRel(merchant.id, game.playerId, { affection: -3 }, 'insulting offer');
  return { price, roll: r };
}

function buy(game, p) {
  if (!p.item) fail('need_item', 'Buy what?');
  const m = chooseMerchant(game, p, p.item, 'sell');
  const shop = game.npcDef(m.id).shop;
  const typeId = resolveItemType(p.item, shop.sells.map((id) => ({ id, name: game.itemType(id).name })));
  if (!typeId) fail('not_sold', `${m.name} doesn't sell "${p.item}". They sell: ${shop.sells.map((id) => game.itemType(id).name).join(', ')}.`);
  const qty = qtyOf(p);
  const stock = game.count(m.id, typeId);
  if (stock <= 0) fail('out_of_stock', `${m.name} is out of ${game.itemType(typeId).name}.`);
  if (stock < qty) fail('insufficient_items', `${m.name} only has ${stock} ${game.itemType(typeId).name}.`, { have: stock });
  const quoted = quote(game, m.id, typeId, 'sell', game.playerId);
  const offerUnit = p.price != null ? Math.max(0, Math.floor(Number(p.price) / (p.price_is_total ? qty : 1))) : null;
  const { price, roll } = negotiate(game, m, quoted, offerUnit, 'buy');
  const rolls = roll ? [roll] : [];
  if (offerUnit != null && price > offerUnit) {
    game.advance(5, 'trade');
    return { ok: false, minutes: 5, summary: `${m.name} won't go below ${game.money(price)} each.`, facts: [`Asked ${game.money(quoted)} each; you offered ${game.money(offerUnit)}; best price ${game.money(price)}.`], rolls, dialogue: { npc: m.id, npcName: m.name, persona: m.persona, approach: 'haggle', attitude: attitudeLabel(game.rel(m.id, game.playerId)), disclosed: [] } };
  }
  const total = price * qty;
  executeTrade(game, { buyer: game.playerId, seller: m.id, typeId, qty, unitPrice: price, memo: `Bought ${qty} ${game.itemType(typeId).name} from ${m.name}` });
  game.adjustRel(m.id, game.playerId, { familiarity: 2, ...(daily(game, `custom:${m.id}`) ? { affection: 1 } : {}) }, 'custom');
  game.recordEvent({ kind: 'trade', actor: game.playerId, target: m.id, summary: `${game.player().name} bought ${qty} ${game.itemType(typeId).name} from ${m.name} for ${game.money(total)}.`, visibility: 'witnessed', importance: 1 });
  game.advance(5 + qty, 'trade');
  return { ok: true, minutes: 5, summary: `You buy ${qty} ${game.itemType(typeId).name} for ${game.money(total)}.`, facts: [`Price: ${game.money(price)} each (asked ${game.money(quoted)}).`], rolls };
}

function sell(game, p) {
  const typeId = needHeldItem(game, p.item);
  const t = game.itemType(typeId);
  const m = chooseMerchant(game, p, p.item, 'buy');
  const shop = game.npcDef(m.id).shop;
  const qty = qtyOf(p);
  const owned = game.count(game.playerId, typeId, { ownerId: game.playerId });
  const heldAll = game.count(game.playerId, typeId);
  const rolls = [], facts = [];
  if (heldAll < qty) fail('insufficient_items', `You only have ${heldAll} ${t.name}.`);
  if (owned < qty) {
    // some of these belong to someone else (stolen or consigned)
    const rows = game.db.prepare("SELECT owner_id, stolen, SUM(quantity) q FROM items WHERE holder_kind='character' AND holder_id=? AND type_id=? AND owner_id<>? GROUP BY owner_id, stolen").all(game.playerId, typeId, game.playerId);
    const other = rows[0];
    if (other.owner_id === m.id) {
      const ev = game.recordEvent({ kind: 'caught', actor: m.id, target: game.playerId, summary: `${m.name} recognised their own stolen ${t.name} when ${game.player().name} tried to sell it back.`, visibility: 'witnessed', importance: 8, valence: -0.9, data: { hearsay: { trust: -20 } } });
      game.adjustRel(m.id, game.playerId, { trust: -40, affection: -30 }, 'tried to sell me my own stolen goods', ev.eventId);
      inv.moveItems(game.ctx, { typeId, qty: other.q, from: { kind: 'character', id: game.playerId }, to: { kind: 'character', id: m.id }, ownerFilter: m.id, clearStolen: true, memo: 'recovered by owner' });
      return { ok: false, minutes: 5, summary: `${m.name} recognises the ${t.name} as their own stolen goods!`, facts: [`${m.name} takes back ${other.q} ${t.name}.`], rolls };
    }
    if (!other.stolen) fail('not_yours', `${other.q} of those ${t.name} belong to ${game.char(other.owner_id)?.name || 'someone else'}; you can't sell them.`);
    if (!shop.fence) {
      const r = game.check(game.playerId, { skill: 'deception', label: `Pass off stolen ${t.name}`, opposedBy: m.id, opposedSkill: 'perception' });
      rolls.push(r);
      if (!isAtLeastPartial(r.degree)) {
        const ev = game.recordEvent({ kind: 'caught', actor: m.id, target: game.playerId, summary: `${m.name} suspected ${game.player().name} of selling stolen goods.`, visibility: 'witnessed', importance: 6, valence: -0.6, data: { hearsay: { trust: -10 } } });
        game.adjustRel(m.id, game.playerId, { trust: -20 }, 'tried to sell stolen goods', ev.eventId);
        return { ok: false, minutes: 5, summary: `${m.name} refuses: "Where did you get these?"`, facts: [], rolls };
      }
    }
  }
  const quoted = quote(game, m.id, typeId, 'buy', game.playerId, { stolen: owned < qty });
  if (quoted == null) fail('wont_buy', `${m.name} doesn't buy ${t.name}.`);
  if (quoted === 0) fail('worthless', `${m.name} won't pay anything for that.`);
  const offerUnit = p.price != null ? Math.floor(Number(p.price)) : null;
  const { price, roll } = negotiate(game, m, quoted, offerUnit, 'sell');
  if (roll) rolls.push(roll);
  if (offerUnit != null && price < offerUnit) {
    game.advance(5, 'trade');
    return { ok: false, minutes: 5, summary: `${m.name} will pay no more than ${game.money(price)} each.`, facts: [`Offered ${game.money(quoted)}; you asked ${game.money(offerUnit)}.`], rolls };
  }
  const total = price * qty;
  if (game.balance(m.id) < total) fail('merchant_poor', `${m.name} can only afford ${game.money(game.balance(m.id))} right now.`);
  // move ownership: owned first, then stolen
  game.pay(m.id, game.playerId, total, `Sold ${qty} ${t.name} to ${m.name}`, 'trade');
  let remaining = qty;
  const mine = Math.min(owned, remaining);
  if (mine > 0) inv.moveItems(game.ctx, { typeId, qty: mine, from: { kind: 'character', id: game.playerId }, to: { kind: 'character', id: m.id }, ownerFilter: game.playerId, newOwner: m.id, memo: 'sale' });
  remaining -= mine;
  if (remaining > 0) inv.moveItems(game.ctx, { typeId, qty: remaining, from: { kind: 'character', id: game.playerId }, to: { kind: 'character', id: m.id }, newOwner: m.id, markStolen: !shop.fence ? false : true, memo: 'fenced' });
  game.recordEvent({ kind: 'trade', actor: game.playerId, target: m.id, summary: `${game.player().name} sold ${qty} ${t.name} to ${m.name} for ${game.money(total)}.`, visibility: 'witnessed', importance: 1 });
  game.advance(5, 'trade');
  facts.push(`Price: ${game.money(price)} each (offered ${game.money(quoted)}).`);
  return { ok: true, minutes: 5, summary: `You sell ${qty} ${t.name} for ${game.money(total)}.`, facts, rolls };
}

function give(game, p) {
  const npc = needNpc(game, p.target, { purpose: 'give something to' });
  const facts = [];
  if (!p.item || isMoneyWord(game, p.item)) {
    const amount = Math.floor(Number(p.price ?? p.quantity));
    if (!Number.isInteger(amount) || amount <= 0) fail('bad_amount', 'How much money?');
    game.pay(game.playerId, npc.id, amount, `Gift to ${npc.name}`, 'gift');
    const bump = clamp(Math.round(amount / 3), 1, 15);
    const isBribe = npc.traits.includes('incorruptible');
    if (isBribe) { game.adjustRel(npc.id, game.playerId, { trust: -10, respect: -5 }, 'attempted bribe'); facts.push(`${npc.name} takes it for the watch's poor-box, and looks at you coldly.`); }
    else game.adjustRel(npc.id, game.playerId, { affection: bump, trust: Math.round(bump / 2) }, `gift of ${game.money(amount)}`);
    game.recordEvent({ kind: 'gift', actor: game.playerId, target: npc.id, summary: `${game.player().name} gave ${npc.name} ${game.money(amount)}.`, visibility: 'private', importance: amount >= 20 ? 5 : 3, valence: 0.5 });
    game.advance(2, 'talk');
    return { ok: true, minutes: 2, summary: `You give ${npc.name} ${game.money(amount)}.`, facts };
  }
  const typeId = needHeldItem(game, p.item);
  const t = game.itemType(typeId);
  const qty = qtyOf(p);
  if (game.count(game.playerId, typeId) < qty) fail('insufficient_items', `You only have ${game.count(game.playerId, typeId)} ${t.name}.`);
  // delivery of a consignment: the recipient pays the owner, not you
  const consignReq = game.db.prepare("SELECT * FROM contracts WHERE kind='request' AND party_b=? AND status='active'").all(game.playerId).find((c) => { const o = J.parse(c.terms, {}).objective; return o.consign && o.item === typeId && o.to === npc.id; });
  if (consignReq) {
    const o = J.parse(consignReq.terms, {}).objective;
    const q = Math.min(qty, game.count(game.playerId, typeId, { ownerId: consignReq.party_a }));
    if (q < o.qty) fail('insufficient_items', `You only carry ${q} of ${game.char(consignReq.party_a).name}'s ${t.name}; the delivery is ${o.qty}.`);
    const due = o.price_each * o.qty;
    if (game.balance(npc.id) < due) fail('recipient_poor', `${npc.name} can't pay ${game.money(due)} for the shipment right now.`);
    inv.moveItems(game.ctx, { typeId, qty: o.qty, from: { kind: 'character', id: game.playerId }, to: { kind: 'character', id: npc.id }, ownerFilter: consignReq.party_a, newOwner: npc.id, memo: `delivery for ${consignReq.title}` });
    game.pay(npc.id, o.pay_to, due, `Payment for ${o.qty} ${t.name} delivered by ${game.player().name}`, 'trade');
    facts.push(`${npc.name} takes delivery and sends ${game.money(due)} to ${game.char(o.pay_to).name}.`);
    facts.push(...completeRequests(game, { type: 'deliver', item: typeId, qty: o.qty, to: npc.id }));
    game.advance(10, 'trade');
    return { ok: true, minutes: 10, summary: `You deliver ${o.qty} ${t.name} to ${npc.name}.`, facts };
  }
  const ownedQty = game.count(game.playerId, typeId, { ownerId: game.playerId });
  if (ownedQty < qty) {
    const other = game.db.prepare("SELECT owner_id FROM items WHERE holder_kind='character' AND holder_id=? AND type_id=? AND owner_id<>? LIMIT 1").get(game.playerId, typeId, game.playerId);
    if (other?.owner_id === npc.id) {
      inv.moveItems(game.ctx, { typeId, qty: Math.min(qty, game.count(game.playerId, typeId, { ownerId: npc.id })), from: { kind: 'character', id: game.playerId }, to: { kind: 'character', id: npc.id }, ownerFilter: npc.id, clearStolen: true, memo: 'returned to owner' });
      game.advance(2, 'talk');
      return { ok: true, minutes: 2, summary: `You return ${npc.name}'s ${t.name}.`, facts: [] };
    }
    fail('not_yours', `Those ${t.name} are not yours to give away.`);
  }
  inv.moveItems(game.ctx, { typeId, qty, from: { kind: 'character', id: game.playerId }, to: { kind: 'character', id: npc.id }, ownerFilter: game.playerId, newOwner: npc.id, memo: `gift to ${npc.name}` });
  const value = t.base_value * qty;
  game.adjustRel(npc.id, game.playerId, { affection: clamp(Math.round(value / 4), 1, 12), trust: clamp(Math.round(value / 8), 0, 6) }, `gift of ${qty} ${t.name}`);
  facts.push(...completeRequests(game, { type: 'deliver', item: typeId, qty, to: npc.id }));
  game.recordEvent({ kind: 'gift', actor: game.playerId, target: npc.id, summary: `${game.player().name} gave ${npc.name} ${qty} ${t.name}.`, visibility: 'private', importance: value >= 20 ? 5 : 3, valence: 0.5 });
  game.advance(2, 'talk');
  return { ok: true, minutes: 2, summary: `You give ${npc.name} ${qty} ${t.name}.`, facts };
}

function take(game, p) {
  const loc = here(game);
  const ground = inv.listHeld(game.db, 'location', loc);
  const typeId = resolveItemType(p.item, ground.map((g) => ({ id: g.type_id, name: g.name })));
  if (!typeId) {
    // taking something a person owns is theft
    const owners = npcsHere(game).filter((n) => resolveItemType(p.item, itemCandidatesHeld(game, n.id)));
    if (owners.length) return steal(game, { ...p, target: owners[0].name });
    fail('not_here', `There is no "${p.item}" here to take.`);
  }
  const qty = Math.min(qtyOf(p), inv.countHeld(game.db, 'location', loc, typeId));
  const row = ground.find((g) => g.type_id === typeId);
  const isMine = row.owner_id === game.playerId || row.owner_id === 'nobody';
  inv.moveItems(game.ctx, { typeId, qty, from: { kind: 'location', id: loc }, to: { kind: 'character', id: game.playerId }, newOwner: isMine ? game.playerId : undefined, markStolen: !isMine, memo: 'picked up' });
  game.advance(1, 'take');
  return { ok: true, minutes: 1, summary: `You pick up ${qty} ${game.itemType(typeId).name}.`, facts: [] };
}

function drop(game, p) {
  const typeId = needHeldItem(game, p.item);
  const qty = qtyOf(p);
  inv.moveItems(game.ctx, { typeId, qty, from: { kind: 'character', id: game.playerId }, to: { kind: 'location', id: here(game) }, memo: 'dropped' });
  game.advance(1, 'drop');
  return { ok: true, minutes: 1, summary: `You put down ${qty} ${game.itemType(typeId).name}.`, facts: [] };
}

// ============================================================================
// steal — real items move; witnesses really see; owners keep legal title
// ============================================================================
function steal(game, p) {
  const victim = needNpc(game, p.target, { purpose: 'steal from' });
  const wantsMoney = !p.item || isMoneyWord(game, p.item) || /^(purse|wallet)$/i.test(String(p.item).trim());
  let typeId = null, qty = 0, amount = 0;
  if (wantsMoney) {
    if (game.balance(victim.id) <= 0) fail('nothing_to_steal', `${victim.name} has no coin to lift.`);
  } else {
    typeId = resolveItemType(p.item, itemCandidatesHeld(game, victim.id));
    if (!typeId) fail('nothing_to_steal', `${victim.name} has no "${p.item}" you could take.`);
    qty = Math.min(qtyOf(p), game.count(victim.id, typeId));
    if (qty <= 0) fail('nothing_to_steal', `${victim.name} has no ${game.itemType(typeId).name} left.`);
  }
  const night = game.calendar().block === 'night';
  const crowd = npcsHere(game).length;
  const mods = [];
  if (qty > 3) mods.push({ label: 'Bulky haul', value: -Math.min(4, Math.floor(qty / 3)) });
  if (crowd >= 3) mods.push({ label: 'Crowd cover', value: 1 });
  const r = game.check(game.playerId, { skill: 'sleight_of_hand', label: `Steal from ${victim.name}`, opposedBy: victim.id, opposedSkill: 'perception', mods, opposedMods: night ? [{ label: 'Darkness', value: -2 }] : [] });
  const rolls = [r], facts = [];
  // every other bystander gets a chance to notice
  const witnesses = [game.playerId];
  for (const w of npcsHere(game)) {
    if (w.id === victim.id) continue;
    const per = game.skill(w.id, 'perception').rank + game.attr(w.id, 'insight');
    const noticeChance = clamp(0.05 + per * 0.03 - (isSuccess(r.degree) ? 0.1 : 0) - (night ? 0.1 : 0), 0.02, 0.6);
    if (game.rng.chance(noticeChance)) witnesses.push(w.id);
  }
  const caught = !isAtLeastPartial(r.degree);
  if (!caught) {
    if (wantsMoney) {
      amount = Math.min(game.balance(victim.id), game.rng.int(2, 6) + (r.degree === 'critical' ? 10 : r.degree === 'strong' ? 4 : 0));
      game.pay(victim.id, game.playerId, amount, `Purse lifted from ${victim.name}`, 'theft');
      facts.push(`You lift ${game.money(amount)} from ${victim.name}.`);
    } else {
      inv.moveItems(game.ctx, { typeId, qty, from: { kind: 'character', id: victim.id }, to: { kind: 'character', id: game.playerId }, markStolen: true, memo: `stolen from ${victim.name}` });
      facts.push(`You take ${qty} ${game.itemType(typeId).name} from ${victim.name} unnoticed${r.degree === 'partial' ? ', though they frown and pat their belongings a moment later' : ''}.`);
    }
  } else facts.push(`${victim.name} catches you in the act!`);
  const seenBy = witnesses.filter((w) => w !== game.playerId);
  if (caught) seenBy.push(victim.id);
  const pname = game.player().name;
  const ev = game.recordEvent({
    kind: caught ? 'theft_caught' : 'theft', actor: game.playerId, target: victim.id,
    summary: caught ? `${pname} was caught trying to steal from ${victim.name}.` : `${pname} stole ${wantsMoney ? `${game.money(amount)}` : `${qty} ${game.itemType(typeId).name}`} from ${victim.name}.`,
    witnesses: [game.playerId, ...new Set(seenBy)], importance: caught || seenBy.length ? 8 : 4, valence: -0.9,
    memory: (pid) => pid === game.playerId ? null : `I saw ${pname} ${caught ? 'try to steal from' : 'steal from'} ${victim.name}.`,
    data: { hearsay: { trust: -25, respect: -10 } },
  });
  // the player always remembers their own deed
  if (!caught) game.db.prepare("INSERT INTO memories(owner_id,time,event_id,kind,summary,participants,location_id,importance,topic,source) VALUES (?,?,?,?,?,?,?,?,?,?)")
    .run(game.playerId, game.time, ev.eventId, 'episodic', `I stole from ${victim.name}.`, J.str([game.playerId, victim.id]), here(game), 5, 'theft', 'experienced');
  for (const w of new Set(seenBy)) game.adjustRel(w, game.playerId, w === victim.id ? { trust: -40, affection: -25 } : { trust: -20, respect: -10 }, 'witnessed theft', ev.eventId);
  if (seenBy.length) {
    facts.push(`Seen by: ${[...new Set(seenBy)].map((id) => game.char(id).name).join(', ')}.`);
    const guardHere = npcsHere(game).find((n) => game.npcDef(n.id)?.guard);
    if (guardHere || caught) {
      const fine = 10;
      const paid = Math.min(fine, game.balance(game.playerId));
      game.fine(game.playerId, paid, 'Fine for theft');
      if (!wantsMoney && !caught) inv.moveItems(game.ctx, { typeId, qty, from: { kind: 'character', id: game.playerId }, to: { kind: 'character', id: victim.id }, ownerFilter: victim.id, clearStolen: true, memo: 'returned after theft was seen' });
      if (!caught && wantsMoney && amount > 0 && game.balance(game.playerId) >= amount) game.pay(game.playerId, victim.id, amount, 'Stolen coin returned', 'restitution');
      for (const gid of game.guardsOf(game.settlementOf(here(game)))) game.adjustRel(gid, game.playerId, { trust: -20, respect: -10 }, 'theft reported', ev.eventId);
      facts.push(guardHere ? `${guardHere.name} seizes you; the goods are returned and you are fined ${game.money(paid)}.` : `The watch is called. You are fined ${game.money(paid)}${!wantsMoney && !caught ? ' and must return what you took' : ''}.`);
      game.advance(60, 'detained');
    }
  }
  game.advance(2, 'steal');
  return { ok: !caught, minutes: 2, summary: caught ? 'You are caught.' : 'The theft succeeds.', facts, rolls };
}

// ============================================================================
// needs: rest, wait, eat
// ============================================================================
function rest(game, p) {
  const hours = clamp(Number(p.hours) || 8, 0.5, 16);
  const loc = game.location(here(game));
  const facts = [];
  let quality = 0.6;
  if (loc.tags.includes('lodging')) {
    const keeper = npcsHere(game).find((n) => game.npcDef(n.id)?.lodging) || game.def.npcs.filter((n) => n.lodging).map((n) => game.char(n.id)).find((c) => game.npcDef(c.id).location === loc.id);
    const price = keeper ? game.npcDef(keeper.id).lodging.price : 0;
    const paidUntil = game.player().data.room_until || 0;
    if (hours >= 4 && paidUntil < game.time + 60 && price > 0) {
      if (game.balance(game.playerId) >= price) {
        game.pay(game.playerId, keeper.id, price, `A night's lodging at ${loc.name}`, 'lodging');
        game.setCharData(game.playerId, { room_until: game.time + 20 * 60 });
        facts.push(`Paid ${game.money(price)} for a room.`);
        quality = 1;
      } else facts.push(`You can't afford a room (${game.money(price)}); you doze on a bench in the common room.`);
    } else quality = 1;
  } else if (loc.tags.includes('wild')) { quality = 0.5; facts.push('You sleep rough beneath the trees.'); }
  else facts.push('You find a corner to rest in.');
  game.advance(hours * 60, 'rest');
  const c = game.player();
  const recovered = Math.round(hours * 12 * quality);
  game.updateChar(game.playerId, { fatigue: clamp(c.fatigue - recovered, 0, 100) });
  if (game.time - c.last_meal < MINUTES_PER_DAY) game.heal(game.playerId, Math.round(hours * 0.8 * quality));
  facts.push(`Fatigue now ${game.player().fatigue}/100.`);
  return { ok: true, minutes: hours * 60, summary: `You rest for ${Math.round(hours * 10) / 10} hours.`, facts };
}

function wait(game, p) {
  if (p.days && !p.hours) {
    // long waits pass day by day: meals, sleep, and important news interrupts
    const days = clamp(Math.floor(Number(p.days)), 1, 365);
    const t0 = game.time;
    const r = multiDay(game, days, 10, () => { game.advance(10 * 60, 'wait'); return {}; });
    return { ok: true, minutes: 0, summary: `You wait ${r.completed} of ${days} days (${fmtMinutes(game.time - t0)}).`, facts: r.notes };
  }
  const hours = clamp(Number(p.hours) || 1, 0.25, 24 * 7);
  game.advance(hours * 60, 'wait');
  return { ok: true, minutes: hours * 60, summary: `You wait ${fmtMinutes(Math.round(hours * 60))}.`, facts: [] };
}

function eatIfPossible(game, facts) {
  const foods = game.held(game.playerId).filter((i) => i.tags.includes('food') && i.owner_id === game.playerId);
  if (foods.length) {
    const f = foods.sort((a, b) => (b.type_data.nourish || 0) - (a.type_data.nourish || 0))[0];
    inv.destroyItems(game.ctx, { typeId: f.type_id, qty: 1, holderKind: 'character', holderId: game.playerId, ownerId: game.playerId, reason: 'consume', memo: 'eaten' });
    game.updateChar(game.playerId, { last_meal: game.time });
    facts.push(`You eat ${f.name}.`);
    return true;
  }
  // buy the cheapest food anyone present is selling
  let best = null;
  for (const n of npcsHere(game)) {
    const shop = game.npcDef(n.id)?.shop;
    if (!shop || n.data.jailed) continue;
    for (const t of shop.sells) {
      const it = game.itemType(t);
      if (!it?.tags.includes('food') || game.count(n.id, t) <= 0) continue;
      const price = quote(game, n.id, t, 'sell');
      if (price != null && price <= game.balance(game.playerId) && (!best || price < best.price || (price === best.price && t === 'meal'))) best = { npc: n, type: t, price, name: it.name };
    }
  }
  if (best) {
    game.pay(game.playerId, best.npc.id, best.price, `${best.name} from ${best.npc.name}`, 'trade');
    inv.destroyItems(game.ctx, { typeId: best.type, qty: 1, holderKind: 'character', holderId: best.npc.id, reason: 'consume', memo: 'eaten by the player' });
    game.updateChar(game.playerId, { last_meal: game.time });
    facts.push(`You buy ${best.type === 'meal' ? 'a hot meal' : `a ${best.name}`} from ${best.npc.name} for ${game.money(best.price)}${best.price === 1 ? '' : 's'} and eat.`);
    return true;
  }
  // Recovery path: the Temple of the Still Ring feeds the destitute, once a day
  const loc = game.location(here(game));
  if (loc.tags.includes('healing') && game.balance(game.playerId) < 3 && daily(game, 'alms')) {
    game.updateChar(game.playerId, { last_meal: game.time });
    const healer = npcsHere(game).find((n) => game.npcDef(n.id)?.healing);
    if (healer) game.adjustRel(healer.id, game.playerId, { familiarity: 2 }, 'gave alms');
    facts.push('The temple feeds you a bowl of barley soup from its alms kitchen, asking nothing in return.');
    return true;
  }
  return false;
}

function eat(game, p) {
  const facts = [];
  if (p.item) {
    const typeId = needHeldItem(game, p.item);
    const t = game.itemType(typeId);
    if (!t.tags.includes('food') && !t.tags.includes('drink')) fail('inedible', `You can't eat ${t.name}.`);
    inv.destroyItems(game.ctx, { typeId, qty: 1, holderKind: 'character', holderId: game.playerId, reason: 'consume', memo: 'eaten' });
    if (t.tags.includes('food')) game.updateChar(game.playerId, { last_meal: game.time });
    facts.push(`You consume ${t.name}.`);
  } else if (!eatIfPossible(game, facts)) fail('no_food', game.balance(game.playerId) < 3 ? 'You have no food and no money. The Temple of the Still Ring is said to feed the destitute.' : `You have no food, and nobody here sells a meal you can afford. Meals are sold at ${game.def.npcs.filter((n) => n.shop?.sells?.includes('meal') && game.settlementOf(n.location) === game.settlementOf(here(game))).map((n) => game.location(n.location).name).join(' and ') || 'the nearest inn'}.`);
  game.addFatigue(game.playerId, -3);
  game.advance(20, 'eat');
  return { ok: true, minutes: 20, summary: 'You eat.', facts };
}

// ============================================================================
// learning: study and train (multi-day aware, with real costs and limits)
// ============================================================================
function studySource(game, skill, p) {
  // returns {method, cap, label, mentor?, fee?, book?}
  const present = npcsHere(game);
  const mentorQuery = p.target;
  for (const n of present) {
    const t = (game.npcDef(n.id)?.teaches || []).find(([s]) => s === skill);
    if (!t) continue;
    if (mentorQuery && !resolveCharacter(mentorQuery, [n]).match) continue;
    if (p.method && p.method !== 'mentor') continue;
    return { method: 'mentor', cap: t[1], fee: t[2], mentor: n, label: `lessons with ${n.name}` };
  }
  if (mentorQuery && (p.method === 'mentor' || !p.method)) {
    const any = game.def.npcs.find((n) => (n.teaches || []).some(([s]) => s === skill));
    // a named person who isn't here: say so rather than silently teaching yourself
    const named = resolveCharacter(mentorQuery, game.def.npcs.map((n) => game.char(n.id)).filter(Boolean)).match;
    if (named && !present.some((n) => n.id === named.id)) {
      const where = game.rel(named.id, game.playerId).familiarity > 0 || game.knowsLocation(game.playerId, named.location_id) ? ` (you could look for them at ${game.location(named.location_id).name})` : '';
      fail('no_mentor', `${named.name} isn't here${where}.`);
    }
    if (p.method === 'mentor') fail('no_mentor', any ? `${any.name} teaches ${game.rules.skills[skill].label}, but isn't here.` : `Nobody here teaches ${game.rules.skills[skill].label}.`);
  }
  const book = game.held(game.playerId).find((i) => i.type_data.teaches === skill);
  if (book) return { method: 'book', cap: book.type_data.max_rank, book: book.name, label: `studying ${book.name}` };
  // archive reading room: books can be read on site for a fee
  const loc = game.location(here(game));
  if (loc.tags.includes('library')) {
    const keeper = present.find((n) => game.npcDef(n.id)?.reading_fee != null);
    const shelf = keeper && game.held(keeper.id).find((i) => i.type_data.teaches === skill);
    if (shelf) return { method: 'book', cap: shelf.type_data.max_rank, book: shelf.name, label: `reading ${shelf.name} in the archive`, readingFee: game.npcDef(keeper.id).reading_fee, keeper };
  }
  return { method: 'self', cap: LEARNING_METHODS.self.cap, label: 'teaching yourself' };
}

function studyHours(p, dflt = 4) {
  if (p.days) return null;
  return clamp(Number(p.hours) || dflt, 1, 12);
}

function learnSession(game, skill, src, hours, mode) {
  // perform `hours` of study/training today. Returns {xp, notes}
  const notes = [];
  const s = game.skill(game.playerId, skill);
  const attrName = (mode === 'train' ? LEARNING_METHODS.drill.attr : LEARNING_METHODS[src.method]?.attr) || 'intellect';
  const methodKey = mode === 'train' ? (src.method === 'experiment' ? 'experiment' : 'drill') : src.method;
  const capRank = mode === 'train' ? LEARNING_METHODS[methodKey].cap : src.cap;
  if (s.rank >= capRank) return { xp: 0, capped: true, notes: [`${src.label || LEARNING_METHODS[methodKey].label} can't take you past rank ${capRank} in ${game.rules.skills[skill].label}.`] };
  let xp = 0;
  const perHour = studyXpPerHour(methodKey, game.attr(game.playerId, attrName));
  for (let h = 0; h < hours; h++) {
    const sessionFactor = h < 4 ? 1 : h < 8 ? 0.6 : 0.25;
    const fat = game.player().fatigue;
    const fatFactor = fat >= 90 ? 0.2 : fat >= 70 ? 0.6 : 1;
    xp += perHour * sessionFactor * fatFactor * game.dailyDiminishing(game.playerId, skill);
    game.advance(60, mode);
    game.addFatigue(game.playerId, mode === 'train' ? 6 : 4);
  }
  if (src.fee) {
    const sessions = Math.max(1, Math.round(hours / 4));
    const fee = src.fee * sessions;
    if (game.balance(game.playerId) < fee) fail('insufficient_funds', `${src.mentor.name} charges ${game.money(fee)} for this; you have ${game.balance(game.playerId)}.`);
    game.pay(game.playerId, src.mentor.id, fee, `${game.rules.skills[skill].label} lessons`, 'tuition');
    notes.push(`Paid ${src.mentor.name} ${game.money(fee)}.`);
    game.adjustRel(src.mentor.id, game.playerId, { familiarity: 2, ...(daily(game, `lesson:${src.mentor.id}`) ? { respect: 1 } : {}) }, 'lessons');
  }
  if (src.readingFee && daily(game, 'reading_fee')) {
    if (game.balance(game.playerId) < src.readingFee) fail('insufficient_funds', `The reading room costs ${game.money(src.readingFee)}.`);
    game.pay(game.playerId, src.keeper.id, src.readingFee, 'Archive reading room', 'fee');
    notes.push(`Paid ${game.money(src.readingFee)} for the reading room.`);
  }
  const res = game.gainXp(game.playerId, skill, round2(xp), mode === 'train' ? methodKey : src.method, hours * 60, src.label, { cap: capRank });
  return { xp: res.xp, rankAfter: res.rankAfter, rankBefore: res.rankBefore, capped: res.capped, notes };
}

function untilHour(game, h) {
  const cal = game.calendar();
  let mins = ((h - cal.hour + 24) % 24) * 60 - cal.min;
  if (mins < 0) mins += MINUTES_PER_DAY;
  if (mins > 0) game.advance(mins, 'wait');
}

/** Repeat a daily routine for N days: activity, a meal, a night's sleep — with real costs and interruptions. */
function multiDay(game, days, hoursPerDay, dayFn) {
  const notes = [];
  let completed = 0, totalXp = 0;
  const startDigest = game.digest.length;
  for (let d = 0; d < days; d++) {
    const cal = game.calendar();
    if (cal.hour >= 12 || cal.hour < 6) { rest(game, { hours: 8 }); untilHour(game, 7); }
    const res = dayFn(d);
    totalXp += res.xp || 0;
    if (res.stop) { notes.push(res.stop); break; }
    if (res.capped && !res.xp) { notes.push(...(res.notes || [])); break; }
    completed++;
    if (!eatIfPossible(game, [])) notes.push(`Day ${d + 1}: you went hungry.`);
    const newsy = game.digest.slice(startDigest).filter((e) => e.importance >= 7);
    if (newsy.length) { notes.push(`Interrupted: ${newsy.map((e) => e.summary).join(' ')}`); break; }
    if (game.player().health < 40) { notes.push('Your health is failing; you stop.'); break; }
  }
  return { completed, totalXp: round2(totalXp), notes: [...new Set(notes)] };
}

/**
 * Learn a world ability/technique (rule with requires.capability). Needs a teacher present
 * who has it, or enough skill to work it out alone; takes the rule's learn.hours of study.
 */
function learnAbility(game, rule, p) {
  const spec = rule.spec;
  if (hasCapability(game, game.playerId, rule.id)) return { ok: true, minutes: 0, summary: `You already know ${rule.name}.`, facts: [] };
  const teacher = npcsHere(game).find((n) => hasCapability(game, n.id, rule.id));
  const rank = game.skill(game.playerId, spec.skill).rank;
  const need = spec.requires?.skill_min || 0;
  if (!teacher && rank < need + 2) fail('no_teacher', `To learn ${rule.name} you need someone who knows it${spec.learn?.teachers?.length ? ` (${spec.learn.teachers.map((t) => game.char(t)?.name).filter(Boolean).join(', ')})` : ''}, or ${game.rules.skills[spec.skill].label} ${need + 2} to work it out yourself (you have ${rank}).`);
  if (rank < need) fail('underqualified', `${rule.name} needs ${game.rules.skills[spec.skill].label} ${need} before it can be learned (you have ${rank}).`);
  const hours = clamp(Number(p.hours) || (p.days ? p.days * 6 : 4), 1, 12 * 30);
  const required = spec.learn?.hours || 12;
  const prog = game.player().data.learning || {};
  let done = prog[rule.id] || 0;
  let spent = 0;
  if (teacher) {
    const fee = (game.npcDef(teacher.id)?.teaches_fee ?? 3) * Math.max(1, Math.round(Math.min(hours, required - done) / 4));
    if (game.balance(game.playerId) < fee) fail('insufficient_funds', `${teacher.name} asks ${game.money(fee)} for the lessons.`);
    if (fee > 0) game.pay(game.playerId, teacher.id, fee, `Lessons in ${rule.name}`, 'tuition');
  }
  while (spent < hours && done < required) {
    const step = Math.min(4, hours - spent, required - done);
    game.advance(step * 60, 'study');
    game.addFatigue(game.playerId, step * 4);
    done += step * (teacher ? 1 : 0.6);
    spent += step;
  }
  const facts = [];
  if (done >= required) {
    grantCapability(game, game.playerId, rule.id, teacher ? `taught by ${teacher.name}` : 'self-taught');
    game.recordEvent({ kind: 'learned', actor: game.playerId, target: teacher?.id || null, summary: `${game.player().name} learned ${rule.name}.`, visibility: 'private', importance: 6 });
    game.journal('discovery', `Learned: ${rule.name}`, spec.summary, `cap:${rule.id}`);
    facts.push(`You have learned ${rule.name}. (${spec.summary})`);
    done = required;
  } else facts.push(`Progress learning ${rule.name}: ${Math.floor(done)}/${required} hours.`);
  game.setCharData(game.playerId, { learning: { ...prog, [rule.id]: done } });
  return { ok: true, minutes: spent * 60, summary: `You study ${rule.name}${teacher ? ` with ${teacher.name}` : ''}.`, facts };
}

function useAbility(game, p) {
  const rule = findRule(game, p.target || p.item || p.topic || p.detail);
  if (!rule) fail('unknown_ability', `There is no ability or technique called "${p.target || p.topic || p.detail}" in this world.`);
  let targetId = null;
  if (rule.spec.requires?.target || p.item) {
    const who = p.item ? resolveCharacter(p.item, npcsHere(game)).match : null;
    targetId = who?.id || null;
  }
  const res = useRule(game, game.playerId, rule, { targetId, destination: p.destination || p.detail || p.topic || p.item });
  return { ok: res.bucket !== 'failure', minutes: res.minutes, summary: `You use ${rule.name}.`, facts: res.facts, rolls: [res.roll] };
}

function study(game, p) {
  const asRule = !game.resolveSkill(p.skill || p.topic) && findRule(game, p.skill || p.topic || p.target);
  if (asRule && asRule.spec.requires?.capability) return learnAbility(game, asRule, p);
  const skill = game.resolveSkill(p.skill || p.topic);
  if (!skill) fail('unknown_skill', `There's no way to study "${p.skill || p.topic}" here. Skills: ${Object.values(game.rules.skills).map((s) => s.label).join(', ')}.`);
  const src = studySource(game, skill, p);
  const days = p.days ? clamp(Math.floor(Number(p.days)), 1, 365) : (Number(p.hours) > 12 ? Math.ceil(Number(p.hours) / 6) : 0);
  const facts = [];
  const before = game.skill(game.playerId, skill);
  if (days) {
    const r = multiDay(game, days, 6, () => {
      const cur = studySource(game, skill, p);
      if (cur.method !== src.method) return { stop: 'Your teacher or book is no longer available.' };
      try { return learnSession(game, skill, cur, 6, 'study'); } catch (e) { if (e instanceof RuleError) return { stop: e.message }; throw e; }
    });
    const after = game.skill(game.playerId, skill);
    facts.push(`Studied ${r.completed} of ${days} days by ${src.label}.`, `${game.rules.skills[skill].label}: rank ${before.rank} → ${after.rank} (+${round2(after.xp - before.xp)} xp).`, ...r.notes);
    if (after.rank >= src.cap && !r.notes.some((n) => n.includes("can't take you past"))) facts.push(`${src.label} can't take you past rank ${src.cap}; you'll need a better teacher, deeper texts, or real practice.`);
    if (src.method === 'self') { const t = game.def.npcs.filter((n) => (n.teaches || []).some(([s]) => s === skill)).map((n) => n.name); facts.push(`Without a teacher or book you only grasp the basics. Seek a mentor${t.length ? ` (${t.slice(0, 3).join(', ')} teach it)` : ''} or a book.`); }
    return { ok: r.completed > 0, minutes: 0, summary: `You spend ${r.completed} days studying ${game.rules.skills[skill].label.toLowerCase()}.`, facts };
  }
  const hours = studyHours(p);
  const r = learnSession(game, skill, src, hours, 'study');
  const after = game.skill(game.playerId, skill);
  facts.push(...r.notes, `Method: ${src.label}.`, r.capped && r.xp === 0 ? '' : `${game.rules.skills[skill].label}: +${r.xp} xp (rank ${after.rank}, ${round2(after.xp)}/${xpForRank(after.rank + 1)} xp).`);
  if (src.method === 'self') facts.push('Without a teacher or book you only grasp the basics. Seek a mentor or a book.');
  return { ok: true, minutes: hours * 60, summary: `You study ${game.rules.skills[skill].label.toLowerCase()} for ${hours} hours.`, facts: facts.filter(Boolean) };
}

function train(game, p) {
  const skill = game.resolveSkill(p.skill || p.topic);
  if (!skill) fail('unknown_skill', `Train what? Skills: ${Object.values(game.rules.skills).map((s) => s.label).join(', ')}.`);
  let method = 'drill';
  if (!game.rules.drillable(skill)) {
    if (game.rules.experimentable(skill)) method = 'experiment';
    else fail('cant_drill', `${game.rules.skills[skill].label} can't be drilled alone. Study it, or use it for real with people.`);
  }
  if (skill === 'smithing') {
    if (!game.location(here(game)).tags.includes('smithing')) fail('need_forge', 'You need a forge to practise smithing.');
  }
  if (method === 'experiment') {
    const tool = inv.toolBonus(game.db, game.playerId, skill);
    if (!tool) fail('need_tools', `Experimenting in ${game.rules.skills[skill].label} needs proper tools.`);
  }
  const src = { method, label: LEARNING_METHODS[method].label };
  const days = p.days ? clamp(Math.floor(Number(p.days)), 1, 365) : 0;
  const before = game.skill(game.playerId, skill);
  const facts = [];
  if (days) {
    const r = multiDay(game, days, 5, () => learnSession(game, skill, src, 5, 'train'));
    const after = game.skill(game.playerId, skill);
    facts.push(`Trained ${r.completed} of ${days} days.`, `${game.rules.skills[skill].label}: rank ${before.rank} → ${after.rank}.`, ...r.notes);
    if (after.rank >= LEARNING_METHODS[method].cap) facts.push(`Drills alone won't take you past rank ${LEARNING_METHODS[method].cap}. Real challenges will.`);
    return { ok: true, minutes: 0, summary: `You train ${game.rules.skills[skill].label.toLowerCase()} for ${r.completed} days.`, facts };
  }
  const hours = studyHours(p, 3);
  const r = learnSession(game, skill, src, hours, 'train');
  const after = game.skill(game.playerId, skill);
  facts.push(...r.notes, `${game.rules.skills[skill].label}: +${r.xp} xp (rank ${after.rank}).`);
  return { ok: true, minutes: hours * 60, summary: `You train ${game.rules.skills[skill].label.toLowerCase()} for ${hours} hours.`, facts };
}

// ============================================================================
// craft & gather
// ============================================================================
function craft(game, p) {
  const recipes = game.def.recipes;
  const q = norm(p.item || p.topic || p.detail);
  let recipe = recipes.find((r) => norm(r.name) === q || r.id === q) || recipes.find((r) => q && (norm(r.name).includes(q) || Object.keys(r.outputs).some((o) => q.includes(o) || norm(game.itemType(o).name).includes(q))));
  if (!recipe) {
    const out = resolveItemType(q, recipes.flatMap((r) => Object.keys(r.outputs)).map((id) => ({ id, name: game.itemType(id).name })));
    recipe = recipes.find((r) => out && r.outputs[out]);
  }
  if (!recipe) {
    const projects = game.db.prepare("SELECT * FROM projects WHERE owner_id=? AND status='completed'").all(game.playerId);
    const inv2 = projects.find((pr) => q.includes(norm(pr.title)) || norm(pr.title).includes(q));
    if (inv2 && J.parse(inv2.data, {}).recipe) recipe = J.parse(inv2.data, {}).recipe;
  }
  if (!recipe) fail('unknown_recipe', `You don't know how to make "${p.item || p.topic}". Known recipes: ${recipes.map((r) => r.name).join(', ')}.`);
  const batches = qtyOf(p);
  const loc = game.location(here(game));
  for (const tag of recipe.location_tags || []) if (!loc.tags.includes(tag)) fail('wrong_place', `To ${recipe.name} you need a suitable place (${tag}).`);
  for (const tool of recipe.tools || []) if (!game.count(game.playerId, tool)) fail('need_tools', `You need a ${game.itemType(tool).name}.`);
  const facts = [], rolls = [];
  let made = 0;
  for (let b = 0; b < batches; b++) {
    for (const [t, n] of Object.entries(recipe.inputs)) {
      if (game.count(game.playerId, t, { ownerId: game.playerId }) < n) {
        if (b === 0) fail('missing_inputs', `To ${recipe.name} you need ${Object.entries(recipe.inputs).map(([x, k]) => `${k} ${game.itemType(x).name}`).join(' and ')}. You have ${game.count(game.playerId, t, { ownerId: game.playerId })} ${game.itemType(t).name}.`);
        facts.push('You run out of materials.');
        b = batches; break;
      }
    }
    if (b >= batches) break;
    const r = game.check(game.playerId, { skill: recipe.skill, tn: recipe.tn, label: `${recipe.name}` });
    rolls.push(r);
    const lossFactor = r.degree === 'severe_failure' ? 1 : r.degree === 'failure' ? 0.5 : 0;
    const outFactor = { critical: 1.5, strong: 1.25, success: 1, partial: 0.5, failure: 0, severe_failure: 0, automatic: 1 }[r.degree] ?? 0;
    for (const [t, n] of Object.entries(recipe.inputs)) {
      const used = outFactor > 0 ? n : Math.max(1, Math.round(n * lossFactor));
      inv.destroyItems(game.ctx, { typeId: t, qty: used, holderKind: 'character', holderId: game.playerId, ownerId: game.playerId, reason: 'consume', memo: recipe.name });
    }
    for (const [t, n] of Object.entries(recipe.outputs)) {
      const out = Math.floor(n * outFactor);
      if (out > 0) { inv.createItems(game.ctx, { typeId: t, qty: out, holderKind: 'character', holderId: game.playerId, ownerId: game.playerId, reason: 'produce', memo: recipe.name }); made += out; }
    }
    facts.push(`Batch ${b + 1}: ${DEGREE_LABEL[r.degree].toLowerCase()}${outFactor ? ` — made ${Object.entries(recipe.outputs).map(([t, n]) => `${Math.floor(n * outFactor)} ${game.itemType(t).name}`).join(', ')}` : ' — materials wasted'}.`);
    game.advance(recipe.minutes, 'craft');
    game.addFatigue(game.playerId, recipe.minutes / 30);
  }
  return { ok: made > 0, minutes: recipe.minutes * batches, summary: made ? `You ${recipe.name}.` : `Your attempt to ${recipe.name} fails.`, facts, rolls };
}

function gather(game, p) {
  const loc = game.location(here(game));
  const nodes = loc.data.gather || [];
  if (!nodes.length) fail('nothing_to_gather', `There is nothing to gather at ${loc.name}.`);
  let node = nodes[0];
  if (p.item) {
    const id = resolveItemType(p.item, nodes.map((n) => ({ id: n.type, name: game.itemType(n.type).name })));
    if (!id) fail('nothing_to_gather', `You won't find "${p.item}" here. You could gather: ${nodes.map((n) => game.itemType(n.type).name).join(', ')}.`);
    node = nodes.find((n) => n.type === id);
  }
  const state = loc.data.gather_state || {};
  const avail = state[node.type] ?? node.capacity;
  const hours = clamp(Number(p.hours) || 2, 1, 8);
  if (avail <= 0) { game.advance(30, 'gather'); return { ok: false, minutes: 30, summary: `The ${game.itemType(node.type).name} here has been picked clean. It will regrow in time.`, facts: [] }; }
  const r = game.check(game.playerId, { skill: node.skill, tn: node.tn, label: `Gather ${game.itemType(node.type).name}`, mods: hours >= 4 ? [{ label: 'Thorough search', value: 1 }] : [] });
  const yieldN = Math.min(avail, Math.round(({ critical: 4, strong: 3, success: 2, partial: 1, failure: 0, severe_failure: 0, automatic: 3 }[r.degree] ?? 0) * (hours / 2)));
  if (yieldN > 0) {
    inv.createItems(game.ctx, { typeId: node.type, qty: yieldN, holderKind: 'character', holderId: game.playerId, ownerId: game.playerId, reason: 'gather', memo: `gathered at ${loc.name}` });
    state[node.type] = avail - yieldN;
    loc.data.gather_state = state;
    game.db.prepare('UPDATE locations SET data=? WHERE id=?').run(J.str(loc.data), loc.id);
  }
  game.advance(hours * 60, 'gather');
  game.addFatigue(game.playerId, hours * 4);
  const facts = [yieldN ? `Gathered ${yieldN} ${game.itemType(node.type).name}.` : 'You find nothing worth taking.'];
  if (r.degree === 'severe_failure') { game.hurt(game.playerId, 6, 'brambles and a twisted ankle'); facts.push('You twist an ankle in the undergrowth (−6 health).'); }
  return { ok: yieldN > 0, minutes: hours * 60, summary: `You search for ${game.itemType(node.type).name}.`, facts, rolls: [r] };
}

// ============================================================================
// investigate — searching locations, following leads
// ============================================================================
function investigate(game, p) {
  const loc = game.location(here(game));
  const facts = [], rolls = [];
  const night = game.calendar().block === 'night';
  const lightMods = night && !inv.toolBonus(game.db, game.playerId, 'investigation') ? [{ label: 'Darkness without a lantern', value: -2 }] : [];
  const topic = norm(`${p.topic || ''} ${p.detail || ''} ${p.target || ''}`);
  let minutes = 60;
  // hidden stores (evidence of the grain hoard)
  for (const h of game.def.hidden_stores || []) {
    if (h.location_id !== loc.id) continue;
    const flags = getFlags(game);
    const watchers = h.watchers || [h.owner];
    const observers = npcsHere(game).filter((n) => watchers.includes(n.id));
    let unseen = true;
    if (observers.length) {
      const sr = game.check(game.playerId, { skill: 'stealth', label: `Snoop unobserved`, opposedBy: observers[0].id, opposedSkill: 'perception' });
      rolls.push(sr);
      unseen = isAtLeastPartial(sr.degree);
      if (!unseen) {
        const ev = game.recordEvent({ kind: 'snooping', actor: game.playerId, target: observers[0].id, summary: `${observers[0].name} caught ${game.player().name} poking around the chained granary.`, importance: 6, valence: -0.5, data: { hearsay: { trust: -6 } } });
        game.adjustRel(observers[0].id, game.playerId, { trust: -15 }, 'caught snooping', ev.eventId);
        if (h.owner && observers[0].id !== h.owner) game.adjustRel(h.owner, game.playerId, { trust: -10 }, `${observers[0].name} reported snooping`);
        facts.push(`${observers[0].name} spots you and hurries you away from the granary doors.`);
      }
    }
    if (!unseen) continue;
    const r = game.check(game.playerId, { skill: h.evidence.skill, tn: h.evidence.tn, label: `Search ${h.name}`, mods: lightMods });
    rolls.push(r);
    const hidden = game.db.prepare("SELECT COALESCE(SUM(quantity),0) q FROM items WHERE holder_kind='hidden' AND holder_id=?").get(h.id).q;
    if (flags[`seized:${h.id}`]) { facts.push(h.seized_text || 'Someone has already broken in and emptied this place.'); continue; }
    if (isSuccess(r.degree)) {
      const ev = inv.countHeld(game.db, 'hidden', `${h.id}:evidence`, h.evidence.item);
      if (ev) {
        inv.moveItems(game.ctx, { typeId: h.evidence.item, qty: 1, from: { kind: 'hidden', id: `${h.id}:evidence` }, to: { kind: 'character', id: game.playerId }, markStolen: true, memo: 'taken as evidence' });
        facts.push(`${h.found_text || `Hidden inside ${h.name} you find ${hidden} stored goods.`} You take the ${game.itemType(h.evidence.item).name} as evidence.`);
      } else facts.push(h.found_text || `Hidden inside ${h.name} you count ${hidden} stored goods.`);
      game.learnFact(game.playerId, h.evidence.fact, { belief: 'known', confidence: 0.95, source: 'saw it myself' });
      game.recordEvent({ kind: 'discovery', actor: game.playerId, summary: `${game.player().name} discovered the mayor's hidden grain hoard.`, visibility: 'secret', importance: 8 });
    } else if (r.degree === 'partial') {
      facts.push('The lower doors are chained, but fresh flour dust lies on the threshold and the hinges are oiled. Someone uses this store often.');
      if (h.evidence.partial_fact) game.learnFact(game.playerId, h.evidence.partial_fact, { belief: 'suspected', confidence: 0.6, source: 'own observation' });
    } else facts.push('You find nothing but chains, cobwebs and a nervous cat.');
  }
  // lost secrets in ruins
  for (const s of game.def.secrets_at || []) {
    if (s.location_id !== loc.id) continue;
    const left = inv.countHeld(game.db, 'hidden', `secret:${loc.id}`, s.item);
    if (!left) { facts.push('You have already found what this place had to give.'); continue; }
    const r = game.check(game.playerId, { skill: s.skill, tn: s.tn, label: `Search ${loc.name}`, mods: lightMods });
    rolls.push(r);
    if (isSuccess(r.degree)) {
      inv.moveItems(game.ctx, { typeId: s.item, qty: 1, from: { kind: 'hidden', id: `secret:${loc.id}` }, to: { kind: 'character', id: game.playerId }, newOwner: game.playerId, memo: 'found in the ruins' });
      facts.push(s.text);
      game.learnFact(game.playerId, s.fact, { belief: 'known', confidence: 1, source: 'saw it myself' });
      setFlag(game, s.flag || `found:${loc.id}`, game.day);
      const itemName = game.itemType(s.item).name;
      game.recordEvent({ kind: 'discovery', actor: game.playerId, summary: `${game.player().name} recovered ${itemName} from ${loc.name}.`, visibility: 'private', importance: 8 });
      game.journal('discovery', s.title || `Found: ${itemName}`, s.journal || s.text, `found:${loc.id}`);
    } else if (r.degree === 'partial') facts.push('Star-charts, broken lenses, a collapsed stair. Something glints under the rubble, but the light fails you. Try again.');
    else facts.push('Dust, rot and fallen masonry. Nothing you can find today.');
    minutes = 120;
  }
  // hidden paths to secret places
  for (const hp of loc.data.hidden_paths || []) {
    if (hp.keywords && topic && !hp.keywords.some((k) => topic.includes(k))) continue;
    const dest = game.location(hp.to);
    if (game.knowsLocation(game.playerId, hp.to)) { facts.push(`You know the way to ${dest.name} from here.`); continue; }
    const r = game.check(game.playerId, { skill: hp.skill || 'survival', tn: hp.tn || DIFFICULTY.hard, label: `Search for a hidden way`, mods: hp.fact && belief(game.db, game.playerId, hp.fact) ? [{ label: 'You know roughly where to look', value: 2 }] : [] });
    rolls.push(r);
    if (isSuccess(r.degree)) {
      if (hp.fact) game.learnFact(game.playerId, hp.fact, { belief: 'known', confidence: 1, source: 'found the path' });
      else game.setCharData(game.playerId, { visited: [...new Set([...(game.player().data.visited || []), hp.to])] });
      facts.push(hp.text || `You find a hidden way to ${dest.name}.`);
    } else facts.push('The trail fades and you circle back without finding anything.');
    minutes = 180;
  }
  // market inspection: prices are public and deterministic
  if (loc.tags.includes('market') || /price|market|cost|trade|economy/.test(topic)) {
    const s = game.settlementOf(loc.id);
    if (s) {
      const rows = game.db.prepare('SELECT type_id FROM markets WHERE settlement=?').all(s);
      const named = rows.filter((r) => topic.includes(norm(game.itemType(r.type_id).name).split(' ').pop()));
      const shown = (named.length ? named : rows).slice(0, 8);
      facts.push(`Market prices in ${game.def.settlements.find((x) => x.id === s).name}: ${shown.map((r) => `${game.itemType(r.type_id).name} ${game.money(marketPrice(game, s, r.type_id))}`).join(', ')}.`);
      for (const r of shown.slice(0, 3)) {
        const hist = game.db.prepare('SELECT day, price FROM price_history WHERE settlement=? AND type_id=? ORDER BY day').all(s, r.type_id);
        if (hist.length > 1 && hist[0].price !== hist.at(-1).price) facts.push(`${game.itemType(r.type_id).name} has gone from ${game.money(hist[0].price)} to ${game.money(hist.at(-1).price)} over ${hist.length} days of records.`);
      }
      minutes = Math.min(minutes, 45);
    }
  }
  if (!facts.length) {
    const people = npcsHere(game);
    const r = game.check(game.playerId, { skill: 'perception', tn: DIFFICULTY.moderate, label: `Look around ${loc.name}`, mods: lightMods });
    rolls.push(r);
    facts.push(loc.description);
    if (isSuccess(r.degree) && people.length) facts.push(`You notice: ${people.map((c) => `${c.name} ${c.traits[0] ? `seems ${c.traits[0]}` : ''}`).join('; ')}.`);
    if (topic) facts.push(`Nothing here bears directly on "${p.topic || p.detail}". People who might know are a better lead.`);
    minutes = 30;
  }
  game.advance(minutes, 'investigate');
  return { ok: true, minutes, summary: `You investigate ${loc.name}.`, facts, rolls };
}

// ============================================================================
// combat (deliberately dangerous and consequential)
// ============================================================================
function attack(game, p) {
  const foe = needNpc(game, p.target, { purpose: 'attack' });
  const rolls = [], facts = [];
  const pname = game.player().name;
  let rounds = 0;
  while (rounds < 4 && game.char(foe.id).alive && game.player().alive && game.char(foe.id).health > 30 && game.player().health > 20) {
    rounds++;
    const r = game.check(game.playerId, { skill: 'melee', label: `Strike ${foe.name}`, opposedBy: foe.id, opposedSkill: 'melee', opposedMods: [{ label: 'Armour', value: inv.equippedBonus(game.db, foe.id, 'defense') }] });
    rolls.push(r);
    if (isAtLeastPartial(r.degree)) {
      const dmg = { critical: 30, strong: 22, success: 15, partial: 8 }[r.degree] + inv.equippedBonus(game.db, game.playerId, 'melee') * 3;
      game.hurt(foe.id, dmg, `killed by ${pname}`);
      facts.push(`Round ${rounds}: you hit ${foe.name} (−${dmg}).`);
    } else {
      const dmg = { failure: 10, severe_failure: 20 }[r.degree] + inv.equippedBonus(game.db, foe.id, 'melee') * 3 - inv.equippedBonus(game.db, game.playerId, 'defense') * 3;
      game.hurt(game.playerId, Math.max(3, dmg), `killed by ${foe.name}`);
      facts.push(`Round ${rounds}: ${foe.name} hits you (−${Math.max(3, dmg)}).`);
    }
    game.advance(1, 'fight');
  }
  const f = game.char(foe.id);
  if (!f.alive) facts.push(`${foe.name} is dead.`);
  else if (f.health <= 30) facts.push(`${foe.name} yields, bloodied.`);
  if (game.player().health <= 20 && game.player().alive) facts.push('You are badly hurt and break off.');
  const ev = game.recordEvent({ kind: 'assault', actor: game.playerId, target: foe.id, summary: `${pname} attacked ${foe.name}${!f.alive ? ', killing them' : ''}.`, visibility: 'witnessed', importance: !f.alive ? 10 : 8, valence: -1, data: { hearsay: { trust: -30, fear: 20 } } });
  game.adjustRel(foe.id, game.playerId, { trust: -60, affection: -50, fear: 30 }, 'attacked me', ev.eventId);
  for (const w of npcsHere(game)) if (w.id !== foe.id) game.adjustRel(w.id, game.playerId, { trust: -25, fear: 15 }, 'saw an assault', ev.eventId);
  if (game.settlementOf(here(game))) {
    const fine = Math.min(game.balance(game.playerId), !f.alive ? 100 : 20);
    game.fine(game.playerId, fine, 'Fine for assault');
    facts.push(`The authorities arrive. You are fined ${game.money(fine)}${!f.alive ? ' and marked as a killer' : ''}.`);
    for (const gid of game.guardsOf(game.settlementOf(here(game)))) game.adjustRel(gid, game.playerId, { trust: -30, respect: -10 }, 'assault in town', ev.eventId);
  }
  return { ok: true, minutes: rounds, summary: `You fight ${foe.name}.`, facts, rolls };
}

function heal(game, p) {
  const facts = [], rolls = [];
  const healer = npcsHere(game).find((n) => game.npcDef(n.id)?.healing);
  if (healer && (!p.skill || p.target)) {
    const price = game.npcDef(healer.id).healing.price;
    if (game.player().health >= 100) fail('not_hurt', 'You are not hurt.');
    game.pay(game.playerId, healer.id, price, `Treatment from ${healer.name}`, 'service');
    game.heal(game.playerId, 30);
    game.advance(60, 'heal');
    return { ok: true, minutes: 60, summary: `${healer.name} treats your wounds.`, facts: [`Paid ${game.money(price)}. Health now ${game.player().health}.`] };
  }
  const r = game.check(game.playerId, { skill: 'medicine', tn: DIFFICULTY.moderate, label: 'Treat wounds' });
  rolls.push(r);
  const amt = { critical: 25, strong: 18, success: 12, partial: 6, automatic: 15 }[r.degree] || 0;
  if (amt) game.heal(game.playerId, amt);
  if (r.degree === 'severe_failure') game.hurt(game.playerId, 4, 'botched treatment');
  facts.push(amt ? `You treat your wounds (+${amt} health).` : 'Your treatment does no good.');
  game.advance(45, 'heal');
  return { ok: amt > 0, minutes: 45, summary: 'You tend your wounds.', facts, rolls };
}

// ============================================================================
// finance: loans, repayment, investment
// ============================================================================
function loan(game, p) {
  const lender = needNpc(game, p.target, { purpose: 'borrow from' });
  const terms = game.npcDef(lender.id)?.lends;
  if (!terms) fail('not_lender', `${lender.name} doesn't lend money.`);
  const amount = Math.floor(Number(p.price ?? p.quantity));
  if (!Number.isInteger(amount) || amount <= 0) fail('bad_amount', `How much do you want to borrow? (${lender.name} lends up to ${game.money(terms.max)}.)`);
  if (amount > terms.max) fail('too_much', `${lender.name} won't lend more than ${game.money(terms.max)}.`);
  const outstanding = game.db.prepare("SELECT * FROM contracts WHERE kind='loan' AND party_a=? AND party_b=? AND status='active'").all(lender.id, game.playerId);
  const owed = outstanding.reduce((s, c) => s + J.parse(c.terms, {}).owed, 0);
  if (owed + amount > terms.max) fail('too_much_debt', `You already owe ${lender.name} ${game.money(owed)}; ${terms.max} is the most they'll carry.`);
  const defaults = game.db.prepare("SELECT COUNT(*) n FROM contracts WHERE kind='loan' AND party_b=? AND status='defaulted'").get(game.playerId).n;
  if (defaults) fail('bad_credit', `${lender.name} knows you have defaulted before. No.`);
  const lenderFaction = game.db.prepare('SELECT faction_id FROM faction_members WHERE character_id=?').get(lender.id)?.faction_id;
  const rep = lenderFaction ? game.db.prepare('SELECT value FROM reputation WHERE faction_id=? AND character_id=?').get(lenderFaction, game.playerId)?.value ?? 0 : 0;
  const collateral = game.balance(game.playerId) + businessesOf(game, game.playerId).reduce((s, b) => s + game.balance(b.id), 0);
  const tn = DIFFICULTY.moderate + Math.round(amount / 50) - Math.min(3, Math.floor(collateral / 40)) - Math.round(rep / 25);
  const r = game.check(game.playerId, { skill: 'negotiation', tn, label: `Secure a loan of ${amount} from ${lender.name}`, mods: [{ label: 'Relationship', value: socialMod(game.rel(lender.id, game.playerId)) }] });
  const facts = [];
  if (!isAtLeastPartial(r.degree)) {
    game.advance(30, 'talk');
    return { ok: false, minutes: 30, summary: `${lender.name} declines to lend you ${game.money(amount)}.`, facts: [`They judged the risk too high (TN ${tn}).`], rolls: [r] };
  }
  const rate = r.degree === 'partial' ? terms.rate * 1.5 : r.degree === 'critical' ? terms.rate * 0.6 : terms.rate;
  if (game.balance(lender.id) < amount) fail('lender_poor', `${lender.name} doesn't have ${game.money(amount)} to lend right now.`);
  const due = game.time + terms.days * MINUTES_PER_DAY;
  const totalOwed = Math.ceil(amount * (1 + rate));
  game.pay(lender.id, game.playerId, amount, `Loan from ${lender.name}`, 'loan');
  game.db.prepare(`INSERT INTO contracts(kind,party_a,party_b,title,terms,status,created_at,due_at,data) VALUES ('loan',?,?,?,?,'active',?,?,?)`)
    .run(lender.id, game.playerId, `Loan of ${game.money(amount)} from ${lender.name}`, J.str({ principal: amount, rate: round2(rate), owed: totalOwed }), game.time, due, J.str({ repaid: 0 }));
  game.recordEvent({ kind: 'loan', actor: lender.id, target: game.playerId, summary: `${lender.name} lent ${game.player().name} ${game.money(amount)}, ${totalOwed} to be repaid by ${game.calendar(due).short}.`, visibility: 'private', importance: 6 });
  game.journal('plan', `Debt: ${game.money(totalOwed)} to ${lender.name}`, `Repay ${game.money(totalOwed)} to ${lender.name} by ${game.calendar(due).short}. Defaulting will ruin your standing with the Guild.`, `loan:${lender.id}:${game.time}`);
  facts.push(`Borrowed ${game.money(amount)} at ${Math.round(rate * 100)}%: repay ${totalOwed} by ${game.calendar(due).short}.`);
  game.advance(30, 'talk');
  return { ok: true, minutes: 30, summary: `${lender.name} lends you ${game.money(amount)}.`, facts, rolls: [r] };
}

function repay(game, p) {
  const loans = game.db.prepare("SELECT * FROM contracts WHERE kind='loan' AND party_b=? AND status='active' ORDER BY due_at").all(game.playerId);
  if (!loans.length) fail('no_debt', 'You owe nobody money.');
  let c = loans[0];
  if (p.target) { const n = resolveCharacter(p.target, loans.map((l) => game.char(l.party_a))).match; if (n) c = loans.find((l) => l.party_a === n.id) || c; }
  const lender = game.char(c.party_a);
  if (lender.location_id !== here(game)) fail('not_here', `You must repay ${lender.name} in person (at ${game.location(lender.location_id).name} now).`);
  const terms = J.parse(c.terms, {});
  const amount = Math.min(terms.owed, Math.floor(Number(p.price ?? p.quantity ?? terms.owed)) || terms.owed);
  game.pay(game.playerId, lender.id, amount, `Loan repayment to ${lender.name}`, 'loan_repayment');
  terms.owed -= amount;
  const done = terms.owed <= 0;
  game.db.prepare('UPDATE contracts SET terms=?, status=? WHERE id=?').run(J.str(terms), done ? 'completed' : 'active', c.id);
  if (done) {
    game.adjustRel(lender.id, game.playerId, { trust: 10, respect: 5 }, 'repaid a loan in full');
    const lf = game.db.prepare('SELECT faction_id FROM faction_members WHERE character_id=?').get(lender.id)?.faction_id;
    if (lf) game.db.prepare('INSERT INTO reputation(faction_id, character_id, value) VALUES (?,?,?) ON CONFLICT(faction_id, character_id) DO UPDATE SET value=MIN(100, value+5)').run(lf, game.playerId, 5);
    game.db.prepare("UPDATE journal SET status='done' WHERE ref LIKE ?").run(`loan:${lender.id}:%`);
    if (c.title.startsWith('Family debt')) game.closeJournal('note', 'bg_debt');
  }
  game.recordEvent({ kind: 'repayment', actor: game.playerId, target: lender.id, summary: `${game.player().name} repaid ${game.money(amount)} to ${lender.name}${done ? ', clearing the debt' : ''}.`, visibility: 'private', importance: done ? 5 : 3, valence: 0.4 });
  game.advance(10, 'talk');
  return { ok: true, minutes: 10, summary: `You repay ${game.money(amount)} to ${lender.name}.`, facts: [done ? 'The debt is cleared.' : `${game.money(terms.owed)} still owed.`] };
}

function invest(game, p) {
  // ask an NPC to invest in one of the player's businesses
  const npc = needNpc(game, p.target, { purpose: 'pitch an investment to' });
  const cfg = game.npcDef(npc.id)?.invests;
  const biz = businessesOf(game, game.playerId).filter((b) => b.status === 'active');
  if (!biz.length) fail('no_business', 'You have no business for anyone to invest in yet.');
  const b = (p.item && biz.find((x) => norm(x.name).includes(norm(p.item)))) || biz[biz.length - 1];
  if (!cfg) fail('not_investor', `${npc.name} isn't in a position to invest.`);
  if (!cfg.interest.includes(b.data.template)) fail('not_interested', `${npc.name} has no interest in a ${b.data.template.replace('_', ' ')}.`);
  if (b.data.investor) fail('has_investor', `${b.name} already has an investor.`);
  const amount = Math.min(cfg.max, Math.floor(Number(p.price) || cfg.max));
  const r = game.check(game.playerId, { skill: 'persuasion', tn: DIFFICULTY.hard - (b.data.history?.some((h) => h.profit > 0) ? 2 : 0), label: `Pitch ${b.name} to ${npc.name}`, mods: [{ label: 'Relationship', value: socialMod(game.rel(npc.id, game.playerId)) }, ...(game.skill(game.playerId, 'commerce').rank >= 3 ? [{ label: 'Credible figures', value: 1 }] : [])] });
  if (!isSuccess(r.degree)) {
    game.advance(30, 'talk');
    return { ok: false, minutes: 30, summary: `${npc.name} isn't convinced.`, facts: [], rolls: [r], dialogue: { npc: npc.id, npcName: npc.name, persona: npc.persona, approach: 'pitch', attitude: attitudeLabel(game.rel(npc.id, game.playerId)), disclosed: [] } };
  }
  const avail = Math.min(amount, Math.max(0, game.balance(npc.id) - 20));
  if (avail < 10) fail('investor_poor', `${npc.name} likes the idea but can't spare the money.`);
  addInvestor(game, b.id, npc.id, avail, cfg.share);
  game.adjustRel(npc.id, game.playerId, { trust: 6, respect: 6 }, 'became partners');
  game.recordEvent({ kind: 'investment', actor: npc.id, target: game.playerId, summary: `${npc.name} invested ${game.money(avail)} in ${b.name} for a ${Math.round(cfg.share * 100)}% share of profits.`, visibility: 'private', importance: 6 });
  game.advance(30, 'talk');
  return { ok: true, minutes: 30, summary: `${npc.name} invests ${game.money(avail)} in ${b.name}.`, facts: [`${npc.name} takes ${Math.round(cfg.share * 100)}% of weekly profits.`], rolls: [r] };
}

function foundBiz(game, p) {
  const templates = game.def.business_templates;
  const q = norm(`${p.item || ''} ${p.topic || ''} ${p.detail || ''}`);
  let tpl = templates.find((t) => q.includes(t.id.replace('_', ' ')) || q.includes(norm(t.name)));
  if (!tpl) {
    const hints = { bakery: ['bake', 'bread', 'bakery'], brewery: ['brew', 'ale', 'beer'], fish_curing: ['fish', 'cure', 'curing', 'salted'], apothecary: ['salve', 'apothec', 'remed', 'medicine shop'], trading_company: ['trade', 'trading', 'shipping', 'import', 'export', 'transport', 'company', 'merchant house', 'caravan'] };
    tpl = templates.find((t) => hints[t.id].some((h) => q.includes(h)));
  }
  if (!tpl) fail('unknown_business', `What kind of business? Options here: ${templates.map((t) => `${t.name} (${t.description})`).join('; ')}.`);
  const prems = premisesList(game).filter((pr) => pr.suits.includes(tpl.id) && !pr.taken);
  if (!prems.length) fail('no_premises', `No suitable premises are free for a ${tpl.name.toLowerCase()}.`);
  const prem = prems.find((pr) => q.includes(norm(pr.name).split(' ').slice(-1)[0])) || prems.find((pr) => game.settlementOf(pr.location_id) === game.settlementOf(here(game))) || prems[0];
  const landlord = game.char(prem.landlord);
  if (landlord.location_id !== here(game)) fail('see_landlord', `To take ${prem.name} you must arrange the lease with ${landlord.name} (now at ${game.location(landlord.location_id).name}).`);
  if (game.rel(prem.landlord, game.playerId).trust <= -30) fail('landlord_refuses', `${landlord.name} will not rent to you.`);
  let commodity = null;
  if (tpl.id === 'trading_company') {
    commodity = resolveItemType(q, game.def.item_types.filter((t) => t.commodity).map((t) => ({ id: t.id, name: t.name }))) || 'salt';
  }
  const capital = p.price != null ? Math.floor(Number(p.price)) : Math.max(0, Math.min(game.balance(game.playerId) - (tpl.startup_cost + prem.rent * 6), 40));
  const licensed = /licen[cs]/.test(q) || p.approach === 'licensed';
  const res = foundBusiness(game, { ownerId: game.playerId, templateId: tpl.id, premisesId: prem.id, name: p.detail && p.detail.length < 50 && /[A-Z]/.test(p.detail) ? p.detail : null, capital, commodity, licensed });
  game.adjustRel(prem.landlord, game.playerId, { familiarity: 5, trust: 3 }, 'became a tenant');
  game.advance(60, 'business');
  return {
    ok: true, minutes: 60, summary: `You found ${res.name}.`,
    facts: [`Paid ${game.money(res.upfront)} (equipment, six days' rent${licensed ? ', guild licence' : ''}) and put ${game.money(res.capital)} of working capital into the business.`, `${res.name} will buy inputs, produce and sell each day; reports come weekly.`, ...(licensed ? [] : ['Operating without a guild licence will cost you some goodwill with the Guild of Weights.'])],
  };
}

function manageBiz(game, p) {
  const biz = businessesOf(game, game.playerId).filter((b) => b.status !== 'closed');
  if (!biz.length) fail('no_business', 'You own no business.');
  const b = (p.target && biz.find((x) => norm(x.name).includes(norm(p.target)))) || biz[biz.length - 1];
  const q = norm(`${p.approach || ''} ${p.topic || ''} ${p.detail || ''}`);
  const op = ['deposit', 'withdraw', 'hire', 'pause', 'resume', 'close'].find((o) => q.includes(o)) || (q.includes('take') ? 'withdraw' : q.includes('put') || q.includes('add') ? 'deposit' : null);
  if (!op) {
    const d = b.data;
    return { ok: true, minutes: 5, summary: `${b.name}: status report.`, facts: [`Cash ${game.money(game.balance(b.id))}; revenue to date ${game.money(d.stats.revenue)}; costs ${game.money(d.stats.costs)}; efficiency ${Math.round(d.efficiency * 100)}%; staff ${d.staff}.`, d.last_log?.length ? `Yesterday: ${d.last_log.join(', ')}.` : 'No activity yet.', `You can deposit, withdraw, hire, pause, resume or close.`] };
  }
  const amount = Math.floor(Number(p.price ?? p.quantity) || 0);
  if ((op === 'deposit' || op === 'withdraw') && amount <= 0) fail('bad_amount', 'How much?');
  const r = businessOp(game, game.playerId, b.id, op, amount);
  game.advance(15, 'business');
  return { ok: true, minutes: 15, summary: r.msg, facts: [] };
}

// ============================================================================
// research & invention — long projects resolved through repeated checks
// ============================================================================
const NOVELTY = {
  incremental: { tn: 13, required: 6, minRank: 1 },
  significant: { tn: 16, required: 14, minRank: 3 },
  revolutionary: { tn: 20, required: 30, minRank: 5 },
};

function research(game, p) {
  const skill = game.resolveSkill(p.skill) || game.skillFor(p.skill) || game.rules.roles.research;
  const title = String(p.topic || p.item || 'an untitled inquiry').slice(0, 80);
  let proj = game.db.prepare("SELECT * FROM projects WHERE owner_id=? AND status='active' AND (lower(title)=lower(?) OR ?=1) ORDER BY id DESC").get(game.playerId, title, p.continue ? 1 : 0);
  const facts = [], rolls = [];
  if (!proj) {
    const novelty = NOVELTY[p.novelty] ? p.novelty : (p.difficulty === 'extreme' || p.difficulty === 'legendary' ? 'revolutionary' : p.difficulty === 'hard' || p.difficulty === 'very_hard' ? 'significant' : 'incremental');
    const n = NOVELTY[novelty];
    const rank = game.skill(game.playerId, skill).rank;
    if (rank < n.minRank) fail('underqualified', `A ${novelty} project in ${game.rules.skills[skill].label} needs at least rank ${n.minRank}; you have ${rank}. Study or practise first — or attempt something more modest.`);
    const kind = p.approach === 'invention' || /invent|device|machine|build|design|alloy|tool|engine|ship|craft/.test(norm(title + ' ' + (p.detail || ''))) ? 'invention' : 'research';
    // Foundation knowledge: related facts and techniques of this world that you do not yet
    // understand make the work harder (+2 TN each, up to +6). Knowledge genuinely matters.
    const words = norm(`${title} ${p.detail || ''}`).split(' ').filter((w) => w.length > 4);
    const related = game.db.prepare('SELECT id, subject, tags, content FROM facts WHERE truth=1').all()
      .filter((f) => words.some((w) => J.parse(f.tags, []).some((t) => t.length > 3 && (t.includes(w) || w.includes(t))) || norm(f.subject).includes(w)));
    const unknown = related.filter((f) => !(belief(game.db, game.playerId, f.id)?.confidence >= 0.5)).slice(0, 3);
    const foundationPenalty = unknown.length * 2;
    if (unknown.length) facts.push(`You lack foundational knowledge (${unknown.map((f) => f.subject).join(', ')}): +${foundationPenalty} difficulty until you learn it.`);
    const r = game.db.prepare('INSERT INTO projects(owner_id,kind,title,description,skill,tn,progress,required,status,created_at,data) VALUES (?,?,?,?,?,?,0,?,?,?,?)')
      .run(game.playerId, kind, title, String(p.detail || title).slice(0, 400), skill, n.tn, n.required, 'active', game.time, J.str({ novelty, hours: 0, foundation: unknown.map((f) => f.id) }));
    proj = game.db.prepare('SELECT * FROM projects WHERE id=?').get(Number(r.lastInsertRowid));
    facts.push(`New ${novelty} ${kind} project: "${title}" (${game.rules.skills[skill].label}, TN ${n.tn}, ${n.required} progress needed).`);
    game.journal('plan', `Project: ${title}`, `A ${novelty} ${kind} project in ${game.rules.skills[skill].label}. Progress ${0}/${n.required}.`, `proj:${proj.id}`);
  }
  const hours = clamp(Number(p.hours) || 4, 2, 12);
  const blocks = Math.floor(hours / 2);
  const data = J.parse(proj.data, {});
  const materialCost = proj.kind === 'invention' ? 2 : 0;
  let progress = proj.progress;
  for (let i = 0; i < blocks; i++) {
    if (materialCost) {
      if (game.balance(game.playerId) < materialCost) { facts.push('You run out of money for materials.'); break; }
      game.burn(game.playerId, materialCost, `Materials for "${proj.title}"`);
    }
    const missing = (data.foundation || []).filter((f) => !(belief(game.db, game.playerId, f)?.confidence >= 0.5)).length;
    const mods = [...(game.location(here(game)).tags.includes('library') && proj.kind === 'research' ? [{ label: 'Library resources', value: 1 }] : []), ...(missing ? [{ label: `Missing foundational knowledge (${missing})`, value: -2 * missing }] : [])];
    const r = game.check(game.playerId, { skill: proj.skill, tn: proj.tn, label: `Work on "${proj.title}"`, mods });
    rolls.push(r);
    const gain = { critical: 4, strong: 3, success: 2, partial: 1, failure: 0, severe_failure: -1, automatic: 2, impossible: 0 }[r.degree];
    progress = Math.max(0, progress + gain);
    game.advance(120, 'research');
    game.addFatigue(game.playerId, 7);
    if (progress >= proj.required) break;
  }
  data.hours = (data.hours || 0) + blocks * 2;
  facts.push(`Progress: ${proj.progress} → ${Math.min(progress, proj.required)} of ${proj.required}.`);
  let status = 'active';
  if (progress >= proj.required) {
    status = 'completed';
    // What the result actually does is designed after this turn commits (AI designer with
    // engine validation, or a labelled deterministic fallback) — see engine/innovation.js.
    data.needs_design = true;
    facts.push(proj.kind === 'invention' ? `Breakthrough! "${proj.title}" works. You set down how it is built and used.` : `Breakthrough! Your research into "${proj.title}" is complete.`);
    game.recordEvent({ kind: 'discovery', actor: game.playerId, summary: `${game.player().name} completed "${proj.title}".`, visibility: 'private', importance: 8 });
    game.gainXp(game.playerId, proj.skill, 10, 'experiment', 0, `completed ${proj.title}`);
  } else game.journal('plan', `Project: ${proj.title}`, `Progress ${progress}/${proj.required}. TN ${proj.tn} in ${game.rules.skills[proj.skill].label}.`, `proj:${proj.id}`);
  game.db.prepare('UPDATE projects SET progress=?, status=?, data=? WHERE id=?').run(Math.min(progress, proj.required), status, J.str(data), proj.id);
  return { ok: true, minutes: blocks * 120, summary: status === 'completed' ? `You complete "${proj.title}".` : `You work on "${proj.title}".`, facts, rolls };
}

// ============================================================================
// attempt — bounded catch-all for creative actions without a dedicated rule
// ============================================================================
function attempt(game, p) {
  const skill = game.resolveSkill(p.skill) || game.skillFor(p.skill) || game.rules.roles.notice;
  const tn = clamp(DIFFICULTY[p.difficulty] || DIFFICULTY.moderate, DIFFICULTY.easy, DIFFICULTY.legendary);
  const target = p.target ? resolveCharacter(p.target, npcsHere(game)).match : null;
  const minutes = clamp(Math.round((Number(p.hours) || 0.5) * 60), 5, 240);
  const r = game.check(game.playerId, { skill, tn, label: String(p.detail || p.topic || 'An attempt').slice(0, 80) });
  const facts = [`${DEGREE_LABEL[r.degree]} (${game.rules.skills[skill].label} vs TN ${tn}).`];
  if (target) {
    const d = { critical: 4, strong: 3, success: 2, partial: 0, failure: -1, severe_failure: -3 }[r.degree] || 0;
    if (d && daily(game, `attempt:${target.id}`)) game.adjustRel(target.id, game.playerId, d > 0 ? { respect: d } : { respect: d, affection: d }, String(p.detail || 'an attempt').slice(0, 60));
  }
  game.recordEvent({ kind: 'attempt', actor: game.playerId, target: target?.id || null, summary: `${game.player().name} attempted: ${String(p.detail || p.topic || '').slice(0, 120)} — ${DEGREE_LABEL[r.degree].toLowerCase()}.`, importance: 3 });
  game.advance(minutes, 'attempt');
  game.addFatigue(game.playerId, minutes / 30);
  facts.push('No lasting change to the world beyond what is described: this action has no dedicated rule, so its effects are limited to experience, time and impressions.');
  return { ok: isAtLeastPartial(r.degree), minutes, summary: `You attempt: ${String(p.detail || p.topic || 'something').slice(0, 100)}.`, facts, rolls: [r], freeform: true };
}

function equipA(game, p) {
  const typeId = needHeldItem(game, p.item);
  const row = game.held(game.playerId).find((i) => i.type_id === typeId);
  if (p.approach === 'unequip' || /remove|unequip|take off/.test(norm(p.detail))) {
    inv.unequip(game.ctx, game.playerId, row.id);
    return { ok: true, minutes: 1, summary: `You take off the ${row.name}.`, facts: [] };
  }
  inv.equip(game.ctx, game.playerId, row.id);
  return { ok: true, minutes: 1, summary: `You equip the ${row.name}.`, facts: [] };
}

function use(game, p) {
  // "use <ability or invented device>" arrives as use; route it to the world rule when no held item matches
  const name = p.item || p.target;
  const heldMatch = name && game.held(game.playerId).some((i) => norm(i.name) === norm(name) || norm(i.name).includes(norm(name)));
  if (!heldMatch) { const rule = findRule(game, name || p.detail); if (rule) return useAbility(game, { ...p, target: rule.name, item: null }); }
  const typeId = needHeldItem(game, p.item);
  const t = game.itemType(typeId);
  if (t.data.heal) {
    inv.destroyItems(game.ctx, { typeId, qty: 1, holderKind: 'character', holderId: game.playerId, reason: 'consume', memo: 'applied' });
    game.heal(game.playerId, t.data.heal);
    game.advance(10, 'heal');
    return { ok: true, minutes: 10, summary: `You apply the ${t.name}.`, facts: [`Health now ${game.player().health}.`] };
  }
  if (t.tags.includes('food') || t.tags.includes('drink')) return eat(game, p);
  if (t.data.teaches) return study(game, { skill: t.data.teaches, hours: p.hours || 3 });
  if (t.slot) return equipA(game, p);
  fail('no_use', `You can't think of a way to use the ${t.name} by itself.`);
}

function status(game) {
  const pl = game.player();
  return { ok: true, minutes: 0, summary: 'You take stock.', facts: [`Health ${pl.health}, fatigue ${pl.fatigue}, ${game.money(game.balance(pl.id))}.`] };
}

export const HANDLERS = {
  look, move, talk, tell, ask_job: askJob, accept_request: acceptRequest, buy, sell, give, take, drop, steal, work,
  study, train, rest, wait, eat, craft, gather, investigate, attack, heal, loan, repay, invest,
  found_business: foundBiz, manage_business: manageBiz, research, attempt, equip: equipA, use, status, use_ability: useAbility,
};

/** Rough cost/feasibility preview without rolling dice or changing state. */
export function previewAction(game, a) {
  const out = { type: a.type, feasible: true, notes: [] };
  try {
    if (a.type === 'move') {
      const dest = resolveLocation(a.destination || a.target, game.db.prepare('SELECT id,name FROM locations').all());
      if (!dest || !game.knowsLocation(game.playerId, dest)) { out.feasible = false; out.notes.push('Unknown destination'); }
      else { const path = findPath(game, here(game), dest); if (!path) { out.feasible = false; out.notes.push('No known route'); } else { out.minutes = path.minutes; out.cost = path.cost; } }
    } else if (a.type === 'study' || a.type === 'train') {
      const skill = game.resolveSkill(a.skill || a.topic);
      if (!skill) { out.feasible = false; out.notes.push('Unknown skill'); }
      else { out.skill = skill; out.minutes = (a.days ? a.days * MINUTES_PER_DAY : (Number(a.hours) || 4) * 60); }
    } else if (a.type === 'found_business') {
      out.notes.push('Requires a free premises, the landlord present, and startup money.');
    } else if (a.type === 'steal') {
      out.notes.push('Opposed Sleight of Hand vs the victim\'s Perception; bystanders may notice.');
    }
  } catch (e) { out.feasible = false; out.notes.push(e.message); }
  return out;
}

export { DIFFICULTY };
