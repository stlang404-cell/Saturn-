// Builds compact, grounded context for the Game Master from authoritative state.
// Only information the *player character* could know is included in interpretation
// context; NPC knowledge is only included for the NPC being voiced.
import { J } from '../engine/db.js';
import { SKILLS } from '../engine/rules.js';
import { attitudeLabel } from '../engine/relationships.js';
import { retrieveMemories } from '../engine/memory.js';
import { factsAbout } from '../engine/knowledge.js';
import { businessesOf } from '../engine/business.js';

export function sanitizePlayerText(text, max = 600) {
  return String(text || '')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, ' ')
    .replace(/<\/?(system|assistant|user|player_input|im_start|im_end)[^>]*>/gi, ' ')
    .replace(/<\|[^|>]{0,40}\|>/g, ' ')
    .slice(0, max)
    .trim();
}

export function buildPlayerContext(game, input = '') {
  const p = game.player();
  const loc = game.location(p.location_id);
  const cal = game.calendar();
  const people = game.charactersAt(loc.id, { excludeId: p.id }).filter((c) => c.kind === 'npc');
  const lines = [];
  lines.push(`TIME: ${cal.label} (${cal.block}, ${cal.season}).`);
  lines.push(`LOCATION: ${loc.name}. ${loc.description}`);
  lines.push(`PEOPLE HERE: ${people.length ? people.map((c) => {
    const def = game.npcDef(c.id) || {};
    const roles = [c.role, def.shop ? 'trades' : null, def.job ? 'hires' : null, def.teaches ? `teaches ${def.teaches.map((t) => t[0]).join('/')}` : null, def.lends ? 'lends money' : null].filter(Boolean).join(', ');
    return `${c.name} (${roles}; ${attitudeLabel(game.rel(c.id, p.id))})`;
  }).join('; ') : 'nobody'}.`);
  lines.push(`EXITS: ${game.exits(loc.id).map((e) => `${e.name} ${e.minutes}min${e.cost ? ` ${e.cost}m` : ''}`).join('; ')}.`);
  const known = game.db.prepare("SELECT id FROM characters WHERE kind='npc'").all().map((r) => game.char(r.id)).filter((c) => game.rel(c.id, p.id).familiarity > 0 && c.location_id !== loc.id);
  if (known.length) lines.push(`PEOPLE YOU KNOW ELSEWHERE: ${known.map((c) => `${c.name} (${c.role})`).join('; ')}.`);
  lines.push(`YOU: ${p.name}, ${p.role}. Health ${p.health}/100, fatigue ${p.fatigue}/100, ${game.balance(p.id)} marks. Attributes: ${Object.entries(p.attributes).map(([k, v]) => `${k} ${v}`).join(', ')}.`);
  const skills = game.db.prepare('SELECT skill, rank FROM skills WHERE character_id=? AND rank>0 ORDER BY rank DESC').all(p.id);
  lines.push(`SKILLS: ${skills.length ? skills.map((s) => `${s.skill} ${s.rank}`).join(', ') : 'none trained'}.`);
  const items = game.held(p.id);
  lines.push(`CARRYING: ${items.length ? items.map((i) => `${i.quantity > 1 ? i.quantity + ' ' : ''}${i.name}${i.equipped ? ' (equipped)' : ''}${i.owner_id !== p.id ? ` (belongs to ${game.char(i.owner_id)?.name || 'someone else'})` : ''}`).join(', ') : 'nothing'}.`);
  const contracts = game.db.prepare("SELECT * FROM contracts WHERE party_b=? AND status IN ('active','offered')").all(p.id).filter((c) => c.status === 'active' || J.parse(c.data, {}).known);
  if (contracts.length) lines.push(`OBLIGATIONS & OFFERS: ${contracts.map((c) => `${c.status === 'offered' ? 'OFFERED' : 'ACTIVE'} ${c.kind}: ${c.title}`).join('; ')}.`);
  const biz = businessesOf(game, p.id).filter((b) => b.status !== 'closed');
  if (biz.length) lines.push(`YOUR BUSINESSES: ${biz.map((b) => `${b.name} (${b.kind}, ${game.balance(b.id)}m cash)`).join('; ')}.`);
  const projects = game.db.prepare("SELECT title, progress, required FROM projects WHERE owner_id=? AND status='active'").all(p.id);
  if (projects.length) lines.push(`PROJECTS: ${projects.map((x) => `"${x.title}" ${x.progress}/${x.required}`).join('; ')}.`);
  const facts = factsAbout(game.db, p.id, input).slice(0, 4);
  if (facts.length) lines.push(`THINGS YOU KNOW OR HAVE HEARD: ${facts.map((f) => `${f.content} [${f.belief}]`).join(' ')}`);
  const mem = retrieveMemories(game.db, { ownerId: p.id, now: game.time, text: input, locationId: loc.id, limit: 4 });
  if (mem.memories.length) lines.push(`YOUR RELEVANT MEMORIES: ${mem.memories.map((m) => m.summary).join(' | ')}`);
  const recent = game.db.prepare("SELECT input, narration FROM turns WHERE status='committed' ORDER BY id DESC LIMIT 3").all().reverse();
  if (recent.length) lines.push(`RECENT TURNS: ${recent.map((r) => `> ${r.input}`).join(' ')}`);
  return { text: lines.join('\n'), memories: mem };
}

export function npcVoiceContext(game, npcId, topicText) {
  const npc = game.char(npcId);
  const rel = game.rel(npcId, game.playerId);
  const mem = retrieveMemories(game.db, { ownerId: npcId, now: game.time, text: topicText, participants: [game.playerId], limit: 5 });
  return {
    name: npc.name, role: npc.role, persona: npc.persona, traits: npc.traits,
    attitude: attitudeLabel(rel), rel: { trust: rel.trust, affection: rel.affection, respect: rel.respect, fear: rel.fear, familiarity: rel.familiarity },
    memories: mem.memories.map((m) => m.summary), memoryDebug: mem,
  };
}

export function skillList() {
  return Object.entries(SKILLS).map(([k, v]) => `${k} (${v.desc})`).join('; ');
}
