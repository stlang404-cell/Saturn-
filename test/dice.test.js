import test from 'node:test';
import assert from 'node:assert/strict';
import { checkDistribution, opposedDistribution, summarizeDistribution, classifyCheck, resolveCheck, gradeRoll, DEGREES } from '../src/engine/dice.js';
import { AuditRng, hash32 } from '../src/engine/rng.js';
import { practiceXp, xpForRank, rankForXp, studyXpPerHour } from '../src/engine/rules.js';

test('degree distributions sum to 1 and success is monotonic in bonus', () => {
  let prev = -1;
  for (let bonus = -5; bonus <= 15; bonus++) {
    const d = checkDistribution(bonus, 14);
    const total = DEGREES.reduce((s, k) => s + d[k], 0);
    assert.ok(Math.abs(total - 1) < 1e-9);
    const s = summarizeDistribution(d).success;
    assert.ok(s >= prev, `success chance must not drop as bonus rises (${bonus})`);
    prev = s;
  }
});

test('calibration anchors: an average untrained person vs moderate is a coin flip-ish; an expert is reliable', () => {
  // attribute 3 + skill 0 vs moderate (14): need 2d10 >= 11 → 55%
  assert.equal(summarizeDistribution(checkDistribution(3, 14)).success, 0.55);
  // apprentice (attr 3 + skill 4) vs hard (17): need 10 → 64%
  assert.equal(summarizeDistribution(checkDistribution(7, 17)).success, 0.64);
  // master (attr 5 + skill 9) vs very hard (20): need 6 → 90%; still not certain
  const m = summarizeDistribution(checkDistribution(14, 20));
  assert.ok(m.success >= 0.85 && m.success < 1);
  // novice vs legendary is impossible
  assert.equal(classifyCheck(3, 28), 'impossible');
  // master vs trivial needs no roll
  assert.equal(classifyCheck(14, 8), 'automatic');
});

test('natural doubles shift degrees', () => {
  assert.equal(gradeRoll(10, 10, 25, 20).degree, 'critical'); // margin 5 = strong, double 10 upgrades
  assert.equal(gradeRoll(4, 5, 25, 20).degree, 'strong');
  assert.equal(gradeRoll(1, 1, 16, 14).degree, 'partial'); // success downgraded
});

test('opposed checks are symmetric for equal opponents (ties favour defender)', () => {
  const s = summarizeDistribution(opposedDistribution(5, 5));
  assert.ok(s.success < 0.5 && s.success > 0.35, `equal opposed success ${s.success}`);
  const better = summarizeDistribution(opposedDistribution(9, 5)).success;
  assert.ok(better > 0.6);
});

test('RNG is deterministic, counter-addressable and roughly uniform', () => {
  const a = new AuditRng(99), b = new AuditRng(99);
  for (let i = 0; i < 1000; i++) assert.equal(a.next(), b.next());
  const c = new AuditRng(99, 500);
  const d = new AuditRng(99); for (let i = 0; i < 500; i++) d.next();
  assert.equal(c.next(), d.next());
  // chi-square on d10
  const counts = Array(10).fill(0);
  const r = new AuditRng(7);
  const N = 100000;
  for (let i = 0; i < N; i++) counts[r.die(10) - 1]++;
  const chi = counts.reduce((s, x) => s + (x - N / 10) ** 2 / (N / 10), 0);
  assert.ok(chi < 27.9, `chi-square ${chi} exceeds p=0.001 critical value`);
  assert.notEqual(hash32(1, 1), hash32(1, 2));
});

test('a recorded roll can be replayed from its counter', () => {
  const rng = new AuditRng(4242, 77);
  const first = resolveCheck(rng, { attribute: 3, skill: 2, mods: [], tn: 15, forceRoll: true });
  const replay = resolveCheck(new AuditRng(4242, first.rngCounter), { attribute: 3, skill: 2, mods: [], tn: 15, forceRoll: true });
  assert.deepEqual(replay.dice, first.dice);
  assert.equal(replay.degree, first.degree);
});

test('progression: trivial practice teaches nothing; repetition diminishes; ranks are earned', () => {
  assert.equal(practiceXp({ attribute: 4, rank: 6, tn: 8, degree: 'success', dailyXp: 0 }), 0);
  const fresh = practiceXp({ attribute: 3, rank: 2, tn: 17, degree: 'success', dailyXp: 0 });
  const tired = practiceXp({ attribute: 3, rank: 2, tn: 17, degree: 'success', dailyXp: 40 });
  assert.ok(fresh > tired * 3, 'diminishing returns within a day');
  assert.equal(rankForXp(xpForRank(5)), 5);
  assert.equal(rankForXp(xpForRank(5) - 0.01), 4);
  assert.ok(studyXpPerHour('mentor', 3) > studyXpPerHour('book', 3));
  assert.ok(studyXpPerHour('book', 3) > studyXpPerHour('self', 3));
  // a full year of daily maximal grinding of one easy-ish skill cannot reach mastery via practice alone
  let xp = 0;
  for (let day = 0; day < 365; day++) {
    let daily = 0;
    for (let i = 0; i < 40; i++) { const g = practiceXp({ attribute: 3, rank: rankForXp(xp), tn: 14, degree: 'success', dailyXp: daily }); xp += g; daily += g; }
  }
  assert.ok(rankForXp(xp) <= 6, `rank ${rankForXp(xp)} from grinding moderate tasks`);
});
