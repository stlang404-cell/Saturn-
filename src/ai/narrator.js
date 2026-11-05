// Narration: turns verified outcomes into prose. The LLM narrator is checked for
// contradictions against the authoritative outcome (numbers, names, mechanics);
// a deterministic template narrator is always available as fallback.
import { DEGREE_LABEL } from '../engine/dice.js';
import { seedFromString } from '../engine/rng.js';

const pickFrom = (arr, seed) => arr[Math.abs(seed) % arr.length];

/** Compact, explicit outcome description for the narrator model. */
export function describeOutcomes(game, input, result) {
  const loc = game.location(game.player().location_id);
  const lines = [`PLAYER INPUT: ${input}`, `NOW AT: ${loc.name} — ${game.calendar().label}`];
  result.outcomes.forEach((o, i) => {
    if (o.status === 'blocked') {
      lines.push(`${i + 1}. ${o.type} — BLOCKED: ${o.error?.message}`);
      return;
    }
    lines.push(`${i + 1}. ${o.type} — ${o.status.toUpperCase()}: ${o.summary}`);
    if (o.facts?.length) lines.push(`   FACTS: ${o.facts.join(' ')}`);
    for (const r of o.rolls || []) {
      const verdict = /success|critical|automatic/.test(r.degree) && r.degree !== 'partial' ? 'IT WORKS — show it succeeding' : r.degree === 'partial' ? 'IT PARTLY WORKS, at a cost' : 'IT FAILS — show it failing';
      lines.push(`   RESULT of "${r.label}": ${DEGREE_LABEL[r.degree]} → ${verdict}`);
    }
    const d = o.dialogue;
    if (d) {
      const v = d.voice || {};
      lines.push(`   NPC: ${d.npcName} — ${v.role || ''}. Persona: ${d.persona || v.persona || ''} Attitude toward player: ${d.attitude}.`);
      if (d.approach) lines.push(`   PLAYER APPROACH: ${d.approach}${d.topic ? `; TOPIC: ${d.topic}` : ''}${d.said ? `; PLAYER SAID: "${d.said}"` : ''}${d.told ? `; PLAYER TOLD THEM: ${d.told} (believed: ${d.believed})` : ''}`);
      lines.push(`   DISCLOSED: ${d.disclosed?.length ? d.disclosed.map((x) => `[${x.npcBelief === 'known' ? 'they know' : 'they have heard'}] ${x.content}`).join(' ') : 'nothing'}`);
      if (d.unknown) lines.push('   NPC_KNOWS_NOTHING: true');
      if (d.refused) lines.push('   REFUSED: true');
      if (d.keeperDenies) lines.push('   KEEPER_DENIES: true');
      if (d.caughtLying) lines.push('   THE NPC CAUGHT THE PLAYER LYING');
      if (d.firstMeeting) lines.push('   FIRST MEETING');
      if (v.memories?.length) lines.push(`   NPC REMEMBERS: ${v.memories.slice(0, 3).join(' | ')}`);
      if (d.request) lines.push(`   NPC OFFERS TASK: ${d.request.text} Reward ${d.request.reward} marks.`);
      if (d.goals?.length) lines.push(`   NPC CONCERNS: ${d.goals.join('; ')}`);
    }
  });
  const c = result.changes;
  const ch = [];
  if (c.money) ch.push(`money ${c.money > 0 ? '+' : ''}${c.money}`);
  for (const it of c.items) ch.push(`${it.delta > 0 ? '+' : ''}${it.delta} ${it.name}`);
  if (c.minutes) ch.push(`${c.minutes} minutes passed`);
  if (c.health) ch.push(`health ${c.health > 0 ? '+' : ''}${c.health}`);
  if (ch.length) lines.push(`CHANGES: ${ch.join(', ')}`);
  if (result.digest?.length) lines.push(`MEANWHILE IN THE WORLD: ${result.digest.map((d) => d.summary).join(' ')}`);
  return lines.join('\n');
}

/** Detect narration that contradicts the authoritative outcome. */
export function checkNarration(game, text, outcomeText) {
  const problems = [];
  const allowedNums = new Set((outcomeText.match(/\d+/g) || []));
  for (const n of text.match(/\b\d+\b/g) || []) if (!allowedNums.has(n) && Number(n) > 1) problems.push(`number ${n} not in outcome`);
  if (/\b(dice|d10|roll(ed)? a|natural \d|skill check|target number|\bTN\b)/i.test(text)) problems.push('mentions game mechanics');
  const names = game.db.prepare("SELECT name FROM characters WHERE kind='npc'").all().map((r) => r.name);
  const presentNames = game.charactersAt(game.player().location_id).map((c) => c.name);
  for (const full of names) {
    const first = full.split(' ')[0];
    const mentioned = text.includes(full) || new RegExp(`\\b${first}\\b`).test(text);
    if (mentioned && !outcomeText.includes(first) && !presentNames.includes(full)) problems.push(`mentions ${full}, who is not involved`);
  }
  if (/\b(as an ai|language model|system prompt|json)\b/i.test(text)) problems.push('breaks the fiction');
  // the player is always "you": naming them signals invented third-person framing or invented history
  const pname = game.player()?.name;
  if (pname && new RegExp(`\\b${pname.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(text)) problems.push('refers to the player by name');
  // outcome polarity: narration must not depict failure for a success or vice versa
  const works = (outcomeText.match(/IT WORKS/g) || []).length;
  const fails = (outcomeText.match(/IT FAILS/g) || []).length;
  const FAIL_WORDS = /\b(not acknowledged|unmoved|unimpressed|ignores you|does not react|doesn't react|not persuaded|unconvinced|isn't convinced|is not convinced|refuses|turns away|without looking|you fail|fails to|no effect|not looking at you|shakes (his|her|their) head)\b/i;
  const SUCCESS_WORDS = /\b(is persuaded|is convinced|agrees|impressed|won over|you succeed|succeeds|nods approvingly|warms to you|delighted)\b/i;
  if (works && !fails && FAIL_WORDS.test(text)) problems.push(`depicts failure but the outcome succeeded ("${text.match(FAIL_WORDS)[0]}")`);
  if (fails && !works && SUCCESS_WORDS.test(text)) problems.push(`depicts success but the outcome failed ("${text.match(SUCCESS_WORDS)[0]}")`);
  return { ok: problems.length === 0, problems };
}

function sayDisclosed(d, seed) {
  const out = [];
  for (const [i, x] of (d.disclosed || []).entries()) {
    const body = x.content.replace(/\.$/, '');
    const lead = x.npcBelief === 'known'
      ? pickFrom(['', 'I\'ll tell you plainly: ', 'Fact is, ', 'Everyone who matters knows it: '], seed + i)
      : pickFrom(['Word is, ', 'I\'ve heard it said that ', 'Can\'t swear to it, but they say ', 'Rumour has it '], seed + i);
    out.push(`"${lead}${lead ? body.charAt(0).toLowerCase() + body.slice(1) : body}."`);
  }
  return out;
}

/** Deterministic narration from outcomes (no model). */
export function templateNarration(game, input, result) {
  const seed = seedFromString(`${result.turnId}:${input}`);
  const parts = [];
  for (const o of result.outcomes) {
    if (o.status === 'blocked') { parts.push(o.error?.message || 'You cannot do that.'); continue; }
    const d = o.dialogue;
    if (d && (o.type === 'talk' || o.type === 'tell' || o.type === 'ask_job' || o.type === 'accept_request' || o.type === 'invest')) {
      const name = d.npcName;
      const first = /^(Brother|Captain|Old|Sister|Master|Mayor)\b/.test(name) ? name : name.split(' ')[0];
      const opener = d.firstMeeting
        ? pickFrom([`${name} looks you over — a new face.`, `${name} gives you a measuring look as you introduce yourself.`, `You introduce yourself to ${name}.`], seed)
        : pickFrom([`${name} turns to you.`, `${first} looks up as you approach.`, `${first} nods in recognition.`], seed);
      parts.push(opener);
      const mood = { devoted: 'warmly', friendly: 'with a friendly smile', warm: 'pleasantly', neutral: 'evenly', unfamiliar: 'politely', cool: 'coolly', hostile: 'with open dislike', loathing: 'with contempt', afraid: 'nervously' }[d.attitude] || 'evenly';
      if (o.type === 'tell') parts.push(d.believed ? `${first} listens ${mood}, and you can see the words land.` : `${first} listens ${mood} but plainly isn't convinced.`);
      else if (o.type === 'ask_job') parts.push(d.hired ? `"Very well," ${first} says ${mood}. "We'll see what you're worth."` : `${first} shakes their head. "Not now."`);
      else if (d.caughtLying) parts.push(`${first}'s eyes narrow. "Do you take me for a fool?"`);
      else if (d.approach === 'intimidate') parts.push(o.rolls?.[0] && /success|critical/.test(o.rolls[0].degree) ? `${first} pales and steps back.` : `${first} stares you down, unimpressed.`);
      else if (d.approach === 'insult') parts.push(`${first} stiffens. "I'll remember that."`);
      else if (d.approach === 'persuade' || d.approach === 'propose') parts.push(o.rolls?.[0] && /success|strong|critical/.test(o.rolls[0].degree) ? `${first} considers your words and seems persuaded.` : `${first} hears you out ${mood}, unmoved.`);
      else if (d.approach === 'flatter') parts.push(`${first} accepts the compliment ${mood}.`);
      parts.push(...sayDisclosed(d, seed));
      if (d.unknown && !d.disclosed?.length) parts.push(pickFrom([`"Can't say I know anything about that," ${first} says.`, `${first} shrugs. "Nothing I've heard of."`, `"You're asking the wrong person," ${first} says.`], seed));
      if (d.keeperDenies) parts.push(pickFrom([`"Whoever told you that is mistaken," ${first} says, a little too quickly.`, `${first}'s smile doesn't reach their eyes. "Idle gossip. Nothing more."`], seed));
      else if (d.refused && !d.disclosed?.length) parts.push(`${first} hesitates, then changes the subject.`);
      if (d.request) parts.push(`"Since you ask," ${first} adds, "${d.request.text.replace(/^.*?\b(needs|wants|will pay well for)\b/, 'I need')}"`);
      const other = (o.facts || []).filter((f) => !/does not know anything|mentions a task|will not say/.test(f));
      if (other.length && o.type !== 'talk') parts.push(other.join(' '));
      else if (other.length) parts.push(other.filter((f) => /pays you|could use|sees through/.test(f)).join(' '));
      continue;
    }
    parts.push(o.summary);
    if (o.facts?.length) parts.push(o.facts.join(' '));
  }
  if (result.digest?.length) parts.push(`Meanwhile: ${result.digest.map((x) => x.summary).join(' ')}`);
  return parts.filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
}
