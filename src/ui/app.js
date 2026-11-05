// SATURN UI. Renders only values taken from the authoritative state returned by
// the engine; nothing displayed is computed or invented on the client.
import { sceneSVG, portraitSVG, LOGO } from './art.js';

// ---------------------------------------------------------------- bridge
const bridge = window.saturn?.call
  ? window.saturn.call
  : async (method, ...args) => {
    const r = await fetch('/api', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ method, args }) });
    const j = await r.json();
    if (!j.ok) throw new Error(j.error);
    return j.result;
  };
const isDesktop = !!window.saturn?.call;

// ---------------------------------------------------------------- utils
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const $ = (sel, root = document) => root.querySelector(sel);
const fmtMin = (m) => (m >= 1440 ? `${(m / 1440).toFixed(m % 1440 ? 1 : 0)} days` : m >= 60 ? `${(m / 60).toFixed(m % 60 ? 1 : 0)} h` : `${m} min`);
const pct = (x) => `${Math.round((x || 0) * 100)}%`;
function toast(msg) {
  const t = document.createElement('div');
  t.className = 'toast';
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 2800);
}

// ---------------------------------------------------------------- store
const S = {
  screen: 'title', st: null, entries: [], busy: false, stage: '', tab: 'world', history: [], histIdx: -1,
  creation: null, saves: [], ai: null, lastResult: null, memQuery: '',
};

const TABS = [
  ['world', 'World'], ['character', 'Character'], ['skills', 'Skills'], ['inventory', 'Inventory'], ['equipment', 'Equipment'],
  ['economy', 'Economy'], ['relationships', 'Relationships'], ['journal', 'Journal'], ['map', 'Map'], ['factions', 'Factions'],
  ['history', 'History'], ['settings', 'Settings'],
];

// ---------------------------------------------------------------- title & creation
async function showTitle() {
  S.screen = 'title';
  [S.saves, S.ai] = await Promise.all([bridge('listSaves'), bridge('aiStatus')]);
  render();
}

function renderTitle() {
  const ai = S.ai || {};
  return `<div class="title-screen"><div class="title-wrap">
    <div class="hero">${sceneSVG('square', 'evening', 'title')}<div class="over"><h1>SATURN</h1><div class="tag">The Living World — a persistent simulation beneath the Great Ring.</div></div></div>
    <div class="title-actions">
      <div class="card"><h3>Begin a new life</h3><p class="muted serif">Arrive in Brindlemarch with a few marks and a past. The world will not wait for you.</p>
        <button class="btn primary" data-act="create">New journey</button></div>
      <div class="card saves"><h3>Continue</h3>${S.saves.length ? S.saves.map((s) => `<div class="save"><div><div>${esc(s.name)}</div><div class="faint" style="font-size:.8em">${s.error ? esc(s.error) : `${s.turns} turns · ${esc((s.lastPlayed || '').slice(0, 16).replace('T', ' '))}`}</div></div>
        <div class="row"><button class="btn small" data-load="${esc(s.id)}" ${s.error ? 'disabled' : ''}>Load</button><button class="btn small ghost" data-del="${esc(s.id)}" title="Delete">✕</button></div></div>`).join('') : '<p class="faint">No saved worlds yet.</p>'}</div>
    </div>
    <p class="faint" style="margin-top:14px;font-size:.82em">Local AI: ${esc(ai.state || 'unknown')} — ${esc(ai.message || '')}. Fully offline: no accounts, no network.</p>
  </div></div>`;
}

async function startCreation() {
  const opts = await bridge('creationOptions');
  S.creation = { opts, name: '', bg: opts.backgrounds[0].id, alloc: Object.fromEntries(opts.attributes.map((a) => [a.id, 0])) };
  S.screen = 'create';
  render();
}

function renderCreation() {
  const c = S.creation;
  const bg = c.opts.backgrounds.find((b) => b.id === c.bg);
  const spent = Object.values(c.alloc).reduce((s, v) => s + v, 0);
  const left = c.opts.points - spent;
  const attrRows = c.opts.attributes.map((a) => {
    const base = 2 + (bg.attributes[a.id] || 0);
    const val = base + c.alloc[a.id];
    return `<div class="attr-row"><b style="text-transform:capitalize">${esc(a.id)}</b><span class="rank">${val}</span>
      <button class="btn small" data-attr="${a.id}" data-d="-1" ${c.alloc[a.id] <= 0 ? 'disabled' : ''} aria-label="decrease ${a.id}">−</button>
      <button class="btn small" data-attr="${a.id}" data-d="1" ${left <= 0 || val >= 5 ? 'disabled' : ''} aria-label="increase ${a.id}">+</button>
      <span class="faint" style="font-size:.82em">${esc(a.info)}</span></div>`;
  }).join('');
  return `<div class="title-screen"><div class="title-wrap card" style="padding:22px">
    <h2 style="margin-top:0">Who arrives in Brindlemarch?</h2>
    <div class="row" style="margin-bottom:12px"><label for="cname">Name</label><input id="cname" type="text" maxlength="40" placeholder="Wren" value="${esc(c.name)}" style="width:240px"></div>
    <h3>Background</h3><div class="bg-grid">${c.opts.backgrounds.map((b) => `<button class="bg-card" data-bg="${b.id}" aria-pressed="${b.id === c.bg}">
      <div class="n">${esc(b.name)}</div><div class="d">${esc(b.description)}</div>
      <div class="faint" style="font-size:.78em">${Object.entries(b.skills).map(([k, v]) => `${k.replace(/_/g, ' ')} ${v}`).join(', ')} · ${b.money} marks${b.debt ? ` · owes ${b.debt.amount}` : ''}</div></button>`).join('')}</div>
    <h3>Attributes <span class="chip gold">${left} point${left === 1 ? '' : 's'} to spend</span></h3>${attrRows}
    <div class="row" style="margin-top:16px;justify-content:flex-end"><button class="btn ghost" data-act="title">Back</button><button class="btn primary" data-act="begin">Begin</button></div>
  </div></div>`;
}

async function beginGame() {
  const c = S.creation;
  const name = ($('#cname')?.value || '').trim() || 'Wren';
  setBusy(true, 'Creating the world…');
  try {
    const r = await bridge('newGame', { name, background: c.bg, allocation: c.alloc });
    S.st = r.state;
    S.entries = [{ kind: 'intro', narration: r.intro }];
    S.screen = 'game';
  } catch (e) { toast(e.message); }
  setBusy(false);
  render();
  focusInput();
}

async function loadGame(id) {
  setBusy(true, 'Loading…');
  try {
    const r = await bridge('loadGame', id);
    S.st = r.state;
    S.entries = [{ kind: 'intro', narration: `You return to ${r.state.world.name}. ${r.state.time.label}.` }, ...r.state.log.map((l) => ({ kind: l.status === 'clarify' ? 'clarify' : 'turn', input: l.input, narration: l.narration, turnId: l.id }))];
    S.screen = 'game';
  } catch (e) { toast(e.message); }
  setBusy(false);
  render();
  focusInput();
}

// ---------------------------------------------------------------- play
function setBusy(b, stage = '') {
  S.busy = b;
  S.stage = stage;
  const st = $('#stage');
  if (st) st.innerHTML = b ? `<div class="spinner"></div><span>${esc(stage)}</span><button class="btn small ghost" data-act="cancel">Cancel (Esc)</button>` : '';
  const send = $('#send');
  if (send) send.disabled = b;
}

let aiPoll = null;
function pollAI() {
  clearInterval(aiPoll);
  aiPoll = setInterval(async () => {
    try {
      S.ai = await bridge('aiStatus');
      const pill = $('#aipill');
      if (pill) pill.outerHTML = aiPill();
      if (S.ai.state !== 'loading') clearInterval(aiPoll);
    } catch { /* ignore */ }
  }, 1500);
}

async function submit(text) {
  text = text.trim();
  if (!text || S.busy) return;
  S.history.push(text);
  S.histIdx = -1;
  setBusy(true, S.st?.ai?.state === 'ready' ? 'The Game Master considers your intent…' : 'Interpreting…');
  try {
    const r = await bridge('act', text);
    handleResult(text, r);
  } catch (e) {
    S.entries.push({ kind: 'clarify', input: text, narration: `Something went wrong: ${e.message}` });
  }
  setBusy(false);
  renderGame();
  focusInput();
}

function handleResult(text, r) {
  S.lastResult = r;
  if (r.state) S.st = r.state;
  if (r.kind === 'plan') S.entries.push({ kind: 'plan', input: text, planId: r.planId, preview: r.preview, source: r.source });
  else if (r.kind === 'turn') S.entries.push({ kind: 'turn', input: text, narration: r.narration, changes: r.changes, outcomes: r.outcomes, turnId: r.turnId, source: r.source, nsource: r.narrationSource, digest: r.digest, debug: r.debug });
  else S.entries.push({ kind: 'clarify', input: text, narration: r.narration, source: r.source });
}

async function confirmPlan(id) {
  if (S.busy) return;
  const entry = S.entries.find((e) => e.planId === id);
  if (entry) entry.resolved = 'confirmed';
  setBusy(true, 'Carrying out your plan… the world moves on around you.');
  try {
    const r = await bridge('confirmPlan', id);
    handleResult(entry?.input || 'plan', r);
  } catch (e) { toast(e.message); }
  setBusy(false);
  renderGame();
}

async function cancelPlan(id) {
  const entry = S.entries.find((e) => e.planId === id);
  if (entry) entry.resolved = 'cancelled';
  const r = await bridge('cancelPlan', id);
  if (r?.state) S.st = r.state;
  renderGame();
}

function focusInput() { setTimeout(() => $('#input')?.focus(), 30); }

// ---------------------------------------------------------------- game rendering
function aiPill() {
  const ai = S.ai || S.st?.ai || {};
  const cls = ai.state === 'ready' ? 'good' : ai.state === 'loading' ? 'gold' : ai.state === 'error' ? 'bad' : '';
  const label = ai.state === 'ready' ? 'Local AI ready' : ai.state === 'loading' ? `Loading AI ${ai.progress ? pct(ai.progress) : ''}` : ai.state === 'missing' ? 'Offline parser (no model)' : ai.state === 'error' ? 'AI error — offline parser' : 'Offline parser';
  return `<span id="aipill" class="chip ${cls}" title="${esc(ai.message || '')}">${esc(label)}</span>`;
}

function renderTop() {
  const st = S.st, p = st.player;
  return `<div class="topbar">
    <div class="brand">${LOGO}<span>SATURN</span></div>
    <div class="stat"><span class="label">${esc(st.time.season)} · ${esc(st.time.block)}</span><span class="value">${esc(st.time.label)}</span></div>
    <div class="stat"><span class="label">Location</span><span class="value">${esc(st.location.name)}</span></div>
    <div class="stat"><span class="label">Purse</span><span class="value" style="color:var(--gold2)">${p.money} marks</span></div>
    <div class="stat" title="Health"><span class="label">Health ${p.health}</span><div class="bar"><i style="width:${p.health}%;background:${p.health < 40 ? 'var(--bad)' : 'var(--good)'}"></i></div></div>
    <div class="stat" title="Fatigue"><span class="label">Fatigue ${p.fatigue}</span><div class="bar fat"><i style="width:${p.fatigue}%"></i></div></div>
    <span class="chip ${p.hunger === 'fed' ? '' : 'bad'}">${esc(p.hunger)}</span>
    <div class="grow"></div>${aiPill()}
    <button class="btn small" data-act="save" title="Save a snapshot (Ctrl+S)">Save</button>
    <button class="btn small ghost" data-act="menu">Menu</button>
  </div>`;
}

function renderScene() {
  const st = S.st, l = st.location;
  return `<div class="scene-art">${sceneSVG(l.art || 'square', st.time.block, l.id)}<div class="scene-title"><h2>${esc(l.name)}</h2><div class="sub">${esc(l.settlement)}</div></div></div>
  <div class="scene-body">
    <div class="scene-desc">${esc(l.description)}</div>
    <h3>People here</h3>${l.people.length ? l.people.map((c) => `<button class="person" data-say="talk to ${esc(c.name)}" title="Talk to ${esc(c.name)}">${portraitSVG(c.name)}<div class="grow"><div class="name">${esc(c.name)}${c.jailed ? ' <span class="chip bad">in a cell</span>' : ''}</div><div class="role">${esc(c.role)}</div>
      <div class="row" style="flex-wrap:wrap;gap:4px;margin-top:3px"><span class="chip ${c.disposition > 10 ? 'good' : c.disposition < -10 ? 'bad' : ''}">${esc(c.met ? c.attitude : 'stranger')}</span>${c.offers.map((o) => `<span class="chip">${esc(o)}</span>`).join('')}</div></div></button>`).join('') : '<p class="faint">Nobody of note is here.</p>'}
    <h3>Ways on</h3><div class="exits">${l.exits.map((e) => `<button class="btn small" data-say="go to ${esc(e.name)}">${esc(e.name)} <span class="faint">${fmtMin(e.minutes)}${e.cost ? ` · ${e.cost}m` : ''}</span></button>`).join('')}</div>
  </div>`;
}

function changeChips(c) {
  if (!c) return '';
  const chips = [];
  if (c.money) chips.push(`<span class="chip ${c.money > 0 ? 'good' : 'bad'}">${c.money > 0 ? '+' : ''}${c.money} marks</span>`);
  for (const it of c.items || []) chips.push(`<span class="chip ${it.delta > 0 ? 'good' : 'bad'}">${it.delta > 0 ? '+' : ''}${it.delta} ${esc(it.name)}</span>`);
  for (const s of c.skills || []) chips.push(`<span class="chip gold">${esc(s.skill.replace(/_/g, ' '))} +${s.xp} xp${s.rankAfter > s.rankBefore ? ` → rank ${s.rankAfter}` : ''}</span>`);
  if (c.health) chips.push(`<span class="chip ${c.health > 0 ? 'good' : 'bad'}">health ${c.health > 0 ? '+' : ''}${c.health}</span>`);
  if (c.minutes) chips.push(`<span class="chip">${fmtMin(c.minutes)}</span>`);
  if (c.moved) chips.push(`<span class="chip info">travelled</span>`);
  return chips.join('');
}

function rollChips(e) {
  const out = [];
  for (const o of e.outcomes || []) {
    for (const r of o.rolls || []) {
      const good = /success|critical|automatic/.test(r.degree) && r.degree !== 'partial';
      out.push(`<button class="chip ${good ? 'good' : r.degree === 'partial' ? 'gold' : 'bad'}" data-inspect="${e.turnId}" title="Show the check">⚄ ${esc(r.label)}: ${esc(r.degreeLabel)}${S.st.settings.showInspector && r.probability ? ` (${pct(r.probability.success)})` : ''}</button>`);
    }
    if (o.status === 'blocked') out.push(`<span class="chip bad">✕ ${esc(o.type)}: not possible</span>`);
  }
  return out.join('');
}

function renderEntry(e, i) {
  if (e.kind === 'intro') return `<div class="entry"><div class="narr intro">${esc(e.narration)}</div></div>`;
  if (e.kind === 'plan') {
    const p = e.preview;
    return `<div class="entry"><div class="you">${esc(e.input)}</div><div class="plan-card"><div class="t serif" style="font-size:1.1em;color:var(--gold2)">Plan: ${esc(p.title)}</div>
      <ol>${p.steps.map((s) => `<li>${esc(describeAction(s.action))}${s.preview.minutes ? ` <span class="faint">(~${fmtMin(s.preview.minutes)}${s.preview.cost ? `, ${s.preview.cost}m` : ''})</span>` : ''}${!s.preview.feasible ? ` <span class="chip bad">${esc(s.preview.notes.join('; '))}</span>` : ''}</li>`).join('')}</ol>
      ${p.risks?.length ? `<div class="muted" style="font-size:.88em">Risks: ${esc(p.risks.join(' '))}</div>` : ''}
      ${p.estimate ? `<div class="muted" style="font-size:.88em">About ${p.estimate.days} days. Living costs roughly ${p.estimate.livingCost} marks; you have ${p.estimate.money}.</div>` : ''}
      ${e.resolved ? `<div class="faint" style="margin-top:6px">${esc(e.resolved)}</div>` : `<div class="row" style="margin-top:10px"><button class="btn primary small" data-confirm="${e.planId}">Confirm plan</button><button class="btn small ghost" data-cancelplan="${e.planId}">Cancel</button></div>`}
    </div></div>`;
  }
  return `<div class="entry ${e.kind}">${e.input ? `<div class="you">${esc(e.input)}</div>` : ''}<div class="narr">${esc(e.narration)}</div>
    ${e.changes || e.outcomes ? `<div class="changes">${changeChips(e.changes)}${rollChips(e)}</div>` : ''}
    ${e.turnId ? `<div class="meta"><span>${esc(e.source || '')}${e.nsource ? ` · narration: ${esc(e.nsource)}` : ''}</span><button data-inspect="${e.turnId}">inspect</button></div>` : ''}</div>`;
}

function describeAction(a) {
  const bits = [a.type.replace(/_/g, ' ')];
  if (a.destination) bits.push(`to ${a.destination}`);
  if (a.target) bits.push(a.type === 'move' ? `to ${a.target}` : `· ${a.target}`);
  if (a.item) bits.push(`· ${a.item}`);
  if (a.skill) bits.push(`· ${a.skill.replace(/_/g, ' ')}`);
  if (a.topic) bits.push(`· “${a.topic}”`);
  if (a.days) bits.push(`for ${a.days} days`);
  if (a.hours) bits.push(`for ${a.hours} h`);
  if (a.price) bits.push(`· ${a.price}m`);
  if (a.quantity && a.quantity > 1) bits.push(`× ${a.quantity}`);
  return bits.join(' ');
}

const SUGGESTIONS = ['look around', 'ask about the bread prices', 'ask for work', 'study medicine for 3 days', 'investigate', 'rest 8 hours'];

function renderStory() {
  return `<div class="story"><div class="log" id="log">${S.entries.map(renderEntry).join('')}</div>
    <div class="composer"><div class="stage" id="stage"></div>
      <form id="composer"><textarea id="input" rows="1" placeholder="What do you do? Describe it in your own words…" aria-label="Your action"></textarea><button class="btn primary" id="send" type="submit">Act</button></form>
      <div class="hint"><span>Enter to act · Shift+Enter newline · ↑ recall · Esc cancel</span>${SUGGESTIONS.map((s) => `<button data-fill="${esc(s)}">${esc(s)}</button>`).join('')}</div></div></div>`;
}

// ---------------------------------------------------------------- tabs
function spark(values, w = 70, h = 18) {
  if (!values || values.length < 2) return '';
  const min = Math.min(...values), max = Math.max(...values), span = max - min || 1;
  const pts = values.map((v, i) => `${(i / (values.length - 1)) * w},${h - ((v - min) / span) * (h - 2) - 1}`).join(' ');
  const up = values.at(-1) > values[0];
  return `<svg class="spark" width="${w}" height="${h}" aria-hidden="true"><polyline points="${pts}" fill="none" stroke="${up ? '#e07a6a' : '#7bc49a'}" stroke-width="1.5"/></svg>`;
}

function relBar(label, v, min = -100) {
  const left = min < 0 ? 50 : 0;
  const w = min < 0 ? Math.abs(v) / 2 : v;
  const start = min < 0 ? (v >= 0 ? 50 : 50 - w) : 0;
  return `<div class="relbar"><span>${label}</span><div class="track"><i style="left:${start}%;width:${w}%;background:${v >= 0 ? (label === 'fear' || label === 'rivalry' ? 'var(--bad)' : 'var(--good)') : 'var(--bad)'}"></i>${min < 0 ? `<i style="left:${left}%;width:1px;background:#555"></i>` : ''}</div><span class="num">${v}</span></div>`;
}

const TAB_RENDER = {
  world(st) {
    const open = st.journal.filter((j) => j.status === 'open');
    const opp = open.filter((j) => j.kind === 'opportunity');
    const cons = st.journal.filter((j) => j.kind === 'consequence').slice(0, 5);
    const plans = open.filter((j) => j.kind === 'plan');
    return `<h3>Opportunities</h3>${opp.length ? opp.map((j) => `<div class="card"><div class="t">${esc(j.title)}</div><div class="b">${esc(j.body)}</div></div>`).join('') : '<p class="faint">None known yet. Talk to people.</p>'}
      <h3>Ongoing</h3>${plans.length ? plans.map((j) => `<div class="card"><div class="t">${esc(j.title)}</div><div class="b">${esc(j.body)}</div></div>`).join('') : '<p class="faint">Nothing in progress.</p>'}
      <h3>Recent consequences</h3>${cons.length ? cons.map((j) => `<div class="card"><div class="t">${esc(j.title)} <span class="faint" style="font-size:.8em">${esc(j.when)}</span></div><div class="b">${esc(j.body)}</div></div>`).join('') : '<p class="faint">None yet.</p>'}
      <h3>Recent events you know of</h3>${st.history.slice(0, 6).map((h) => `<div class="card"><div class="b"><span class="faint">${esc(h.when)}</span> — ${esc(h.summary)}</div></div>`).join('')}`;
  },
  character(st) {
    const p = st.player;
    return `<div class="row">${portraitSVG(p.name, 56)}<div><div class="serif" style="font-size:1.3em">${esc(p.name)}</div><div class="muted">${esc(p.background)}</div></div></div>
      <h3>Attributes</h3><table class="grid">${Object.entries(p.attributes).map(([k, v]) => `<tr><td style="text-transform:capitalize">${esc(k)}</td><td class="num rank">${v}</td></tr>`).join('')}</table>
      <h3>Condition</h3><table class="grid"><tr><td>Health</td><td class="num">${p.health}/100</td></tr><tr><td>Fatigue</td><td class="num">${p.fatigue}/100</td></tr><tr><td>Hunger</td><td class="num">${esc(p.hunger)}</td></tr><tr><td>Load</td><td class="num">${p.carry.weight} / ${p.carry.capacity}</td></tr><tr><td>Purse</td><td class="num">${p.money} marks</td></tr></table>
      <h3>What you know</h3>${st.knowledge.length ? st.knowledge.map((k) => `<div class="card"><div class="b">${esc(k.content)}</div><div class="faint" style="font-size:.78em;margin-top:3px">${esc(k.belief)} · ${k.confidence}% sure · ${esc(k.source)}</div></div>`).join('') : '<p class="faint">Nothing yet.</p>'}`;
  },
  skills(st) {
    const groups = {};
    for (const s of st.skills) (groups[s.group] = groups[s.group] || []).push(s);
    return Object.entries(groups).map(([g, list]) => `<h3 style="text-transform:capitalize">${esc(g)}</h3>${list.map((s) => {
      const prev = s.rank === 0 ? 0 : 8 * s.rank * s.rank + 12 * s.rank;
      const frac = s.rank >= 10 ? 1 : (s.xp - prev) / Math.max(1, s.next - prev);
      return `<div class="skill"><div><b>${esc(s.label)}</b> <span class="faint" style="font-size:.8em">(${esc(s.attr)}${s.trained ? ', specialist' : ''})</span><div class="faint" style="font-size:.78em">${esc(s.desc)}</div></div><div class="num"><span class="rank">${s.rank}</span> <span class="faint" style="font-size:.78em">${esc(s.title)}</span></div><div class="xpbar"><i style="width:${Math.max(0, Math.min(1, frac)) * 100}%"></i></div><div class="faint" style="font-size:.72em;grid-column:1/-1">${Math.round(s.xp * 10) / 10} / ${s.next} xp</div></div>`;
    }).join('')}`).join('') + `<p class="faint" style="font-size:.8em">Skills improve through real use against meaningful difficulty, study (books, mentors), drills and experimentation. Each method has limits; easy tasks teach nothing, and learning slows when you repeat the same thing all day.</p>`;
  },
  inventory(st) {
    const inv = st.inventory.filter((i) => !i.equipped);
    return `<div class="muted" style="font-size:.85em">Carrying ${st.player.carry.weight} of ${st.player.carry.capacity} weight · ${st.player.money} marks</div>
      <table class="grid" style="margin-top:6px"><tr><th>Item</th><th class="num">Qty</th><th class="num">Value</th><th></th></tr>${inv.map((i) => `<tr><td>${esc(i.name)}${i.owner ? ` <span class="chip ${i.stolen ? 'bad' : 'info'}" title="Legal owner">${i.stolen ? 'stolen from ' : 'belongs to '}${esc(i.owner)}</span>` : ''}</td><td class="num">${i.qty}</td><td class="num">${i.value}</td><td>${i.slot ? `<button class="btn small" data-say="equip ${esc(i.name)}">equip</button>` : ''}${i.category === 'food' ? `<button class="btn small" data-say="eat ${esc(i.name)}">eat</button>` : ''}${i.category === 'book' ? `<button class="btn small" data-say="read ${esc(i.name)}">read</button>` : ''}</td></tr>`).join('') || '<tr><td colspan="4" class="faint">Nothing.</td></tr>'}</table>`;
  },
  equipment(st) {
    const eq = st.inventory.filter((i) => i.equipped);
    const slots = ['weapon', 'body', 'clothes', 'back'];
    return `<table class="grid"><tr><th>Slot</th><th>Item</th><th></th></tr>${slots.map((s) => { const it = eq.find((i) => i.equipped === s); return `<tr><td style="text-transform:capitalize">${s}</td><td>${it ? esc(it.name) : '<span class="faint">—</span>'}</td><td>${it ? `<button class="btn small" data-say="take off ${esc(it.name)}">remove</button>` : ''}</td></tr>`; }).join('')}</table>
      <p class="faint" style="font-size:.82em">Tools you carry (lantern, kits, ledgers, hammers) help automatically when relevant; equipped weapons and armour matter in a fight.</p>`;
  },
  economy(st) {
    const loans = st.contracts.filter((c) => c.kind === 'loan');
    return `<h3>Purse: ${st.player.money} marks</h3>
      <h3>Businesses</h3>${st.businesses.length ? st.businesses.map((b) => `<div class="card"><div class="t">${esc(b.name)} <span class="chip ${b.status === 'active' ? 'good' : 'bad'}">${esc(b.status)}</span></div><div class="b">${esc(b.kind.replace('_', ' '))} at ${esc(b.location)} · cash ${b.cash}m · efficiency ${pct(b.efficiency)} · staff ${b.staff}${b.commodity ? ` · trades ${esc(b.commodity)}` : ''}${b.trip ? ` · ${esc(b.trip.state)}` : ''}${b.investor ? ` · ${esc(b.investor.name)} holds ${pct(b.investor.share)}` : ''}</div>
        <div class="b">Revenue ${b.stats.revenue}m · costs ${b.stats.costs}m · produced ${b.stats.produced} · sold ${b.stats.sold}${b.lastLog?.length ? ` · last day: ${esc(b.lastLog.join(', '))}` : ''}</div>${b.history?.length ? `<div class="b">Weekly profit: ${b.history.map((h) => `<span class="${h.profit >= 0 ? 'pos' : 'neg'}">${h.profit}</span>`).join(' · ')}</div>` : ''}</div>`).join('') : '<p class="faint">You own no business. Premises available: ' + esc(st.premises.filter((p) => !p.taken).map((p) => `${p.name} (${p.rent}m/day)`).join('; ')) + '.</p>'}
      <h3>Contracts & debts</h3>${st.contracts.length ? `<table class="grid"><tr><th>Contract</th><th>Status</th><th>Due</th></tr>${st.contracts.map((c) => `<tr><td>${esc(c.title)}${c.kind === 'loan' && c.terms.owed != null ? ` <span class="faint">(${c.terms.owed}m owed)</span>` : ''}</td><td>${esc(c.status)}</td><td>${esc(c.due || '—')}</td></tr>`).join('')}</table>` : '<p class="faint">None.</p>'}
      ${loans.length ? '' : ''}
      <h3>Market prices</h3><table class="grid"><tr><th>Goods</th><th class="num">Brindlemarch</th><th class="num">Kestrel Pt</th><th>21-day trend</th></tr>${st.commodities.map((c) => `<tr><td>${esc(c.name)}</td><td class="num">${c.brindlemarch}</td><td class="num">${c.kestrel}</td><td>${spark(c.trend)}</td></tr>`).join('')}</table>
      <p class="faint" style="font-size:.78em">Prices emerge from merchants' real stock; merchants add a markup and buy below market.</p>
      <h3>Ledger</h3><table class="grid"><tr><th>When</th><th>Memo</th><th class="num">Amount</th></tr>${st.ledger.map((t) => `<tr><td class="faint">${esc(t.when)}</td><td>${esc(t.memo)}</td><td class="num ${t.amount >= 0 ? 'pos' : 'neg'}">${t.amount > 0 ? '+' : ''}${t.amount}</td></tr>`).join('')}</table>`;
  },
  relationships(st) {
    return st.relationships.length ? st.relationships.map((r) => `<div class="card"><div class="row">${portraitSVG(r.name, 34)}<div class="grow"><div class="t">${esc(r.name)} <span class="chip ${r.disposition > 10 ? 'good' : r.disposition < -10 ? 'bad' : ''}">${esc(r.attitude)}</span>${r.alive ? '' : ' <span class="chip bad">dead</span>'}</div><div class="b">${esc(r.role)} · now at ${esc(r.location || '?')}</div></div><button class="btn small ghost" data-mem="${esc(r.id)}" title="Memory inspector">memory</button></div>
      ${relBar('trust', r.trust)}${relBar('affection', r.affection)}${relBar('respect', r.respect)}${r.fear ? relBar('fear', r.fear, 0) : ''}${r.rivalry ? relBar('rivalry', r.rivalry, 0) : ''}
      ${r.recent.length ? `<div class="faint" style="font-size:.76em;margin-top:5px">${r.recent.map((x) => `${esc(x.when)}: ${x.delta > 0 ? '+' : ''}${x.delta} ${esc(x.dim)} (${esc(x.reason)})`).join('<br>')}</div>` : ''}</div>`).join('') : '<p class="faint">You have not met anyone yet.</p>';
  },
  journal(st) {
    const by = (k) => st.journal.filter((j) => j.kind === k);
    const sec = (k, title) => { const l = by(k); return l.length ? `<h3>${title}</h3>${l.map((j) => `<div class="card" style="${j.status !== 'open' ? 'opacity:.6' : ''}"><div class="t">${esc(j.title)} ${j.status !== 'open' ? `<span class="chip">${esc(j.status)}</span>` : ''}</div><div class="b">${esc(j.body)}</div><div class="faint" style="font-size:.75em">${esc(j.when)}</div></div>`).join('')}` : ''; };
    return sec('plan', 'Plans & obligations') + sec('opportunity', 'Opportunities') + sec('discovery', 'Discoveries') + sec('consequence', 'Consequences') + sec('note', 'Notes');
  },
  map(st) {
    const L = st.map.locations;
    const pos = Object.fromEntries(L.map((l) => [l.id, [l.x * 4, l.y * 3.2]]));
    const lines = st.map.routes.map((r) => `<line x1="${pos[r.from_id][0]}" y1="${pos[r.from_id][1]}" x2="${pos[r.to_id][0]}" y2="${pos[r.to_id][1]}" stroke="${r.mode === 'riverboat' ? '#4f7fae' : r.mode === 'road' ? '#7a6a4a' : '#3f4566'}" stroke-width="${r.mode === 'walk' ? 1.5 : 2.5}" ${r.mode !== 'walk' ? 'stroke-dasharray="5 4"' : ''}/>`).join('');
    const nodes = L.map((l) => `<g class="node" data-say="go to ${esc(l.name)}" tabindex="0" role="button" aria-label="Travel to ${esc(l.name)}"><circle cx="${pos[l.id][0]}" cy="${pos[l.id][1]}" r="${l.here ? 7 : 5}" fill="${l.here ? '#f3d58c' : l.visited ? '#8a96c8' : '#4a5070'}" stroke="#0d0f17" stroke-width="2"/><text x="${pos[l.id][0] + 8}" y="${pos[l.id][1] + 3}">${esc(l.name)}</text></g>`).join('');
    return `<div class="map"><svg viewBox="0 0 420 300"><path d="M240 330 Q 250 250 260 200 Q 280 160 330 250 Q 360 300 420 280" fill="none" stroke="#24406a" stroke-width="10" opacity="0.6"/>${lines}${nodes}</svg></div><p class="faint" style="font-size:.8em">Click a place to travel there. Dashed blue: riverboat; dashed brown: road. Places you have not heard of are not shown.</p>`;
  },
  factions(st) {
    return st.factions.map((f) => `<div class="card"><div class="t">${esc(f.name)} <span class="chip ${f.reputation > 10 ? 'good' : f.reputation < -10 ? 'bad' : ''}">standing ${f.reputation}</span></div><div class="b">${esc(f.description)}</div>${f.members.length ? `<div class="faint" style="font-size:.8em;margin-top:4px">Members you know: ${esc(f.members.map((m) => `${m.name} (${m.rank})`).join(', '))}</div>` : ''}</div>`).join('');
  },
  history(st) {
    return `<p class="faint" style="font-size:.82em">Events you witnessed, took part in, or that became public knowledge.</p>${st.history.map((h) => `<div class="card"><div class="b"><span class="faint">${esc(h.when)}</span> — ${esc(h.summary)}</div></div>`).join('') || '<p class="faint">History is yet to be written.</p>'}`;
  },
  settings(st) {
    const s = st.settings;
    const models = S.ai?.models || [];
    return `<h3>Local AI</h3><div class="card"><div class="b">${esc(st.ai.message || '')}</div>
      <label class="row" style="margin-top:8px"><input type="checkbox" data-setting="aiEnabled" ${s.aiEnabled ? 'checked' : ''}> Use the local language model</label>
      <label class="row" style="margin-top:6px">Profile <select data-setting="modelProfile">${['light', 'standard', 'high'].map((p) => `<option value="${p}" ${s.modelProfile === p ? 'selected' : ''}>${p}${models.some((m) => m.profile === p) ? '' : ' (model not installed)'}</option>`).join('')}</select></label>
      <label class="row" style="margin-top:6px"><input type="checkbox" data-setting="fastPath" ${s.fastPath ? 'checked' : ''}> Fast path for short, simple commands</label>
      <div class="faint" style="font-size:.78em;margin-top:6px">Installed models: ${esc(models.map((m) => `${m.file} (${(m.size / 1e9).toFixed(1)} GB)`).join(', ') || 'none')}</div></div>
      <h3>Display</h3><div class="card"><label class="row"><input type="checkbox" data-setting="showInspector" ${s.showInspector ? 'checked' : ''}> Show success chances on rolls</label>
      <label class="row" style="margin-top:6px">Text size <input type="range" min="0.85" max="1.35" step="0.05" value="${s.textScale}" data-setting="textScale"></label></div>
      <h3>Saves</h3><div class="card"><div class="row"><button class="btn small" data-act="save">Save snapshot now</button><button class="btn small" data-act="backups">Backups…</button><button class="btn small" data-act="integrity">Check integrity</button>${isDesktop ? '<button class="btn small" data-act="export">Export…</button>' : ''}</div>
      <div class="faint" style="font-size:.78em;margin-top:6px">The world saves itself after every action (each turn is an atomic database transaction). Rolling backups are taken every few turns.</div></div>`;
  },
};

function renderSide() {
  const st = S.st;
  return `<div class="tabs" role="tablist">${TABS.map(([id, label], i) => `<button class="tab" role="tab" aria-selected="${S.tab === id}" data-tab="${id}" title="Alt+${(i + 1) % 10}">${label}</button>`).join('')}</div>
    <div class="tabpanel" role="tabpanel">${TAB_RENDER[S.tab](st)}</div>`;
}

function renderGame() {
  if (S.screen !== 'game') return render();
  document.documentElement.style.setProperty('--scale', S.st.settings.textScale || 1);
  const app = $('#app');
  const keepInput = $('#input')?.value || '';
  const sideScroll = $('.side-col')?.scrollTop || 0;
  app.innerHTML = `<div class="shell">${renderTop()}<div class="main"><div class="col scene-col">${renderScene()}</div><div class="col story-col" style="overflow:hidden">${renderStory()}</div><div class="col side-col">${renderSide()}</div></div></div>`;
  $('#input').value = keepInput;
  $('.side-col').scrollTop = sideScroll;
  const log = $('#log');
  log.scrollTop = log.scrollHeight;
  setBusy(S.busy, S.stage);
}

function render() {
  const app = $('#app');
  if (S.screen === 'title') app.innerHTML = renderTitle();
  else if (S.screen === 'create') app.innerHTML = renderCreation();
  else renderGame();
}

// ---------------------------------------------------------------- modals
function modal(html) {
  $('#modal-root').innerHTML = `<div class="modal-back" data-close="1"><div class="modal" role="dialog" aria-modal="true">${html}<div class="row" style="justify-content:flex-end;margin-top:12px"><button class="btn" data-close="1">Close</button></div></div></div>`;
  $('.modal button[data-close]')?.focus();
}
function closeModal() { $('#modal-root').innerHTML = ''; }

function probBar(p) {
  const s = p.success || 0, part = (p.atLeastPartial || 0) - s;
  return `<div class="prob" title="success ${pct(s)}, partial ${pct(part)}"><i style="width:${s * 100}%;background:var(--good)"></i><i style="width:${part * 100}%;background:var(--warn)"></i><i style="flex:1;background:#5a2e2a"></i></div>`;
}

async function inspect(turnId) {
  const d = await bridge('inspectTurn', turnId);
  if (!d) return;
  const entry = S.entries.find((e) => e.turnId === turnId);
  const rolls = d.rolls.map((r) => `<div class="roll"><div class="row"><b class="grow">${esc(r.label)}</b><span class="chip">${esc(r.degree.replace('_', ' '))}</span></div>
    ${r.dice ? `<div class="dice">${r.kind === 'opposed' ? `You ${r.dice.slice(0, 2).join(' + ')} ${r.bonus >= 0 ? '+' : '−'} ${Math.abs(r.bonus)} = ${r.total} vs ${esc(r.opponent || 'opponent')} ${r.dice.slice(2).join(' + ')} → needs ${r.tn}` : `${r.dice.join(' + ')} ${r.bonus >= 0 ? '+' : '−'} ${Math.abs(r.bonus)} = ${r.total} vs target ${r.tn} (margin ${r.margin >= 0 ? '+' : ''}${r.margin})`}</div>` : `<div class="muted">No roll needed (${esc(r.degree)}).</div>`}
    <table class="grid">${r.mods.map((m) => `<tr><td>${esc(m.label)}</td><td class="num ${m.value >= 0 ? 'pos' : 'neg'}">${m.value >= 0 ? '+' : ''}${m.value}</td></tr>`).join('')}</table>
    ${probBar(r.probability)}<div class="faint" style="font-size:.78em">Chance before rolling: success ${pct(r.probability.success)}, at least partial ${pct(r.probability.atLeastPartial)}, critical ${pct(r.probability.critical)}, severe failure ${pct(r.probability.severe)}. RNG draw #${r.rng_counter ?? '—'}.</div></div>`).join('');
  const ledger = d.ledger.length ? `<table class="grid">${d.ledger.map((l) => `<tr><td>${esc(l.memo)}</td><td>${esc(l.account_id)}</td><td class="num ${l.amount >= 0 ? 'pos' : 'neg'}">${l.amount}</td></tr>`).join('')}</table>` : '<p class="faint">No money moved.</p>';
  const items = d.items.length ? `<table class="grid">${d.items.map((l) => `<tr><td>${esc(l.reason)}</td><td>${esc(l.type_id)} ×${l.delta}</td><td class="faint">${esc(l.from_holder || '—')} → ${esc(l.to_holder || '—')}</td></tr>`).join('')}</table>` : '<p class="faint">No items moved.</p>';
  const dbg = entry?.debug;
  modal(`<h2>Action inspector</h2><div class="muted">“${esc(d.turn.input)}” · interpreted by ${esc(d.turn.source)}</div>
    <h3>Checks</h3>${rolls || '<p class="faint">No checks this turn.</p>'}
    <h3>Ledger entries</h3>${ledger}<h3>Item log</h3>${items}
    <h3>Events recorded</h3>${d.events.map((e) => `<div class="card"><div class="b">[${esc(e.visibility)}, importance ${e.importance}] ${esc(e.summary)}</div></div>`).join('') || '<p class="faint">None.</p>'}
    <h3>Interpretation (validated proposal)</h3><pre class="json">${esc(JSON.stringify(d.turn.interpretation, null, 2))}</pre>
    ${dbg?.context ? `<h3>Context given to the model</h3><pre class="json">${esc(dbg.context)}</pre>` : ''}
    ${dbg?.memories?.memories?.length ? `<h3>Memories retrieved (player)</h3>${dbg.memories.memories.map((m) => `<div class="card"><div class="b">${esc(m.summary)}</div><div class="faint" style="font-size:.75em">score ${m.score} · ${esc(JSON.stringify(m.why))}</div></div>`).join('')}` : ''}
    ${dbg?.attempts?.length ? `<h3>Model attempts</h3><pre class="json">${esc(JSON.stringify(dbg.attempts.map((a) => ({ attempt: a.attempt, ok: a.ok, ms: a.ms, errors: a.errors })), null, 2))}</pre>` : ''}`);
}

async function memoryInspector(id, q = '') {
  const d = await bridge('inspectMemory', id, q);
  modal(`<h2>Memory inspector — ${esc(d.owner)}</h2>
    <form id="memq" class="row"><input type="text" id="memtext" value="${esc(q)}" placeholder="query (e.g. salt, promise, theft)" class="grow"><button class="btn small">Retrieve</button></form>
    <div class="faint" style="font-size:.8em;margin:6px 0">${d.stats.total} memories (${d.stats.active} active, ${d.stats.summaries || 0} summaries, ${d.stats.important || 0} important) · ${d.candidates} candidates scored · terms: ${esc(d.terms.join(', ') || '—')}</div>
    ${d.memories.map((m) => `<div class="card"><div class="b">${esc(m.summary)}</div><div class="faint" style="font-size:.75em">${esc(m.when)} · ${esc(m.kind)} · ${esc(m.source)} · importance ${m.importance} · score ${m.score} = recency ${m.why.recency} + importance ${m.why.importance} + participant ${m.why.participant} + place ${m.why.location} + text ${m.why.text}${m.why.pinned ? ' + pinned' : ''}</div></div>`).join('') || '<p class="faint">No memories.</p>'}
    <h3>What ${esc(d.owner)} believes</h3>${d.knowledge.map((k) => `<div class="card"><div class="b">${esc(k.content)}</div><div class="faint" style="font-size:.75em">${esc(k.belief)} · ${Math.round(k.confidence * 100)}% · from ${esc(k.source)} · actually ${k.truth ? 'true' : 'false'}</div></div>`).join('')}
    ${d.decisions?.length ? `<h3>Recent decisions</h3>${d.decisions.map((x) => `<div class="card"><div class="b">${esc(x.when)} — ${esc(x.decision)} <span class="faint">(${esc(x.reasons.join('; '))}${x.outcome ? ` → ${esc(x.outcome)}` : ''})</span></div></div>`).join('')}` : ''}`);
  $('#memq').addEventListener('submit', (ev) => { ev.preventDefault(); memoryInspector(id, $('#memtext').value); });
}

async function backups() {
  const list = await bridge('listSnapshots');
  modal(`<h2>Backups</h2>${list.length ? list.map((b) => `<div class="save card row"><span class="grow">${esc(b.name)}</span><button class="btn small" data-restore="${esc(b.name)}">Restore</button></div>`).join('') : '<p class="faint">No backups yet.</p>'}`);
}

// ---------------------------------------------------------------- events
document.addEventListener('click', async (ev) => {
  const t = ev.target.closest('button, [data-say], [data-close]');
  if (!t) return;
  const d = t.dataset;
  if (d.close && (ev.target === t || t.tagName === 'BUTTON')) return closeModal();
  if (d.act === 'create') return startCreation();
  if (d.act === 'title') return showTitle();
  if (d.act === 'begin') return beginGame();
  if (d.load) return loadGame(d.load);
  if (d.del) { if (confirm('Delete this world permanently?')) { await bridge('deleteSave', d.del); showTitle(); } return; }
  if (d.bg) { S.creation.name = $('#cname')?.value || ''; S.creation.bg = d.bg; S.creation.alloc = Object.fromEntries(Object.keys(S.creation.alloc).map((k) => [k, 0])); return render(); }
  if (d.attr) { S.creation.name = $('#cname')?.value || ''; S.creation.alloc[d.attr] += Number(d.d); return render(); }
  if (d.tab) { S.tab = d.tab; return renderGame(); }
  if (d.say) { if (!S.busy) submit(d.say); return; }
  if (d.fill) { const i = $('#input'); i.value = d.fill; i.focus(); return; }
  if (d.confirm) return confirmPlan(Number(d.confirm));
  if (d.cancelplan) return cancelPlan(Number(d.cancelplan));
  if (d.inspect) return inspect(Number(d.inspect));
  if (d.mem) return memoryInspector(d.mem);
  if (d.restore) { const r = await bridge('restoreSnapshot', S.st.saveId, d.restore); closeModal(); S.st = r.state; S.entries.push({ kind: 'clarify', narration: `Restored backup ${d.restore}.` }); return renderGame(); }
  if (d.act === 'cancel') { await bridge('cancel'); return; }
  if (d.act === 'save') { const r = await bridge('snapshot', 'manual'); toast(`Saved ${r.name}`); return; }
  if (d.act === 'backups') return backups();
  if (d.act === 'integrity') { const r = await bridge('integrity'); modal(`<h2>Integrity check</h2><pre class="json">${esc(JSON.stringify(r, null, 2))}</pre><p class="muted">${r.sqlite === 'ok' && !r.ledger.length && !r.items.length ? 'All checks passed: the database is sound, every balance reconciles with its ledger entries, and every item is accounted for.' : 'Problems were found.'}</p>`); return; }
  if (d.act === 'export') { const r = await window.saturn.exportSave(); if (r) toast(`Exported to ${r}`); return; }
  if (d.act === 'menu') { await bridge('closeGame'); return showTitle(); }
});

document.addEventListener('change', async (ev) => {
  const el = ev.target;
  if (!el.dataset?.setting) return;
  const key = el.dataset.setting;
  const value = el.type === 'checkbox' ? el.checked : el.type === 'range' ? Number(el.value) : el.value;
  await bridge('saveSettings', { [key]: value });
  S.st = await bridge('state');
  S.ai = await bridge('aiStatus');
  if (key === 'modelProfile' || key === 'aiEnabled') pollAI();
  renderGame();
});

document.addEventListener('submit', (ev) => {
  if (ev.target.id !== 'composer') return;
  ev.preventDefault();
  const i = $('#input');
  const v = i.value;
  i.value = '';
  submit(v);
});

document.addEventListener('keydown', (ev) => {
  if (ev.key === 'Escape') { if ($('#modal-root').innerHTML) return closeModal(); if (S.busy) bridge('cancel'); }
  if (S.screen !== 'game') return;
  if ((ev.ctrlKey || ev.metaKey) && ev.key === 's') { ev.preventDefault(); bridge('snapshot', 'manual').then((r) => toast(`Saved ${r.name}`)); }
  if (ev.altKey && /^[0-9]$/.test(ev.key)) { const idx = (Number(ev.key) + 9) % 10; if (TABS[idx]) { S.tab = TABS[idx][0]; renderGame(); } }
  if (ev.target.id === 'input') {
    if (ev.key === 'Enter' && !ev.shiftKey) { ev.preventDefault(); $('#composer').requestSubmit(); }
    if (ev.key === 'ArrowUp' && !ev.target.value) { ev.preventDefault(); const h = S.history; if (h.length) { S.histIdx = S.histIdx < 0 ? h.length - 1 : Math.max(0, S.histIdx - 1); ev.target.value = h[S.histIdx]; } }
  }
  if (ev.target.closest?.('.node') && ev.key === 'Enter') ev.target.closest('.node').dispatchEvent(new MouseEvent('click', { bubbles: true }));
});

showTitle().then(() => { if (S.ai?.state === 'loading') pollAI(); });
pollAI();
