// Turn execution. Takes a *validated* interpretation (typed action proposals) and
// applies it to the world inside one SQLite transaction. Each action runs in its own
// savepoint: an action that breaks a rule is rolled back and reported, while a real
// bug aborts the entire turn so nothing half-committed survives.
import { J } from './db.js';
import { RuleError } from './ledger.js';
import { HANDLERS, CONSEQUENTIAL, previewAction } from './actions.js';
import { MINUTES_PER_DAY } from './rules.js';

export function snapshot(game) {
  const p = game.player();
  const items = {};
  for (const it of game.held(p.id)) items[it.type_id] = (items[it.type_id] || 0) + it.quantity;
  const skills = Object.fromEntries(game.db.prepare('SELECT skill, rank, xp FROM skills WHERE character_id=?').all(p.id).map((s) => [s.skill, { rank: s.rank, xp: s.xp }]));
  return { time: game.time, money: game.balance(p.id), items, location: p.location_id, health: p.health, fatigue: p.fatigue, skills, alive: p.alive };
}

export function diffSnapshots(a, b, game) {
  const items = [];
  for (const t of new Set([...Object.keys(a.items), ...Object.keys(b.items)])) {
    const d = (b.items[t] || 0) - (a.items[t] || 0);
    if (d) items.push({ type: t, name: game.itemType(t)?.name || t, delta: d });
  }
  const skills = [];
  for (const s of Object.keys(b.skills)) {
    const before = a.skills[s] || { rank: 0, xp: 0 };
    const dx = Math.round((b.skills[s].xp - before.xp) * 100) / 100;
    if (dx || b.skills[s].rank !== before.rank) skills.push({ skill: s, xp: dx, rankBefore: before.rank, rankAfter: b.skills[s].rank });
  }
  return {
    minutes: b.time - a.time, money: b.money - a.money, items, skills,
    moved: a.location !== b.location ? { from: a.location, to: b.location } : null,
    health: b.health - a.health, fatigue: b.fatigue - a.fatigue, died: a.alive && !b.alive,
  };
}

/** Does this interpretation need the player's explicit confirmation before it runs? */
export function needsConfirmation(interp) {
  if (interp.mode === 'plan') return true;
  const acts = interp.actions || [];
  if (acts.length > 1 && acts.some((a) => CONSEQUENTIAL.has(a.type))) return true;
  if (acts.some((a) => (a.days && a.days > 3) || (a.hours && a.hours > 24))) return true;
  return false;
}

export function previewPlan(game, interp) {
  const steps = (interp.actions || []).map((a) => ({ action: a, preview: previewAction(game, a) }));
  const days = (interp.actions || []).reduce((s, a) => s + (a.days || 0), 0);
  const food = days ? days * 2 : 0;
  const lodging = days ? days * 3 : 0;
  return {
    title: interp.plan_title || interp.intent || 'Plan', steps, risks: interp.risks || [],
    estimate: days ? { days, livingCost: food + lodging, money: game.balance(game.playerId) } : null,
  };
}

export function createPlan(game, input, interp, source) {
  const preview = previewPlan(game, interp);
  const r = game.db.prepare("INSERT INTO plans(turn_id, created_at, status, data) VALUES (NULL, ?, 'pending', ?)").run(game.time, J.str({ input, interp, source, preview }));
  return { planId: Number(r.lastInsertRowid), preview };
}

export function getPlan(game, id) {
  const r = game.db.prepare('SELECT * FROM plans WHERE id=?').get(id);
  return r ? { ...r, data: J.parse(r.data, {}) } : null;
}

export function cancelPlan(game, id) {
  game.db.prepare("UPDATE plans SET status='cancelled' WHERE id=? AND status='pending'").run(id);
}

export function executeTurn(game, { input, interp, source = 'unknown', planId = null }) {
  const before = snapshot(game);
  const turn = game.db.prepare('INSERT INTO turns(time_before, input, interpretation, source, status, created_real) VALUES (?,?,?,?,?,?)')
    .run(game.time, String(input).slice(0, 2000), J.str(interp), source, 'open', new Date().toISOString());
  const turnId = Number(turn.lastInsertRowid);
  game.turnId = turnId;
  const outcomes = [];
  try {
    game.transact(() => {
      for (const a of interp.actions || []) {
        const handler = HANDLERS[a.type];
        if (!handler) { outcomes.push({ type: a.type, params: a, ok: false, status: 'blocked', error: { code: 'unknown_action', message: `Unknown action "${a.type}".` } }); break; }
        const snap = { time: game.time, counter: game.rng.counter, digest: game.digest.length };
        try {
          const out = game.db.transaction(() => handler(game, a))();
          outcomes.push({ type: a.type, params: a, status: out.ok ? 'done' : 'failed', ...out });
          if (!out.ok && (interp.actions.length > 1)) break;
        } catch (e) {
          if (!(e instanceof RuleError)) throw e;
          game.time = snap.time;
          game.rng.counter = snap.counter;
          game.digest.length = snap.digest;
          outcomes.push({ type: a.type, params: a, ok: false, status: 'blocked', error: { code: e.code, message: e.message, details: e.details } });
          break;
        }
        if (!game.player().alive) break;
      }
      game.db.prepare("UPDATE turns SET time_after=?, outcome=?, status='committed' WHERE id=?").run(game.time, J.str(outcomes.map(stripForStorage)), turnId);
      if (planId) game.db.prepare("UPDATE plans SET status='done', turn_id=? WHERE id=?").run(turnId, planId);
    });
  } catch (e) {
    game.db.prepare("UPDATE turns SET status='aborted', outcome=? WHERE id=?").run(J.str({ error: String(e.message || e) }), turnId);
    game.turnId = null;
    throw e;
  }
  game.turnId = null;
  const after = snapshot(game);
  return { turnId, outcomes, changes: diffSnapshots(before, after, game), digest: game.takeDigest() };
}

function stripForStorage(o) {
  const { dialogue, ...rest } = o;
  return { ...rest, dialogue: dialogue ? { npc: dialogue.npc, approach: dialogue.approach, topic: dialogue.topic, disclosed: dialogue.disclosed, attitude: dialogue.attitude, unknown: dialogue.unknown, refused: dialogue.refused } : undefined };
}

export function setNarration(game, turnId, narration) {
  game.db.prepare('UPDATE turns SET narration=? WHERE id=?').run(String(narration).slice(0, 8000), turnId);
}

export { MINUTES_PER_DAY };
