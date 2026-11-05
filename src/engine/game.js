// The authoritative simulation. Only code in src/engine may change world state,
// and all changes for a player turn happen inside a single SQLite transaction.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDatabase, getMeta, setMeta, J } from './db.js';
import { AuditRng, seedFromString } from './rng.js';
import { resolveCheck, resolveOpposed, DEGREE_LABEL } from './dice.js';
import { buildRuleset, ROLE_DEFAULTS, MINUTES_PER_DAY, practiceXp, rankForXp, xpForRank, diminishing, round2, clamp, timeBlock } from './rules.js';
import * as ledger from './ledger.js';
import * as inv from './inventory.js';
import { addMemory } from './memory.js';
import { learn } from './knowledge.js';
import { adjustRel, getRel } from './relationships.js';
import { RuleError } from './ledger.js';
import { resolveSkill } from './resolve.js';
import { populateWorld } from './worldgen.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const DATA_DIR = path.resolve(__dirname, '../../data');

export function loadWorldDef(worldId = 'saltwind') {
  const file = path.join(DATA_DIR, 'worlds', worldId, 'world.json');
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

export class Game {
  constructor(db) {
    this.db = db;
    this.def = getMeta(db, 'world_def');
    if (!this.def) throw new Error('Not a SATURN save (missing world definition).');
    this._time = getMeta(db, 'time', 0);
    this.rng = new AuditRng(getMeta(db, 'seed', 1), getMeta(db, 'rng_counter', 0));
    this.turnId = null;
    this.playerId = getMeta(db, 'player_id', 'player');
    this.digest = [];
    this._recipes = Object.fromEntries((this.def.recipes || []).map((r) => [r.id, r]));
    this._npcDefs = Object.fromEntries((this.def.npcs || []).map((n) => [n.id, n]));
    this.rules = buildRuleset(this.def);
  }

  /**
   * Map a skill name, a legacy skill id, or an engine role onto this world's skill ids.
   * Generic actions name the skill they would use in Saltwind (e.g. 'sleight_of_hand');
   * worlds that define their own skills receive the skill filling that role.
   */
  skillFor(name) {
    if (!name) return null;
    if (this.rules.skills[name]) return name;
    if (this.rules.roles[name]) return this.rules.roles[name];
    const role = Object.entries(ROLE_DEFAULTS).find(([, legacy]) => legacy === name)?.[0];
    if (role) return this.rules.roles[role];
    return resolveSkill(name, this.rules);
  }
  resolveSkill(name) {
    return resolveSkill(name, this.rules);
  }
  money(n) {
    return this.rules.money(n);
  }

  // ---------- lifecycle ----------
  static create(file, { worldId = 'saltwind', seed = null, player = {} } = {}) {
    if (file !== ':memory:' && fs.existsSync(file)) throw new Error(`Save already exists: ${file}`);
    const db = openDatabase(file);
    const def = loadWorldDef(worldId);
    const s = seed ?? Math.floor(Math.random() * 2 ** 31);
    db.transaction(() => {
      setMeta(db, 'world_def', def);
      setMeta(db, 'seed', typeof s === 'string' ? seedFromString(s) : s >>> 0);
      setMeta(db, 'rng_counter', 0);
      setMeta(db, 'created_real', new Date().toISOString());
      const c = def.calendar.start;
      setMeta(db, 'time', (c.month * def.calendar.daysPerMonth + (c.day - 1)) * MINUTES_PER_DAY + c.hour * 60);
    })();
    const game = new Game(db);
    game.transact(() => populateWorld(game, player));
    return game;
  }

  static open(file) {
    if (!fs.existsSync(file)) throw new Error(`No such save: ${file}`);
    return new Game(openDatabase(file));
  }

  close() {
    try { this.db.pragma('wal_checkpoint(TRUNCATE)'); } catch { /* ignore */ }
    this.db.close();
  }

  get time() { return this._time; }
  set time(t) { this._time = t; }
  get ctx() { return { db: this.db, time: this._time, turnId: this.turnId }; }

  /**
   * Run `fn` atomically. On any exception the database transaction is rolled back
   * and in-memory time / RNG state is restored, so no half-committed action survives.
   */
  transact(fn) {
    const snapshot = { time: this._time, counter: this.rng.counter, digest: this.digest.length };
    try {
      return this.db.transaction(() => {
        const r = fn();
        setMeta(this.db, 'time', this._time);
        setMeta(this.db, 'rng_counter', this.rng.counter);
        return r;
      })();
    } catch (e) {
      this._time = snapshot.time;
      this.rng.counter = snapshot.counter;
      this.digest.length = snapshot.digest;
      throw e;
    }
  }

  // ---------- calendar ----------
  calendar(t = this._time) {
    const cal = this.def.calendar;
    const day = Math.floor(t / MINUTES_PER_DAY);
    const minute = t % MINUTES_PER_DAY;
    const year = cal.startYear + Math.floor(day / (cal.daysPerMonth * cal.months.length));
    const dayOfYear = day % (cal.daysPerMonth * cal.months.length);
    const month = Math.floor(dayOfYear / cal.daysPerMonth);
    const dom = (dayOfYear % cal.daysPerMonth) + 1;
    const hh = Math.floor(minute / 60), mm = minute % 60;
    const season = ['Winter', 'Spring', 'Spring', 'Spring', 'Summer', 'Summer', 'Summer', 'Autumn', 'Autumn', 'Autumn', 'Winter', 'Winter'][month];
    return {
      day, minute, year, month, monthName: cal.months[month], dayOfMonth: dom, hour: hh, min: mm,
      weekday: cal.weekdays[day % cal.weekdays.length], block: timeBlock(minute), season,
      label: `${cal.weekdays[day % cal.weekdays.length]}, ${dom} ${cal.months[month]}, Year ${year} — ${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`,
      short: `${dom} ${cal.months[month]} ${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`,
    };
  }
  get day() { return Math.floor(this._time / MINUTES_PER_DAY); }

  // ---------- queries ----------
  char(id) {
    const c = this.db.prepare('SELECT * FROM characters WHERE id=?').get(id);
    if (!c) return null;
    return { ...c, attributes: J.parse(c.attributes, {}), traits: J.parse(c.traits, []), goals: J.parse(c.goals, []), schedule: J.parse(c.schedule, {}), data: J.parse(c.data, {}) };
  }
  player() { return this.char(this.playerId); }
  npcDef(id) { return this._npcDefs[id] || null; }
  recipe(id) { return this._recipes[id] || null; }
  location(id) {
    const l = this.db.prepare('SELECT * FROM locations WHERE id=?').get(id);
    return l ? { ...l, tags: J.parse(l.tags, []), data: J.parse(l.data, {}) } : null;
  }
  charactersAt(locId, { excludeId = null } = {}) {
    return this.db.prepare("SELECT id FROM characters WHERE location_id=? AND alive=1 AND id IS NOT ? ORDER BY kind DESC, name").all(locId, excludeId).map((r) => this.char(r.id));
  }
  exits(locId, { forId = this.playerId } = {}) {
    const rows = this.db.prepare('SELECT r.*, l.name FROM routes r JOIN locations l ON l.id=r.to_id WHERE r.from_id=?').all(locId);
    return rows.filter((r) => this.knowsLocation(forId, r.to_id))
      .map((r) => ({ to: r.to_id, name: r.name, minutes: r.minutes, mode: r.mode, risk: r.risk, cost: r.cost }));
  }
  isHiddenLocation(locId) {
    return !!this.location(locId)?.data?.hidden;
  }
  /** Hidden places are only reachable once a character has learned of them or been there. */
  knowsLocation(charId, locId) {
    const l = this.location(locId);
    if (!l?.data?.hidden) return true;
    const c = this.char(charId);
    if (c?.data?.visited?.includes(locId)) return true;
    const facts = this.db.prepare('SELECT f.data FROM knowledge k JOIN facts f ON f.id=k.fact_id WHERE k.holder_id=?').all(charId);
    return facts.some((f) => J.parse(f.data, {}).reveals_location === locId);
  }
  attr(charId, a) { return this.char(charId)?.attributes?.[a] ?? 2; }
  skill(charId, skill) {
    return this.db.prepare('SELECT * FROM skills WHERE character_id=? AND skill=?').get(charId, skill) || { character_id: charId, skill, xp: 0, rank: 0, daily_xp: 0, daily_day: -1, specialization: null };
  }
  balance(id) { return ledger.balance(this.db, id); }
  settlementOf(locId) { return this.location(locId)?.settlement || null; }

  updateChar(id, fields) {
    const sets = [], args = [];
    for (const [k, v] of Object.entries(fields)) {
      sets.push(`${k}=?`);
      args.push(typeof v === 'object' && v !== null ? J.str(v) : v);
    }
    if (!sets.length) return;
    this.db.prepare(`UPDATE characters SET ${sets.join(',')} WHERE id=?`).run(...args, id);
  }
  setCharData(id, patch) {
    const c = this.char(id);
    this.updateChar(id, { data: { ...c.data, ...patch } });
  }

  // ---------- condition modifiers ----------
  conditionMods(charId) {
    const c = this.char(charId);
    const mods = [];
    if (c.fatigue >= 90) mods.push({ label: 'Exhausted', value: -2 });
    else if (c.fatigue >= 70) mods.push({ label: 'Tired', value: -1 });
    if (c.health < 25) mods.push({ label: 'Badly hurt', value: -3 });
    else if (c.health < 50) mods.push({ label: 'Injured', value: -1 });
    if (c.kind === 'player') {
      const hungry = this._time - c.last_meal;
      if (hungry > 3 * MINUTES_PER_DAY) mods.push({ label: 'Starving', value: -2 });
      else if (hungry > MINUTES_PER_DAY) mods.push({ label: 'Hungry', value: -1 });
    }
    return mods;
  }

  /** Build the full modifier list for a character using a skill. */
  skillMods(charId, skill, extra = []) {
    const info = this.rules.skills[skill];
    const s = this.skill(charId, skill);
    const mods = [];
    if (info?.trained && s.rank === 0) mods.push({ label: 'Untrained in a specialist skill', value: -3 });
    if (s.specialization) mods.push({ label: `Specialization: ${s.specialization}`, value: 0 });
    const tool = inv.toolBonus(this.db, charId, skill);
    if (tool) mods.push(tool);
    if (skill === this.rules.roles.fight) {
      const w = inv.equippedBonus(this.db, charId, 'melee');
      if (w) mods.push({ label: 'Weapon', value: w });
    }
    return [...mods, ...this.conditionMods(charId), ...extra.filter((m) => m && m.value)];
  }

  /**
   * Perform a check for `actorId`. Records the roll and grants practice XP.
   * opts: { skill, tn, mods, label, opposedBy, opposedSkill, opposedMods, forceRoll, noXp }
   */
  check(actorId, opts) {
    const skill = this.skillFor(opts.skill);
    const label = opts.label || skill;
    const info = this.rules.skills[skill];
    if (!info) throw new RuleError('unknown_skill', `Unknown skill ${opts.skill}`);
    const s = this.skill(actorId, skill);
    const attrName = info.attr;
    const attribute = this.attr(actorId, attrName);
    const mods = this.skillMods(actorId, skill, opts.mods || []);
    let result;
    if (opts.opposedBy) {
      const oppSkill = this.skillFor(opts.opposedSkill || 'perception');
      const oInfo = this.rules.skills[oppSkill];
      const os = this.skill(opts.opposedBy, oppSkill);
      result = resolveOpposed(this.rng,
        { attributeName: attrName, attribute, skillName: info.label, skill: s.rank, mods },
        { attributeName: oInfo.attr, attribute: this.attr(opts.opposedBy, oInfo.attr), skillName: oInfo.label, skill: os.rank, mods: [...this.conditionMods(opts.opposedBy), ...(opts.opposedMods || [])] });
      result.opponent = opts.opposedBy;
    } else {
      result = resolveCheck(this.rng, { attributeName: attrName, attribute, skillName: info.label, skill: s.rank, mods, tn: opts.tn, forceRoll: opts.forceRoll });
    }
    result.skill = skill;
    result.label = label;
    result.actor = actorId;
    result.degreeLabel = DEGREE_LABEL[result.degree];
    const r = this.db.prepare(`INSERT INTO rolls(turn_id, time, actor_id, label, kind, tn, bonus, dice, total, margin, degree, mods, probability, rng_counter, opponent)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(this.turnId, this._time, actorId, label, result.kind, result.tn, result.bonus,
      J.str(result.dice ? [...result.dice, ...(result.opponentDice || [])] : null), result.total, result.margin, result.degree,
      J.str(result.mods.concat(result.opponentMods || [])), J.str(result.probability), result.rngCounter, result.opponent || null);
    result.rollId = Number(r.lastInsertRowid);
    if (!opts.noXp && result.dice) {
      const tnForXp = result.kind === 'opposed' ? result.tn : opts.tn;
      const xp = practiceXp({ attribute, rank: s.rank, tn: tnForXp, degree: result.degree, dailyXp: this._dailyXp(actorId, skill) });
      if (xp > 0) result.xp = this.gainXp(actorId, skill, xp, 'practice', 0, label);
    }
    return result;
  }

  _dailyXp(charId, skill) {
    const s = this.skill(charId, skill);
    return s.daily_day === this.day ? s.daily_xp : 0;
  }

  /** Add XP (already scaled) to a skill. Returns {xp, rankBefore, rankAfter}. */
  gainXp(charId, skill, xp, method, minutes = 0, note = null, { cap = 10 } = {}) {
    const s = this.skill(charId, skill);
    const capXp = xpForRank(cap) + (cap >= 10 ? 0 : xpForRank(cap + 1) - xpForRank(cap) - 0.01);
    let gained = Math.max(0, Math.min(xp, Math.max(0, capXp - s.xp)));
    gained = round2(gained);
    const newXp = round2(s.xp + gained);
    const rank = rankForXp(newXp);
    const daily = (s.daily_day === this.day ? s.daily_xp : 0) + gained;
    this.db.prepare(`INSERT INTO skills(character_id, skill, xp, rank, daily_xp, daily_day) VALUES (?,?,?,?,?,?)
      ON CONFLICT(character_id, skill) DO UPDATE SET xp=excluded.xp, rank=excluded.rank, daily_xp=excluded.daily_xp, daily_day=excluded.daily_day`)
      .run(charId, skill, newXp, rank, daily, this.day);
    if (gained > 0) this.db.prepare('INSERT INTO training_log(time, character_id, skill, method, minutes, xp, note) VALUES (?,?,?,?,?,?,?)').run(this._time, charId, skill, method, minutes, gained, note);
    if (rank > s.rank && charId === this.playerId) {
      this.recordEvent({ kind: 'skill_rank', actor: charId, summary: `${this.char(charId).name} reached rank ${rank} in ${this.rules.skills[skill].label}.`, visibility: 'private', importance: 5, data: { skill, rank } });
      this.journal('consequence', `Skill improved: ${this.rules.skills[skill].label} ${rank}`, `Your ${this.rules.skills[skill].label.toLowerCase()} has improved to rank ${rank}.`, `rank:${skill}:${rank}`);
    }
    return { xp: gained, rankBefore: s.rank, rankAfter: rank, capped: gained < xp };
  }

  dailyDiminishing(charId, skill) {
    return diminishing(this._dailyXp(charId, skill));
  }

  // ---------- events & witnesses ----------
  /**
   * Record an authoritative event and give memories to everyone who could perceive it.
   * visibility: public (everyone present + news), witnessed (present characters),
   *             private (actor & target only), secret (actor only).
   * `witnesses` overrides who perceived it (e.g. after stealth checks).
   */
  recordEvent({ kind, actor = null, target = null, location = undefined, summary, data = {}, visibility = 'witnessed', importance = 3, witnesses = null, memory = null, valence = 0, topic = '', cause = null }) {
    const loc = location === undefined ? (actor ? this.char(actor)?.location_id : null) : location;
    const r = this.db.prepare(`INSERT INTO events(turn_id, time, kind, actor_id, target_id, location_id, summary, data, visibility, importance, cause_id)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(this.turnId, this._time, kind, actor, target, loc, summary, J.str(data), visibility, importance, cause);
    const eventId = Number(r.lastInsertRowid);
    let perceivers;
    if (witnesses) perceivers = new Set(witnesses);
    else if (visibility === 'secret') perceivers = new Set(actor ? [actor] : []);
    else if (visibility === 'private') perceivers = new Set([actor, target].filter(Boolean));
    else perceivers = new Set([actor, target, ...(loc ? this.charactersAt(loc).map((c) => c.id) : [])].filter(Boolean));
    const participants = [actor, target].filter(Boolean);
    for (const pid of perceivers) {
      const c = this.char(pid);
      if (!c || !c.alive) continue;
      const involved = participants.includes(pid);
      if (!involved && importance < 2) continue;
      const text = typeof memory === 'function' ? memory(pid) : memory || summary;
      if (!text) continue;
      addMemory(this.db, {
        ownerId: pid, time: this._time, eventId, summary: text, participants, locationId: loc,
        importance: involved ? importance : Math.max(1, importance - 1), valence: involved ? valence : valence / 2,
        topic: [kind, topic].filter(Boolean).join(' '), source: involved ? 'experienced' : 'witnessed',
      });
    }
    const involvesPlayer = actor === this.playerId || target === this.playerId;
    if (importance >= 4 && !involvesPlayer && (perceivers.has(this.playerId) || visibility === 'public')) {
      this.digest.push({ eventId, time: this._time, kind, summary, importance });
    }
    return { eventId, witnesses: [...perceivers] };
  }

  journal(kind, title, body, ref = null, status = 'open') {
    if (ref) {
      const prev = this.db.prepare('SELECT id FROM journal WHERE kind=? AND ref=?').get(kind, ref);
      if (prev) {
        this.db.prepare('UPDATE journal SET title=?, body=?, status=?, time=? WHERE id=?').run(title, body, status, this._time, prev.id);
        return prev.id;
      }
    }
    return Number(this.db.prepare('INSERT INTO journal(time, kind, title, body, status, ref) VALUES (?,?,?,?,?,?)').run(this._time, kind, title, body, status, ref).lastInsertRowid);
  }
  closeJournal(kind, ref, status = 'done') {
    this.db.prepare('UPDATE journal SET status=? WHERE kind=? AND ref=?').run(status, kind, ref);
  }

  learnFact(holderId, factId, opts = {}) {
    const res = learn(this.db, holderId, factId, { time: this._time, ...opts });
    if ((res.isNew || res.upgraded) && holderId === this.playerId) {
      const f = this.db.prepare('SELECT content, data FROM facts WHERE id=?').get(factId);
      const reveal = J.parse(f.data, {}).reveals_location;
      if (reveal && res.isNew) this.journal('discovery', `Learned of ${this.location(reveal).name}`, f.content, `loc:${reveal}`);
    }
    if (holderId !== this.playerId && (res.isNew || res.upgraded)) this._npcLearned?.(holderId, factId, res.record);
    return res;
  }

  rel(from, to) { return getRel(this.db, from, to); }
  adjustRel(from, to, deltas, reason, eventId) { return adjustRel(this.ctx, from, to, deltas, reason, eventId); }

  // ---------- money & items wrappers (bound to current turn context) ----------
  pay(from, to, amount, memo, kind = 'payment', idem = null) { return ledger.transfer(this.ctx, { from, to, amount, memo, kind, idem }); }
  mint(to, amount, memo) { return ledger.mint(this.ctx, { to, amount, memo }); }
  burn(from, amount, memo) { return ledger.burn(this.ctx, { from, amount, memo }); }
  held(charId) { return inv.listHeld(this.db, 'character', charId); }
  count(charId, typeId, opts) { return inv.countHeld(this.db, 'character', charId, typeId, opts); }
  itemType(id) { return inv.itemType(this.db, id); }
  carryCapacity(charId) {
    const packs = this.db.prepare(`SELECT t.data FROM items i JOIN item_types t ON t.id=i.type_id WHERE i.holder_kind='character' AND i.holder_id=? AND t.category='container'`).all(charId);
    const extra = packs.length ? Math.max(...packs.map((p) => J.parse(p.data, {}).capacity || 0)) : 0;
    return 30 + this.attr(charId, 'might') * 10 + extra;
  }

  // ---------- needs ----------
  addFatigue(charId, amount) {
    const c = this.char(charId);
    this.updateChar(charId, { fatigue: clamp(Math.round(c.fatigue + amount), 0, 100) });
  }
  hurt(charId, amount, cause) {
    const c = this.char(charId);
    const health = clamp(c.health - amount, 0, 100);
    this.updateChar(charId, { health });
    if (health === 0 && c.alive) {
      this.updateChar(charId, { alive: 0 });
      this.recordEvent({ kind: 'death', actor: charId, summary: `${c.name} died (${cause}).`, visibility: 'public', importance: 9 });
    }
    return health;
  }
  heal(charId, amount) {
    const c = this.char(charId);
    this.updateChar(charId, { health: clamp(c.health + amount, 0, 100) });
  }

  /** Advance time, running the world simulation for every hour and day crossed. */
  advance(minutes, activity = 'idle') {
    if (minutes <= 0) return;
    const sim = this._sim;
    const end = this._time + Math.round(minutes);
    while (this._time < end) {
      const nextHour = (Math.floor(this._time / 60) + 1) * 60;
      const step = Math.min(nextHour, end) - this._time;
      const before = this._time;
      this._time += step;
      if (sim) {
        if (Math.floor(before / 60) !== Math.floor(this._time / 60)) sim.hourly(this);
        if (Math.floor(before / MINUTES_PER_DAY) !== Math.floor(this._time / MINUTES_PER_DAY)) sim.daily(this);
      }
    }
  }
  attachSim(sim) { this._sim = sim; }
  takeDigest() { const d = this.digest; this.digest = []; return d; }
}

export { RuleError };
