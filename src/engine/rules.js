// Core rules data: attributes, skills, progression math, time constants.

export const MINUTES_PER_DAY = 1440;

export const ATTRIBUTES = ['might', 'agility', 'endurance', 'intellect', 'insight', 'presence'];

export const ATTRIBUTE_INFO = {
  might: 'Raw strength: lifting, hauling, striking hard.',
  agility: 'Speed, balance and quick hands.',
  endurance: 'Stamina, toughness, resistance to fatigue and injury.',
  intellect: 'Reasoning, memory and learning from study.',
  insight: 'Perception, intuition and reading people.',
  presence: 'Force of personality, charm and command.',
};

// trained: untrained use suffers a penalty (−3) because the skill needs real knowledge
export const SKILLS = {
  athletics: { attr: 'might', label: 'Athletics', group: 'physical', desc: 'Climbing, swimming, hauling, running.' },
  melee: { attr: 'might', label: 'Melee', group: 'physical', desc: 'Fighting hand-to-hand or with weapons.' },
  stealth: { attr: 'agility', label: 'Stealth', group: 'physical', desc: 'Moving unseen and unheard.' },
  sleight_of_hand: { attr: 'agility', label: 'Sleight of Hand', group: 'physical', desc: 'Picking pockets and locks, palming objects.' },
  survival: { attr: 'endurance', label: 'Survival', group: 'physical', desc: 'Foraging, tracking, enduring the wilds.' },
  perception: { attr: 'insight', label: 'Perception', group: 'mental', desc: 'Noticing details and danger.' },
  investigation: { attr: 'intellect', label: 'Investigation', group: 'mental', desc: 'Searching, deducing, following evidence.' },
  scholarship: { attr: 'intellect', label: 'Scholarship', group: 'mental', desc: 'History, letters, mathematics, research.' },
  medicine: { attr: 'intellect', label: 'Medicine', group: 'mental', trained: true, desc: 'Diagnosing and treating wounds and illness.' },
  herbalism: { attr: 'insight', label: 'Herbalism', group: 'mental', trained: true, desc: 'Identifying, gathering and preparing plants.' },
  engineering: { attr: 'intellect', label: 'Engineering', group: 'mental', trained: true, desc: 'Mechanisms, structures, waterworks, invention.' },
  alchemy: { attr: 'intellect', label: 'Alchemy', group: 'mental', trained: true, desc: 'Tinctures, reagents and transmutation of matter.' },
  persuasion: { attr: 'presence', label: 'Persuasion', group: 'social', desc: 'Convincing others honestly.' },
  deception: { attr: 'presence', label: 'Deception', group: 'social', desc: 'Lying, bluffing, disguise.' },
  intimidation: { attr: 'presence', label: 'Intimidation', group: 'social', desc: 'Getting your way through threat.' },
  negotiation: { attr: 'insight', label: 'Negotiation', group: 'social', desc: 'Haggling and striking deals.' },
  leadership: { attr: 'presence', label: 'Leadership', group: 'social', desc: 'Directing workers, organising people.' },
  commerce: { attr: 'intellect', label: 'Commerce', group: 'trade', desc: 'Bookkeeping, pricing, running a business.' },
  crafting: { attr: 'agility', label: 'Crafting', group: 'trade', desc: 'Cooking, brewing, carpentry and general handiwork.' },
  smithing: { attr: 'might', label: 'Smithing', group: 'trade', trained: true, desc: 'Working metal at the forge.' },
};
export const SKILL_NAMES = Object.keys(SKILLS);

export const RANK_TITLES = ['Untrained', 'Novice', 'Novice', 'Apprentice', 'Apprentice', 'Journeyman', 'Journeyman', 'Expert', 'Expert', 'Master', 'Grandmaster'];

/** Cumulative XP needed to reach rank r. */
export function xpForRank(r) {
  if (r <= 0) return 0;
  return 8 * r * r + 12 * r; // 20, 56, 108, 176, 260, 360, 476, 608, 756, 920
}
export function rankForXp(xp) {
  let r = 0;
  while (r < 10 && xp >= xpForRank(r + 1)) r++;
  return r;
}

/**
 * XP from using a skill in a real check. Learning requires challenge: checks that
 * are trivial for your current ability teach nothing. Failures teach a little more
 * than successes. Daily diminishing returns stop grinding.
 */
export function practiceXp({ attribute, rank, tn, degree, dailyXp }) {
  const expected = attribute + rank + 11; // average roll
  const challenge = tn - expected; // >0 means harder than average for you
  if (challenge < -5) return 0;
  let base = 1 + 0.3 * (challenge + 5); // 1.0 .. ~4
  base = Math.min(base, 4.5);
  if (degree === 'failure' || degree === 'partial') base *= 1.25;
  if (degree === 'severe_failure') base *= 0.8;
  if (degree === 'critical') base *= 1.2;
  return round2(base * diminishing(dailyXp));
}

export function diminishing(dailyXp) {
  return 1 / (1 + Math.max(0, dailyXp) / 10);
}

/**
 * Learning methods. xpPerHour is scaled by intellect for study and endurance for drills.
 *  self: thinking it through without resources; only gets you started.
 *  book: steady, cheap, capped by the book's depth.
 *  mentor: fastest, costs money and the mentor's time, capped one below the mentor.
 *  drill: physical practice, capped at apprentice level — beyond that you need real use.
 *  experiment: hands-on trial and error for trade/mental skills; slow, consumes materials.
 */
export const LEARNING_METHODS = {
  self: { rate: 0.35, cap: 1, attr: 'intellect', label: 'self-study' },
  book: { rate: 0.9, cap: null, attr: 'intellect', label: 'study from a book' },
  mentor: { rate: 1.6, cap: null, attr: 'intellect', label: 'lessons with a mentor' },
  drill: { rate: 0.75, cap: 4, attr: 'endurance', label: 'drills and practice' },
  experiment: { rate: 0.6, cap: 6, attr: 'intellect', label: 'experimentation' },
};

export function studyXpPerHour(method, attrValue) {
  const m = LEARNING_METHODS[method];
  return m.rate * (0.6 + 0.2 * attrValue);
}

export const DRILLABLE = new Set(['athletics', 'melee', 'stealth', 'sleight_of_hand', 'survival', 'perception', 'crafting', 'smithing']);
export const EXPERIMENTABLE = new Set(['crafting', 'smithing', 'alchemy', 'engineering', 'herbalism', 'medicine']);

export function round2(x) {
  return Math.round(x * 100) / 100;
}

export function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}

export function timeBlock(minuteOfDay) {
  const h = Math.floor(minuteOfDay / 60);
  if (h >= 5 && h < 8) return 'dawn';
  if (h >= 8 && h < 12) return 'morning';
  if (h >= 12 && h < 17) return 'afternoon';
  if (h >= 17 && h < 22) return 'evening';
  return 'night';
}

export const BLOCK_START_HOUR = { dawn: 5, morning: 8, afternoon: 12, evening: 17, night: 22 };
