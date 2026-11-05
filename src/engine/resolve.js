// Grounding helpers: resolve names the player or AI used into real entity ids,
// strictly within what the player can perceive or knows about.

export function norm(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9\s'-]/g, ' ').replace(/\s+/g, ' ').trim();
}

/** Resolve a free-text skill name to a skill id of the given world ruleset. */
export function resolveSkill(name, rules) {
  const n = norm(name).replace(/_/g, ' ');
  if (!n || !rules) return null;
  const skills = rules.skills;
  const direct = n.replace(/ /g, '_');
  if (skills[direct]) return direct;
  for (const [id, s] of Object.entries(skills)) if (norm(s.label) === n) return id;
  for (const [id, s] of Object.entries(skills)) if ((s.keywords || []).includes(n)) return id;
  const hasWords = (phrase) => new RegExp(`(^|\\s)${phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(\\s|$)`).test(n);
  for (const [id, s] of Object.entries(skills)) if (norm(s.label).length > 3 && hasWords(norm(s.label))) return id;
  for (const [id, s] of Object.entries(skills)) if ((s.keywords || []).some((k) => k.length > 2 && hasWords(k))) return id;
  return null;
}

const ROLE_WORDS = {
  npc_odile: ['merchant', 'salt merchant', 'cloth merchant', 'trader'],
  npc_sabine: ['rival merchant', 'sabine'],
  npc_mirela: ['innkeeper', 'landlady', 'barkeep', 'bartender', 'hostess'],
  npc_brannoc: ['blacksmith', 'smith'],
  npc_ysolde: ['archivist', 'scholar', 'librarian'],
  npc_aldous: ['healer', 'priest', 'monk', 'brother'],
  npc_corvin: ['mayor'],
  npc_tamsin: ['miller', 'grain factor', 'factor'],
  npc_wenna: ['farmer'],
  npc_piet: ['dockmaster', 'harbourmaster', 'harbormaster'],
  npc_jory: ['fence', 'fixer'],
  npc_hedda: ['captain', 'guard', 'watch captain', 'guard captain', 'watchman', 'watch'],
  npc_aurel: ['guildmaster', 'guild master'],
  npc_isa: ['captain isa', 'harbour trader', 'harbor trader', 'sea captain'],
  npc_fenwick: ['landlord', 'old sailor'],
};

function scoreName(query, c) {
  const q = norm(query).replace(/^(the|a|an|to|with|at)\s+/, '');
  if (!q) return 0;
  const name = norm(c.name);
  if (q === name || q === c.id) return 100;
  const parts = name.split(' ');
  if (parts.includes(q)) return 80;
  if (name.includes(q) || q.includes(name)) return 70;
  if (parts.some((p) => p.length > 2 && q.split(' ').includes(p))) return 60;
  if ((c.aliases || []).map(norm).includes(q)) return 85;
  const roles = ROLE_WORDS[c.id] || [];
  if (roles.includes(q)) return 50;
  if (c.role && norm(c.role).includes(q)) return 40;
  if (roles.some((r) => q.includes(r))) return 35;
  return 0;
}

/** Resolve an NPC name among a candidate list of characters. Returns {match, ambiguous}. */
export function resolveCharacter(query, candidates) {
  if (!query) return { match: null };
  const scored = candidates.map((c) => ({ c, s: scoreName(query, c) })).filter((x) => x.s > 0).sort((a, b) => b.s - a.s);
  if (!scored.length) return { match: null };
  if (scored.length > 1 && scored[0].s === scored[1].s && scored[0].s < 80) return { match: scored[0].c, ambiguous: scored.filter((x) => x.s === scored[0].s).map((x) => x.c.name) };
  return { match: scored[0].c };
}

const ITEM_SYNONYMS = {
  meal: ['meal', 'food', 'dinner', 'supper', 'breakfast', 'lunch', 'hot meal', 'stew'],
  bread: ['bread', 'loaf', 'loaves'],
  ale: ['ale', 'beer', 'drink', 'jug'],
  rations: ['rations', 'travel rations', 'provisions'],
  salt: ['salt'],
  book_medicine: ['medicine book', 'book on medicine', 'healing book', 'primer', 'medical book'],
  book_commerce: ['commerce book', 'merchant book', "merchant's reckoning", 'book on trade', 'business book'],
  book_herbal: ['herbal', 'herb book', 'herbalism book'],
  book_engineering: ['engineering book', 'book on engineering', 'levers'],
  book_lore: ['history book', 'chronicle', 'lore book'],
  book_alchemy: ['alchemy book', 'tinctures'],
  herb_silverleaf: ['silverleaf', 'herbs', 'herb', 'silverleaf bundle'],
  remedy: ['salve', 'remedy', 'medicine', 'healing salve', 'potion'],
  smith_hammer: ['hammer', "smith's hammer", 'smithing hammer'],
  shortsword: ['sword', 'shortsword', 'blade'],
  leather_armor: ['armor', 'armour', 'jerkin', 'leather'],
  fine_clothes: ['fine clothes', 'fine clothing', 'nice clothes', 'good clothes'],
  common_clothes: ['clothes', 'common clothes'],
  medical_kit: ['satchel', 'medical kit', 'physician satchel', "physician's satchel", 'medkit'],
  herbalist_kit: ['herbalist kit', "herbalist's kit", 'herb kit'],
  surveyor_tools: ['surveyor', 'instruments', 'surveying tools'],
  glassware: ['glassware', 'alchemy glassware', 'alembic'],
  ink_paper: ['ink', 'paper', 'ink and paper'],
  pack: ['pack', 'backpack', 'bag', 'travelling pack', 'traveling pack'],
  ring_astrolabe: ['astrolabe', 'instrument', 'artifact', 'artefact'],
  grain_ledger: ['ledger', 'granary ledger', 'evidence', 'tally'],
  ledger_book: ["merchant's ledger", 'ledger book', 'account book'],
  salted_fish: ['salted fish', 'salt fish', 'cured fish'],
};

/** Resolve an item name to a type id among candidate type rows [{id,name}]. */
export function resolveItemType(query, candidates) {
  const q = norm(query).replace(/^(a|an|the|some|my|\d+)\s+/, '').replace(/s$/, '');
  if (!q) return null;
  const qFull = norm(query);
  let best = null, bestScore = 0;
  for (const c of candidates) {
    const name = norm(c.name);
    let s = 0;
    if (q === c.id || qFull === c.id || q === name || qFull === name) s = 100;
    else if ([...(ITEM_SYNONYMS[c.id] || []), ...(c.aliases || []).map(norm)].some((syn) => syn === q || syn === qFull)) s = 90;
    else if (name.includes(q) || name.includes(qFull)) s = 70;
    else if ((ITEM_SYNONYMS[c.id] || []).some((syn) => qFull.includes(syn) || q.includes(syn))) s = 60;
    else if (q.split(' ').some((w) => w.length > 3 && name.split(' ').includes(w))) s = 40;
    if (s > bestScore) { best = c; bestScore = s; }
  }
  return best ? best.id : null;
}

export function resolveLocation(query, locations) {
  const q = norm(query).replace(/^(the|to)\s+/, '');
  if (!q) return null;
  const aliases = {
    bm_square: ['square', 'market', 'market square', 'marketplace', 'town square'],
    bm_inn: ['inn', 'lantern', 'gilded lantern', 'tavern', 'pub'],
    bm_docks: ['docks', 'dock', 'quay', 'harbor', 'harbour', 'river', 'pier', 'wharf'],
    bm_guild: ['guild', 'guildhall', 'guild hall', 'hall of weights'],
    bm_archive: ['archive', 'library', 'ringwatch', 'tower'],
    bm_forge: ['forge', 'smithy', 'blacksmith'],
    bm_temple: ['temple', 'chapel', 'church', 'shrine'],
    bm_hall: ['town hall', 'hall', 'council', 'watch house', 'barracks'],
    bm_narrows: ['narrows', 'slums', 'alley', 'alleys'],
    bm_mill: ['mill', 'granary', 'ashby mill'],
    bm_fields: ['fields', 'farm', 'farmland', "cobb's fields", 'cobbs fields'],
    ww_edge: ['whisperwood', 'forest', 'woods', 'wood'],
    ww_observatory: ['observatory', 'sunken observatory', 'ruin', 'ruins'],
    kp_harbor: ['kestrel', 'kestrel point', 'kestrel harbour', 'kestrel harbor'],
    kp_market: ['fishmarket', 'fish market', 'kestrel market'],
    kp_tidewatch: ['tidewatch'],
  };
  let best = null, bestScore = 0;
  for (const l of locations) {
    const name = norm(l.name);
    let s = 0;
    if (q === name || q === l.id) s = 100;
    else if ([...(aliases[l.id] || []), ...(l.aliases || []).map(norm)].includes(q)) s = 90;
    else if (name.includes(q)) s = 70;
    else if ((aliases[l.id] || []).some((a) => q.includes(a))) s = 50 + Math.min(20, (aliases[l.id].find((a) => q.includes(a)) || '').length);
    if (s > bestScore) { best = l; bestScore = s; }
  }
  return best ? best.id : null;
}
