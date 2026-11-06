// World Forge orchestration: description → staged AI generation → compile → validate.
// Each stage is retried once on failure; any stage can be regenerated later with player
// feedback (downstream stages are regenerated too, since they depend on it).
import Ajv from 'ajv';
import { STAGES, stagePrompt, STAGE_TOKENS } from './stages.js';
import { compileWorld, summarizeSpec } from './compile.js';

const ajv = new Ajv({ allErrors: true, strict: false });

/**
 * The inference grammar enforces structure, enums and string lengths, but not regex patterns
 * or numeric bounds. Coerce what the model produced to the schema (slugify pattern-bound ids,
 * clamp numbers, trim arrays) rather than discarding an otherwise good stage.
 */
export function coerceToSchema(schema, v) {
  if (v == null || !schema) return v;
  const t = Array.isArray(schema.type) ? schema.type.find((x) => x !== 'null') : schema.type;
  if (t === 'object' && typeof v === 'object' && !Array.isArray(v)) {
    for (const [k, sub] of Object.entries(schema.properties || {})) if (k in v) v[k] = coerceToSchema(sub, v[k]);
    return v;
  }
  if (t === 'array' && Array.isArray(v)) {
    let out = v.map((x) => coerceToSchema(schema.items, x));
    if (schema.maxItems != null) out = out.slice(0, schema.maxItems);
    return out;
  }
  if ((t === 'integer' || t === 'number') && typeof v === 'number') {
    let n = t === 'integer' ? Math.round(v) : v;
    if (schema.minimum != null) n = Math.max(schema.minimum, n);
    if (schema.maximum != null) n = Math.min(schema.maximum, n);
    return n;
  }
  if (t === 'string' && typeof v === 'string' && schema.pattern) {
    let s = v.toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/^[^a-z]+/, '').replace(/_+$/, '');
    const lettersOnly = /^\^\[a-z\]\{/.test(schema.pattern);
    if (lettersOnly) s = s.replace(/[^a-z]/g, '');
    const max = Number((schema.pattern.match(/,(\d+)\}\$$/) || [])[1]) || 30;
    s = s.slice(0, lettersOnly ? max : max + 1);
    if (s.length < 3) s = (s + 'xyz').slice(0, 3);
    return s;
  }
  return v;
}

export class WorldForge {
  constructor({ llm, log = () => {} }) {
    this.llm = llm;
    this.log = log;
  }

  get ready() {
    return this.llm?.state === 'ready';
  }

  /**
   * Generate a world draft. `draft` may be partially filled (regeneration): only stages from
   * `fromStage` onward are generated. onProgress({stage, index, total, label, tokens}).
   */
  async generate(description, { draft = { description }, fromStage = 'core', feedback = null, onProgress, signal } = {}) {
    if (!this.ready) throw new Error('The World Forge needs the local language model, which is not loaded.');
    const desc = String(description).replace(/[\u0000-\u001f]/g, ' ').slice(0, 2000);
    draft.description = desc;
    const start = STAGES.findIndex((s) => s.id === fromStage);
    const timings = draft._timings || {};
    for (let i = Math.max(0, start); i < STAGES.length; i++) {
      const stage = STAGES[i];
      onProgress?.({ stage: stage.id, index: i, total: STAGES.length, label: stage.label, tokens: 0 });
      const schema = stage.schema(draft);
      const validate = ajv.compile(schema);
      const { system, user } = stagePrompt(stage, draft, i === start ? feedback : null);
      let lastErr = null;
      for (let attempt = 1; attempt <= 2; attempt++) {
        try {
          const r = await this.llm.generateJson({
            system, user: attempt > 1 ? `${user}\n\nYour previous answer was invalid (${lastErr}). Answer again.` : user,
            schema, maxTokens: STAGE_TOKENS[stage.id] || 1200, temperature: 0.8, timeoutMs: 1800000, signal,
            onToken: (n) => onProgress?.({ stage: stage.id, index: i, total: STAGES.length, label: stage.label, tokens: n }),
          });
          coerceToSchema(schema, r.parsed);
          if (!validate(r.parsed)) throw new Error(validate.errors.slice(0, 3).map((e) => `${e.instancePath} ${e.message}`).join('; '));
          draft[stage.id] = r.parsed;
          timings[stage.id] = { ms: r.ms, tokens: r.tokens };
          lastErr = null;
          break;
        } catch (e) {
          lastErr = String(e.message || e);
          if (/cancelled|aborted/.test(lastErr)) throw e;
          this.log(`forge stage ${stage.id} attempt ${attempt} failed: ${lastErr}`);
        }
      }
      if (lastErr) throw new Error(`World generation failed at "${stage.label}": ${lastErr}`);
    }
    draft._timings = timings;
    return draft;
  }

  /** Compile a complete draft into an executable World Specification + preview summary. */
  static compile(draft) {
    const { spec, report } = compileWorld(draft, { description: draft.description });
    return { spec, report, summary: summarizeSpec(spec, report) };
  }
}

export { STAGES };
