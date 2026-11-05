// Layered memory: episodic memories per character, consolidated summaries, and
// relevance-ranked retrieval. Memories are *derived* from authoritative events;
// the events table is never summarised or deleted, so exact facts survive.
import { J } from './db.js';
import { MINUTES_PER_DAY } from './rules.js';

const STOP = new Set('the a an and or of to in on at for with about is are was were be i me my you your he she it they them we us this that what who how why do does did can could would should will from into have has had not no yes please want try'.split(' '));

export function addMemory(db, { ownerId, time, eventId = null, kind = 'episodic', summary, participants = [], locationId = null, importance = 3, valence = 0, confidence = 1, topic = '', source = 'witnessed', pinned = false }) {
  const r = db.prepare(`INSERT INTO memories(owner_id, time, event_id, kind, summary, participants, location_id, importance, valence, confidence, topic, source, pinned)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(ownerId, time, eventId, kind, summary, J.str(participants), locationId, Math.max(0, Math.min(10, Math.round(importance))), valence, confidence, topic, source, pinned ? 1 : 0);
  return Number(r.lastInsertRowid);
}

export function queryTerms(text) {
  return [...new Set(String(text || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter((w) => w.length > 2 && !STOP.has(w)))].slice(0, 12);
}

/**
 * Retrieve the most relevant memories for `ownerId`.
 * Score = recency + importance + participant match + location match + text relevance + pin.
 * Returns memories with a `why` breakdown for the memory inspector.
 */
export function retrieveMemories(db, { ownerId, now, text = '', participants = [], locationId = null, limit = 8 }) {
  const terms = queryTerms(text);
  const cand = new Map();
  const add = (rows) => rows.forEach((r) => cand.set(r.id, r));
  if (terms.length) {
    const q = terms.map((t) => `"${t}"*`).join(' OR ');
    try {
      add(db.prepare(`SELECT m.*, bm25(memories_fts) AS rank FROM memories_fts JOIN memories m ON m.id = memories_fts.rowid
        WHERE memories_fts MATCH ? AND m.owner_id=? AND m.consolidated=0 ORDER BY rank LIMIT 60`).all(q, ownerId));
    } catch { /* malformed query is non-fatal */ }
  }
  add(db.prepare('SELECT *, NULL AS rank FROM memories WHERE owner_id=? AND consolidated=0 ORDER BY time DESC LIMIT 30').all(ownerId));
  add(db.prepare('SELECT *, NULL AS rank FROM memories WHERE owner_id=? AND consolidated=0 AND (importance>=7 OR pinned=1) ORDER BY importance DESC, time DESC LIMIT 20').all(ownerId));
  for (const p of participants) {
    add(db.prepare(`SELECT *, NULL AS rank FROM memories WHERE owner_id=? AND consolidated=0 AND participants LIKE ? ORDER BY time DESC LIMIT 25`).all(ownerId, `%"${p}"%`));
  }
  const ranks = [...cand.values()].map((m) => m.rank).filter((r) => r != null);
  const bestRank = ranks.length ? Math.min(...ranks) : -1;
  const scored = [];
  for (const m of cand.values()) {
    const parts = J.parse(m.participants, []);
    const ageDays = Math.max(0, (now - m.time) / MINUTES_PER_DAY);
    const halfLife = 6 + m.importance * 6; // important memories fade slower
    const recency = Math.pow(0.5, ageDays / halfLife);
    const importance = m.importance / 10;
    const participant = participants.length && parts.some((p) => participants.includes(p)) ? 1 : 0;
    const location = locationId && m.location_id === locationId ? 0.4 : 0;
    // FTS rank is negative (more negative = better); normalise against the best hit
    const textRel = m.rank != null && bestRank < 0 ? Math.min(1, m.rank / bestRank) : 0;
    const pin = m.pinned ? 0.5 : 0;
    const score = 1.0 * recency + 1.2 * importance + 1.0 * participant + location + 1.6 * textRel + pin;
    scored.push({
      id: m.id, time: m.time, kind: m.kind, summary: m.summary, importance: m.importance, valence: m.valence,
      confidence: m.confidence, source: m.source, participants: parts, location_id: m.location_id, event_id: m.event_id,
      score: Math.round(score * 1000) / 1000,
      why: { recency: r3(recency), importance: r3(importance * 1.2), participant, location, text: r3(textRel * 1.6), pinned: pin },
    });
  }
  scored.sort((a, b) => b.score - a.score || b.time - a.time);
  return { terms, memories: scored.slice(0, limit), candidates: cand.size };
}

function r3(x) {
  return Math.round(x * 1000) / 1000;
}

/**
 * Consolidate old, low-importance episodic memories into summaries so retrieval stays
 * fast and storage is bounded. Important memories (>= 6) and pinned memories are never
 * consolidated. Consolidated originals older than `purgeDays` are deleted (the
 * authoritative event log keeps the exact record).
 */
export function consolidateMemories(db, { ownerId, now, minAgeDays = 7, threshold = 40, purgeDays = 240 }) {
  const cutoff = now - minAgeDays * MINUTES_PER_DAY;
  const rows = db.prepare(`SELECT * FROM memories WHERE owner_id=? AND kind='episodic' AND consolidated=0 AND pinned=0 AND importance<6 AND time<? ORDER BY time`).all(ownerId, cutoff);
  let made = 0;
  if (rows.length >= threshold) {
    const groups = new Map();
    for (const r of rows) {
      const parts = J.parse(r.participants, []).filter((p) => p !== ownerId);
      const key = parts[0] || '_general';
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(r);
    }
    for (const [key, list] of groups) {
      if (list.length < 3) continue;
      const top = [...list].sort((a, b) => b.importance - a.importance).slice(0, 4);
      const avgVal = list.reduce((s, r) => s + r.valence, 0) / list.length;
      const summary = `Summary of ${list.length} older memories${key !== '_general' ? ` involving ${key}` : ''}: ` + top.map((t) => t.summary.replace(/\.$/, '')).join('; ') + '.';
      addMemory(db, {
        ownerId, time: list[list.length - 1].time, kind: 'summary', summary, participants: key !== '_general' ? [key] : [],
        importance: Math.min(5, Math.max(...list.map((r) => r.importance)) + 1), valence: avgVal,
        topic: [...new Set(list.map((r) => r.topic).filter(Boolean))].join(' ').slice(0, 300), source: 'consolidated',
      });
      const ids = list.map((r) => r.id);
      db.prepare(`UPDATE memories SET consolidated=1 WHERE id IN (${ids.map(() => '?').join(',')})`).run(...ids);
      made++;
    }
  }
  const purged = db.prepare('DELETE FROM memories WHERE owner_id=? AND consolidated=1 AND time<?').run(ownerId, now - purgeDays * MINUTES_PER_DAY).changes;
  return { summaries: made, purged };
}

export function memoryStats(db, ownerId) {
  return db.prepare(`SELECT COUNT(*) total, SUM(consolidated=0) active, SUM(kind='summary') summaries, SUM(importance>=6) important FROM memories WHERE owner_id=?`).get(ownerId);
}
