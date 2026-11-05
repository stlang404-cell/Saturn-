// The contract between the Game Master and the engine. The language model's output
// is constrained to this schema by grammar at generation time AND validated by Ajv
// afterwards. Nothing outside this shape can reach the simulation.
import Ajv from 'ajv';
import { ACTION_TYPES } from '../engine/actions.js';
import { DIFFICULTY_NAMES } from '../engine/dice.js';

const nullable = (schema) => ({ type: [schema.type, 'null'], ...(schema.enum ? { enum: [...schema.enum, null] } : {}), ...(schema.maxLength ? { maxLength: schema.maxLength } : {}) });

export const APPROACH_VALUES = ['chat', 'ask', 'persuade', 'intimidate', 'deceive', 'flatter', 'apologize', 'insult', 'propose', 'invention', 'licensed', 'unequip'];
export const NOVELTY_VALUES = ['incremental', 'significant', 'revolutionary'];

export const ACTION_SCHEMA = {
  type: 'object',
  properties: {
    type: { type: 'string', enum: ACTION_TYPES },
    target: nullable({ type: 'string', maxLength: 60 }),
    item: nullable({ type: 'string', maxLength: 60 }),
    quantity: { type: ['integer', 'null'] },
    skill: nullable({ type: 'string', maxLength: 60 }),
    topic: nullable({ type: 'string', maxLength: 120 }),
    approach: nullable({ type: 'string', enum: APPROACH_VALUES }),
    hours: { type: ['number', 'null'] },
    days: { type: ['integer', 'null'] },
    price: { type: ['integer', 'null'] },
    destination: nullable({ type: 'string', maxLength: 60 }),
    difficulty: nullable({ type: 'string', enum: DIFFICULTY_NAMES }),
    novelty: nullable({ type: 'string', enum: NOVELTY_VALUES }),
    detail: nullable({ type: 'string', maxLength: 240 }),
  },
  required: ['type', 'target', 'item', 'quantity', 'skill', 'topic', 'approach', 'hours', 'days', 'price', 'destination', 'difficulty', 'novelty', 'detail'],
  additionalProperties: false,
};

// Compact action shape the language model emits (fewer keys = fewer tokens = faster).
// `target` doubles as destination for move; `level` carries difficulty or novelty.
export const LEVEL_VALUES = [...DIFFICULTY_NAMES, ...NOVELTY_VALUES];
export const LLM_ACTION_SCHEMA = {
  type: 'object',
  properties: {
    type: { type: 'string', enum: ACTION_TYPES },
    target: nullable({ type: 'string', maxLength: 60 }),
    item: nullable({ type: 'string', maxLength: 60 }),
    quantity: { type: ['integer', 'null'] },
    skill: nullable({ type: 'string', maxLength: 60 }),
    topic: nullable({ type: 'string', maxLength: 120 }),
    approach: nullable({ type: 'string', enum: APPROACH_VALUES }),
    hours: { type: ['number', 'null'] },
    days: { type: ['integer', 'null'] },
    price: { type: ['integer', 'null'] },
    level: nullable({ type: 'string', enum: LEVEL_VALUES }),
    detail: nullable({ type: 'string', maxLength: 240 }),
  },
  required: ['type', 'target', 'item', 'quantity', 'skill', 'topic', 'approach', 'hours', 'days', 'price', 'level', 'detail'],
  additionalProperties: false,
};

export const INTERPRETATION_SCHEMA = {
  type: 'object',
  properties: {
    mode: { type: 'string', enum: ['act', 'plan', 'clarify', 'impossible', 'meta'] },
    intent: { type: 'string', maxLength: 200 },
    actions: { type: 'array', items: ACTION_SCHEMA, maxItems: 6 },
    plan_title: nullable({ type: 'string', maxLength: 100 }),
    risks: { type: 'array', items: { type: 'string', maxLength: 160 }, maxItems: 4 },
    question: nullable({ type: 'string', maxLength: 240 }),
    reason: nullable({ type: 'string', maxLength: 240 }),
  },
  required: ['mode', 'intent', 'actions', 'plan_title', 'risks', 'question', 'reason'],
  additionalProperties: false,
};

export const NARRATION_SCHEMA = {
  type: 'object',
  properties: {
    narration: { type: 'string', maxLength: 1400 },
  },
  required: ['narration'],
  additionalProperties: false,
};

export const LLM_INTERPRETATION_SCHEMA = {
  ...INTERPRETATION_SCHEMA,
  properties: { ...INTERPRETATION_SCHEMA.properties, actions: { type: 'array', items: LLM_ACTION_SCHEMA, maxItems: 6 } },
};

/** LLM output schema for a specific world: the skill field is constrained to that world's skills. */
const _llmSchemaCache = new Map();
export function llmInterpretationSchema(skillIds) {
  const key = skillIds.join(',');
  if (!_llmSchemaCache.has(key)) {
    const action = { ...LLM_ACTION_SCHEMA, properties: { ...LLM_ACTION_SCHEMA.properties, skill: { type: ['string', 'null'], enum: [...skillIds, null] } } };
    _llmSchemaCache.set(key, { ...INTERPRETATION_SCHEMA, properties: { ...INTERPRETATION_SCHEMA.properties, actions: { type: 'array', items: action, maxItems: 6 } } });
  }
  return _llmSchemaCache.get(key);
}

const ajv = new Ajv({ allErrors: true, coerceTypes: false, useDefaults: false });
const validateInterp = ajv.compile(INTERPRETATION_SCHEMA);
const validateNarr = ajv.compile(NARRATION_SCHEMA);

export function blankAction(type) {
  return { type, target: null, item: null, quantity: null, skill: null, topic: null, approach: null, hours: null, days: null, price: null, destination: null, difficulty: null, novelty: null, detail: null };
}

/**
 * Normalise a loosely-shaped object into a full interpretation (fill missing nullable
 * fields, drop unknown keys) and validate it. Returns {ok, value, errors}.
 */
export function normalizeInterpretation(raw) {
  if (!raw || typeof raw !== 'object') return { ok: false, errors: ['not an object'] };
  const v = {
    mode: raw.mode, intent: typeof raw.intent === 'string' ? raw.intent : '',
    actions: Array.isArray(raw.actions) ? raw.actions.slice(0, 6).map((a) => {
      const b = blankAction(a?.type);
      for (const k of Object.keys(b)) if (a && a[k] !== undefined) b[k] = a[k];
      if (a && typeof a.level === 'string') {
        if (NOVELTY_VALUES.includes(a.level)) b.novelty = b.novelty ?? a.level;
        else if (DIFFICULTY_NAMES.includes(a.level)) b.difficulty = b.difficulty ?? a.level;
      }
      if (b.type === 'move' && !b.destination && b.target) { b.destination = b.target; b.target = null; }
      for (const k of ['quantity', 'days', 'price']) if (typeof b[k] === 'number') b[k] = Math.round(b[k]);
      for (const k of ['quantity', 'days', 'price', 'hours']) if (typeof b[k] === 'string' && /^\d+(\.\d+)?$/.test(b[k])) b[k] = Number(b[k]);
      for (const k of ['target', 'item', 'topic', 'destination', 'detail']) if (typeof b[k] === 'string') { b[k] = b[k].trim().slice(0, ACTION_SCHEMA.properties[k].maxLength); if (!b[k]) b[k] = null; }
      if (typeof b.skill === 'string') { b.skill = b.skill.trim().slice(0, 60) || null; }
      if (b.approach && !APPROACH_VALUES.includes(b.approach)) b.approach = null;
      if (b.difficulty && !DIFFICULTY_NAMES.includes(b.difficulty)) b.difficulty = null;
      if (b.novelty && !NOVELTY_VALUES.includes(b.novelty)) b.novelty = null;
      return b;
    }) : [],
    plan_title: raw.plan_title ?? null, risks: Array.isArray(raw.risks) ? raw.risks.filter((r) => typeof r === 'string').slice(0, 4).map((r) => r.slice(0, 160)) : [],
    question: raw.question ?? null, reason: raw.reason ?? null,
  };
  v.intent = v.intent.slice(0, 200);
  if (typeof v.plan_title === 'string') v.plan_title = v.plan_title.slice(0, 100);
  if (typeof v.question === 'string') v.question = v.question.slice(0, 240);
  if (typeof v.reason === 'string') v.reason = v.reason.slice(0, 240);
  const ok = validateInterp(v);
  const errors = ok ? [] : validateInterp.errors.map((e) => `${e.instancePath} ${e.message}`);
  if (ok && (v.mode === 'act' || v.mode === 'plan') && !v.actions.length) return { ok: false, value: v, errors: ['act/plan with no actions'] };
  return { ok, value: v, errors };
}

export function validateNarration(raw) {
  const ok = validateNarr(raw);
  return { ok, errors: ok ? [] : validateNarr.errors.map((e) => `${e.instancePath} ${e.message}`) };
}
