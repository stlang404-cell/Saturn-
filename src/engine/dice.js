// SATURN Resolution System (SRS)
//
// Core check: 2d10 + attribute + skill rank + situational modifiers vs a Target Number (TN).
// The 2d10 sum has a triangular distribution (mean 11), which keeps results
// predictable for experts while leaving room for surprise. Results are graded by
// margin (total - TN) into six degrees. Natural double 10 raises the degree one
// step; natural double 1 lowers it one step.
//
// Every probability shown to the player is computed exactly by enumerating all
// 100 (or 10,000 for opposed checks) dice outcomes — nothing is estimated.

export const DIFFICULTY = Object.freeze({
  trivial: 8,
  easy: 11,
  moderate: 14,
  hard: 17,
  very_hard: 20,
  extreme: 24,
  legendary: 28,
});

export const DIFFICULTY_NAMES = Object.keys(DIFFICULTY);

export const DEGREES = Object.freeze([
  'severe_failure', // 0
  'failure', // 1  failure with complication
  'partial', // 2  success at a cost
  'success', // 3
  'strong', // 4
  'critical', // 5
]);

export const DEGREE_LABEL = {
  severe_failure: 'Severe failure',
  failure: 'Failure',
  partial: 'Partial success',
  success: 'Success',
  strong: 'Strong success',
  critical: 'Critical success',
  automatic: 'Automatic success',
  impossible: 'Not possible now',
};

export function isSuccess(degree) {
  return degree === 'success' || degree === 'strong' || degree === 'critical' || degree === 'automatic';
}
export function isAtLeastPartial(degree) {
  return degree === 'partial' || isSuccess(degree);
}

function degreeIndexFromMargin(m) {
  if (m >= 8) return 5;
  if (m >= 4) return 4;
  if (m >= 0) return 3;
  if (m >= -3) return 2;
  if (m >= -7) return 1;
  return 0;
}

export function gradeRoll(d1, d2, total, tn) {
  const margin = total - tn;
  let idx = degreeIndexFromMargin(margin);
  if (d1 === 10 && d2 === 10) idx = Math.min(5, idx + 1);
  if (d1 === 1 && d2 === 1) idx = Math.max(0, idx - 1);
  return { margin, degree: DEGREES[idx] };
}

/** Sum modifiers: [{label, value}] → number */
export function sumMods(mods) {
  return mods.reduce((s, m) => s + (m.value || 0), 0);
}

/** Exact probability distribution of degrees for a simple check. */
export function checkDistribution(bonus, tn) {
  const counts = Object.fromEntries(DEGREES.map((d) => [d, 0]));
  for (let a = 1; a <= 10; a++)
    for (let b = 1; b <= 10; b++) counts[gradeRoll(a, b, a + b + bonus, tn).degree] += 1;
  const dist = {};
  for (const d of DEGREES) dist[d] = counts[d] / 100;
  return dist;
}

/** Exact distribution for opposed checks: attacker margin = (2d10+A) - (2d10+D). */
export function opposedDistribution(attBonus, defBonus) {
  const counts = Object.fromEntries(DEGREES.map((d) => [d, 0]));
  for (let a = 1; a <= 10; a++)
    for (let b = 1; b <= 10; b++)
      for (let c = 1; c <= 10; c++)
        for (let d = 1; d <= 10; d++) {
          const defTotal = c + d + defBonus;
          counts[gradeRoll(a, b, a + b + attBonus, defTotal + 1).degree] += 1; // ties favour defender by 1
        }
  const dist = {};
  for (const deg of DEGREES) dist[deg] = counts[deg] / 10000;
  return dist;
}

export function summarizeDistribution(dist) {
  const success = dist.success + dist.strong + dist.critical;
  return {
    success: round3(success),
    atLeastPartial: round3(success + dist.partial),
    critical: round3(dist.critical),
    severe: round3(dist.severe_failure),
  };
}

function round3(x) {
  return Math.round(x * 1000) / 1000;
}

/**
 * Classify a check before rolling.
 *  - automatic: even the worst roll (2) succeeds → no roll needed
 *  - impossible: even the best non-critical roll (20) cannot reach a partial success
 *  - uncertain: otherwise
 */
export function classifyCheck(bonus, tn) {
  if (2 + bonus >= tn) return 'automatic';
  if (20 + bonus < tn - 3) return 'impossible';
  return 'uncertain';
}

/**
 * Resolve a simple check.
 * @param {import('./rng.js').AuditRng} rng
 * @param {{attribute:number, skill:number, mods:Array<{label:string,value:number}>, tn:number, forceRoll?:boolean}} spec
 */
export function resolveCheck(rng, spec) {
  const mods = [
    { label: `Attribute (${spec.attributeName || 'attr'})`, value: spec.attribute },
    { label: `Skill (${spec.skillName || 'skill'})`, value: spec.skill },
    ...(spec.mods || []),
  ];
  const bonus = sumMods(mods);
  const tn = spec.tn;
  const cls = classifyCheck(bonus, tn);
  const dist = checkDistribution(bonus, tn);
  const summary = summarizeDistribution(dist);
  if (cls === 'automatic' && !spec.forceRoll) {
    return { kind: 'check', classification: cls, degree: 'automatic', bonus, tn, mods, dice: null, total: null, margin: null, probability: summary, rngCounter: null };
  }
  if (cls === 'impossible' && !spec.forceRoll) {
    return { kind: 'check', classification: cls, degree: 'impossible', bonus, tn, mods, dice: null, total: null, margin: null, probability: summary, rngCounter: null };
  }
  const rngCounter = rng.counter;
  const d1 = rng.die(10);
  const d2 = rng.die(10);
  const total = d1 + d2 + bonus;
  const { margin, degree } = gradeRoll(d1, d2, total, tn);
  return { kind: 'check', classification: cls, degree, bonus, tn, mods, dice: [d1, d2], total, margin, probability: summary, rngCounter };
}

/** Resolve an opposed check. */
export function resolveOpposed(rng, att, def) {
  const attMods = [
    { label: `Attribute (${att.attributeName})`, value: att.attribute },
    { label: `Skill (${att.skillName})`, value: att.skill },
    ...(att.mods || []),
  ];
  const defMods = [
    { label: `Opponent attribute (${def.attributeName})`, value: def.attribute },
    { label: `Opponent skill (${def.skillName})`, value: def.skill },
    ...(def.mods || []),
  ];
  const ab = sumMods(attMods);
  const db = sumMods(defMods);
  const summary = summarizeDistribution(opposedDistribution(ab, db));
  const rngCounter = rng.counter;
  const a1 = rng.die(10), a2 = rng.die(10), d1 = rng.die(10), d2 = rng.die(10);
  const total = a1 + a2 + ab;
  const defTotal = d1 + d2 + db;
  const { margin, degree } = gradeRoll(a1, a2, total, defTotal + 1);
  return {
    kind: 'opposed', classification: 'uncertain', degree, bonus: ab, tn: defTotal + 1, mods: attMods,
    opponentMods: defMods, opponentBonus: db, dice: [a1, a2], opponentDice: [d1, d2], total, opponentTotal: defTotal,
    margin, probability: summary, rngCounter,
  };
}
