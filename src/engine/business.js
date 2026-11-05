// Player-founded businesses. A business is a legal entity with its own ledger
// account and storage. Every day it pays rent and wages, buys real inputs from
// real merchants, produces through recipes and sells into the market. Weekly
// management checks against the owner's Commerce skill set its efficiency.
import { J } from './db.js';
import * as inv from './inventory.js';
import * as ledger from './ledger.js';
import { RuleError } from './ledger.js';
import { quote, marketPrice, homeSettlement } from './economy.js';
import { MINUTES_PER_DAY } from './rules.js';

const EFF = { critical: 1.3, strong: 1.15, success: 1.0, partial: 0.85, failure: 0.7, severe_failure: 0.5, automatic: 1.1, impossible: 0.5 };

export function businessTemplates(game) {
  return game.def.business_templates;
}
export function premisesList(game) {
  return game.def.premises.map((p) => ({ ...p, taken: !!game.db.prepare("SELECT 1 FROM businesses WHERE json_extract(data,'$.premises')=? AND status IN ('active','paused')").get(p.id) }));
}

export function getBusiness(game, id) {
  const b = game.db.prepare('SELECT * FROM businesses WHERE id=?').get(id);
  return b ? { ...b, data: J.parse(b.data, {}) } : null;
}
export function businessesOf(game, ownerId) {
  return game.db.prepare('SELECT id FROM businesses WHERE owner_id=? ORDER BY founded_at').all(ownerId).map((r) => getBusiness(game, r.id));
}
function save(game, b) {
  game.db.prepare('UPDATE businesses SET status=?, data=? WHERE id=?').run(b.status, J.str(b.data), b.id);
}

/**
 * Validate and found a business. Requirements: a suitable free premises, startup
 * capital (paid to the outfitter), a first rent payment, and capital for working stock.
 * A guild licence is optional but trading unlicensed angers the guild.
 */
export function foundBusiness(game, { ownerId, templateId, premisesId, name, capital, commodity = null, licensed = false }) {
  const tpl = game.def.business_templates.find((t) => t.id === templateId);
  if (!tpl) throw new RuleError('unknown_business', `There is no kind of business called ${templateId}. Options: ${game.def.business_templates.map((t) => t.id).join(', ')}.`);
  const prem = premisesList(game).find((p) => p.id === premisesId);
  if (!prem) throw new RuleError('unknown_premises', 'No such premises.');
  if (prem.taken) throw new RuleError('premises_taken', `${prem.name} is already let.`);
  if (!prem.suits.includes(templateId)) throw new RuleError('premises_unsuitable', `${prem.name} is not suited to a ${tpl.name.toLowerCase()}.`);
  if (templateId === 'trading_company') {
    if (!commodity || !game.itemType(commodity)?.commodity) throw new RuleError('need_commodity', 'A trading company needs a commodity to trade (e.g. salt).');
  }
  const licensor = (game.def.npcs || []).find((n) => n.licenses && game.settlementOf(n.location) === game.settlementOf(prem.location_id));
  const fee = licensed && licensor ? licensor.licenses.fee : 0;
  const licenceFaction = licensor ? game.db.prepare('SELECT faction_id FROM faction_members WHERE character_id=?').get(licensor.id)?.faction_id : null;
  const upfront = tpl.startup_cost + prem.rent * 6 + fee;
  if (!Number.isInteger(capital) || capital < 0) throw new RuleError('bad_amount', 'Working capital must be a whole number.');
  const total = upfront + capital;
  if (game.balance(ownerId) < total) {
    throw new RuleError('insufficient_funds', `Founding this needs ${game.money(upfront)} (equipment ${tpl.startup_cost}, six days' rent ${prem.rent * 6}${fee ? `, licence ${fee}` : ''}) plus working capital — ${total} in all. You have ${game.balance(ownerId)}.`, { need: total, have: game.balance(ownerId) });
  }
  const id = `biz_${game.db.prepare('SELECT COUNT(*) n FROM businesses').get().n + 1}`;
  const bname = (name || `${game.char(ownerId).name}'s ${tpl.name}`).slice(0, 60);
  ledger.ensureAccount(game.db, id, { owner: ownerId, kind: 'business', name: bname });
  // equipment comes from a named outfitter if the world has one, otherwise from suppliers outside the simulation
  const outfitter = tpl.outfitter && game.char(tpl.outfitter)?.alive ? tpl.outfitter : null;
  if (outfitter) game.pay(ownerId, outfitter, tpl.startup_cost, `Equipment for ${bname}`, 'investment');
  else game.burn(ownerId, tpl.startup_cost, `Equipment for ${bname}`);
  game.pay(ownerId, prem.landlord, prem.rent * 6, `Six days' rent for ${prem.name}`, 'rent');
  if (fee) game.pay(ownerId, licenceFaction || licensor.id, fee, 'Trading licence', 'fee');
  if (capital > 0) game.pay(ownerId, id, capital, `Working capital for ${bname}`, 'investment');
  const data = {
    template: templateId, premises: premisesId, rent: prem.rent, prepaid_days: 6, licensed, staff: tpl.staff, wage: tpl.wage,
    efficiency: 1, missed_rent: 0, commodity, trip: templateId === 'trading_company' ? { state: 'loading', days_left: 0, cargo: 0, cost: 0 } : null,
    stats: { days: 0, revenue: 0, costs: tpl.startup_cost + prem.rent * 6 + fee, produced: 0, sold: 0, week_revenue: 0, week_costs: 0 }, history: [], investor: null,
  };
  game.db.prepare('INSERT INTO businesses(id,name,owner_id,kind,location_id,founded_at,status,data) VALUES (?,?,?,?,?,?,?,?)').run(id, bname, ownerId, templateId, prem.location_id, game.time, 'active', J.str(data));
  if (!licensed && licenceFaction) game.db.prepare('INSERT INTO reputation(faction_id, character_id, value) VALUES (?,?,?) ON CONFLICT(faction_id, character_id) DO UPDATE SET value=MAX(-100, value-10)').run(licenceFaction, ownerId, -10);
  const ev = game.recordEvent({ kind: 'business_founded', actor: ownerId, location: prem.location_id, summary: `${game.char(ownerId).name} founded ${bname}, a ${tpl.name.toLowerCase()} at ${prem.name}.`, visibility: 'public', importance: 6, data: { business: id, hearsay: { respect: 6 } } });
  game.journal('plan', bname, `Your ${tpl.name.toLowerCase()} at ${prem.name}. Rent ${prem.rent}m/day, ${tpl.staff} staff at ${tpl.wage}m/day.${commodity ? ` Trading ${commodity}.` : ''}`, `biz:${id}`);
  return { id, name: bname, upfront, capital, eventId: ev.eventId };
}

export function addInvestor(game, businessId, npcId, amount, share) {
  const b = getBusiness(game, businessId);
  game.pay(npcId, businessId, amount, `${game.char(npcId).name} invests in ${b.name}`, 'investment');
  b.data.investor = { npc: npcId, amount, share };
  save(game, b);
  game.db.prepare(`INSERT INTO contracts(kind,party_a,party_b,title,terms,status,created_at,data) VALUES ('investment',?,?,?,?,'active',?,?)`)
    .run(npcId, b.owner_id, `${game.char(npcId).name}'s stake in ${b.name}`, J.str({ amount, share, business: businessId }), game.time, '{}');
}

function storage(b) {
  return { kind: 'business', id: b.id };
}

/** Buy `qty` of an input from merchants in the settlement for the business. Returns qty bought. */
function buyInput(game, b, typeId, qty, settlement) {
  let got = 0;
  const sellers = game.def.npcs.filter((n) => n.shop && (n.shop.sells || []).includes(typeId) && homeSettlement(game, n.id) === settlement && game.char(n.id)?.alive);
  for (const s of sellers) {
    if (got >= qty) break;
    const have = inv.countHeld(game.db, 'character', s.id, typeId);
    const price = quote(game, s.id, typeId, 'sell', b.owner_id);
    if (!price || have <= 0) continue;
    const q = Math.min(qty - got, have, Math.floor(game.balance(b.id) / price));
    if (q <= 0) continue;
    game.pay(b.id, s.id, q * price, `${b.name} buys ${typeId}`, 'trade');
    inv.moveItems(game.ctx, { typeId, qty: q, from: { kind: 'character', id: s.id }, to: storage(b), newOwner: b.id, memo: 'business input' });
    b.data.stats.costs += q * price;
    b.data.stats.week_costs += q * price;
    got += q;
  }
  return got;
}

/** Sell goods: first directly to townsfolk (share of demand), then to merchants who buy them. */
function sellOutput(game, b, typeId, settlement) {
  let have = inv.countHeld(game.db, 'business', b.id, typeId);
  let revenue = 0, sold = 0;
  const m = game.db.prepare('SELECT * FROM markets WHERE settlement=? AND type_id=?').get(settlement, typeId);
  const pop = `pop_${settlement}`;
  if (m && have > 0) {
    const unit = Math.max(1, Math.round(marketPrice(game, settlement, typeId) * 0.95));
    const q = Math.min(have, Math.ceil(m.daily_demand * 0.6), Math.floor(game.balance(pop) / unit));
    if (q > 0) {
      game.pay(pop, b.id, q * unit, `Townsfolk buy from ${b.name}`, 'trade');
      inv.destroyItems(game.ctx, { typeId, qty: q, holderKind: 'business', holderId: b.id, reason: 'consume', memo: `bought and consumed by townsfolk of ${settlement}` });
      revenue += q * unit; sold += q; have -= q;
    }
  }
  const buyers = game.def.npcs.filter((n) => n.shop && ((n.shop.buys || []).includes(typeId)) && !n.shop.fence && homeSettlement(game, n.id) === settlement && game.char(n.id)?.alive);
  for (const buyer of buyers) {
    if (have <= 0) break;
    const unit = quote(game, buyer.id, typeId, 'buy', b.owner_id);
    if (!unit) continue;
    const q = Math.min(have, Math.floor(game.balance(buyer.id) * 0.5 / unit), 20);
    if (q <= 0) continue;
    game.pay(buyer.id, b.id, q * unit, `${buyer.name} buys ${typeId} from ${b.name}`, 'trade');
    inv.moveItems(game.ctx, { typeId, qty: q, from: storage(b), to: { kind: 'character', id: buyer.id }, newOwner: buyer.id, memo: 'business sale' });
    revenue += q * unit; sold += q; have -= q;
  }
  b.data.stats.revenue += revenue;
  b.data.stats.week_revenue += revenue;
  b.data.stats.sold += sold;
  return { revenue, sold };
}

export function businessDaily(game) {
  for (const row of game.db.prepare("SELECT id FROM businesses WHERE status='active'").all()) {
    const b = getBusiness(game, row.id);
    const d = b.data;
    const tpl = game.def.business_templates.find((t) => t.id === d.template);
    const settlement = game.settlementOf(b.location_id);
    d.stats.days += 1;
    const log = [];
    // rent
    if (d.prepaid_days > 0) d.prepaid_days -= 1;
    else {
      const prem = game.def.premises.find((p) => p.id === d.premises);
      if (game.balance(b.id) >= d.rent) {
        game.pay(b.id, prem.landlord, d.rent, `Rent for ${prem.name}`, 'rent');
        d.stats.costs += d.rent; d.stats.week_costs += d.rent; d.missed_rent = 0;
      } else {
        d.missed_rent += 1;
        log.push('could not pay rent');
        if (d.missed_rent >= 3) {
          b.status = 'closed';
          d.closed_reason = 'evicted for unpaid rent';
          save(game, b);
          game.recordEvent({ kind: 'eviction', actor: prem.landlord, target: b.owner_id, location: b.location_id, summary: `${b.name} was evicted from ${prem.name} for unpaid rent.`, visibility: 'public', importance: 7, data: { hearsay: { respect: -8 } } });
          game.journal('consequence', `${b.name} evicted`, `Three days without rent: ${game.char(prem.landlord).name} has thrown your business out of ${prem.name}.`, `evict:${b.id}`);
          game.closeJournal('plan', `biz:${b.id}`, 'failed');
          continue;
        }
      }
    }
    // wages
    if (d.staff > 0) {
      const wages = d.staff * d.wage;
      if (game.balance(b.id) >= wages) {
        game.pay(b.id, `pop_${settlement}`, wages, `${b.name} wages`, 'wage');
        d.stats.costs += wages; d.stats.week_costs += wages;
      } else {
        log.push('staff unpaid and walked out');
        d.staff = 0;
      }
    }
    // weekly management check
    if (d.stats.days % 6 === 1) {
      const owner = b.owner_id;
      const r = game.check(owner, { skill: 'commerce', tn: 13, label: `Managing ${b.name}`, mods: d.licensed ? [] : [{ label: 'Unlicensed (guild friction)', value: -1 }] });
      d.efficiency = EFF[r.degree] ?? 1;
      d.last_check = { degree: r.degree, roll: r.rollId };
    }
    const staffFactor = d.staff >= tpl.staff ? 1 : (tpl.staff === 0 ? 1 : 0.5);
    if (tpl.recipe) {
      const recipe = game.recipe(tpl.recipe);
      const batches = Math.max(0, Math.floor(tpl.batches_per_day * d.efficiency * staffFactor + 0.5));
      let made = 0;
      for (let i = 0; i < batches; i++) {
        let ok = true;
        for (const [t, q] of Object.entries(recipe.inputs)) {
          const have = inv.countHeld(game.db, 'business', b.id, t);
          if (have < q) buyInput(game, b, t, q - have, settlement);
          if (inv.countHeld(game.db, 'business', b.id, t) < q) { ok = false; break; }
        }
        if (!ok) { log.push('ran short of inputs'); break; }
        for (const [t, q] of Object.entries(recipe.inputs)) inv.destroyItems(game.ctx, { typeId: t, qty: q, holderKind: 'business', holderId: b.id, reason: 'consume', memo: recipe.name });
        for (const [t, q] of Object.entries(recipe.outputs)) inv.createItems(game.ctx, { typeId: t, qty: q, holderKind: 'business', holderId: b.id, ownerId: b.id, reason: 'produce', memo: `${b.name}: ${recipe.name}` });
        made++;
      }
      d.stats.produced += made;
      for (const t of Object.keys(recipe.outputs)) sellOutput(game, b, t, settlement);
      if (made) log.push(`made ${made} batch(es)`);
    } else if (d.template === 'trading_company') {
      tradingDay(game, b, tpl, settlement, log);
    }
    // weekly report + investor share
    if (d.stats.days % 6 === 0) {
      const profit = d.stats.week_revenue - d.stats.week_costs;
      if (d.investor && profit > 0) {
        const share = Math.floor(profit * d.investor.share);
        if (share > 0 && game.balance(b.id) >= share) game.pay(b.id, d.investor.npc, share, `Profit share to ${game.char(d.investor.npc).name}`, 'dividend');
      }
      d.history.push({ day: game.day, revenue: d.stats.week_revenue, costs: d.stats.week_costs, profit, efficiency: d.efficiency, cash: game.balance(b.id) });
      if (d.history.length > 30) d.history.shift();
      game.journal('consequence', `${b.name}: weekly report`, `Revenue ${game.money(d.stats.week_revenue)}, costs ${game.money(d.stats.week_costs)}, profit ${game.money(profit)}. Cash on hand ${game.money(game.balance(b.id))}. Efficiency ${Math.round(d.efficiency * 100)}%.`, `bizweek:${b.id}`);
      if (profit !== 0) game.digest.push({ time: game.time, kind: 'business', summary: `${b.name} made ${profit >= 0 ? 'a profit' : 'a loss'} of ${game.money(Math.abs(profit))} this week.`, importance: 5 });
      d.stats.week_revenue = 0; d.stats.week_costs = 0;
    }
    d.last_log = log;
    save(game, b);
  }
}

function tradingDay(game, b, tpl, home, log) {
  const d = b.data;
  const t = d.trip;
  const other = d.destination || (game.def.settlements || []).map((s) => s.id).find((s) => s !== home && game.db.prepare('SELECT 1 FROM markets WHERE settlement=?').get(s));
  if (!other) { log.push('no other market to trade with'); return; }
  if (t.state === 'loading') {
    const got = buyInput(game, b, d.commodity, Math.floor(tpl.capacity * Math.min(1.2, d.efficiency)), home);
    if (got > 0) {
      if (game.balance(b.id) < tpl.freight) { log.push('cannot pay freight'); return; }
      game.burn(b.id, tpl.freight, `Freight for ${b.name}`);
      d.stats.costs += tpl.freight; d.stats.week_costs += tpl.freight;
      inv.moveItems(game.ctx, { typeId: d.commodity, qty: got, from: { kind: 'business', id: b.id }, to: { kind: 'business', id: `${b.id}:cargo` }, memo: 'loaded onto riverboat' });
      t.state = 'outbound'; t.days_left = tpl.trip_days; t.cargo = got;
      log.push(`loaded ${got} ${d.commodity}`);
    } else log.push(`no ${d.commodity} to buy`);
  } else if (t.state === 'outbound') {
    t.days_left -= 1;
    if (t.days_left <= 0) {
      if (game.rng.chance(0.05 / Math.max(0.5, d.efficiency))) {
        const lost = Math.ceil(t.cargo / 3);
        inv.destroyItems(game.ctx, { typeId: d.commodity, qty: lost, holderKind: 'business', holderId: `${b.id}:cargo`, reason: 'destroy', memo: 'lost overboard on the river' });
        log.push(`lost ${lost} ${d.commodity} on the river`);
        game.digest.push({ time: game.time, kind: 'business', summary: `${b.name} lost ${lost} ${d.commodity} when a barge capsized.`, importance: 5 });
      }
      const cargo = inv.countHeld(game.db, 'business', `${b.id}:cargo`, d.commodity);
      if (cargo > 0) inv.moveItems(game.ctx, { typeId: d.commodity, qty: cargo, from: { kind: 'business', id: `${b.id}:cargo` }, to: { kind: 'business', id: b.id }, memo: 'unloaded' });
      const { revenue, sold } = sellOutput(game, b, d.commodity, other);
      log.push(`sold ${sold} ${d.commodity} at ${other} for ${game.money(revenue)}`);
      t.state = 'returning'; t.days_left = tpl.trip_days; t.cargo = 0;
    }
  } else if (t.state === 'returning') {
    t.days_left -= 1;
    if (t.days_left <= 0) {
      // unsold stock comes back home; sell it locally if possible
      if (inv.countHeld(game.db, 'business', b.id, d.commodity) > 0) sellOutput(game, b, d.commodity, home);
      t.state = 'loading';
    }
  }
}

export function businessOp(game, ownerId, businessId, op, amount) {
  const b = getBusiness(game, businessId);
  if (!b || b.owner_id !== ownerId) throw new RuleError('not_owner', 'You do not own that business.');
  if (op === 'deposit') { game.pay(ownerId, b.id, amount, `Deposit into ${b.name}`, 'investment'); return { msg: `Deposited ${game.money(amount)} into ${b.name}.` }; }
  if (op === 'withdraw') { game.pay(b.id, ownerId, amount, `Withdrawal from ${b.name}`, 'withdrawal'); return { msg: `Withdrew ${game.money(amount)} from ${b.name}.` }; }
  if (op === 'hire') { const tpl = game.def.business_templates.find((t) => t.id === b.data.template); b.data.staff = Math.max(b.data.staff, tpl.staff); save(game, b); return { msg: `Staffed ${b.name}.` }; }
  if (op === 'pause') { b.status = 'paused'; save(game, b); return { msg: `${b.name} is paused.` }; }
  if (op === 'resume') { b.status = 'active'; save(game, b); return { msg: `${b.name} is open again.` }; }
  if (op === 'close') {
    b.status = 'closed'; save(game, b);
    const cash = game.balance(b.id);
    if (cash > 0) game.pay(b.id, ownerId, cash, `Closing ${b.name}`, 'withdrawal');
    return { msg: `${b.name} is closed. ${game.money(cash)} returned to you.` };
  }
  throw new RuleError('bad_op', `Unknown business operation ${op}`);
}

export { MINUTES_PER_DAY };
