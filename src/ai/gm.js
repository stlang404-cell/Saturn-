// The Game Master: interprets free text into validated action proposals, and
// narrates verified outcomes. The model proposes; the engine disposes.
import { llmInterpretationSchema, NARRATION_SCHEMA, normalizeInterpretation, validateNarration } from './schema.js';
import { interpreterSystem, narratorSystem } from './prompts.js';
import { buildPlayerContext, sanitizePlayerText, npcVoiceContext } from './context.js';
import { fallbackInterpret } from './fallback-parser.js';
import { describeOutcomes, checkNarration, templateNarration } from './narrator.js';

const FAST_PATH_MAX_WORDS = 7;

export class GameMaster {
  constructor({ llm = null, log = () => {}, useFastPath = true, interpretTimeoutMs = 120000, narrateTimeoutMs = 90000 } = {}) {
    this.llm = llm;
    this.log = log;
    this.useFastPath = useFastPath;
    this.interpretTimeoutMs = interpretTimeoutMs;
    this.narrateTimeoutMs = narrateTimeoutMs;
    this.lastDebug = null;
  }

  /** World-specific system prompts, cached per world and per rule version. */
  _prompt(game, which) {
    const ver = game.db.prepare("SELECT COUNT(*) n, COALESCE(SUM(version),0) v, (SELECT COUNT(*) FROM capabilities WHERE holder_id=?) c FROM world_rules").get(game.playerId);
    const key = `${which}:${game.def.id}:${ver.n}:${ver.v}:${ver.c}`;
    this._prompts = this._prompts || new Map();
    if (!this._prompts.has(key)) this._prompts.set(key, which === 'i' ? interpreterSystem(game) : narratorSystem(game));
    return this._prompts.get(key);
  }

  get aiReady() {
    return this.llm?.state === 'ready';
  }

  /**
   * Interpret player text. Returns {interp, source, attempts, errors, ms, context}.
   * Strategy: short, unambiguous commands use the deterministic parser (fast path);
   * everything else goes to the local model with schema-constrained decoding,
   * validation and up to one repair retry; on any failure, the deterministic parser.
   */
  async interpret(game, rawInput, { signal, onProgress } = {}) {
    const input = sanitizePlayerText(rawInput);
    const t0 = Date.now();
    const debug = { input, attempts: [], source: null };
    const fb = fallbackInterpret(input);
    const fbNorm = normalizeInterpretation(fb);
    const words = input.split(/\s+/).length;
    if (fbNorm.ok && fbNorm.value.mode === 'meta') return { interp: fbNorm.value, source: 'help', attempts: 0, errors: [], ms: 0, debug };
    if (!this.aiReady || (this.useFastPath && words <= FAST_PATH_MAX_WORDS && fbNorm.ok && fbNorm.value.mode === 'act')) {
      debug.source = this.aiReady ? 'fast-path' : 'fallback';
      debug.ms = Date.now() - t0;
      this.lastDebug = debug;
      return { interp: fbNorm.ok ? fbNorm.value : fb, source: debug.source, attempts: 0, errors: fbNorm.errors, ms: debug.ms, debug };
    }
    const ctx = buildPlayerContext(game, input);
    debug.context = ctx.text;
    debug.memories = ctx.memories;
    let user = `CONTEXT:\n${ctx.text}\n\n<player_input>${input}</player_input>`;
    let lastErr = null;
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        const r = await this.llm.generateJson({ system: this._prompt(game, 'i'), user, schema: llmInterpretationSchema(game.rules.skillIds), maxTokens: 700, temperature: 0.2, timeoutMs: this.interpretTimeoutMs, signal, onToken: onProgress });
        const norm = normalizeInterpretation(r.parsed);
        debug.attempts.push({ attempt, ms: r.ms, tokens: r.tokens, ok: norm.ok, errors: norm.errors, raw: r.parsed });
        if (norm.ok) {
          debug.source = 'llm';
          debug.ms = Date.now() - t0;
          this.lastDebug = debug;
          return { interp: norm.value, source: 'llm', attempts: attempt, errors: [], ms: debug.ms, debug };
        }
        lastErr = norm.errors.join('; ');
        user = `${user}\n\nYour previous answer was invalid: ${lastErr}. Answer again with valid JSON.`;
      } catch (e) {
        lastErr = String(e.message || e);
        debug.attempts.push({ attempt, ok: false, errors: [lastErr] });
        if (/cancelled|aborted/.test(lastErr)) throw e;
        if (/timeout/.test(lastErr)) break;
      }
    }
    debug.source = 'fallback-after-llm';
    debug.ms = Date.now() - t0;
    this.lastDebug = debug;
    this.log(`interpretation fell back: ${lastErr}`);
    return { interp: fbNorm.ok ? fbNorm.value : fb, source: 'fallback-after-llm', attempts: debug.attempts.length, errors: [lastErr], ms: debug.ms, debug };
  }

  /**
   * Design what a completed invention/research actually does in this world. Returns a
   * proposal (validated later by the engine) and its source; never mutates state.
   */
  async designInvention(game, proj, { signal } = {}) {
    const { inventionSchema, inventionPrompt, fallbackProposal } = await import('../engine/innovation.js');
    if (!this.aiReady) return { proposal: fallbackProposal(game, proj), source: 'fallback' };
    const { system, user } = inventionPrompt(game, proj);
    try {
      const r = await this.llm.generateJson({ system, user, schema: inventionSchema(game), maxTokens: 700, temperature: 0.5, timeoutMs: this.narrateTimeoutMs * 2, signal });
      return { proposal: r.parsed, source: 'ai', ms: r.ms };
    } catch (e) {
      this.log(`invention design fell back: ${e.message}`);
      return { proposal: fallbackProposal(game, proj), source: 'fallback-after-ai', error: String(e.message) };
    }
  }

  /** Narrate a committed turn result. Never changes state. */
  async narrate(game, input, result, { signal } = {}) {
    for (const o of result.outcomes) if (o.dialogue) o.dialogue.voice = npcVoiceContext(game, o.dialogue.npc, `${o.dialogue.topic || ''} ${o.dialogue.said || ''}`);
    const outcomeText = describeOutcomes(game, sanitizePlayerText(input), result);
    const onlyMechanical = result.outcomes.every((o) => ['status', 'look', 'wait', 'rest', 'eat', 'equip', 'drop', 'take'].includes(o.type) || o.status === 'blocked');
    if (!this.aiReady || onlyMechanical) {
      return { text: templateNarration(game, input, result), source: 'template', outcomeText };
    }
    let user = `OUTCOME:\n${outcomeText}`;
    const problems = [];
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        const r = await this.llm.generateJson({ system: this._prompt(game, 'n'), user, schema: NARRATION_SCHEMA, maxTokens: 420, temperature: 0.7, timeoutMs: this.narrateTimeoutMs, signal });
        const v = validateNarration(r.parsed);
        if (!v.ok) { problems.push(...v.errors); continue; }
        const text = String(r.parsed.narration).trim();
        const check = checkNarration(game, text, outcomeText);
        if (check.ok && text.length > 20) return { text, source: 'llm', outcomeText, ms: r.ms, attempts: attempt };
        problems.push(...check.problems);
        user = `OUTCOME:\n${outcomeText}\n\nYour previous narration had problems: ${check.problems.join('; ')}. Rewrite it, strictly grounded in the OUTCOME.`;
      } catch (e) {
        problems.push(String(e.message || e));
        if (/cancelled|aborted|timeout/.test(String(e.message))) break;
      }
    }
    this.log(`narration fell back to template: ${problems.join('; ')}`);
    return { text: templateNarration(game, input, result), source: 'template-after-llm', outcomeText, problems };
  }
}
