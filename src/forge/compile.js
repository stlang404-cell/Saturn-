// World compiler: turns an AI-generated World Draft into a complete, validated, executable
// World Specification (the same format as hand-written worlds). Everything the simulation
// needs but the model should not have to spell out — ids, map layout, connected routes,
// markets, schedules, money, stock, producers, mentors, premises, businesses — is derived
// deterministically. Every repair is recorded in the report; nothing is silently faked.
import { slug } from '../engine/worldrules.js';

export const SPEC_VERSION = 2;

const ART_KINDS = [
  ['square', /market|bazaar|plaza|square|exchange|agora|mall|trading/],
  ['inn', /inn|tavern|hostel|lodg|hotel|canteen|bar|mess|hall of rest|bunk/],
  ['docks', /dock|port|wharf|quay|pier|harbo|landing|mooring|berth/],
  ['harbor', /harbo|bay|anchorage|spaceport|airfield/],
  ['guild', /guild|bank|exchange|office|company|corporat|chamber|bourse/],
  ['archive', /library|archive|academy|university|school|observ|institute|lab|college/],
  ['forge', /forge|smith|workshop|foundry|factory|works|mill|refinery|yard|hangar|garage|plant/],
  ['temple', /temple|shrine|church|chapel|clinic|hospital|infirmary|cathedral/],
  ['hall', /hall|palace|council|court|senate|ministry|government|barracks|fort|citadel|precinct|headquarters/],
  ['narrows', /slum|alley|undercity|warren|backstreet|underworld|den|black market|shanty/],
  ['fields', /farm|field|orchard|pasture|garden|plantation|ranch|hydropon/],
  ['forest', /forest|wood|jungle|grove|wild|thicket|swamp|marsh/],
  ['ruin', /ruin|tomb|vault|wreck|crater|cave|dungeon|derelict|abandoned/],
];

function artFor(kind, name, tags) {
  const t = `${kind} ${name}`.toLowerCase();
  for (const [art, rx] of ART_KINDS) if (rx.test(t)) return art;
  if (tags.includes('wild')) return 'forest';
  if (tags.includes('market')) return 'square';
  if (tags.includes('lodging')) return 'inn';
  return 'square';
}

function uniqueId(base, used) {
  let id = base, i = 2;
  while (used.has(id)) id = `${base}_${i++}`;
  used.add(id);
  return id;
}

const WEALTH = { destitute: 3, poor: 12, modest: 35, comfortable: 90, rich: 300 };

export function compileWorld(draft, { description = '' } = {}) {
  const report = { repairs: [], warnings: [], approximations: [] };
  const fix = (m) => report.repairs.push(m);
  const { core, skills: sk, roles, places, items: it, people, story } = draft;
  const used = new Set();
  const worldId = uniqueId(`w_${slug(core.name, 24)}`, new Set());

  // ------------------------------------------------------------ attributes & skills
  const attrUsed = new Set();
  const attrRename = {};
  const attributes = core.attributes.map((a) => { const id = uniqueId(slug(a.id, 12).replace(/_/g, ''), attrUsed); if (id !== a.id) attrRename[a.id] = id; return { id, label: a.label, info: a.info }; });
  if (Object.keys(attrRename).length) fix(`attribute ids normalised: ${Object.entries(attrRename).map(([a, b]) => `${a}→${b}`).join(', ')}`);
  const attrIds = new Set(attributes.map((a) => a.id));
  const skillUsed = new Set();
  const skills = [];
  for (const s of sk.skills) {
    const id = uniqueId(slug(s.id, 24), skillUsed);
    skills.push({ id, label: s.label, attr: attrIds.has(s.attr) ? s.attr : attributes[0].id, group: s.group, desc: s.desc, trained: s.trained, keywords: s.keywords.map((k) => k.toLowerCase()) });
  }
  const skillIds = new Set(skills.map((s) => s.id));
  const skill_roles = {};
  for (const [role, sid] of Object.entries(roles || {})) skill_roles[role] = skillIds.has(sid) ? sid : skills[0].id;

  // ------------------------------------------------------------ settlements & places
  const settlements = core.settlements.map((s, i) => ({ id: uniqueId(`s_${slug(s.name, 20)}`, used), name: s.name, description: s.description, population: Math.min(5000, Math.max(100, Math.round(s.population || 800))), wage: 3, _i: i, kind: s.kind }));
  const settlementByName = Object.fromEntries(settlements.map((s) => [s.name.toLowerCase(), s.id]));
  const locUsed = new Set();
  const locations = [];
  const nameToLoc = {};
  for (const l of places.locations) {
    const id = uniqueId(`l_${slug(l.name, 24)}`, locUsed);
    const settlement = settlementByName[l.settlement.toLowerCase()] || null;
    const tags = [...new Set(l.tags)];
    if (tags.includes('lodging') && !tags.includes('food')) tags.push('food');
    if (tags.includes('healing')) tags.push('charity');
    if (tags.includes('library')) tags.push('study');
    if (tags.includes('craft') || tags.includes('industry')) tags.push('craft');
    if (!settlement && !tags.includes('wild')) tags.push('wild');
    const loc = { id, name: l.name, settlement, region: settlement || 'wilds', kind: l.kind, art: artFor(l.kind, l.name, tags), tags: [...new Set(tags)], description: l.description, _conn: l.connections };
    locations.push(loc);
    nameToLoc[l.name.toLowerCase()] = id;
  }
  // every settlement needs at least one place
  for (const s of settlements) {
    if (!locations.some((l) => l.settlement === s.id)) {
      const id = uniqueId(`l_${slug(s.name, 20)}_centre`, locUsed);
      locations.push({ id, name: `${s.name} Centre`, settlement: s.id, region: s.id, kind: 'square', art: 'square', tags: ['market', 'public', 'lodging', 'food'], description: s.description, _conn: [] });
      fix(`settlement ${s.name} had no places; added "${s.name} Centre"`);
    }
  }
  // layout on a 100×100 map: settlements around a ring, their places clustered, wilds between
  const cx = 50, cy = 50;
  settlements.forEach((s, i) => { s._x = cx + 32 * Math.cos((i / settlements.length) * 2 * Math.PI); s._y = cy + 30 * Math.sin((i / settlements.length) * 2 * Math.PI); });
  const perSettlement = {};
  for (const l of locations) {
    const s = settlements.find((x) => x.id === l.settlement);
    const k = l.settlement || 'wilds';
    const n = (perSettlement[k] = (perSettlement[k] || 0) + 1);
    if (s) { l.x = Math.round(s._x + 9 * Math.cos(n * 1.9)); l.y = Math.round(s._y + 9 * Math.sin(n * 1.9)); } else { l.x = Math.round(cx + 12 * Math.cos(n * 2.4)); l.y = Math.round(cy + 12 * Math.sin(n * 2.4)); }
  }
  // routes from declared connections
  const routeSet = new Map();
  const addRoute = (a, b, minutes, mode = 'walk') => {
    if (a === b) return;
    const key = [a, b].sort().join('|');
    if (!routeSet.has(key)) routeSet.set(key, [a, b, Math.max(2, Math.round(minutes)), mode === 'walk' ? {} : { mode: slug(mode, 16) }]);
  };
  for (const l of locations) for (const c of l._conn || []) {
    const to = nameToLoc[String(c.to).toLowerCase()];
    if (to) addRoute(l.id, to, c.minutes, c.mode || 'walk'); else fix(`dropped connection from ${l.name} to unknown place "${c.to}"`);
  }
  // guarantee connectivity: within a settlement link to its hub; then join components
  for (const s of settlements) {
    const locs = locations.filter((l) => l.settlement === s.id);
    const hub = locs.find((l) => l.tags.includes('market')) || locs[0];
    s._hub = hub.id;
    for (const l of locs) if (l !== hub && ![...routeSet.values()].some((r) => r[0] === l.id || r[1] === l.id)) { addRoute(hub.id, l.id, 8); fix(`connected ${l.name} to ${hub.name}`); }
  }
  const comp = () => {
    const adj = Object.fromEntries(locations.map((l) => [l.id, []]));
    for (const [a, b] of routeSet.values()) { adj[a].push(b); adj[b].push(a); }
    const seen = new Set([locations[0].id]); const q = [locations[0].id];
    while (q.length) for (const n of adj[q.shift()]) if (!seen.has(n)) { seen.add(n); q.push(n); }
    return seen;
  };
  let guard = 0;
  while (guard++ < 50) {
    const seen = comp();
    const out = locations.find((l) => !seen.has(l.id));
    if (!out) break;
    // join to the nearest reachable place
    const near = locations.filter((l) => seen.has(l.id)).sort((a, b) => Math.hypot(a.x - out.x, a.y - out.y) - Math.hypot(b.x - out.x, b.y - out.y))[0];
    const minutes = Math.round(Math.hypot(near.x - out.x, near.y - out.y) * 10) + 10;
    addRoute(near.id, out.id, minutes, near.settlement !== out.settlement ? 'road' : 'walk');
    fix(`linked unreachable ${out.name} to ${near.name} (${minutes} min)`);
  }
  const routes = [...routeSet.values()];
  const startLoc = nameToLoc[String(places.start || '').toLowerCase()] || locations.find((l) => l.tags.includes('lodging'))?.id || locations[0].id;
  if (!nameToLoc[String(places.start || '').toLowerCase()]) fix(`start place "${places.start}" not found; starting at ${locations.find((l) => l.id === startLoc).name}`);
  for (const l of locations) delete l._conn;

  // ------------------------------------------------------------ items & recipes
  const itemUsed = new Set();
  const item_types = [];
  const itemMap = {};
  for (const i of it.items) {
    const id = uniqueId(slug(i.id, 30), itemUsed);
    itemMap[i.id] = id;
    const tags = [];
    if (i.food || i.category === 'food') tags.push('food');
    if (i.tool_for && skillIds.has(i.tool_for)) tags.push(`tool:${i.tool_for}`);
    const t = { id, name: i.name.toLowerCase(), category: i.category, base_value: Math.max(1, Math.round(i.value)), weight: Math.max(0, i.weight), commodity: !!i.traded_commodity, tags, description: i.description, data: {} };
    if (tags.includes('food')) t.data.nourish = 10;
    if (i.tool_for) t.data.tool_bonus = 1 + (i.value > 30 ? 1 : 0);
    if (i.category === 'weapon') { t.slot = 'weapon'; t.stackable = false; t.data.melee = i.value > 40 ? 2 : 1; }
    if (i.category === 'armor') { t.slot = 'body'; t.stackable = false; t.data.defense = 1; }
    if (i.category === 'clothing') { t.slot = 'clothes'; t.stackable = false; }
    if (['tool', 'device', 'vehicle', 'treasure', 'book'].includes(i.category)) t.stackable = false;
    if (i.category === 'medicine') { t.data.heal = 20; t.tags.push('medicine'); }
    if (i.category === 'book' && i.tool_for) t.data = { ...t.data, teaches: i.tool_for, max_rank: 4 };
    item_types.push(t);
  }
  const itemIds = new Set(item_types.map((t) => t.id));
  const resolveItem = (ref) => itemMap[ref] || (itemIds.has(ref) ? ref : null);
  if (!item_types.some((t) => t.tags.includes('food'))) {
    item_types.push({ id: uniqueId('rations', itemUsed), name: 'rations', category: 'food', base_value: 1, weight: 1, commodity: true, tags: ['food'], description: 'Plain food.', data: { nourish: 10 } });
    itemIds.add('rations');
    fix('the world had no food; added basic rations');
  }
  const recipes = [];
  const recUsed = new Set();
  for (const r of it.recipes || []) {
    const inputs = {}, outputs = {};
    for (const x of r.inputs) { const id = resolveItem(x.item); if (id) inputs[id] = (inputs[id] || 0) + x.qty; else fix(`recipe "${r.name}": unknown input ${x.item}`); }
    for (const x of r.outputs) { const id = resolveItem(x.item); if (id) outputs[id] = (outputs[id] || 0) + x.qty; else fix(`recipe "${r.name}": unknown output ${x.item}`); }
    if (!Object.keys(inputs).length || !Object.keys(outputs).length) { fix(`dropped recipe "${r.name}" (no valid inputs/outputs)`); continue; }
    // value sanity: outputs worth at most 3× inputs (labour adds value; alchemy of wealth does not)
    const inV = Object.entries(inputs).reduce((s, [t, q]) => s + item_types.find((x) => x.id === t).base_value * q, 0);
    const outV = Object.entries(outputs).reduce((s, [t, q]) => s + item_types.find((x) => x.id === t).base_value * q, 0);
    if (outV > inV * 3 + 20) { for (const t of Object.keys(outputs)) outputs[t] = Math.max(1, Math.floor(outputs[t] * (inV * 3 + 20) / outV)); fix(`recipe "${r.name}" yielded too much value; output reduced`); }
    recipes.push({ id: uniqueId(`r_${slug(r.name, 24)}`, recUsed), name: r.name.toLowerCase(), skill: skillIds.has(r.skill) ? r.skill : skill_roles.craft, tn: 12, minutes: r.minutes, inputs, outputs });
  }

  // ------------------------------------------------------------ factions
  const facUsed = new Set();
  const factions = people.factions.map((f) => ({ id: uniqueId(`fac_${slug(f.name, 20)}`, facUsed), name: f.name, description: f.description, treasury: 200, _governs: f.governs }));
  for (const f of factions) {
    const s = f._governs && settlements.find((x) => x.name === f._governs);
    if (s && !s.government) s.government = f.id;
    delete f._governs;
  }

  // ------------------------------------------------------------ people
  const npcUsed = new Set(['player']);
  const npcs = [];
  const npcByName = {};
  const blocks = ['dawn', 'morning', 'afternoon', 'evening', 'night'];
  for (const n of people.npcs) {
    const id = uniqueId(`npc_${slug(n.name.split(' ')[0], 16)}`, npcUsed);
    npcByName[n.name] = id;
    const loc = nameToLoc[n.location.toLowerCase()] || startLoc;
    const settlement = locations.find((l) => l.id === loc).settlement;
    const inn = locations.find((l) => l.settlement === settlement && l.tags.includes('lodging'));
    const schedule = Object.fromEntries(blocks.map((b) => [b, loc]));
    if (inn && !n.host && !n.guard) schedule.evening = inn.id;
    const skillsObj = {};
    for (const s of n.skills) if (skillIds.has(s.skill)) skillsObj[s.skill] = Math.max(skillsObj[s.skill] || 0, s.rank);
    const attrs = Object.fromEntries(attributes.map((a, i) => [a.id, 2 + ((n.name.length + i * 3) % 3)]));
    const sells = [...new Set(n.sells.map(resolveItem).filter(Boolean))];
    const buys = [...new Set(n.buys.map(resolveItem).filter(Boolean))];
    const produces = [...new Set(n.produces.map(resolveItem).filter(Boolean))];
    const inventory = {};
    for (const t of sells) { const ty = item_types.find((x) => x.id === t); inventory[t] = ty.stackable === false ? 2 : Math.max(3, Math.min(30, Math.round(120 / ty.base_value))); }
    for (const t of produces) inventory[t] = (inventory[t] || 0) + 6;
    const merchant = sells.length > 0;
    const npc = {
      id, name: n.name, role: n.role, location: loc, schedule, attributes: attrs, skills: skillsObj, traits: n.traits, persona: n.persona,
      money: merchant ? 180 : n.lends ? 600 : 70, inventory,
      goals: [{ id: 'goal', text: n.goal }],
    };
    const facId = factions.find((f) => f.name.toLowerCase() === String(n.faction).toLowerCase())?.id;
    if (facId) npc.factions = [[facId, 'member']];
    if (merchant || buys.length) npc.shop = { sells, buys: [...new Set([...buys, ...sells])], markup: 0.2 };
    if (produces.length) npc.production = produces.map((t) => ({ type: t, qty: Math.max(2, Math.min(12, Math.round(60 / item_types.find((x) => x.id === t).base_value))), source: `${n.name}'s work` }));
    const topSkill = Object.entries(skillsObj).sort((a, b) => b[1] - a[1])[0];
    if (n.employs) npc.job = { title: `${n.role.split(' ').slice(-1)[0]}'s assistant`, wage: 4, location: loc, minutes: 480, skill: topSkill?.[0] || skill_roles.labor };
    if (n.teaches && topSkill) npc.teaches = Object.entries(skillsObj).filter(([, r]) => r >= 3).map(([s, r]) => [s, r - 1, 3]);
    if (n.lends) npc.lends = { max: 200, rate: 0.1, days: 30 };
    if (n.guard) npc.guard = true;
    if (n.healer) npc.healing = { price: 4 };
    if (n.host) {
      npc.lodging = { price: 3 };
      npc.shop = npc.shop || { sells: [], buys: [], markup: 0.25 };
      for (const f of item_types.filter((t) => t.tags.includes('food')).slice(0, 2)) { if (!npc.shop.sells.includes(f.id)) npc.shop.sells.push(f.id); npc.inventory[f.id] = (npc.inventory[f.id] || 0) + 20; }
      const loca = locations.find((l) => l.id === loc);
      if (!loca.tags.includes('lodging')) loca.tags.push('lodging', 'food');
    }
    npcs.push(npc);
  }
  // economy wiring: every traded commodity needs a producer and a seller, every recipe a workshop
  const sellersOf = (t) => npcs.filter((n) => n.shop?.sells.includes(t));
  for (const t of item_types.filter((x) => x.commodity)) {
    if (!npcs.some((n) => (n.production || []).some((p) => p.type === t.id)) && !recipes.some((r) => r.outputs[t.id])) {
      const who = sellersOf(t.id)[0] || npcs.find((n) => n.shop) || npcs[0];
      who.production = [...(who.production || []), { type: t.id, qty: Math.max(1, Math.min(8, Math.round(40 / t.base_value))), source: 'supplies from beyond the region' }];
      fix(`${t.name} had no source; ${who.name} now receives a steady supply`);
    }
    if (!sellersOf(t.id).length) {
      const who = npcs.find((n) => (n.production || []).some((p) => p.type === t.id)) || npcs.find((n) => n.shop) || npcs[0];
      who.shop = who.shop || { sells: [], buys: [], markup: 0.2 };
      who.shop.sells.push(t.id); who.shop.buys.push(t.id);
      who.inventory[t.id] = (who.inventory[t.id] || 0) + 8;
      fix(`${t.name} had no seller; ${who.name} now sells it`);
    }
  }
  for (const r of recipes) {
    const out = Object.keys(r.outputs)[0];
    const maker = npcs.find((n) => n.shop?.sells.includes(out)) || null;
    if (maker) maker.consumes_recipes = [...(maker.consumes_recipes || []), { recipe: r.id, per_day: 1 }];
  }
  // a host is needed somewhere to eat and sleep
  if (!npcs.some((n) => n.lodging)) {
    const loc = locations.find((l) => l.id === startLoc);
    const h = npcs.find((n) => n.location === startLoc) || npcs[0];
    h.lodging = { price: 3 }; loc.tags.push('lodging', 'food');
    fix(`no host was defined; ${h.name} rents beds at ${loc.name}`);
  }

  // markets per settlement for commodities and food
  const markets = {};
  const market_base = {};
  for (const s of settlements) {
    markets[s.id] = {};
    for (const t of item_types.filter((x) => x.commodity || x.tags.includes('food'))) {
      const food = t.tags.includes('food');
      markets[s.id][t.id] = [food ? 30 : 16, food ? 6 : 1];
    }
  }
  // regional price differences make trade between settlements worthwhile
  item_types.filter((t) => t.commodity).forEach((t, i) => {
    const prod = npcs.find((n) => (n.production || []).some((p) => p.type === t.id));
    const home = prod && locations.find((l) => l.id === prod.location)?.settlement;
    for (const s of settlements) {
      market_base[s.id] = market_base[s.id] || {};
      market_base[s.id][t.id] = Math.max(1, Math.round(t.base_value * (home && s.id !== home ? 1.6 : 1)));
    }
  });

  // ------------------------------------------------------------ facts, agendas, requests
  const factUsed = new Set();
  const facts = [];
  const knows = {};
  for (const f of story.facts) {
    const id = uniqueId(`f_${slug(f.subject, 24)}`, factUsed);
    const keepers = (f.keepers || []).map((n) => npcByName[n]).filter(Boolean);
    facts.push({ id, subject: f.subject, content: f.content, truth: f.true_fact ? 1 : 0, secrecy: f.secret_level, tags: f.tags.map((t) => t.toLowerCase()), data: keepers.length ? { keepers } : {} });
    for (const n of f.known_by) { const nid = npcByName[n]; if (nid) (knows[nid] = knows[nid] || []).push([id, f.true_fact ? 'known' : 'rumor', f.true_fact ? 1 : 0.6]); }
  }
  for (const n of npcs) if (knows[n.id]) n.knows = knows[n.id];
  const hidden_stores = [];
  for (const a of story.agendas || []) {
    const who = npcs.find((n) => n.id === npcByName[a.who]);
    const other = a.partner_or_rival ? npcByName[a.partner_or_rival] : null;
    const ag = a.kind;
    if (!who || ag === 'none') continue;
    const goods = a.items.map(resolveItem).filter(Boolean);
    if (ag === 'stockpile' && other && goods.length) {
      const store = `store_${who.id}`;
      hidden_stores.push({ id: store, location_id: npcs.find((n) => n.id === other).location, owner: who.id, name: `${who.name}'s hidden store`, items: Object.fromEntries(goods.map((g) => [g, 10])), watchers: [who.id, other] });
      for (const g of goods) { const p = npcs.find((n) => n.id === other); p.production = [...(p.production || []), { type: g, qty: 5, source: `${p.name}'s trade` }]; p.shop = p.shop || { sells: [], buys: [], markup: 0.2 }; if (!p.shop.sells.includes(g)) p.shop.sells.push(g); }
      who.agendas = [...(who.agendas || []), { type: 'stockpile', partner: other, types: goods, per_day: 2, store, until_month: Math.min(11, core.calendar.months.length - 1), motive: a.motive }];
      who.goals.push({ id: 'agenda', text: a.motive, secret: true });
    } else if (ag === 'undercut' && other && npcs.find((n) => n.id === other)?.shop && who.shop) {
      who.agendas = [...(who.agendas || []), { type: 'undercut', rival: other, motive: a.motive }];
      who.goals.push({ id: 'agenda', text: a.motive, secret: true });
    } else if (ag === 'debt') {
      const creditor = (other && npcs.find((n) => n.id === other)) || npcs.find((n) => n.lends) || null;
      const credAcct = creditor ? creditor.id : factions[0].id;
      who.agendas = [...(who.agendas || []), { type: 'debt', creditor: credAcct, amount: 800, due_month: Math.min(core.calendar.months.length - 1, 6), seize_to: creditor?.id, ruin_text: `${who.name} was ruined by an unpaid debt.` }];
      who.goals.push({ id: 'agenda', text: a.motive, secret: true });
    } else if (ag === 'pilfer') {
      const guardN = npcs.find((n) => n.guard);
      who.agendas = [...(who.agendas || []), { type: 'pilfer', chance: 0.2, min: 2, max: 8, ...(guardN ? { suspicion: { watcher: guardN.id, fact: facts.find((f) => f.data.keepers?.includes(who.id))?.id || facts[0]?.id, chance: 0.15, confidence: 0.12 } } : {}) }];
    } else report.warnings.push(`agenda "${ag}" for ${a.who} could not be wired (missing partner/rival/shop) and was skipped`);
  }
  // NPCs with the skills to do so may adopt new inventions
  for (const n of npcs) if (Object.values(n.skills).some((r) => r >= 4)) n.agendas = [...(n.agendas || []), { type: 'adopt_innovations', chance: 0.08 }];
  for (const r of story.requests || []) {
    const giver = npcs.find((n) => n.id === npcByName[r.giver]);
    const to = npcByName[r.deliver_to];
    const item = resolveItem(r.item);
    if (!giver || !to || !item) { fix(`dropped request "${r.title}" (unknown person or item)`); continue; }
    giver.requests = [...(giver.requests || []), { id: `req_${slug(r.title, 20)}`, title: r.title, text: r.text, objective: { type: 'deliver', item, qty: r.qty, to }, reward: Math.min(r.reward, 400), days: r.days, rel: 12 }];
    if (to === giver.id) giver.requests.at(-1).text += '';
  }

  // ------------------------------------------------------------ special rules (validated again at install)
  const rules = [];
  for (const r of story.special_rules || []) {
    const conv = (e) => {
      const out = { type: e.type };
      if (e.type === 'produce') { out.item = resolveItem(e.item); out.qty = Math.max(1, Math.min(5, e.amount || 1)); if (!out.item) return null; }
      else if (e.type === 'travel') out.speed = 0.4;
      else if (e.type === 'xp') { out.skill = r.skill; out.amount = Math.min(5, e.amount || 2); }
      else if (['heal', 'harm_target', 'harm_self', 'fatigue', 'restore', 'relationship'].includes(e.type)) out.amount = e.amount || 10;
      else if (e.type === 'note') out.text = e.text;
      return out;
    };
    const success = r.on_success.map(conv).filter(Boolean);
    if (!success.length) { report.approximations.push(`"${r.name}" had no effect the engine can represent; it was approximated as descriptive only`); success.push({ type: 'note', text: r.summary }); }
    const id = slug(r.name);
    rules.push({
      id, name: r.name, kind: r.kind, summary: r.summary, skill: r.skill, difficulty: r.difficulty, minutes: r.minutes,
      requires: { capability: !!r.must_be_learned, skill_min: r.min_skill },
      costs: { items: r.consumes.map((c) => ({ item: resolveItem(c.item), qty: c.qty })).filter((c) => c.item), fatigue: r.fatigue },
      effects: { success, failure: (r.on_failure || []).map(conv).filter(Boolean) },
      learn: { hours: 8 + r.min_skill * 4, teachers: r.known_by.map((n) => npcByName[n]).filter(Boolean) },
      keywords: r.name.toLowerCase().split(/\W+/).filter((w) => w.length > 3),
    });
    for (const n of r.known_by) { const nn = npcs.find((x) => x.id === npcByName[n]); if (nn) nn.abilities = [...(nn.abilities || []), id]; }
    if (r.on_success.some((e) => e.type === 'learn_fact')) report.approximations.push(`"${r.name}": knowledge effects are represented as notes`);
  }

  // ------------------------------------------------------------ premises & business types
  const business_templates = recipes.slice(0, 5).map((r) => ({ id: `b_${r.id}`, name: `${r.name.replace(/^(make|brew|bake|forge|build|cook|craft|refine|process)\s+/, '')} works`.replace(/^\w/, (c) => c.toUpperCase()), recipe: r.id, startup_cost: 60, batches_per_day: 2, staff: 1, wage: 3, description: `Produces ${Object.keys(r.outputs).map((t) => item_types.find((x) => x.id === t).name).join(', ')} for sale.` }));
  if (settlements.length > 1 && item_types.some((t) => t.commodity)) business_templates.push({ id: 'trading_company', name: 'Trading company', recipe: null, startup_cost: 50, staff: 1, wage: 4, trip_days: 2, capacity: 12, freight: 6, description: 'Ships a commodity between settlements to profit from price differences.' });
  const premises = [];
  for (const s of settlements) {
    const sites = locations.filter((l) => l.settlement === s.id && (l.tags.includes('market') || l.tags.includes('craft') || l.tags.includes('work') || l.tags.includes('industry')));
    const landlord = npcs.find((n) => locations.find((l) => l.id === n.location)?.settlement === s.id && (n.lends || n.factions)) || npcs.find((n) => locations.find((l) => l.id === n.location)?.settlement === s.id);
    if (!landlord) continue;
    for (const site of sites.slice(0, 2)) premises.push({ id: `prem_${site.id}`, name: `a workspace at ${site.name}`, location_id: site.id, landlord: landlord.id, rent: 3, suits: business_templates.map((b) => b.id) });
  }

  // ------------------------------------------------------------ player backgrounds & start
  const bgUsed = new Set();
  const backgrounds = story.backgrounds.map((b, i) => {
    const attrs = {};
    for (const a of b.attribute_bonus.slice(0, 2)) if (attrIds.has(a)) attrs[a] = (attrs[a] || 0) + 1;
    const sks = {};
    for (const s of b.skills) if (skillIds.has(s.skill)) sks[s.skill] = Math.min(2, s.rank);
    const items = {};
    for (const x of b.items) { const id = resolveItem(x); if (id) items[id] = (items[id] || 0) + 1; }
    const food = item_types.find((t) => t.tags.includes('food'));
    if (food) items[food.id] = (items[food.id] || 0) + 2;
    const money = i === 0 ? Math.min(b.money, Math.max(WEALTH[core.player.wealth] ?? 20, 5) * 3) : Math.min(b.money, 400);
    return { id: uniqueId(`bg_${slug(b.name, 20)}`, bgUsed), name: b.name, description: b.description, attributes: attrs, skills: sks, items, money: Math.max(0, Math.round(money)) };
  });
  const start = {
    location: startLoc,
    known_facts: facts.filter((f) => f.secrecy === 0 && f.truth === 1).map((f) => f.id),
  };

  const months = core.calendar.months;
  const spec = {
    spec_version: SPEC_VERSION, id: worldId, name: core.name, tagline: core.tagline, premise: core.premise, tone: core.tone,
    origin: { kind: 'forge', description, created: new Date().toISOString() },
    intro: core.intro, physics: core.physics, impossible: core.impossible, common_knowledge: core.common_knowledge,
    magic: core.magic, technology: core.technology,
    currency: { name: core.currency.name.toLowerCase(), plural: core.currency.plural.toLowerCase(), symbol: core.currency.name[0].toLowerCase(), medium: core.currency.medium },
    calendar: { era: core.calendar.era, startYear: 1, months, daysPerMonth: 30, weekdays: core.calendar.weekdays, start: { month: 0, day: 1, hour: 8 } },
    attributes, skills, skill_roles,
    settlements: settlements.map(({ _i, _x, _y, _hub, kind, ...s }) => s),
    locations, routes, item_types, recipes, markets, market_base, factions, facts, premises, business_templates,
    npcs, npc_relationships: [], hidden_stores, secrets_at: [], backgrounds, start, rules,
    contradictions_resolved: core.contradictions_resolved,
  };
  return { spec, report };
}

/** Human-readable summary of a compiled world for the Forge preview. */
export function summarizeSpec(spec, report) {
  return {
    name: spec.name, tagline: spec.tagline, premise: spec.premise, intro: spec.intro,
    physics: spec.physics, impossible: spec.impossible, magic: spec.magic, technology: spec.technology,
    currency: spec.currency, attributes: spec.attributes.map((a) => `${a.label}: ${a.info}`),
    skills: spec.skills.map((s) => ({ label: s.label, desc: s.desc, attr: s.attr })),
    settlements: spec.settlements.map((s) => s.name), places: spec.locations.map((l) => ({ name: l.name, settlement: spec.settlements.find((s) => s.id === l.settlement)?.name || 'wilds', tags: l.tags })),
    items: spec.item_types.map((t) => `${t.name} (${t.base_value} ${spec.currency.plural})`),
    factions: spec.factions.map((f) => f.name), people: spec.npcs.map((n) => `${n.name} — ${n.role}`),
    rules: spec.rules.map((r) => `${r.name}: ${r.summary}`), backgrounds: spec.backgrounds.map((b) => `${b.name} — ${b.description}`),
    tensions: spec.npcs.flatMap((n) => (n.agendas || []).filter((a) => a.type !== 'adopt_innovations').map((a) => `${n.name}: ${a.type}`)),
    contradictions_resolved: spec.contradictions_resolved || [],
    report,
  };
}
