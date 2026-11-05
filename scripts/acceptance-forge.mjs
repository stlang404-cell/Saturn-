#!/usr/bin/env node
// World Forge acceptance (directive §16), with the REAL local model, offline.
//   unshare -n sh -c 'ip link set lo up; node scripts/acceptance-forge.mjs [spec.json | --forge "<description>"]'
// Uses a spec forged by the real model (data/forge-samples/floating.spec.json by default),
// or forges one now with --forge. Then plays through the GameService exactly as the UI does.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { GameService } from '../src/service/service.js';
import { reconcile } from '../src/engine/ledger.js';
import { conservationCheck } from '../src/engine/inventory.js';
import { activeRules } from '../src/engine/worldrules.js';

const args = process.argv.slice(2);
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'saturn-accept-'));
const svc = new GameService({ dataDir: home, log: () => {} });
const log = (...a) => console.log(...a);
const check = (cond, msg) => { log(`${cond ? 'PASS' : 'FAIL'}  ${msg}`); if (!cond) process.exitCode = 1; };

log(`offline check: ${await fetch('https://huggingface.co').then(() => 'NETWORK REACHABLE').catch(() => 'no network (expected)')}`);
await svc.startAI();
log(`AI: ${svc.aiStatus.message}`);
let ref;
if (args[0] === '--forge') {
  svc.forgeStart({ description: args.slice(1).join(' ') });
  let last = '';
  while (svc.forgeStatus().state === 'running') { const s = svc.forgeStatus(); if (s.label !== last) { last = s.label; log(`  forging: ${s.label} (${s.seconds}s)`); } await new Promise((r) => setTimeout(r, 2000)); }
  const st = svc.forgeStatus();
  check(st.state === 'done', `world forged from the description (${st.seconds}s) ${st.error || ''}`);
  ref = svc.forgeSave().ref;
} else {
  const spec = JSON.parse(fs.readFileSync(args[0] || 'data/forge-samples/floating.spec.json', 'utf8'));
  ref = svc.saveWorldSpec(spec).ref;
}
const spec = svc.worldSpec(ref);
log(`\nWORLD: ${spec.name} — ${spec.tagline}\n${spec.premise}`);
check(spec.skills.length >= 12, `world-specific skills: ${spec.skills.map((s) => s.label).join(', ')}`);
check(spec.item_types.length >= 12, `resources & items: ${spec.item_types.slice(0, 8).map((i) => i.name).join(', ')}…`);
check(spec.factions.length >= 3 && spec.npcs.length >= 7, `institutions: ${spec.factions.map((f) => f.name).join(', ')}`);

const opts = svc.creationOptions(ref);
const bg = opts.backgrounds[0];
log(`starting background: ${bg.name} — ${bg.description} (${bg.money} ${opts.currency.plural})`);
const ng = svc.newGame({ name: 'Ren', background: bg.id, worldRef: ref, seed: 16 });
const g = () => svc.game;
const money0 = ng.state.player.money;
check(ng.state.location && ng.state.location.people.length >= 0, `entered the world at ${ng.state.location.name}`);

async function act(text, { confirm = true } = {}) {
  const t0 = Date.now();
  let r = await svc.act(text);
  if (r.kind === 'plan' && confirm) { log(`  [plan] ${r.preview.title}: ${r.preview.steps.map((s) => s.action.type).join(' → ')}`); r = await svc.confirmPlan(r.planId); }
  const secs = ((Date.now() - t0) / 1000).toFixed(0);
  log(`\n> ${text}   (${r.kind}, ${r.source || ''}, ${secs}s)\n${String(r.narration).slice(0, 700)}`);
  for (const o of r.outcomes || []) for (const roll of o.rolls || []) log(`  ⚄ ${roll.label}: ${roll.degreeLabel}${roll.dice ? ` (${roll.dice.join('+')}+${roll.bonus}=${roll.total} vs ${roll.tn})` : ''}`);
  for (const o of r.outcomes || []) if (o.status === 'blocked') log(`  ✕ ${o.type}: ${o.error.message}`);
  return r;
}

const people = ng.state.location.people;
await act('I look around and take in where I am.');
const firstNpc = people[0]?.name || svc.game.def.npcs[0].name;
const talk = await act(`I introduce myself to ${firstNpc} and ask what work an apprentice engineer could find here.`);
check(talk.kind === 'turn', 'free-text conversation resolved');
const buy = await act('I buy something cheap to eat and eat it.');
check(buy.kind === 'turn' || buy.kind === 'plan', 'commerce attempted with world currency');
const memAfter = g().db.prepare('SELECT COUNT(*) n FROM memories WHERE owner_id<>?').get('player').n;
check(memAfter > 0, `NPCs remember the interaction (${memAfter} NPC memories)`);

// Research gravity-crystal technology: first find out who teaches engineering, study, then research
const teacher = svc.game.def.npcs.find((n) => (n.teaches || []).some(([s]) => s === g().rules.roles.invent || s === g().rules.roles.research));
if (teacher) {
  await act(`I go to find ${teacher.name}.`);
  await act(`I spend two weeks studying ${g().rules.skills[teacher.teaches[0][0]].label} with ${teacher.name}.`);
}
const invSkill = g().rules.roles.invent;
g().transact(() => { g().mint('player', 300, 'acceptance-test grant (stands in for months of wages)'); });
const before = g().skill('player', invSkill).rank;
await act(`I research how the gravity crystals actually work, studying them methodically for many hours.`);
// A flying machine is revolutionary: the engine should refuse it until the character is qualified
const early = await act('I attempt to invent a flying machine powered by gravity crystals.');
const refused = (early.outcomes || []).some((o) => o.status === 'blocked' && /rank|lack|needs/.test(o.error.message)) || early.kind !== 'turn';
check(refused || before >= 5, `an under-qualified attempt is not simply granted (${(early.outcomes || []).map((o) => o.error?.message || o.summary).join(' | ')})`);
// Qualify through time: months of mentoring/practice are simulated by raising rank via XP the engine records
g().transact(() => g().gainXp('player', invSkill, 300, 'mentor', 60 * 600, 'acceptance: months of apprenticeship'));
log(`\n(${g().rules.skills[invSkill].label} is now rank ${g().skill('player', invSkill).rank} after recorded months of training)`);
let designed = null;
for (let i = 0; i < 14 && !designed; i++) {
  const r = await act(i === 0 ? 'I begin designing a flying machine powered by gravity crystals, working long hours in a workshop.' : 'I keep working on the flying machine.');
  designed = activeRules(g()).find((x) => x.origin === 'player');
  if (!designed) await act('I rest for eight hours.');
}
check(!!designed, `the invention became a persistent world capability: ${designed ? `${designed.name} — ${designed.spec.summary}` : 'none'}`);
if (designed) {
  const proj = g().db.prepare("SELECT * FROM projects WHERE status='completed' ORDER BY id DESC").get();
  const pdata = JSON.parse(proj.data);
  check(pdata.designer === 'ai', `designed by the local AI and validated by the engine (designer: ${pdata.designer})`);
  check(g().db.prepare('SELECT COUNT(*) n FROM world_rule_revisions WHERE rule_id=? AND cause_event_id IS NOT NULL').get(designed.id).n === 1, 'rule revision recorded with its causing event');
  const dest = g().def.locations.find((l) => l.settlement && l.settlement !== g().location(g().player().location_id).settlement)?.name;
  await act(`I use ${designed.name}${designed.spec.effects.success.some((e) => e.type === 'travel') ? ` to fly to ${dest}` : ''}.`);
  // let the world respond: news spreads, skilled NPCs may adopt it
  g().transact(() => { const n = g().def.npcs.find((x) => (x.agendas || []).some((a) => a.type === 'adopt_innovations')); if (n) g().learnFact(n.id, designed.spec.fact, { belief: 'rumor', confidence: 0.7, source: 'gossip', sourceId: 'player' }); });
  await act('I wait for thirty days and keep my ears open.');
  const adopters = g().db.prepare("SELECT holder_id FROM capabilities WHERE rule_id=? AND holder_id<>'player'").all(designed.id);
  const heard = g().db.prepare("SELECT COUNT(*) n FROM knowledge WHERE fact_id=? AND holder_id<>'player'").get(designed.spec.fact).n;
  check(heard > 0, `NPCs know of the invention (${heard} heard of it; ${adopters.length} adopted it: ${adopters.map((a) => g().char(a.holder_id).name).join(', ') || 'none yet'})`);
}
check(reconcile(g().db).length === 0 && conservationCheck(g().db).length === 0, 'ledger and inventory reconcile');
const snap = { t: g().time, m: g().balance('player'), rules: activeRules(g()).map((r) => `${r.id}@${r.version}`).join(','), items: g().held('player').map((i) => `${i.type_id}:${i.quantity}`).join(',') };
const saveId = svc.saveId;
svc.closeGame();
const re = svc.loadGame(saveId);
const snap2 = { t: g().time, m: g().balance('player'), rules: activeRules(g()).map((r) => `${r.id}@${r.version}`).join(','), items: g().held('player').map((i) => `${i.type_id}:${i.quantity}`).join(',') };
check(JSON.stringify(snap) === JSON.stringify(snap2), `saved, closed and reloaded intact (${re.state.world.name}, money ${snap2.m} vs start ${money0})`);
await act('I look around.');
svc.closeGame();
await svc.stopAI();
log(`\n${process.exitCode ? 'ACCEPTANCE FAILED' : 'ACCEPTANCE PASSED'} (home: ${home})`);
