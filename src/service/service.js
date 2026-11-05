// GameService: the single API used by the desktop app (via IPC), the dev web server
// and the CLI. Owns save files, the AI runtime, and turn orchestration.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { Game } from '../engine/game.js';
import { attach, getFlags } from '../engine/sim.js';
import { executeTurn, needsConfirmation, createPlan, getPlan, cancelPlan, setNarration } from '../engine/turn.js';
import { backupTo, integrityCheck, J, openDatabase } from '../engine/db.js';
import { reconcile, recentTransactions } from '../engine/ledger.js';
import { conservationCheck } from '../engine/inventory.js';
import { retrieveMemories, memoryStats } from '../engine/memory.js';
import { knownFacts } from '../engine/knowledge.js';
import { attitudeLabel, disposition } from '../engine/relationships.js';
import { marketPrice, priceTrend } from '../engine/economy.js';
import { businessesOf, premisesList } from '../engine/business.js';
import { SKILLS, ATTRIBUTES, ATTRIBUTE_INFO, RANK_TITLES, xpForRank, MINUTES_PER_DAY } from '../engine/rules.js';
import { loadWorldDef } from '../engine/game.js';
import { CREATION_POINTS } from '../engine/worldgen.js';
import { GameMaster } from '../ai/gm.js';
import { LocalLLM, findModels, MODEL_PROFILES } from '../ai/llm.js';
import { normalizeInterpretation } from '../ai/schema.js';

const AUTOSAVE_EVERY = 8;
const AUTOSAVE_KEEP = 5;

export function defaultDataDir() {
  if (process.env.SATURN_HOME) return process.env.SATURN_HOME;
  if (process.platform === 'win32') return path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'SATURN');
  return path.join(os.homedir(), '.saturn');
}

export class GameService {
  constructor({ dataDir = defaultDataDir(), modelDirs = [], log = (...a) => console.log('[saturn]', ...a), aiEnabled = true } = {}) {
    this.dataDir = dataDir;
    this.savesDir = path.join(dataDir, 'saves');
    this.modelDirs = modelDirs;
    this.log = log;
    fs.mkdirSync(this.savesDir, { recursive: true });
    this.settingsFile = path.join(dataDir, 'settings.json');
    this.settings = { modelProfile: 'standard', aiEnabled, fastPath: true, showInspector: false, gpu: 'auto', textScale: 1, ...this._readSettings() };
    if (!aiEnabled) this.settings.aiEnabled = false;
    this.game = null;
    this.saveId = null;
    this.llm = null;
    this.gm = new GameMaster({ log });
    this.aiStatus = { state: 'off', message: 'AI not started' };
    this.busy = false;
    this._abort = null;
    this.turnsSinceAutosave = 0;
  }

  _readSettings() {
    try { return JSON.parse(fs.readFileSync(this.settingsFile, 'utf8')); } catch { return {}; }
  }
  saveSettings(patch = {}) {
    const prevProfile = this.settings.modelProfile;
    const prevAi = this.settings.aiEnabled;
    this.settings = { ...this.settings, ...patch };
    fs.writeFileSync(this.settingsFile, JSON.stringify(this.settings, null, 2));
    this.gm.useFastPath = this.settings.fastPath;
    if (patch.modelProfile && patch.modelProfile !== prevProfile && this.settings.aiEnabled) this.startAI(true);
    if (patch.aiEnabled === false && prevAi) this.stopAI();
    if (patch.aiEnabled === true && !prevAi) this.startAI();
    return this.settings;
  }

  // ---------------- AI runtime ----------------
  availableModels() {
    return findModels(this.modelDirs);
  }

  async startAI(force = false) {
    if (!this.settings.aiEnabled) { this.aiStatus = { state: 'off', message: 'AI disabled in settings; using the offline parser.' }; return; }
    if (this.llm && !force && ['ready', 'loading'].includes(this.llm.state)) return;
    if (this.llm) await this.stopAI();
    const models = this.availableModels();
    const profile = MODEL_PROFILES.find((p) => p.id === this.settings.modelProfile) || MODEL_PROFILES[1];
    const pick = models.find((m) => m.file === profile.file) || models.find((m) => m.profile === 'standard') || models.find((m) => m.profile) || models[0];
    if (!pick) { this.aiStatus = { state: 'missing', message: 'No local model found. Playing with the offline parser and template narration.' }; return; }
    this.llm = new LocalLLM({ modelPath: pick.path, contextSize: profile.contextSize, gpu: this.settings.gpu, log: this.log });
    this.gm.llm = this.llm;
    this.gm.useFastPath = this.settings.fastPath;
    this.aiStatus = { state: 'loading', message: `Loading ${pick.file}…`, progress: 0, model: pick.file };
    try {
      await this.llm.load((p) => { this.aiStatus.progress = p; });
      this.aiStatus = { state: 'ready', message: `${pick.file} on ${this.llm.info.gpu}`, model: pick.file, info: this.llm.info };
    } catch (e) {
      this.aiStatus = { state: 'error', message: `Model failed to load: ${String(e.message).slice(0, 200)}. Using the offline parser.` };
      this.log('AI load failed', e);
    }
  }

  async stopAI() {
    if (this.llm) await this.llm.dispose();
    this.llm = null;
    this.gm.llm = null;
    this.aiStatus = { state: 'off', message: 'AI stopped' };
  }

  cancel() {
    this._abort?.abort();
  }

  // ---------------- saves ----------------
  _saveDir(id) { return path.join(this.savesDir, id); }
  _saveFile(id) { return path.join(this._saveDir(id), 'world.saturn'); }

  listSaves() {
    const out = [];
    for (const id of fs.readdirSync(this.savesDir)) {
      const f = this._saveFile(id);
      if (!fs.existsSync(f)) continue;
      try {
        const db = openDatabase(f, { readonly: true });
        const meta = Object.fromEntries(db.prepare("SELECT key, value FROM meta WHERE key IN ('save_name','time','player_name','created_real','last_played')").all().map((r) => [r.key, JSON.parse(r.value)]));
        const turns = db.prepare('SELECT COUNT(*) n FROM turns').get().n;
        db.close();
        out.push({ id, name: meta.save_name || id, player: meta.player_name, turns, lastPlayed: meta.last_played || meta.created_real, size: fs.statSync(f).size });
      } catch (e) {
        out.push({ id, name: id, error: `unreadable: ${e.message}` });
      }
    }
    return out.sort((a, b) => String(b.lastPlayed).localeCompare(String(a.lastPlayed)));
  }

  creationOptions() {
    const def = loadWorldDef('saltwind');
    return { backgrounds: def.backgrounds.map((b) => ({ id: b.id, name: b.name, description: b.description, attributes: b.attributes, skills: b.skills, money: b.money, debt: b.debt || null })), attributes: ATTRIBUTES.map((a) => ({ id: a, info: ATTRIBUTE_INFO[a] })), points: CREATION_POINTS, world: { name: def.name, tagline: def.tagline, intro: def.intro } };
  }

  newGame({ name, background, allocation, seed, saveName } = {}) {
    this.closeGame();
    const id = `w${Date.now().toString(36)}`;
    fs.mkdirSync(this._saveDir(id), { recursive: true });
    const game = Game.create(this._saveFile(id), { seed: seed ?? undefined, player: { name, background, allocation } });
    attach(game);
    game.transact(() => {
      game.db.prepare("INSERT OR REPLACE INTO meta(key,value) VALUES('save_name',?)").run(JSON.stringify(saveName || `${game.player().name} of Brindlemarch`));
      game.db.prepare("INSERT OR REPLACE INTO meta(key,value) VALUES('player_name',?)").run(JSON.stringify(game.player().name));
    });
    this.game = game;
    this.saveId = id;
    return { id, intro: game.def.intro, state: this.state() };
  }

  loadGame(id) {
    this.closeGame();
    const f = this._saveFile(id);
    const db = openDatabase(f);
    const ok = integrityCheck(db);
    db.close();
    if (ok !== 'ok') throw new Error(`Save is damaged (${ok}). Restore a backup from the saves menu.`);
    this.game = attach(Game.open(f));
    this.saveId = id;
    // mark any turn that was open when the game last closed as aborted (it never committed)
    this.game.db.prepare("UPDATE turns SET status='aborted' WHERE status='open'").run();
    return { id, state: this.state() };
  }

  closeGame() {
    if (this.game) {
      try { this._touch(); this.game.close(); } catch (e) { this.log('close error', e.message); }
    }
    this.game = null;
    this.saveId = null;
  }

  _touch() {
    this.game?.db.prepare("INSERT OR REPLACE INTO meta(key,value) VALUES('last_played',?)").run(JSON.stringify(new Date().toISOString()));
  }

  deleteSave(id) {
    if (id === this.saveId) this.closeGame();
    fs.rmSync(this._saveDir(id), { recursive: true, force: true });
  }

  async snapshot(label = 'manual') {
    if (!this.game) throw new Error('No game loaded');
    const slot = `${label.replace(/[^a-z0-9_-]/gi, '_').slice(0, 30)}-${new Date().toISOString().replace(/[:.]/g, '-')}.saturn`;
    const dest = path.join(this._saveDir(this.saveId), 'backups', slot);
    await backupTo(this.game.db, dest);
    if (label === 'auto') this._rotate();
    return { file: dest, name: slot };
  }

  _rotate() {
    const dir = path.join(this._saveDir(this.saveId), 'backups');
    const autos = fs.readdirSync(dir).filter((f) => f.startsWith('auto-')).sort();
    while (autos.length > AUTOSAVE_KEEP) fs.rmSync(path.join(dir, autos.shift()));
  }

  listSnapshots(id = this.saveId) {
    const dir = path.join(this._saveDir(id), 'backups');
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir).filter((f) => f.endsWith('.saturn')).sort().reverse().map((f) => ({ name: f, size: fs.statSync(path.join(dir, f)).size }));
  }

  restoreSnapshot(id, name) {
    const src = path.join(this._saveDir(id), 'backups', path.basename(name));
    if (!fs.existsSync(src)) throw new Error('No such backup');
    if (id === this.saveId) this.closeGame();
    const f = this._saveFile(id);
    for (const ext of ['', '-wal', '-shm']) fs.rmSync(f + ext, { force: true });
    fs.copyFileSync(src, f);
    return this.loadGame(id);
  }

  async exportSave(dest) {
    if (!this.game) throw new Error('No game loaded');
    await backupTo(this.game.db, dest);
    return dest;
  }

  importSave(src) {
    const db = openDatabase(src, { readonly: true });
    const ok = integrityCheck(db);
    const isSaturn = !!db.prepare("SELECT 1 FROM sqlite_master WHERE name='meta'").get() && !!db.prepare("SELECT 1 FROM meta WHERE key='world_def'").get();
    db.close();
    if (ok !== 'ok' || !isSaturn) throw new Error('That file is not a valid SATURN save.');
    const id = `w${Date.now().toString(36)}`;
    fs.mkdirSync(this._saveDir(id), { recursive: true });
    fs.copyFileSync(src, this._saveFile(id));
    return { id };
  }

  // ---------------- play ----------------
  /**
   * Interpret and (unless it needs confirmation) execute one player input.
   */
  async act(text, { onStage } = {}) {
    if (!this.game) throw new Error('No game loaded');
    if (this.busy) throw new Error('Still resolving the previous action');
    this.busy = true;
    this._abort = new AbortController();
    const signal = this._abort.signal;
    try {
      if (!this.game.player().alive) return { kind: 'dead', narration: 'Your story has ended. Load an earlier save or begin anew.' };
      onStage?.('interpreting');
      const ir = await this.gm.interpret(this.game, text, { signal, onProgress: (n) => onStage?.('interpreting', n) });
      const interp = ir.interp;
      if (interp.mode === 'clarify' || interp.mode === 'impossible' || interp.mode === 'meta' || !interp.actions.length) {
        const msg = interp.mode === 'impossible' ? (interp.reason || 'That is not possible here.') : (interp.question || interp.reason || 'Could you say that another way?');
        this._logNonTurn(text, interp, ir.source, msg);
        return { kind: interp.mode === 'impossible' ? 'impossible' : 'clarify', narration: msg, interpretation: interp, source: ir.source, debug: ir.debug, state: this.state() };
      }
      if (needsConfirmation(interp)) {
        const plan = this.game.transact(() => createPlan(this.game, text, interp, ir.source));
        return { kind: 'plan', planId: plan.planId, preview: plan.preview, interpretation: interp, source: ir.source, narration: `Plan: ${plan.preview.title}. Review the steps and confirm.`, state: this.state() };
      }
      return await this._execute(text, interp, ir.source, null, signal, onStage, ir.debug);
    } finally {
      this.busy = false;
      this._abort = null;
    }
  }

  async confirmPlan(planId, { onStage } = {}) {
    if (this.busy) throw new Error('Busy');
    const plan = getPlan(this.game, planId);
    if (!plan || plan.status !== 'pending') throw new Error('That plan is no longer pending.');
    this.busy = true;
    this._abort = new AbortController();
    try {
      const norm = normalizeInterpretation(plan.data.interp);
      if (!norm.ok) throw new Error('Stored plan failed validation');
      this.game.db.prepare("UPDATE plans SET status='confirmed' WHERE id=?").run(planId);
      return await this._execute(plan.data.input, norm.value, plan.data.source, planId, this._abort.signal, onStage);
    } finally {
      this.busy = false;
      this._abort = null;
    }
  }

  cancelPlan(planId) {
    cancelPlan(this.game, planId);
    return { state: this.state() };
  }

  async _execute(text, interp, source, planId, signal, onStage, debug) {
    onStage?.('resolving');
    const result = executeTurn(this.game, { input: text, interp, source, planId });
    onStage?.('narrating');
    let narr;
    try {
      narr = await this.gm.narrate(this.game, text, result, { signal });
    } catch (e) {
      const { templateNarration } = await import('../ai/narrator.js');
      narr = { text: templateNarration(this.game, text, result), source: 'template-after-error' };
    }
    setNarration(this.game, result.turnId, narr.text);
    this.turnsSinceAutosave++;
    if (this.turnsSinceAutosave >= AUTOSAVE_EVERY) {
      this.turnsSinceAutosave = 0;
      this.snapshot('auto').catch((e) => this.log('autosave failed', e.message));
    }
    this._touch();
    return {
      kind: 'turn', turnId: result.turnId, narration: narr.text, narrationSource: narr.source, source, interpretation: interp,
      outcomes: result.outcomes.map(publicOutcome), changes: result.changes, digest: result.digest, debug, state: this.state(),
    };
  }

  _logNonTurn(text, interp, source, msg) {
    this.game.db.prepare("INSERT INTO turns(time_before, time_after, input, interpretation, source, narration, status, created_real) VALUES (?,?,?,?,?,?,?,?)")
      .run(this.game.time, this.game.time, String(text).slice(0, 2000), J.str(interp), source, msg, 'clarify', new Date().toISOString());
  }

  // ---------------- views ----------------
  state() {
    const g = this.game;
    if (!g) return null;
    const p = g.player();
    const loc = g.location(p.location_id);
    const cal = g.calendar();
    const people = g.charactersAt(loc.id, { excludeId: p.id }).filter((c) => c.kind === 'npc').map((c) => {
      const rel = g.rel(c.id, p.id);
      const def = g.npcDef(c.id) || {};
      return { id: c.id, name: c.name, role: c.role, attitude: attitudeLabel(rel), disposition: disposition(rel), met: rel.familiarity > 0, jailed: !!c.data.jailed,
        offers: [def.shop ? 'trade' : null, def.job ? 'work' : null, def.teaches ? 'lessons' : null, def.lends ? 'loans' : null, def.healing ? 'healing' : null, def.lodging ? 'lodging' : null].filter(Boolean) };
    });
    const items = g.held(p.id).map((i) => ({ id: i.id, type: i.type_id, name: i.name, qty: i.quantity, category: i.category, weight: i.weight, value: i.base_value, equipped: i.equipped, slot: i.slot, owner: i.owner_id === p.id ? null : (g.char(i.owner_id)?.name || i.owner_id), stolen: !!i.stolen }));
    const settlement = loc.settlement;
    const skills = Object.entries(SKILLS).map(([id, info]) => {
      const s = g.skill(p.id, id);
      return { id, label: info.label, attr: info.attr, group: info.group, rank: s.rank, xp: s.xp, next: xpForRank(Math.min(10, s.rank + 1)), title: RANK_TITLES[s.rank], trained: !!info.trained, desc: info.desc };
    });
    const contracts = g.db.prepare("SELECT * FROM contracts WHERE party_b=? OR party_a=? ORDER BY id DESC").all(p.id, p.id).filter((c) => c.status !== 'offered' || J.parse(c.data, {}).known)
      .map((c) => ({ id: c.id, kind: c.kind, title: c.title, status: c.status, with: g.char(c.party_a)?.name || c.party_a, due: c.due_at ? g.calendar(c.due_at).short : null, terms: J.parse(c.terms, {}) }));
    const businesses = businessesOf(g, p.id).map((b) => ({ id: b.id, name: b.name, kind: b.kind, status: b.status, location: g.location(b.location_id).name, cash: g.balance(b.id), efficiency: b.data.efficiency, staff: b.data.staff, stats: b.data.stats, history: b.data.history, lastLog: b.data.last_log, commodity: b.data.commodity, trip: b.data.trip, investor: b.data.investor ? { name: g.char(b.data.investor.npc).name, share: b.data.investor.share } : null }));
    const commodities = g.def.item_types.filter((t) => t.commodity).map((t) => ({ id: t.id, name: t.name, brindlemarch: marketPrice(g, 'brindlemarch', t.id), kestrel: marketPrice(g, 'kestrel', t.id), trend: priceTrend(g, settlement || 'brindlemarch', t.id, 21).map((r) => r.price) }));
    const relationships = g.db.prepare("SELECT * FROM relationships WHERE to_id=? AND familiarity>0").all(p.id).map((r) => {
      const c = g.char(r.from_id);
      return { id: r.from_id, name: c.name, role: c.role, attitude: attitudeLabel(r), disposition: disposition(r), trust: r.trust, affection: r.affection, respect: r.respect, fear: r.fear, rivalry: r.rivalry, familiarity: r.familiarity, location: g.location(c.location_id)?.name, alive: !!c.alive,
        recent: g.db.prepare('SELECT dim, delta, reason, time FROM relationship_log WHERE from_id=? AND to_id=? ORDER BY id DESC LIMIT 4').all(r.from_id, p.id).map((x) => ({ ...x, when: g.calendar(x.time).short })) };
    }).sort((a, b) => b.familiarity - a.familiarity);
    const journal = g.db.prepare("SELECT * FROM journal ORDER BY (status='open') DESC, time DESC LIMIT 80").all().map((j) => ({ ...j, when: g.calendar(j.time).short }));
    const knowledge = knownFacts(g.db, p.id).map((f) => ({ id: f.fact_id, content: f.content, belief: f.belief, confidence: Math.round(f.confidence * 100), source: f.source }));
    const visible = new Set();
    const mapLocs = g.db.prepare('SELECT id, name, settlement, kind, x, y, data FROM locations').all().filter((l) => g.knowsLocation(p.id, l.id)).map((l) => { visible.add(l.id); return { id: l.id, name: l.name, settlement: l.settlement, kind: l.kind, x: l.x, y: l.y, here: l.id === loc.id, visited: (p.data.visited || []).includes(l.id) }; });
    const routes = g.db.prepare('SELECT from_id, to_id, minutes, mode FROM routes WHERE from_id < to_id').all().filter((r) => visible.has(r.from_id) && visible.has(r.to_id));
    const factions = g.db.prepare('SELECT * FROM factions').all().map((f) => ({ id: f.id, name: f.name, description: f.description, reputation: g.db.prepare('SELECT value FROM reputation WHERE faction_id=? AND character_id=?').get(f.id, p.id)?.value ?? 0, members: g.db.prepare('SELECT c.name, m.rank FROM faction_members m JOIN characters c ON c.id=m.character_id WHERE m.faction_id=?').all(f.id).filter((m) => relationships.some((r) => r.name === m.name)) }));
    const history = g.db.prepare(`SELECT DISTINCT e.id, e.time, e.kind, e.summary, e.importance FROM events e
      LEFT JOIN memories m ON m.event_id = e.id AND m.owner_id = ?
      WHERE (m.id IS NOT NULL OR e.visibility='public') AND e.importance >= 2 ORDER BY e.id DESC LIMIT 60`).all(p.id).map((e) => ({ ...e, when: g.calendar(e.time).short }));
    const log = g.db.prepare("SELECT id, input, narration, status, source FROM turns WHERE status IN ('committed','clarify') ORDER BY id DESC LIMIT 30").all().reverse();
    const pendingPlans = g.db.prepare("SELECT id, data FROM plans WHERE status='pending' ORDER BY id DESC LIMIT 3").all().map((r) => ({ id: r.id, preview: J.parse(r.data, {}).preview }));
    const hungry = g.time - p.last_meal;
    return {
      saveId: this.saveId, world: { name: g.def.name },
      time: { ...cal, label: cal.label },
      player: { name: p.name, background: p.role, health: p.health, fatigue: p.fatigue, money: g.balance(p.id), alive: !!p.alive, attributes: p.attributes, hunger: hungry > 3 * MINUTES_PER_DAY ? 'starving' : hungry > MINUTES_PER_DAY ? 'hungry' : hungry > 12 * 60 ? 'peckish' : 'fed', carry: { weight: Math.round(items.reduce((s, i) => s + i.weight * i.qty, 0) * 10) / 10, capacity: g.carryCapacity(p.id) } },
      location: { id: loc.id, name: loc.name, description: loc.description, art: loc.art, settlement: settlement ? g.def.settlements.find((s) => s.id === settlement)?.name : 'The wilds', tags: loc.tags, exits: g.exits(loc.id), people },
      inventory: items, skills, contracts, businesses, premises: premisesList(g), commodities, relationships, journal, knowledge,
      map: { locations: mapLocs, routes }, factions, history, log, pendingPlans, flags: getFlags(g),
      ledger: recentTransactions(g.db, p.id, 25).map((t) => ({ ...t, when: g.calendar(t.time).short })),
      ai: this.aiStatus, settings: this.settings,
    };
  }

  inspectTurn(turnId) {
    const g = this.game;
    const t = g.db.prepare('SELECT * FROM turns WHERE id=?').get(turnId);
    if (!t) return null;
    const rolls = g.db.prepare('SELECT * FROM rolls WHERE turn_id=? ORDER BY id').all(turnId).map((r) => ({ ...r, dice: J.parse(r.dice, null), mods: J.parse(r.mods, []), probability: J.parse(r.probability, {}), opponent: r.opponent ? g.char(r.opponent)?.name : null }));
    const events = g.db.prepare('SELECT id, kind, summary, visibility, importance FROM events WHERE turn_id=? ORDER BY id').all(turnId);
    const ledger = g.db.prepare('SELECT t.memo, t.kind, e.account_id, e.amount FROM ledger_tx t JOIN ledger_entries e ON e.tx_id=t.id WHERE t.turn_id=? ORDER BY t.id').all(turnId);
    const items = g.db.prepare('SELECT type_id, delta, reason, from_holder, to_holder, memo FROM item_log WHERE turn_id=? ORDER BY id').all(turnId);
    return { turn: { ...t, interpretation: J.parse(t.interpretation, null), outcome: J.parse(t.outcome, null) }, rolls, events, ledger, items };
  }

  inspectMemory(ownerId, query = '') {
    const g = this.game;
    const r = retrieveMemories(g.db, { ownerId, now: g.time, text: query, participants: ownerId === g.playerId ? [] : [g.playerId], limit: 12 });
    return { owner: g.char(ownerId)?.name, stats: memoryStats(g.db, ownerId), ...r, memories: r.memories.map((m) => ({ ...m, when: g.calendar(m.time).short })), knowledge: knownFacts(g.db, ownerId).map((f) => ({ content: f.content, belief: f.belief, confidence: f.confidence, truth: !!f.truth, source: f.source })), decisions: g.db.prepare('SELECT * FROM npc_decisions WHERE npc_id=? ORDER BY id DESC LIMIT 15').all(ownerId).map((d) => ({ ...d, reasons: J.parse(d.reasons, []), when: g.calendar(d.time).short })) };
  }

  integrity() {
    const g = this.game;
    return { sqlite: integrityCheck(g.db), ledger: reconcile(g.db), items: conservationCheck(g.db) };
  }
}

function publicOutcome(o) {
  const { dialogue, ...rest } = o;
  return { ...rest, rolls: (o.rolls || []).map((r) => ({ label: r.label, degree: r.degree, degreeLabel: r.degreeLabel, tn: r.tn, bonus: r.bonus, dice: r.dice, total: r.total, margin: r.margin, mods: r.mods, opponentMods: r.opponentMods, opponentDice: r.opponentDice, opponentTotal: r.opponentTotal, probability: r.probability, kind: r.kind, classification: r.classification })), dialogue: dialogue ? { npc: dialogue.npc, npcName: dialogue.npcName, attitude: dialogue.attitude, disclosed: dialogue.disclosed, unknown: dialogue.unknown, refused: dialogue.refused, memories: dialogue.memories } : null };
}
