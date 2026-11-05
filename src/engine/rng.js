// Counter-based, auditable random number generator.
// Every random draw is a pure function of (worldSeed, counter). The counter is
// persisted in the save, so any roll can be recomputed and audited later, and
// replays from a given counter are exactly reproducible.

function fmix32(h) {
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

/** Hash (seed, counter) into a uniform 32-bit unsigned integer. */
export function hash32(seed, counter) {
  let h = fmix32((seed >>> 0) ^ 0x9e3779b9);
  h = fmix32(h ^ Math.imul((counter >>> 0) + 0x632be5ab, 0x27d4eb2f));
  // mix in the high part of the counter for counters beyond 2^32
  const hi = Math.floor(counter / 4294967296);
  if (hi) h = fmix32(h ^ hi);
  return h;
}

export class AuditRng {
  constructor(seed, counter = 0) {
    this.seed = seed >>> 0;
    this.counter = counter;
  }
  /** Uniform float in [0, 1). */
  next() {
    const v = hash32(this.seed, this.counter);
    this.counter += 1;
    return v / 4294967296;
  }
  /** Integer in [lo, hi], inclusive. */
  int(lo, hi) {
    return lo + Math.floor(this.next() * (hi - lo + 1));
  }
  /** Roll one die with `sides` faces. */
  die(sides) {
    return this.int(1, sides);
  }
  chance(p) {
    return this.next() < p;
  }
  pick(arr) {
    if (!arr.length) return undefined;
    return arr[Math.floor(this.next() * arr.length)];
  }
  /** Weighted pick from [{weight, ...}] */
  weighted(items) {
    const total = items.reduce((s, i) => s + Math.max(0, i.weight), 0);
    if (total <= 0) return undefined;
    let r = this.next() * total;
    for (const it of items) {
      r -= Math.max(0, it.weight);
      if (r < 0) return it;
    }
    return items[items.length - 1];
  }
}

export function seedFromString(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return fmix32(h >>> 0);
}
