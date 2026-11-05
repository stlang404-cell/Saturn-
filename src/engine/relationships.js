// Social memory: multi-dimensional relationships that change only through
// recorded events, each change logged with its reason.
import { clamp } from './rules.js';

const DIMS = ['trust', 'affection', 'respect', 'fear', 'rivalry', 'familiarity'];
const RANGE = { trust: [-100, 100], affection: [-100, 100], respect: [-100, 100], fear: [0, 100], rivalry: [0, 100], familiarity: [0, 100] };

export function getRel(db, from, to) {
  return db.prepare('SELECT * FROM relationships WHERE from_id=? AND to_id=?').get(from, to)
    || { from_id: from, to_id: to, trust: 0, affection: 0, respect: 0, fear: 0, rivalry: 0, familiarity: 0 };
}

export function adjustRel(ctx, from, to, deltas, reason, eventId = null) {
  const { db } = ctx;
  if (from === to) return getRel(db, from, to);
  const cur = getRel(db, from, to);
  const next = { ...cur };
  const changes = {};
  for (const d of DIMS) {
    if (!deltas[d]) continue;
    const [lo, hi] = RANGE[d];
    next[d] = clamp(Math.round(cur[d] + deltas[d]), lo, hi);
    const real = next[d] - cur[d];
    if (real) {
      changes[d] = real;
      db.prepare('INSERT INTO relationship_log(time, from_id, to_id, dim, delta, reason, event_id) VALUES (?,?,?,?,?,?,?)').run(ctx.time ?? 0, from, to, d, real, reason, eventId);
    }
  }
  db.prepare(`INSERT INTO relationships(from_id,to_id,trust,affection,respect,fear,rivalry,familiarity) VALUES (?,?,?,?,?,?,?,?)
    ON CONFLICT(from_id,to_id) DO UPDATE SET trust=excluded.trust, affection=excluded.affection, respect=excluded.respect, fear=excluded.fear, rivalry=excluded.rivalry, familiarity=excluded.familiarity`)
    .run(from, to, next.trust, next.affection, next.respect, next.fear, next.rivalry, next.familiarity);
  return { ...next, changes };
}

/** Overall disposition in [-100, 100]. */
export function disposition(rel) {
  return clamp(Math.round(rel.trust * 0.4 + rel.affection * 0.4 + rel.respect * 0.2 - rel.rivalry * 0.2), -100, 100);
}

/** Social check modifier from disposition: −3 … +3. */
export function socialMod(rel) {
  return clamp(Math.round(disposition(rel) / 20), -3, 3);
}

export function attitudeLabel(rel) {
  const d = disposition(rel);
  if (rel.fear >= 60) return 'afraid';
  if (d >= 50) return 'devoted';
  if (d >= 25) return 'friendly';
  if (d >= 8) return 'warm';
  if (d > -8) return rel.familiarity < 10 ? 'unfamiliar' : 'neutral';
  if (d > -25) return 'cool';
  if (d > -50) return 'hostile';
  return 'loathing';
}

export function relationshipHistory(db, from, to, limit = 20) {
  return db.prepare('SELECT * FROM relationship_log WHERE from_id=? AND to_id=? ORDER BY id DESC LIMIT ?').all(from, to, limit);
}
