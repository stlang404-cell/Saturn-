// Authoritative inventory. Items exist only as rows in `items`; every creation,
// destruction and movement is logged in `item_log`. Creation is only permitted for
// a legitimate reason (init, produce, gather) and destruction for (consume, destroy),
// so per-type conservation can be verified at any time.
import { RuleError } from './ledger.js';
import { J } from './db.js';

const CREATE_REASONS = new Set(['init', 'produce', 'gather']);
const DESTROY_REASONS = new Set(['consume', 'destroy']);

export function itemType(db, typeId) {
  const t = db.prepare('SELECT * FROM item_types WHERE id=?').get(typeId);
  if (!t) return null;
  return { ...t, tags: J.parse(t.tags, []), data: J.parse(t.data, {}), stackable: !!t.stackable, commodity: !!t.commodity };
}

export function listHeld(db, kind, id) {
  return db.prepare(`SELECT i.*, t.name, t.category, t.base_value, t.weight, t.slot, t.tags, t.data AS type_data, t.stackable
    FROM items i JOIN item_types t ON t.id=i.type_id WHERE i.holder_kind=? AND i.holder_id=? ORDER BY t.category, t.name`).all(kind, id)
    .map((r) => ({ ...r, tags: J.parse(r.tags, []), type_data: J.parse(r.type_data, {}), data: J.parse(r.data, {}) }));
}

export function countHeld(db, kind, id, typeId, { ownerId = null, excludeEquipped = false } = {}) {
  let sql = 'SELECT COALESCE(SUM(quantity),0) q FROM items WHERE holder_kind=? AND holder_id=? AND type_id=?';
  const args = [kind, id, typeId];
  if (ownerId) { sql += ' AND owner_id=?'; args.push(ownerId); }
  if (excludeEquipped) sql += ' AND equipped IS NULL';
  return db.prepare(sql).get(...args).q;
}

export function carriedWeight(db, charId) {
  return db.prepare(`SELECT COALESCE(SUM(i.quantity * t.weight),0) w FROM items i JOIN item_types t ON t.id=i.type_id
    WHERE i.holder_kind='character' AND i.holder_id=?`).get(charId).w;
}

function log(ctx, typeId, delta, reason, fromH, toH, memo) {
  ctx.db.prepare('INSERT INTO item_log(time, turn_id, type_id, delta, reason, from_holder, to_holder, memo) VALUES (?,?,?,?,?,?,?,?)')
    .run(ctx.time ?? 0, ctx.turnId ?? null, typeId, delta, reason, fromH, toH, memo ?? null);
}

function putStack(db, { typeId, qty, holderKind, holderId, ownerId, stolen = 0, condition = 100, data = {} }) {
  const t = itemType(db, typeId);
  if (!t) throw new RuleError('unknown_item', `Unknown item type ${typeId}`);
  if (t.stackable) {
    const existing = db.prepare(`SELECT id FROM items WHERE type_id=? AND holder_kind=? AND holder_id=? AND owner_id=? AND stolen=?
      AND equipped IS NULL AND condition=?`).get(typeId, holderKind, holderId, ownerId, stolen ? 1 : 0, condition);
    if (existing) {
      db.prepare('UPDATE items SET quantity = quantity + ? WHERE id=?').run(qty, existing.id);
      return [existing.id];
    }
    const r = db.prepare('INSERT INTO items(type_id, quantity, owner_id, holder_kind, holder_id, stolen, condition, data) VALUES (?,?,?,?,?,?,?,?)')
      .run(typeId, qty, ownerId, holderKind, holderId, stolen ? 1 : 0, condition, J.str(data));
    return [Number(r.lastInsertRowid)];
  }
  const ids = [];
  for (let i = 0; i < qty; i++) {
    const r = db.prepare('INSERT INTO items(type_id, quantity, owner_id, holder_kind, holder_id, stolen, condition, data) VALUES (?,?,?,?,?,?,?,?)')
      .run(typeId, 1, ownerId, holderKind, holderId, stolen ? 1 : 0, condition, J.str(data));
    ids.push(Number(r.lastInsertRowid));
  }
  return ids;
}

/** Create items from a legitimate source. */
export function createItems(ctx, { typeId, qty, holderKind, holderId, ownerId, reason, memo, stolen = 0, data }) {
  if (!CREATE_REASONS.has(reason)) throw new RuleError('bad_reason', `Items cannot be created for reason '${reason}'`);
  if (!Number.isInteger(qty) || qty <= 0) throw new RuleError('bad_quantity', `Invalid quantity ${qty}`);
  const ids = putStack(ctx.db, { typeId, qty, holderKind, holderId, ownerId: ownerId ?? holderId, stolen, data });
  log(ctx, typeId, qty, reason, null, `${holderKind}:${holderId}`, memo);
  return ids;
}

/**
 * Take `qty` of a type from a holder (optionally only items owned by ownerId), splitting stacks.
 * Returns array of {owner_id, stolen, condition, quantity, data} chunks removed (rows are deleted/decremented).
 */
function takeFrom(db, { typeId, qty, holderKind, holderId, ownerId = null, itemId = null, allowEquipped = false }) {
  let sql = 'SELECT * FROM items WHERE type_id=? AND holder_kind=? AND holder_id=?';
  const args = [typeId, holderKind, holderId];
  if (ownerId) { sql += ' AND owner_id=?'; args.push(ownerId); }
  if (itemId) { sql += ' AND id=?'; args.push(itemId); }
  if (!allowEquipped) sql += ' AND equipped IS NULL';
  sql += ' ORDER BY stolen ASC, condition DESC, id ASC';
  const rows = db.prepare(sql).all(...args);
  let available = rows.reduce((s, r) => s + r.quantity, 0);
  if (available < qty && !allowEquipped && !itemId) {
    // fall back to equipped items if needed
    return takeFrom(db, { typeId, qty, holderKind, holderId, ownerId, itemId, allowEquipped: true });
  }
  if (available < qty) {
    const t = itemType(db, typeId);
    throw new RuleError('insufficient_items', `Only ${available} ${t?.name ?? typeId} available, needed ${qty}.`, { have: available, need: qty, typeId });
  }
  const chunks = [];
  let remaining = qty;
  for (const r of rows) {
    if (remaining <= 0) break;
    const take = Math.min(remaining, r.quantity);
    if (take === r.quantity) db.prepare('DELETE FROM items WHERE id=?').run(r.id);
    else db.prepare('UPDATE items SET quantity = quantity - ? WHERE id=?').run(take, r.id);
    chunks.push({ owner_id: r.owner_id, stolen: r.stolen, condition: r.condition, quantity: take, data: J.parse(r.data, {}) });
    remaining -= take;
  }
  return chunks;
}

/** Destroy items for a legitimate reason (consumed as food, used as an input, worn out). */
export function destroyItems(ctx, { typeId, qty, holderKind, holderId, ownerId, reason, memo }) {
  if (!DESTROY_REASONS.has(reason)) throw new RuleError('bad_reason', `Items cannot be destroyed for reason '${reason}'`);
  if (!Number.isInteger(qty) || qty <= 0) throw new RuleError('bad_quantity', `Invalid quantity ${qty}`);
  takeFrom(ctx.db, { typeId, qty, holderKind, holderId, ownerId });
  log(ctx, typeId, -qty, reason, `${holderKind}:${holderId}`, null, memo);
}

/**
 * Move items between holders. Ownership changes only if `newOwner` is given
 * (a sale or gift); otherwise the legal owner is preserved (consignment, theft).
 */
export function moveItems(ctx, { typeId, qty, from, to, ownerFilter = null, newOwner = undefined, markStolen = false, clearStolen = false, itemId = null, memo }) {
  if (!Number.isInteger(qty) || qty <= 0) throw new RuleError('bad_quantity', `Invalid quantity ${qty}`);
  const chunks = takeFrom(ctx.db, { typeId, qty, holderKind: from.kind, holderId: from.id, ownerId: ownerFilter, itemId });
  for (const c of chunks) {
    const owner = newOwner !== undefined ? newOwner : c.owner_id;
    let stolen = c.stolen;
    if (markStolen) stolen = 1;
    if (clearStolen || newOwner !== undefined) stolen = markStolen ? 1 : 0;
    putStack(ctx.db, { typeId, qty: c.quantity, holderKind: to.kind, holderId: to.id, ownerId: owner, stolen, condition: c.condition, data: c.data });
  }
  log(ctx, typeId, qty, 'transfer', `${from.kind}:${from.id}`, `${to.kind}:${to.id}`, memo);
  return chunks;
}

/** Per-type conservation: live quantity must equal created minus destroyed. */
export function conservationCheck(db) {
  const live = Object.fromEntries(db.prepare('SELECT type_id, SUM(quantity) q FROM items GROUP BY type_id').all().map((r) => [r.type_id, r.q]));
  const logged = Object.fromEntries(db.prepare("SELECT type_id, SUM(delta) q FROM item_log WHERE reason <> 'transfer' GROUP BY type_id").all().map((r) => [r.type_id, r.q]));
  const problems = [];
  for (const t of new Set([...Object.keys(live), ...Object.keys(logged)])) {
    if ((live[t] || 0) !== (logged[t] || 0)) problems.push({ type: t, live: live[t] || 0, logged: logged[t] || 0 });
  }
  return problems;
}

export function equip(ctx, charId, itemId) {
  const it = ctx.db.prepare(`SELECT i.*, t.slot, t.name FROM items i JOIN item_types t ON t.id=i.type_id WHERE i.id=? AND holder_kind='character' AND holder_id=?`).get(itemId, charId);
  if (!it) throw new RuleError('not_held', 'You are not carrying that.');
  if (!it.slot) throw new RuleError('not_equippable', `The ${it.name} cannot be equipped.`);
  ctx.db.prepare(`UPDATE items SET equipped=NULL WHERE holder_kind='character' AND holder_id=? AND equipped=?`).run(charId, it.slot);
  if (it.quantity > 1) {
    ctx.db.prepare('UPDATE items SET quantity=quantity-1 WHERE id=?').run(itemId);
    ctx.db.prepare('INSERT INTO items(type_id, quantity, owner_id, holder_kind, holder_id, equipped, condition, stolen, data) VALUES (?,1,?,?,?,?,?,?,?)')
      .run(it.type_id, it.owner_id, 'character', charId, it.slot, it.condition, it.stolen, it.data);
  } else {
    ctx.db.prepare('UPDATE items SET equipped=? WHERE id=?').run(it.slot, itemId);
  }
  return it;
}

export function unequip(ctx, charId, itemId) {
  const it = ctx.db.prepare(`SELECT i.*, t.name FROM items i JOIN item_types t ON t.id=i.type_id WHERE i.id=? AND holder_kind='character' AND holder_id=?`).get(itemId, charId);
  if (!it || !it.equipped) throw new RuleError('not_equipped', 'That is not equipped.');
  ctx.db.prepare('UPDATE items SET equipped=NULL WHERE id=?').run(itemId);
  return it;
}

export function equippedBonus(db, charId, key) {
  const rows = db.prepare(`SELECT t.data FROM items i JOIN item_types t ON t.id=i.type_id WHERE i.holder_kind='character' AND i.holder_id=? AND i.equipped IS NOT NULL`).all(charId);
  return rows.reduce((s, r) => s + (J.parse(r.data, {})[key] || 0), 0);
}

/** Best tool bonus a character holds for a skill (tool:<skill> tag). */
export function toolBonus(db, charId, skill) {
  const rows = db.prepare(`SELECT t.name, t.tags, t.data FROM items i JOIN item_types t ON t.id=i.type_id WHERE i.holder_kind='character' AND i.holder_id=?`).all(charId);
  let best = null;
  for (const r of rows) {
    const tags = J.parse(r.tags, []);
    if (tags.includes(`tool:${skill}`)) {
      const b = J.parse(r.data, {}).tool_bonus || 1;
      if (!best || b > best.value) best = { label: `Tool: ${r.name}`, value: b };
    }
  }
  return best;
}
