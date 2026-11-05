#!/usr/bin/env node
// Terminal client for SATURN. Same engine and Game Master as the desktop app.
//   node src/cli/play.js [--no-ai] [--seed N] [--name Wren] [--background clerk] [--script file.txt]
import readline from 'node:readline';
import fs from 'node:fs';
import { GameService } from '../service/service.js';

const args = process.argv.slice(2);
const flag = (n) => args.includes(`--${n}`);
const opt = (n, d) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : d; };

const svc = new GameService({ aiEnabled: !flag('no-ai'), log: flag('verbose') ? (...a) => console.error('[saturn]', ...a) : () => {} });
const wrap = (s, w = 96) => String(s).split('\n').map((line) => line.replace(new RegExp(`(.{1,${w}})(\\s+|$)`, 'g'), '$1\n').trimEnd()).join('\n');
const C = { dim: (s) => `\x1b[2m${s}\x1b[0m`, gold: (s) => `\x1b[33m${s}\x1b[0m`, cyan: (s) => `\x1b[36m${s}\x1b[0m`, bold: (s) => `\x1b[1m${s}\x1b[0m` };

function header(st) {
  const p = st.player;
  console.log(C.dim(`── ${st.time.label} · ${st.location.name} · ${p.money}m · health ${p.health} · fatigue ${p.fatigue} · ${p.hunger} ──`));
  if (st.location.people.length) console.log(C.dim(`   here: ${st.location.people.map((x) => `${x.name} (${x.role}${x.offers.length ? '; ' + x.offers.join('/') : ''})`).join(', ')}`));
}

function showResult(r) {
  if (r.kind === 'plan') {
    console.log(C.gold(`\nPLAN: ${r.preview.title}`));
    r.preview.steps.forEach((s, i) => console.log(`  ${i + 1}. ${s.action.type} ${[s.action.target, s.action.destination, s.action.item, s.action.skill, s.action.days ? `${s.action.days} days` : null, s.action.hours ? `${s.action.hours}h` : null].filter(Boolean).join(' ')}${s.preview.feasible ? '' : ' ⚠ ' + s.preview.notes.join('; ')}`));
    if (r.preview.risks.length) console.log(C.dim(`  risks: ${r.preview.risks.join(' ')}`));
    if (r.preview.estimate) console.log(C.dim(`  ~${r.preview.estimate.days} days; living costs about ${r.preview.estimate.livingCost}m (you have ${r.preview.estimate.money}m)`));
    return;
  }
  console.log('\n' + wrap(r.narration) + '\n');
  if (r.kind === 'turn') {
    const c = r.changes;
    const bits = [];
    if (c.money) bits.push(`${c.money > 0 ? '+' : ''}${c.money}m`);
    for (const it of c.items) bits.push(`${it.delta > 0 ? '+' : ''}${it.delta} ${it.name}`);
    for (const s of c.skills) bits.push(`${s.skill} +${s.xp}xp${s.rankAfter > s.rankBefore ? ` → rank ${s.rankAfter}!` : ''}`);
    if (c.minutes) bits.push(`${c.minutes >= 1440 ? (c.minutes / 1440).toFixed(1) + ' days' : c.minutes >= 60 ? (c.minutes / 60).toFixed(1) + 'h' : c.minutes + 'min'}`);
    if (bits.length) console.log(C.cyan(`  [${bits.join(' · ')}]`));
    for (const o of r.outcomes) for (const roll of o.rolls || []) console.log(C.dim(`  ⚄ ${roll.label}: ${roll.degreeLabel}${roll.dice ? ` (${roll.dice.join('+')}${roll.bonus >= 0 ? '+' : ''}${roll.bonus}=${roll.total} vs ${roll.tn}; success chance ${Math.round(roll.probability.success * 100)}%)` : ''}`));
    console.log(C.dim(`  (${r.source}${r.narrationSource ? ' / ' + r.narrationSource : ''})`));
  }
}

async function main() {
  if (!flag('no-ai')) { process.stdout.write('Loading local AI… '); await svc.startAI(); console.log(svc.aiStatus.message); }
  const saves = svc.listSaves();
  const load = opt('load');
  if (load) svc.loadGame(load);
  else if (flag('continue') && saves.length) svc.loadGame(saves[0].id);
  else {
    const r = svc.newGame({ name: opt('name', 'Wren'), background: opt('background', 'clerk'), seed: opt('seed') ? Number(opt('seed')) : undefined });
    console.log(C.bold('\nSATURN — The Living World\n'));
    console.log(wrap(r.intro) + '\n');
  }
  header(svc.state());
  const script = opt('script');
  const lines = script ? fs.readFileSync(script, 'utf8').split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#')) : null;
  const rl = script ? null : readline.createInterface({ input: process.stdin, output: process.stdout });
  const ask = (q) => (script ? Promise.resolve(lines.shift() ?? '/quit').then((l) => { console.log(q + l); return l; }) : new Promise((res) => rl.question(q, res)));
  while (true) {
    const line = (await ask(C.gold('> '))).trim();
    if (!line) continue;
    if (line === '/quit' || line === '/exit') break;
    if (line === '/save') { const s = await svc.snapshot('manual'); console.log(`saved ${s.name}`); continue; }
    if (line === '/integrity') { console.log(JSON.stringify(svc.integrity())); continue; }
    if (line.startsWith('/inspect')) { const st = svc.state(); const last = st.log.at(-1); console.log(JSON.stringify(svc.inspectTurn(last.id), null, 1).slice(0, 4000)); continue; }
    if (line.startsWith('/memory')) { const [, who, ...q] = line.split(' '); console.log(JSON.stringify(svc.inspectMemory(who || 'player', q.join(' ')), null, 1).slice(0, 4000)); continue; }
    if (line === '/journal') { for (const j of svc.state().journal.filter((x) => x.status === 'open')) console.log(`• [${j.kind}] ${j.title}: ${j.body}`); continue; }
    if (line === '/inv') { for (const i of svc.state().inventory) console.log(`• ${i.qty} × ${i.name}${i.equipped ? ' (equipped)' : ''}${i.owner ? ` (${i.owner}'s)` : ''}`); continue; }
    try {
      let lastStage = '';
      let r = await svc.act(line, { onStage: (s) => { if (s !== lastStage) { lastStage = s; process.stdout.write(C.dim(`\r  …${s}      `)); } } });
      process.stdout.write('\r');
      if (r.kind === 'plan') {
        showResult(r);
        const yn = (await ask('Confirm plan? (y/n) ')).trim().toLowerCase();
        if (yn.startsWith('y')) r = await svc.confirmPlan(r.planId);
        else { svc.cancelPlan(r.planId); console.log('Plan cancelled.'); continue; }
      }
      showResult(r);
      header(r.state || svc.state());
    } catch (e) {
      console.log('Error:', e.message);
      if (flag('verbose')) console.error(e);
    }
  }
  svc.closeGame();
  await svc.stopAI();
  rl?.close();
}

main().catch((e) => { console.error(e); process.exit(1); });
