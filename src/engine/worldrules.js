// The adaptive rule engine.
//
// Worlds define their own abilities, techniques, technologies and processes as
// DECLARATIVE rule specifications built from a fixed vocabulary of preconditions,
// costs and effects. Rules come from the World Specification (origin 'world'), from
// player inventions and from NPC innovation. The AI may PROPOSE rules; this module
// validates, clamps and installs them, keeps every revision, and executes them through
// normal skill checks. No AI-generated code is ever executed.
import Ajv from 'ajv';
import { J } from './db.js';
import { RuleError } from './ledger.js';
import * as inv from './inventory.js';
import { DIFFICULTY, DIFFICULTY_NAMES, isAtLeastPartial, isSuccess } from './dice.js';
import { norm, resolveLocation } from './resolve.js';
import { clamp, MINUTES_PER_DAY } from './rules.js';

export const RULE_KINDS = ['ability', 'technique', 'technology', 'process', 'device'];
export const EFFECT_TYPES = ['produce', 'heal', 'harm_target', 'harm_self', 'fatigue', 'restore', 'learn_fact', 'relationship', 'travel', 'xp', 'note'];

const itemQty = { type: 'object', properties: { item: { type: 'string', maxLength: 60 }, qty: { type: 'integer', minimum: 1, maximum: 50 } }, required: ['item', 'qty'], additionalProperties: false };
const effect = {
  type: 'object',
  properties: {
    type: { type: 'string', enum: EFFECT_TYPES },
    item: { type: ['string', 'null'], maxLength: 60 },
    qty: { type: ['integer', 'null'], minimum: 0, maximum: 50 },
    amount: { type: ['integer', 'null'], minimum: -60, maximum: 60 },
    fact: { type: ['string', 'null'], maxLength: 300 },
    skill: { type: ['string', 'null'], maxLength: 60 },
    speed: { type: ['number', 'null'], minimum: 0.05, maximum: 1 },
    text: { type: ['string', 'null'], maxLength: 240 },
  },
  required: ['type'],
  additionalProperties: false,
};

export const RULE_SCHEMA = {
  type: 'object',
  properties: {
    id: { type: 'string', pattern: '^[a-z][a-z0-9_]{1,40}$' },
    name: { type: 'string', minLength: 2, maxLength: 60 },
    kind: { type: 'string', enum: RULE_KINDS },
    summary: { type: 'string', maxLength: 240 },
    skill: { type: 'string', maxLength: 60 },
    difficulty: { type: 'string', enum: DIFFICULTY_NAMES },
    minutes: { type: 'integer', minimum: 5, maximum: 1440 },
    requires: {
      type: 'object',
      properties: {
        capability: { type: 'boolean' },
        skill_min: { type: 'integer', minimum: 0, maximum: 10 },
        tools: { type: 'array', items: { type: 'string', maxLength: 60 }, maxItems: 3 },
        location_tags: { type: 'array', items: { type: 'string', maxLength: 30 }, maxItems: 3 },
        target: { type: 'boolean' },
      },
      additionalProperties: false,
    },
    costs: {
      type: 'object',
      properties: {
        items: { type: 'array', items: itemQty, maxItems: 4 },
        money: { type: 'integer', minimum: 0, maximum: 1000 },
        fatigue: { type: 'integer', minimum: 0, maximum: 60 },
        health: { type: 'integer', minimum: 0, maximum: 40 },
      },
      additionalProperties: false,
    },
    effects: {
      type: 'object',
      properties: {
        success: { type: 'array', items: effect, maxItems: 4 },
        partial: { type: 'array', items: effect, maxItems: 4 },
        failure: { type: 'array', items: effect, maxItems: 4 },
      },
      required: ['success'],
      additionalProperties: false,
    },
    learn: {
      type: 'object',
      properties: { hours: { type: 'integer', minimum: 1, maximum: 400 }, teachers: { type: 'array', items: { type: 'string' }, maxItems: 6 } },
      additionalProperties: false,
    },
    limits: { type: 'object', properties: { per_day: { type: 'integer', minimum: 1, maximum: 12 } }, additionalProperties: false },
    side_effects: { type: 'string', maxLength: 240 },
    keywords: { type: 'array', items: { type: 'string', maxLength: 30 }, maxItems: 8 },
    fact: { type: 'string', maxLength: 60 },
    adopt_rank: { type: 'integer', minimum: 0, maximum: 10 },
    opposed: { type: 'string', maxLength: 60 },
  },
  required: ['id', 'name', 'kind', 'summary', 'skill', 'difficulty', 'minutes', 'effects'],
  additionalProperties: false,
};

const ajv = new Ajv({ allErrors: true });
const validateShape = ajv.compile(RULE_SCHEMA);

export function slug(s, max = 40) {
  const t = norm(s).replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, max);
  return /^[a-z]/.test(t) ? t : `r_${t}`.slice(0, max);
}

/**
 * Validate a proposed rule against the schema AND the world's actual contents, repairing
 * what can be repaired safely (unknown skill → closest role; unknown item → dropped) and
 * enforcing balance bounds. Returns {ok, rule, errors, notes}.
 */
export function validateRule(game, raw, { origin = 'world' } = {}) {
  const notes = [];
  const r = JSON.parse(JSON.stringify(raw || {}));
  if (!r.id && r.name) r.id = slug(r.name);
  if (r.id) r.id = slug(r.id);
  r.requires = r.requires || {};
  r.costs = r.costs || {};
  r.effects = r.effects || { success: [] };
  if (!validateShape(r)) return { ok: false, errors: validateShape.errors.map((e) => `${e.instancePath} ${e.message}`), notes };
  if (r.opposed) r.opposed = game.skillFor(r.opposed) || undefined;
  if (!r.opposed) delete r.opposed;
  const skill = game.skillFor(r.skill) || game.resolveSkill(r.skill);
  if (!skill) return { ok: false, errors: [`unknown skill ${r.skill}`], notes };
  if (skill !== r.skill) notes.push(`skill "${r.skill}" mapped to ${skill}`);
  r.skill = skill;
  const itemOk = (id) => !!game.itemType(id);
  for (const list of [r.costs.items || []]) for (const c of [...list]) if (!itemOk(c.item)) { list.splice(list.indexOf(c), 1); notes.push(`dropped unknown cost item ${c.item}`); }
  r.requires.tools = (r.requires.tools || []).filter((t) => itemOk(t) || (notes.push(`dropped unknown tool ${t}`), false));
  const inputValue = (r.costs.items || []).reduce((s, c) => s + game.itemType(c.item).base_value * c.qty, 0) + (r.costs.money || 0);
  for (const bucket of ['success', 'partial', 'failure']) {
    const list = r.effects[bucket] || [];
    r.effects[bucket] = list.filter((e) => {
      if (e.type === 'produce') {
        if (!itemOk(e.item)) { notes.push(`dropped effect producing unknown item ${e.item}`); return false; }
        // conservation of value: without inputs, an ability may only yield a little; with inputs, at most twice their value
        const per = game.itemType(e.item).base_value;
        const maxValue = inputValue > 0 ? inputValue * 2 + 10 : 20;
        const maxQty = Math.max(1, Math.floor(maxValue / Math.max(1, per)));
        if ((e.qty || 1) > maxQty) { notes.push(`clamped ${e.item} output ${e.qty} → ${maxQty} (value bound)`); e.qty = maxQty; }
        e.qty = e.qty || 1;
      }
      if (e.type === 'xp') { e.skill = game.skillFor(e.skill) || r.skill; e.amount = clamp(e.amount || 2, 1, 5); }
      if (['heal', 'harm_target', 'harm_self', 'fatigue', 'restore'].includes(e.type)) e.amount = clamp(Math.abs(e.amount || 10), 1, 40);
      if (e.type === 'relationship') e.amount = clamp(e.amount || 5, -15, 15);
      if (e.type === 'travel') e.speed = clamp(e.speed || 0.5, 0.1, 1);
      if (e.type === 'harm_target') r.requires.target = true;
      return true;
    });
  }
  if (!r.effects.success.length) return { ok: false, errors: ['rule has no valid success effect'], notes };
  if (origin !== 'world' && r.difficulty === 'trivial') { r.difficulty = 'easy'; notes.push('inventions are never trivial'); }
  r.limits = { per_day: r.limits?.per_day ?? 4 };
  return { ok: true, rule: r, errors: [], notes };
}

export function getRule(game, id) {
  const row = game.db.prepare('SELECT * FROM world_rules WHERE id=?').get(id);
  return row ? { ...row, spec: J.parse(row.spec, {}) } : null;
}
export function activeRules(game) {
  return game.db.prepare("SELECT * FROM world_rules WHERE status='active' ORDER BY created_at").all().map((r) => ({ ...r, spec: J.parse(r.spec, {}) }));
}

/** Install (or revise) a validated rule. Every change is a recorded revision with its cause. */
export function installRule(game, rule, { origin, createdBy = null, causeEventId = null, reason }) {
  const prev = getRule(game, rule.id);
  if (prev) {
    const version = prev.version + 1;
    game.db.prepare('UPDATE world_rules SET spec=?, version=?, status=? WHERE id=?').run(J.str(rule), version, 'active', rule.id);
    game.db.prepare('INSERT INTO world_rule_revisions(rule_id, version, time, cause_event_id, reason, spec) VALUES (?,?,?,?,?,?)').run(rule.id, version, game.time, causeEventId, reason || 'revised', J.str(rule));
    return { id: rule.id, version };
  }
  game.db.prepare('INSERT INTO world_rules(id, name, kind, version, status, origin, created_by, created_at, cause_event_id, spec) VALUES (?,?,?,?,?,?,?,?,?,?)')
    .run(rule.id, rule.name, rule.kind, 1, 'active', origin, createdBy, game.time, causeEventId, J.str(rule));
  game.db.prepare('INSERT INTO world_rule_revisions(rule_id, version, time, cause_event_id, reason, spec) VALUES (?,?,?,?,?,?)').run(rule.id, 1, game.time, causeEventId, reason || 'created', J.str(rule));
  return { id: rule.id, version: 1 };
}

export function grantCapability(game, holderId, ruleId, source) {
  game.db.prepare('INSERT OR IGNORE INTO capabilities(holder_id, rule_id, acquired_at, source) VALUES (?,?,?,?)').run(holderId, ruleId, game.time, source);
}
export function hasCapability(game, holderId, ruleId) {
  return !!game.db.prepare('SELECT 1 FROM capabilities WHERE holder_id=? AND rule_id=?').get(holderId, ruleId);
}

export function findRule(game, name) {
  const q = norm(name);
  if (!q) return null;
  const rules = activeRules(game);
  return rules.find((r) => r.id === q.replace(/ /g, '_') || norm(r.name) === q)
    || rules.find((r) => norm(r.name).includes(q) || q.includes(norm(r.name)))
    || rules.find((r) => (r.spec.keywords || []).some((k) => q.includes(norm(k))))
    || null;
}

/** Execute a rule for an actor (the use_ability action). */
export function useRule(game, actorId, rule, { targetId = null, destination = null } = {}) {
  const spec = rule.spec;
  const facts = [];
  const actor = game.char(actorId);
  const loc = game.location(actor.location_id);
  // preconditions
  if (spec.requires?.capability && !hasCapability(game, actorId, rule.id)) {
    const teachers = (spec.learn?.teachers || []).map((t) => game.char(t)?.name).filter(Boolean);
    throw new RuleError('not_learned', `You have not learned ${rule.name}.${teachers.length ? ` ${teachers.join(' or ')} could teach it.` : ' It must be learned or discovered first.'}`);
  }
  const rank = game.skill(actorId, spec.skill).rank;
  if ((spec.requires?.skill_min || 0) > rank) throw new RuleError('underqualified', `${rule.name} needs ${game.rules.skills[spec.skill].label} ${spec.requires.skill_min}; you have ${rank}.`);
  for (const t of spec.requires?.tools || []) if (!game.count(actorId, t)) throw new RuleError('need_tools', `${rule.name} needs a ${game.itemType(t).name}.`);
  for (const tag of spec.requires?.location_tags || []) if (!loc.tags.includes(tag)) throw new RuleError('wrong_place', `${rule.name} can only be done somewhere ${tag}.`);
  if (spec.requires?.target && !targetId) throw new RuleError('need_target', `${rule.name} needs a target.`);
  const usesKey = `ability:${rule.id}`;
  const daily = actor.data.ability_uses || {};
  const today = game.day;
  const used = daily[usesKey]?.day === today ? daily[usesKey].n : 0;
  if (used >= (spec.limits?.per_day ?? 4)) throw new RuleError('exhausted', `You cannot use ${rule.name} again today.`);
  // costs (paid before rolling; a failure still costs)
  for (const c of spec.costs?.items || []) {
    if (game.count(actorId, c.item, { ownerId: actorId }) < c.qty) throw new RuleError('missing_inputs', `${rule.name} consumes ${c.qty} ${game.itemType(c.item).name}; you have ${game.count(actorId, c.item, { ownerId: actorId })}.`);
  }
  if ((spec.costs?.money || 0) > game.balance(actorId)) throw new RuleError('insufficient_funds', `${rule.name} costs ${game.money(spec.costs.money)}.`);
  for (const c of spec.costs?.items || []) inv.destroyItems(game.ctx, { typeId: c.item, qty: c.qty, holderKind: 'character', holderId: actorId, ownerId: actorId, reason: 'consume', memo: rule.name });
  if (spec.costs?.money) game.burn(actorId, spec.costs.money, `Cost of ${rule.name}`);
  if (spec.costs?.fatigue) game.addFatigue(actorId, spec.costs.fatigue);
  if (spec.costs?.health) game.hurt(actorId, spec.costs.health, rule.name);
  // resolution
  const r = game.check(actorId, { skill: spec.skill, tn: DIFFICULTY[spec.difficulty], label: rule.name, ...(targetId && spec.opposed ? { opposedBy: targetId, opposedSkill: spec.opposed } : {}) });
  const bucket = isSuccess(r.degree) ? 'success' : isAtLeastPartial(r.degree) ? (spec.effects.partial?.length ? 'partial' : 'success') : 'failure';
  const effects = spec.effects[bucket] || [];
  let minutes = spec.minutes;
  for (const e of effects) {
    const res = applyEffect(game, actorId, rule, e, { targetId, destination, degree: r.degree });
    if (res?.text) facts.push(res.text);
    if (res?.minutes) minutes = res.minutes;
  }
  if (!effects.length) facts.push(bucket === 'failure' ? `${rule.name} fails.` : `${rule.name} works.`);
  game.setCharData(actorId, { ability_uses: { ...daily, [usesKey]: { day: today, n: used + 1 } } });
  game.advance(minutes, 'ability');
  return { roll: r, bucket, facts, minutes };
}

function applyEffect(game, actorId, rule, e, { targetId, destination }) {
  switch (e.type) {
    case 'produce': {
      inv.createItems(game.ctx, { typeId: e.item, qty: e.qty || 1, holderKind: 'character', holderId: actorId, ownerId: actorId, reason: 'produce', memo: rule.name });
      return { text: `${rule.name} yields ${e.qty || 1} ${game.itemType(e.item).name}.` };
    }
    case 'heal': game.heal(targetId || actorId, e.amount); return { text: `${targetId ? game.char(targetId).name : 'You'} recover${targetId ? 's' : ''} ${e.amount} health.` };
    case 'restore': game.addFatigue(actorId, -e.amount); return { text: `You feel restored (−${e.amount} fatigue).` };
    case 'harm_self': game.hurt(actorId, e.amount, rule.name); return { text: `${rule.name} hurts you (−${e.amount} health).` };
    case 'fatigue': game.addFatigue(actorId, e.amount); return { text: `You are drained (+${e.amount} fatigue).` };
    case 'harm_target': {
      if (!targetId) return null;
      game.hurt(targetId, e.amount, `${rule.name} used by ${game.char(actorId).name}`);
      const ev = game.recordEvent({ kind: 'assault', actor: actorId, target: targetId, summary: `${game.char(actorId).name} used ${rule.name} against ${game.char(targetId).name}.`, importance: 8, valence: -1, data: { hearsay: { trust: -25, fear: 20 } } });
      game.adjustRel(targetId, actorId, { trust: -50, fear: 30 }, `attacked with ${rule.name}`, ev.eventId);
      return { text: `${game.char(targetId).name} is struck (−${e.amount} health).` };
    }
    case 'learn_fact': {
      if (!e.fact) return null;
      const id = `f_rule_${rule.id}_${norm(e.fact).replace(/[^a-z0-9]+/g, '_').slice(0, 30)}`;
      game.db.prepare('INSERT OR IGNORE INTO facts(id,subject,content,truth,secrecy,tags,created_at,data) VALUES (?,?,?,1,1,?,?,?)').run(id, rule.name, e.fact, J.str(rule.spec.keywords || []), game.time, J.str({ rule: rule.id }));
      game.learnFact(actorId, id, { belief: 'known', confidence: 0.9, source: rule.name });
      return { text: `You learn: ${e.fact}` };
    }
    case 'relationship': {
      if (!targetId) return null;
      game.adjustRel(targetId, actorId, e.amount >= 0 ? { affection: e.amount, trust: Math.round(e.amount / 2) } : { affection: e.amount, fear: Math.abs(e.amount) }, rule.name);
      return { text: `${game.char(targetId).name} is ${e.amount >= 0 ? 'moved' : 'unsettled'} by it.` };
    }
    case 'travel': {
      if (!destination) throw new RuleError('need_destination', `Where do you want ${rule.name} to take you?`);
      const all = game.db.prepare('SELECT id, name, data FROM locations').all().map((l) => ({ ...l, aliases: J.parse(l.data, {}).aliases || [] }));
      const dest = resolveLocation(destination, all) || resolveLocation(String(destination).replace(/^.*?\b(?:to|towards|toward|for)\s+(?:the\s+)?/i, ''), all);
      if (!dest || !game.knowsLocation(actorId, dest)) throw new RuleError('unknown_place', `You know of no place called "${destination}".`);
      const from = game.char(actorId).location_id;
      // travel time: a fraction of the fastest known route, or of straight-line distance on the map
      const a = game.location(from), b = game.location(dest);
      const dist = Math.hypot((a.x || 0) - (b.x || 0), (a.y || 0) - (b.y || 0));
      const minutes = Math.max(10, Math.round(dist * 12 * e.speed));
      game.advance(minutes, 'travel');
      game.updateChar(actorId, { location_id: dest });
      const visited = new Set(game.char(actorId).data.visited || []); visited.add(dest);
      game.setCharData(actorId, { visited: [...visited] });
      game.recordEvent({ kind: 'travel', actor: actorId, location: dest, summary: `${game.char(actorId).name} arrived at ${b.name} by ${rule.name}.`, visibility: 'witnessed', importance: 5 });
      return { text: `${rule.name} carries you to ${b.name} in ${minutes < 60 ? `${minutes} minutes` : `${Math.round(minutes / 6) / 10} hours`}.`, minutes: 5 };
    }
    case 'xp': game.gainXp(actorId, e.skill, e.amount, 'experiment', 0, rule.name); return null;
    case 'note': return { text: e.text };
    default: return null;
  }
}

/** Install the rules a World Specification defines, and give the listed NPCs their capabilities. */
export function installWorldRules(game) {
  for (const raw of game.def.rules || []) {
    const v = validateRule(game, raw, { origin: 'world' });
    if (!v.ok) { game.journal?.('note', `World rule skipped: ${raw.name || raw.id}`, v.errors.join('; '), `ruleskip:${raw.id}`); continue; }
    installRule(game, v.rule, { origin: 'world', reason: 'defined by the world specification' });
  }
  for (const n of game.def.npcs || []) for (const id of n.abilities || []) if (getRule(game, slug(id))) grantCapability(game, n.id, slug(id), 'world');
  for (const id of game.def.start?.abilities || []) if (getRule(game, slug(id))) grantCapability(game, 'player', slug(id), 'background');
}

export { MINUTES_PER_DAY };
