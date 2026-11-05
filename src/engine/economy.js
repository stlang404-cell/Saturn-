// Markets, pricing and trade. Prices emerge from real stock held by merchants in a
// settlement compared with that market's target stock. All trades move real items
// and real money atomically.
import * as inv from './inventory.js';
import * as ledger from './ledger.js';
import { RuleError } from './ledger.js';
import { disposition } from './relationships.js';
import { clamp, MINUTES_PER_DAY } from './rules.js';
import { J } from './db.js';

export function homeSettlement(game, npcId) {
  const def = game.npcDef(npcId);
  const loc = def ? def.location : game.char(npcId)?.location_id;
  return game.settlementOf(loc);
}

/** Current markup of a merchant (may be changed by their own decisions, e.g. price cutting). */
export function markupOf(game, npcDef) {
  return game.char(npcDef.id)?.data?.markup ?? npcDef.shop?.markup ?? 0.2;
}

export function stockOf(game, settlement, typeId) {
  let total = 0;
  for (const n of game.def.npcs) {
    if (homeSettlement(game, n.id) !== settlement || !n.shop) continue;
    if (!(n.shop.sells || []).includes(typeId)) continue;
    total += inv.countHeld(game.db, 'character', n.id, typeId);
  }
  return total;
}

export function marketRow(game, settlement, typeId) {
  return game.db.prepare('SELECT * FROM markets WHERE settlement=? AND type_id=?').get(settlement, typeId);
}

export function basePrice(game, settlement, typeId) {
  return game.def.market_base?.[settlement]?.[typeId] ?? game.itemType(typeId).base_value;
}

/** Recompute the market price from stock vs target. */
export function computePrice(game, settlement, typeId) {
  const m = marketRow(game, settlement, typeId);
  const base = basePrice(game, settlement, typeId);
  if (!m) return base;
  const stock = stockOf(game, settlement, typeId);
  const ratio = m.target_stock / Math.max(stock, 1);
  return Math.max(1, Math.round(base * clamp(Math.pow(ratio, 0.6), 0.5, 3)));
}

export function updatePrices(game) {
  const day = game.day;
  for (const m of game.db.prepare('SELECT * FROM markets').all()) {
    const price = computePrice(game, m.settlement, m.type_id);
    game.db.prepare('UPDATE markets SET price=? WHERE settlement=? AND type_id=?').run(price, m.settlement, m.type_id);
    game.db.prepare('INSERT OR REPLACE INTO price_history(settlement,type_id,day,price,stock) VALUES (?,?,?,?,?)').run(m.settlement, m.type_id, day, price, stockOf(game, m.settlement, m.type_id));
  }
}

export function marketPrice(game, settlement, typeId) {
  const m = marketRow(game, settlement, typeId);
  return m ? m.price : basePrice(game, settlement, typeId);
}

/**
 * Unit price quoted by a merchant.
 *  side 'sell' = merchant sells to customer; 'buy' = merchant buys from customer.
 * Relationship shifts prices by up to ±20%.
 */
export function quote(game, merchantId, typeId, side, customerId = game.playerId, { stolen = false } = {}) {
  const def = game.npcDef(merchantId);
  const shop = def?.shop;
  if (!shop) return null;
  const settlement = homeSettlement(game, merchantId);
  const t = game.itemType(typeId);
  if (!t) return null;
  const mp = t.commodity ? marketPrice(game, settlement, typeId) : t.base_value;
  const disp = disposition(game.rel(merchantId, customerId));
  const relFactor = 1 - clamp(disp / 500, -0.2, 0.2);
  if (side === 'sell') {
    if (!(shop.sells || []).includes(typeId)) return null;
    return Math.max(1, Math.round(mp * (1 + markupOf(game, def)) * relFactor));
  }
  const buysAll = (shop.buys || []).includes('*');
  if (!buysAll && !(shop.buys || []).includes(typeId)) return null;
  if (t.category === 'evidence') return null;
  let factor = shop.fence ? 0.45 : 0.7;
  if (stolen && !shop.fence) factor = 0.7;
  return Math.max(0, Math.floor(mp * factor / relFactor));
}

/**
 * Execute a trade between a buyer and a seller character for `qty` units at `unitPrice`.
 * Validates funds and stock; moves money and ownership together inside the caller's transaction.
 */
export function executeTrade(game, { buyer, seller, typeId, qty, unitPrice, memo }) {
  if (!Number.isInteger(qty) || qty <= 0) throw new RuleError('bad_quantity', 'Quantity must be a positive whole number.');
  const total = unitPrice * qty;
  const have = inv.countHeld(game.db, 'character', seller, typeId);
  if (have < qty) {
    throw new RuleError('insufficient_items', `${game.char(seller).name} only has ${have} ${game.itemType(typeId).name}.`, { have, need: qty });
  }
  if (total > 0) {
    const funds = game.balance(buyer);
    if (funds < total) throw new RuleError('insufficient_funds', `${game.char(buyer).name} has ${funds} marks but this costs ${total}.`, { have: funds, need: total });
    game.pay(buyer, seller, total, memo || `${qty} × ${game.itemType(typeId).name}`, 'trade');
  }
  if (buyer === game.playerId) {
    const w = inv.carriedWeight(game.db, buyer) + game.itemType(typeId).weight * qty;
    if (w > game.carryCapacity(buyer) * 1.5) throw new RuleError('too_heavy', `You cannot carry that much (${Math.round(w)} / ${game.carryCapacity(buyer)} weight).`);
  }
  inv.moveItems(game.ctx, { typeId, qty, from: { kind: 'character', id: seller }, to: { kind: 'character', id: buyer }, newOwner: buyer, memo: memo || 'trade' });
  return { total };
}

// ----------------------------------------------------------------------------
// Daily economic simulation
// ----------------------------------------------------------------------------

function npcsIn(game, settlement) {
  return game.def.npcs.filter((n) => homeSettlement(game, n.id) === settlement && game.char(n.id)?.alive);
}

/** Buy up to `qty` of a type from merchants in the buyer's own settlement. Returns qty bought. */
export function buyLocally(game, buyerId, typeId, qty) {
  const home = homeSettlement(game, buyerId);
  let got = 0;
  for (const s of game.def.npcs) {
    if (got >= qty) break;
    if (s.id === buyerId || !s.shop || !(s.shop.sells || []).includes(typeId) || homeSettlement(game, s.id) !== home || !game.char(s.id)?.alive) continue;
    const have = inv.countHeld(game.db, 'character', s.id, typeId) - 2;
    const price = marketPrice(game, home, typeId);
    const q = Math.min(qty - got, have, Math.floor(game.balance(buyerId) / Math.max(1, price)));
    if (q <= 0) continue;
    executeTrade(game, { buyer: buyerId, seller: s.id, typeId, qty: q, unitPrice: price, memo: `${game.char(buyerId).name} buys ${typeId} from ${s.name}` });
    got += q;
  }
  return got;
}

export function dailyEconomy(game) {
  const { db, def } = game;
  const ctx = game.ctx;
  const notes = [];
  // 1. Primary production from land and sea (legitimate item sources)
  for (const n of def.npcs) {
    if (!game.char(n.id)?.alive) continue;
    for (const p of n.production || []) {
      inv.createItems(ctx, { typeId: p.type, qty: p.qty, holderKind: 'character', holderId: n.id, ownerId: n.id, reason: 'produce', memo: p.source });
    }
  }
  // 2. Mills and workshops convert inputs to outputs
  for (const n of def.npcs) {
    if (!game.char(n.id)?.alive) continue;
    if (n.mill) {
      const have = inv.countHeld(db, 'character', n.id, n.mill.converts);
      const q = Math.min(have, n.mill.per_day);
      if (q > 0) {
        inv.destroyItems(ctx, { typeId: n.mill.converts, qty: q, holderKind: 'character', holderId: n.id, reason: 'consume', memo: 'milled' });
        inv.createItems(ctx, { typeId: n.mill.into, qty: q, holderKind: 'character', holderId: n.id, ownerId: n.id, reason: 'produce', memo: 'milled' });
      }
    }
    for (const cr of n.consumes_recipes || []) {
      const r = game.recipe(cr.recipe);
      // keep two days of inputs on hand, bought from local producers at market price
      for (const [t, q] of Object.entries(r.inputs)) {
        const need = Math.ceil(q * Math.max(1, cr.per_day) * 2) - inv.countHeld(db, 'character', n.id, t);
        if (need > 0) buyLocally(game, n.id, t, need);
      }
      const runs = Math.floor(cr.per_day) + (game.rng.chance(cr.per_day % 1) ? 1 : 0);
      for (let k = 0; k < runs; k++) {
        if (!Object.entries(r.inputs).every(([t, q]) => inv.countHeld(db, 'character', n.id, t) >= q)) break;
        for (const [t, q] of Object.entries(r.inputs)) inv.destroyItems(ctx, { typeId: t, qty: q, holderKind: 'character', holderId: n.id, reason: 'consume', memo: r.name });
        for (const [t, q] of Object.entries(r.outputs)) inv.createItems(ctx, { typeId: t, qty: q, holderKind: 'character', holderId: n.id, ownerId: n.id, reason: 'produce', memo: r.name });
      }
    }
  }
  // 3. Standing supply arrangements between NPCs
  for (const n of def.npcs) {
    for (const s of n.sells_to || []) {
      const surplus = inv.countHeld(db, 'character', n.id, s.type) - (s.keep || 0);
      if (surplus <= 0) continue;
      const price = Math.max(1, Math.round(marketPrice(game, homeSettlement(game, s.npc), s.type) * 0.85));
      const afford = Math.floor(game.balance(s.npc) / price);
      const q = Math.min(surplus, afford);
      if (q > 0) executeTrade(game, { buyer: s.npc, seller: n.id, typeId: s.type, qty: q, unitPrice: price, memo: `${n.name} sells ${s.type} to ${game.char(s.npc).name}` });
    }
    for (const im of n.imports || []) {
      const have = inv.countHeld(db, 'character', im.from, im.type);
      const price = marketPrice(game, homeSettlement(game, im.from), im.type);
      const q = Math.min(im.qty, have, Math.floor(game.balance(n.id) / Math.max(1, price)));
      if (q > 0) executeTrade(game, { buyer: n.id, seller: im.from, typeId: im.type, qty: q, unitPrice: price, memo: `river trade: ${im.type}` });
    }
  }
  // 4. Merchant restocking along the river trade route
  for (const n of def.npcs) {
    if (!n.shop || !game.char(n.id)?.alive) continue;
    const home = homeSettlement(game, n.id);
    const wants = new Set([...(n.shop.sells || []).filter((t) => game.itemType(t)?.commodity), ...((n.shop.buys || []).filter((t) => t !== '*' && game.itemType(t)?.commodity && n.shop.restock_buys))]);
    for (const typeId of wants) {
      if ((n.production || []).some((p) => p.type === typeId)) continue;
      const level = inv.countHeld(db, 'character', n.id, typeId);
      const want = n.shop.restock_buys ? 16 : 6;
      if (level >= want / 2) continue;
      // find a supplier elsewhere with surplus
      const suppliers = def.npcs.filter((o) => o.id !== n.id && o.shop && homeSettlement(game, o.id) !== home && (o.shop.sells || []).includes(typeId) && inv.countHeld(db, 'character', o.id, typeId) > 8 && game.char(o.id)?.alive);
      if (!suppliers.length) continue;
      let level2 = level;
      for (const sup of suppliers.sort((a, b) => markupOf(game, a) - markupOf(game, b))) {
        if (level2 >= want) break;
        const price = Math.max(1, Math.round(marketPrice(game, homeSettlement(game, sup.id), typeId) * 1.05));
        const q = Math.min(want - level2, inv.countHeld(db, 'character', sup.id, typeId) - 8, Math.floor((game.balance(n.id) * 0.5) / price));
        if (q <= 0) continue;
        executeTrade(game, { buyer: n.id, seller: sup.id, typeId, qty: q, unitPrice: price, memo: `${n.name} restocks ${typeId} from ${sup.name}` });
        db.prepare('INSERT INTO npc_decisions(time,npc_id,decision,reasons,outcome) VALUES (?,?,?,?,?)').run(game.time, n.id, `restock ${typeId}`, J.str([`stock ${level2} below ${want / 2}`, `${sup.name} has surplus`]), `bought ${q} at ${price}`);
        level2 += q;
      }
    }
  }
  // 5. Townsfolk: income from the wider (unsimulated) economy, taxes, and daily consumption
  for (const s of def.settlements) {
    const acct = `pop_${s.id}`;
    const income = Math.round((s.population * s.wage) / 32);
    ledger.mint(ctx, { to: acct, amount: income, memo: `Wages earned by ${s.name}'s townsfolk` });
    // savings beyond a month of income leave the local market (crown taxes, distant trade)
    const excess = game.balance(acct) - income * 30;
    if (excess > 0) ledger.burn(ctx, { from: acct, amount: excess, memo: `${s.name}'s surplus savings leave the local economy` });
    const gov = game.government(s.id);
    if (gov) {
      const tax = Math.round(income * (s.tax_rate ?? 0.05));
      if (tax > 0) game.pay(acct, gov, tax, 'Market tax', 'tax');
    }
    const shortages = [];
    for (const m of db.prepare('SELECT * FROM markets WHERE settlement=?').all(s.id)) {
      let need = m.daily_demand;
      if (need <= 0) continue;
      const sellers = npcsIn(game, s.id).filter((n) => n.shop && (n.shop.sells || []).includes(m.type_id) && !game.char(n.id).data.bankrupt && !game.char(n.id).data.jailed)
        .sort((a, b) => markupOf(game, a) - markupOf(game, b)); // customers go to the cheapest seller first
      for (const sel of sellers) {
        if (need <= 0) break;
        const have = inv.countHeld(db, 'character', sel.id, m.type_id);
        if (have <= 0) continue;
        const unit = Math.max(1, Math.round(m.price * (1 + markupOf(game, sel) / 2)));
        const q = Math.min(need, have, Math.floor(game.balance(acct) / unit));
        if (q <= 0) continue;
        game.pay(acct, sel.id, unit * q, `Townsfolk buy ${m.type_id}`, 'trade');
        inv.destroyItems(ctx, { typeId: m.type_id, qty: q, holderKind: 'character', holderId: sel.id, reason: 'consume', memo: `consumed by townsfolk of ${s.name}` });
        need -= q;
      }
      if (need > 0 && m.daily_demand >= 4 && need / m.daily_demand > 0.5) shortages.push(m.type_id);
    }
    game.shortages = { ...(game.shortages || {}), [s.id]: shortages };
  }
  // 6. Household upkeep: NPCs spend on living costs (money leaves via the sink)
  for (const n of def.npcs) {
    if (!game.char(n.id)?.alive) continue;
    const bal = game.balance(n.id);
    if (bal > 60) ledger.burn(ctx, { from: n.id, amount: Math.max(1, Math.round(bal * 0.015)), memo: 'Household costs' });
  }
  // 7. Stipends and wages paid from faction treasuries (the watch, the mayor's office)
  for (const n of def.npcs) {
    if (!n.stipend || !game.char(n.id)?.alive || game.char(n.id).data.jailed) continue;
    if (game.balance(n.stipend.from) >= n.stipend.amount) game.pay(n.stipend.from, n.id, n.stipend.amount, `Stipend for ${n.name}`, 'wage');
  }
  // 8. Perishable goods spoil in storage (merchants' and businesses' stock)
  const perish = def.item_types.filter((t) => t.data?.spoil);
  for (const t of perish) {
    for (const row of db.prepare("SELECT holder_kind, holder_id, SUM(quantity) q FROM items WHERE type_id=? AND holder_kind IN ('character','business') AND holder_id<>'player' GROUP BY holder_kind, holder_id").all(t.id)) {
      const lost = Math.floor(row.q * t.data.spoil + (game.rng.chance((row.q * t.data.spoil) % 1) ? 1 : 0));
      if (lost > 0) inv.destroyItems(ctx, { typeId: t.id, qty: Math.min(lost, row.q), holderKind: row.holder_kind, holderId: row.holder_id, reason: 'destroy', memo: 'spoiled' });
    }
  }
  // 9. Wild resources regrow
  for (const l of db.prepare("SELECT id, data FROM locations").all()) {
    const data = J.parse(l.data, {});
    if (!data.gather) continue;
    data.gather_state = data.gather_state || {};
    for (const g of data.gather) {
      const cur = data.gather_state[g.type] ?? g.capacity;
      data.gather_state[g.type] = Math.min(g.capacity, cur + g.regen);
    }
    db.prepare('UPDATE locations SET data=? WHERE id=?').run(J.str(data), l.id);
  }
  updatePrices(game);
  return notes;
}

export function priceTrend(game, settlement, typeId, days = 14) {
  return game.db.prepare('SELECT day, price, stock FROM price_history WHERE settlement=? AND type_id=? AND day>=? ORDER BY day').all(settlement, typeId, game.day - days);
}

export { MINUTES_PER_DAY };
