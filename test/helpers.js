import { Game } from '../src/engine/game.js';
import { attach } from '../src/engine/sim.js';
import { executeTurn } from '../src/engine/turn.js';
import { fallbackInterpret } from '../src/ai/fallback-parser.js';
import { normalizeInterpretation, blankAction } from '../src/ai/schema.js';
import { reconcile } from '../src/engine/ledger.js';
import { conservationCheck } from '../src/engine/inventory.js';

export function newGame(opts = {}) {
  return attach(Game.create(opts.file || ':memory:', { seed: opts.seed ?? 1234, player: { name: 'Wren', background: opts.background || 'clerk', allocation: opts.allocation } }));
}

/** Execute typed actions directly (bypassing any interpreter). */
export function run(game, ...actions) {
  const interp = normalizeInterpretation({ mode: 'act', intent: 'test', actions: actions.map((a) => ({ ...blankAction(a.type), ...a })), plan_title: null, risks: [], question: null, reason: null });
  if (!interp.ok) throw new Error('bad test interpretation: ' + interp.errors.join(';'));
  return executeTurn(game, { input: JSON.stringify(actions), interp: interp.value, source: 'test' });
}

/** Execute free text through the deterministic parser. */
export function say(game, text) {
  const n = normalizeInterpretation(fallbackInterpret(text));
  if (!n.ok || !['act', 'plan'].includes(n.value.mode)) return { parsed: false, interp: n.value };
  return { parsed: true, ...executeTurn(game, { input: text, interp: n.value, source: 'fallback' }) };
}

export function assertSound(t, game) {
  const l = reconcile(game.db);
  const c = conservationCheck(game.db);
  if (l.length) throw new Error('ledger problems: ' + JSON.stringify(l.slice(0, 5)));
  if (c.length) throw new Error('item conservation problems: ' + JSON.stringify(c.slice(0, 5)));
}

export function goTo(game, dest) {
  const r = run(game, { type: 'move', destination: dest });
  if (r.outcomes[0].status === 'blocked') throw new Error(`move to ${dest} blocked: ${r.outcomes[0].error.message}`);
  return r;
}

export function waitUntilHour(game, h) {
  const cal = game.calendar();
  let mins = ((h - cal.hour + 24) % 24) * 60 - cal.min;
  if (mins <= 0) mins += 1440;
  run(game, { type: 'wait', hours: mins / 60 });
}
