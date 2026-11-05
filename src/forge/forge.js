// World Forge orchestration: description → staged AI generation → compile → validate.
// Each stage is retried once on failure; any stage can be regenerated later with player
// feedback (downstream stages are regenerated too, since they depend on it).
import Ajv from 'ajv';
import { STAGES, stagePrompt, STAGE_TOKENS } from './stages.js';
import { compileWorld, summarizeSpec } from './compile.js';

const ajv = new Ajv({ allErrors: true, strict: false });

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
