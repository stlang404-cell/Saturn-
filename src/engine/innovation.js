// Continuous world adaptation: turning completed research and inventions into persistent
// world capabilities. The AI proposes a design (device, recipe, usage rule); this module
// validates it against the world's real items and skills and installs it with a full
// causal history. Without an AI, a transparent deterministic design is used instead.
import { J } from './db.js';
import * as inv from './inventory.js';
import { validateRule, installRule, grantCapability, slug } from './worldrules.js';
import { DIFFICULTY_NAMES } from './dice.js';
import { clamp } from './rules.js';

export const NOVELTY_VALUE = { incremental: 15, significant: 40, revolutionary: 120 };

/** Projects completed but not yet turned into world capabilities. */
export function pendingDesigns(game) {
  return game.db.prepare("SELECT * FROM projects WHERE status='completed'").all()
    .map((p) => ({ ...p, data: J.parse(p.data, {}) }))
    .filter((p) => p.data.needs_design && !p.data.designed);
}

/** JSON schema for the AI's invention proposal, constrained to this world's items and skills. */
export function inventionSchema(game) {
  const items = game.db.prepare('SELECT id FROM item_types').all().map((r) => r.id);
  const itemRef = { type: 'string', enum: [...items, 'DEVICE'] };
  return {
    type: 'object',
    properties: {
      summary: { type: 'string', maxLength: 240 },
      device: {
        type: ['object', 'null'],
        properties: { name: { type: 'string', maxLength: 50 }, description: { type: 'string', maxLength: 200 }, weight: { type: 'integer', minimum: 0, maximum: 200 } },
        required: ['name', 'description', 'weight'], additionalProperties: false,
      },
      recipe: {
        type: ['object', 'null'],
        properties: {
          inputs: { type: 'array', items: { type: 'object', properties: { item: { type: 'string', enum: items }, qty: { type: 'integer', minimum: 1, maximum: 10 } }, required: ['item', 'qty'], additionalProperties: false }, minItems: 1, maxItems: 4 },
          difficulty: { type: 'string', enum: DIFFICULTY_NAMES }, hours: { type: 'integer', minimum: 1, maximum: 48 },
        },
        required: ['inputs', 'difficulty', 'hours'], additionalProperties: false,
      },
      use: {
        type: 'object',
        properties: {
          name: { type: 'string', maxLength: 50 },
          summary: { type: 'string', maxLength: 200 },
          difficulty: { type: 'string', enum: DIFFICULTY_NAMES },
          minutes: { type: 'integer', minimum: 5, maximum: 600 },
          effect: { type: 'string', enum: ['travel', 'produce', 'heal', 'harm_target', 'restore', 'learn_fact', 'relationship', 'note'] },
          produce_item: { type: ['string', 'null'], enum: [...items, null] },
          produce_qty: { type: ['integer', 'null'], minimum: 1, maximum: 10 },
          consumes: { type: 'array', items: { type: 'object', properties: { item: itemRef, qty: { type: 'integer', minimum: 1, maximum: 10 } }, required: ['item', 'qty'], additionalProperties: false }, maxItems: 3 },
          travel_speed: { type: ['number', 'null'], minimum: 0.1, maximum: 1 },
          amount: { type: ['integer', 'null'], minimum: 1, maximum: 40 },
          text: { type: ['string', 'null'], maxLength: 200 },
          failure_risk: { type: 'string', maxLength: 160 },
        },
        required: ['name', 'summary', 'difficulty', 'minutes', 'effect', 'produce_item', 'produce_qty', 'consumes', 'travel_speed', 'amount', 'text', 'failure_risk'],
        additionalProperties: false,
      },
      society: { type: 'string', maxLength: 240 },
    },
    required: ['summary', 'device', 'recipe', 'use', 'society'],
    additionalProperties: false,
  };
}

export function inventionPrompt(game, proj) {
  const items = game.db.prepare('SELECT id, name, base_value FROM item_types ORDER BY base_value').all();
  return {
    system: `You are the world engineer of a living-world simulation. A character has just completed a research or invention project. Design how the result works IN THIS WORLD, using only this world's materials. Be concrete, balanced and consistent with the world's rules: powerful results must have real costs, inputs and risks. Answer with JSON only.`,
    user: `WORLD: ${game.def.name}. ${game.def.premise || ''}
PHYSICAL RULES: ${(game.def.physics || []).join(' ')}
MAGIC: ${game.def.magic?.exists ? game.def.magic.summary || 'exists' : 'none'}. TECHNOLOGY: ${game.def.technology?.summary || game.def.technology?.level || 'unspecified'}.
PROJECT: "${proj.title}" — ${proj.description} (${proj.kind}, ${proj.data.novelty}, skill ${proj.skill}).
MATERIALS AVAILABLE (id: name, value): ${items.map((i) => `${i.id}: ${i.name} (${i.base_value})`).join('; ')}.
Rules: device is null for pure knowledge or techniques. recipe (how to build one device) uses only listed material ids. In "use", refer to the device as "DEVICE" in consumes only if using it destroys it. effect "travel" moves the user between places (travel_speed 0.1 = 10x faster than walking). Keep produce effects modest.`,
  };
}

/**
 * Install an invention from a (validated) proposal. Creates: a discovery fact, optional device
 * item type, optional recipe, and a usage rule the inventor can use. Returns a summary.
 */
export function installInvention(game, proj, proposal, { designer = 'ai' } = {}) {
  const notes = [];
  const novelty = proj.data.novelty || 'incremental';
  let deviceId = null;
  if (proposal.device) {
    deviceId = `inv_${proj.id}_${slug(proposal.device.name, 24)}`;
    const value = NOVELTY_VALUE[novelty] || 15;
    game.db.prepare('INSERT OR IGNORE INTO item_types(id,name,category,base_value,weight,stackable,commodity,tags,description,data,created_by) VALUES (?,?,?,?,?,0,0,?,?,?,?)')
      .run(deviceId, proposal.device.name.toLowerCase().slice(0, 60), 'invention', value, clamp(proposal.device.weight ?? 5, 0, 200), J.str(['invention', `tool:${proj.skill}`]), proposal.device.description, J.str({ tool_bonus: novelty === 'revolutionary' ? 3 : 2, project: proj.id }), proj.owner_id);
    // the prototype the project produced
    inv.createItems(game.ctx, { typeId: deviceId, qty: 1, holderKind: 'character', holderId: proj.owner_id, ownerId: proj.owner_id, reason: 'produce', memo: `prototype of ${proj.title}` });
  }
  let recipe = null;
  if (deviceId && proposal.recipe?.inputs?.length) {
    const inputs = {};
    for (const i of proposal.recipe.inputs) if (game.itemType(i.item)) inputs[i.item] = (inputs[i.item] || 0) + i.qty;
    if (Object.keys(inputs).length) {
      recipe = { id: `make_${deviceId}`, name: `build ${proposal.device.name.toLowerCase()}`, skill: proj.skill, tn: { trivial: 8, easy: 11, moderate: 14, hard: 17, very_hard: 20, extreme: 24, legendary: 28 }[proposal.recipe.difficulty] ?? 14, minutes: clamp(proposal.recipe.hours, 1, 48) * 60, inputs, outputs: { [deviceId]: 1 }, invented_by: proj.owner_id };
    } else notes.push('recipe referenced no real materials and was dropped');
  }
  // the usage rule
  const u = proposal.use;
  const eff = { type: u.effect };
  if (u.effect === 'travel') eff.speed = u.travel_speed ?? 0.4;
  if (u.effect === 'produce') { eff.item = u.produce_item; eff.qty = u.produce_qty ?? 1; }
  if (['heal', 'harm_target', 'restore', 'relationship'].includes(u.effect)) eff.amount = u.amount ?? 10;
  if (u.effect === 'learn_fact' || u.effect === 'note') { eff.fact = u.text; eff.text = u.text; }
  const consumes = (u.consumes || []).filter((c) => c.item !== 'DEVICE' && game.itemType(c.item));
  const failureEffects = /crash|fall|explod|injur|burn|hurt/i.test(u.failure_risk || '') ? [{ type: 'harm_self', amount: novelty === 'revolutionary' ? 15 : 8 }, { type: 'note', text: u.failure_risk }] : [{ type: 'note', text: u.failure_risk || 'It does not work this time.' }];
  const ruleRaw = {
    id: slug(u.name), name: u.name, kind: deviceId ? 'device' : 'technique', summary: u.summary, skill: proj.skill,
    difficulty: u.difficulty, minutes: u.minutes,
    requires: { capability: true, tools: deviceId ? [deviceId] : [] },
    costs: { items: consumes, fatigue: 5 },
    effects: { success: [eff], failure: failureEffects },
    keywords: proj.title.toLowerCase().split(/\W+/).filter((w) => w.length > 3).slice(0, 6),
    adopt_rank: { incremental: 2, significant: 4, revolutionary: 6 }[novelty] ?? 3,
  };
  const v = validateRule(game, ruleRaw, { origin: 'player' });
  if (!v.ok) return { ok: false, errors: v.errors, notes };
  notes.push(...v.notes);
  // the discovery as world knowledge (secret until shared or demonstrated)
  const factId = `f_disc_${proj.id}`;
  game.db.prepare('INSERT OR IGNORE INTO facts(id,subject,content,truth,secrecy,tags,created_at,data) VALUES (?,?,?,1,1,?,?,?)')
    .run(factId, proj.title, `${game.char(proj.owner_id).name} developed ${proj.title}: ${proposal.summary}`, J.str(ruleRaw.keywords), game.time, J.str({ discovery: true, project: proj.id }));
  v.rule.fact = factId;
  const ev = game.recordEvent({ kind: 'innovation', actor: proj.owner_id, summary: `${game.char(proj.owner_id).name}'s ${proj.title} became a working ${deviceId ? 'device' : 'technique'}: ${proposal.summary}`, visibility: 'private', importance: 8, data: { project: proj.id, rule: v.rule.id, device: deviceId, designer } });
  const installed = installRule(game, v.rule, { origin: proj.owner_id === game.playerId ? 'player' : 'npc', createdBy: proj.owner_id, causeEventId: ev.eventId, reason: `invented through "${proj.title}" (${designer} design)` });
  grantCapability(game, proj.owner_id, v.rule.id, 'invented');
  game.learnFact(proj.owner_id, factId, { belief: 'known', confidence: 1, source: 'my own work' });
  if (recipe) {
    const def = game.def;
    def.recipes = [...(def.recipes || []).filter((r) => r.id !== recipe.id), recipe];
    game.db.prepare("UPDATE meta SET value=? WHERE key='world_def'").run(J.str(def));
    game._recipes[recipe.id] = recipe;
  }
  const data = { ...proj.data, designed: true, rule: v.rule.id, device: deviceId, recipe: recipe?.id || null, society: proposal.society, designer };
  game.db.prepare('UPDATE projects SET data=? WHERE id=?').run(J.str(data), proj.id);
  game.journal('discovery', proj.title, `${proposal.summary}${deviceId ? ` You built a working prototype: ${proposal.device.name}.` : ''}${recipe ? ` Building another needs ${Object.entries(recipe.inputs).map(([t, q]) => `${q} ${game.itemType(t).name}`).join(', ')}.` : ''} Use it with: "${v.rule.name}". ${proposal.society ? `Likely consequences: ${proposal.society}` : ''}`, `proj:${proj.id}`, 'done');
  return { ok: true, rule: v.rule, version: installed.version, deviceId, recipe, notes, eventId: ev.eventId };
}

/** Deterministic design used when no language model is available (clearly labelled). */
export function fallbackProposal(game, proj) {
  const isInvention = proj.kind === 'invention';
  const materials = game.db.prepare("SELECT id, base_value FROM item_types WHERE commodity=1 ORDER BY base_value DESC LIMIT 2").all();
  return {
    summary: `${proj.description} (a working result, described generically because no AI designer was available)`,
    device: isInvention ? { name: proj.title.slice(0, 50), description: proj.description.slice(0, 200), weight: 5 } : null,
    recipe: isInvention && materials.length ? { inputs: materials.map((m) => ({ item: m.id, qty: 2 })), difficulty: 'moderate', hours: 4 } : null,
    use: { name: `Use ${proj.title}`.slice(0, 50), summary: `Apply ${proj.title}.`, difficulty: 'moderate', minutes: 30, effect: 'note', produce_item: null, produce_qty: null, consumes: [], travel_speed: null, amount: null, text: `${proj.title} works as intended.`, failure_risk: 'It misbehaves and nothing useful happens.' },
    society: '',
  };
}
