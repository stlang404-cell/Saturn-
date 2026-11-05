// Facts and beliefs. A fact has an objective truth value; characters hold beliefs
// about facts with a confidence and a provenance. A character can only speak about,
// act on or reveal facts they actually hold — this is the knowledge boundary that
// prevents NPCs from knowing things they never learned.
import { J } from './db.js';
import { queryTerms } from './memory.js';

export function getFact(db, id) {
  const f = db.prepare('SELECT * FROM facts WHERE id=?').get(id);
  return f ? { ...f, tags: J.parse(f.tags, []), data: J.parse(f.data, {}) } : null;
}

export function belief(db, holderId, factId) {
  return db.prepare('SELECT * FROM knowledge WHERE holder_id=? AND fact_id=?').get(holderId, factId) || null;
}

/**
 * Learn (or reinforce) a fact. Returns {isNew, upgraded, record}.
 * Confidence combines independent sources: 1 - (1-a)(1-b).
 */
export function learn(db, holderId, factId, { belief: b = 'known', confidence = 1, source = 'told', sourceId = null, time = 0 }) {
  const prev = belief(db, holderId, factId);
  if (!prev) {
    db.prepare('INSERT INTO knowledge(holder_id, fact_id, belief, confidence, source, source_id, learned_at) VALUES (?,?,?,?,?,?,?)')
      .run(holderId, factId, b, clamp01(confidence), source, sourceId, time);
    return { isNew: true, upgraded: false, record: belief(db, holderId, factId) };
  }
  const conf = clamp01(1 - (1 - prev.confidence) * (1 - confidence));
  let nb = prev.belief;
  if (b === 'known' || conf >= 0.85) nb = 'known';
  else if (prev.belief === 'rumor' && b === 'suspected') nb = 'suspected';
  const upgraded = conf > prev.confidence + 1e-9 || nb !== prev.belief;
  db.prepare('UPDATE knowledge SET belief=?, confidence=? WHERE holder_id=? AND fact_id=?').run(nb, conf, holderId, factId);
  return { isNew: false, upgraded, record: belief(db, holderId, factId) };
}

export function knownFacts(db, holderId) {
  return db.prepare(`SELECT k.*, f.subject, f.content, f.truth, f.secrecy, f.tags FROM knowledge k JOIN facts f ON f.id=k.fact_id WHERE k.holder_id=? ORDER BY k.learned_at DESC`).all(holderId)
    .map((r) => ({ ...r, tags: J.parse(r.tags, []) }));
}

/** Facts held by `holderId` that match a topic, ranked by tag/content overlap. */
export function factsAbout(db, holderId, topic) {
  const terms = queryTerms(topic);
  if (!terms.length) return [];
  const out = [];
  for (const f of knownFacts(db, holderId)) {
    const hay = (f.tags.join(' ') + ' ' + f.subject + ' ' + f.content).toLowerCase();
    let score = 0;
    for (const t of terms) {
      if (f.tags.some((tag) => tag === t || tag.startsWith(t) || t.startsWith(tag))) score += 2;
      else if (hay.includes(t)) score += 1;
    }
    if (score > 0) out.push({ ...f, score });
  }
  return out.sort((a, b) => b.score - a.score || a.secrecy - b.secrecy);
}

/** Does any fact in the world (regardless of holder) match the topic? Used to detect unknowable questions. */
export function worldFactsAbout(db, topic) {
  const terms = queryTerms(topic);
  const rows = db.prepare('SELECT * FROM facts').all().map((f) => ({ ...f, tags: J.parse(f.tags, []) }));
  return rows.filter((f) => terms.some((t) => f.tags.includes(t) || f.content.toLowerCase().includes(t)));
}

function clamp01(x) {
  return Math.max(0, Math.min(1, x));
}
