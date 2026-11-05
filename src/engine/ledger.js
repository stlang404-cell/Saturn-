// Double-entry currency ledger. Every movement of money is a transaction whose
// entries sum to zero. Currency enters the world only through the explicit
// `system:mint` account (wages of the unsimulated wider economy, world creation)
// and leaves only through `system:sink` (taxes and fees paid outside the
// simulation, upkeep). Balances are a cache of the entry sums and are reconciled
// by `reconcile()`.

export class RuleError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.code = code;
    this.details = details;
  }
}

export const MINT = 'system:mint';
export const SINK = 'system:sink';

export function ensureSystemAccounts(db) {
  ensureAccount(db, MINT, { owner: 'system', kind: 'system', name: 'Mint (outside economy)', allowNegative: true });
  ensureAccount(db, SINK, { owner: 'system', kind: 'system', name: 'Sink (outside economy)', allowNegative: true });
}

export function ensureAccount(db, id, { owner, kind, name, allowNegative = false }) {
  db.prepare('INSERT OR IGNORE INTO accounts(id, owner_id, kind, name, balance, allow_negative) VALUES (?,?,?,?,0,?)')
    .run(id, owner ?? id, kind, name ?? id, allowNegative ? 1 : 0);
  return id;
}

export function balance(db, id) {
  const r = db.prepare('SELECT balance FROM accounts WHERE id=?').get(id);
  return r ? r.balance : 0;
}

export function hasAccount(db, id) {
  return !!db.prepare('SELECT 1 FROM accounts WHERE id=?').get(id);
}

/**
 * Atomically move `amount` from one account to another.
 * Throws RuleError('insufficient_funds') rather than allowing an unauthorised negative balance.
 * If `idem` is given and a transaction with that key already exists, nothing happens (returns existing id).
 */
export function transfer(ctx, { from, to, amount, kind = 'transfer', memo = '', idem = null }) {
  const { db } = ctx;
  if (!Number.isInteger(amount) || amount <= 0) throw new RuleError('bad_amount', `Invalid amount: ${amount}`);
  if (from === to) throw new RuleError('bad_transfer', 'Cannot transfer to the same account');
  if (idem) {
    const prev = db.prepare('SELECT id FROM ledger_tx WHERE idem_key=?').get(idem);
    if (prev) return { txId: prev.id, duplicate: true };
  }
  const src = db.prepare('SELECT balance, allow_negative, name FROM accounts WHERE id=?').get(from);
  const dst = db.prepare('SELECT 1 FROM accounts WHERE id=?').get(to);
  if (!src) throw new RuleError('no_account', `No account ${from}`);
  if (!dst) throw new RuleError('no_account', `No account ${to}`);
  if (!src.allow_negative && src.balance < amount) {
    throw new RuleError('insufficient_funds', `${src.name} has ${src.balance} but needs ${amount}.`, { have: src.balance, need: amount, account: from });
  }
  const run = () => {
    const tx = db.prepare('INSERT INTO ledger_tx(time, turn_id, kind, memo, idem_key) VALUES (?,?,?,?,?)')
      .run(ctx.time ?? 0, ctx.turnId ?? null, kind, memo, idem);
    const txId = Number(tx.lastInsertRowid);
    db.prepare('INSERT INTO ledger_entries(tx_id, account_id, amount) VALUES (?,?,?)').run(txId, from, -amount);
    db.prepare('INSERT INTO ledger_entries(tx_id, account_id, amount) VALUES (?,?,?)').run(txId, to, amount);
    db.prepare('UPDATE accounts SET balance = balance - ? WHERE id=?').run(amount, from);
    db.prepare('UPDATE accounts SET balance = balance + ? WHERE id=?').run(amount, to);
    return { txId };
  };
  return db.inTransaction ? run() : db.transaction(run)();
}

export function mint(ctx, { to, amount, memo, kind = 'mint', idem }) {
  return transfer(ctx, { from: MINT, to, amount, kind, memo, idem });
}
export function burn(ctx, { from, amount, memo, kind = 'sink', idem }) {
  return transfer(ctx, { from, to: SINK, amount, kind, memo, idem });
}

/** Verify every cached balance equals the sum of its entries and every transaction sums to zero. */
export function reconcile(db) {
  const problems = [];
  const rows = db.prepare(`SELECT a.id, a.balance, COALESCE(SUM(e.amount),0) AS s
    FROM accounts a LEFT JOIN ledger_entries e ON e.account_id=a.id GROUP BY a.id`).all();
  for (const r of rows) if (r.balance !== r.s) problems.push({ type: 'balance_mismatch', account: r.id, cached: r.balance, entries: r.s });
  const bad = db.prepare('SELECT tx_id, SUM(amount) s FROM ledger_entries GROUP BY tx_id HAVING s <> 0').all();
  for (const b of bad) problems.push({ type: 'unbalanced_tx', tx: b.tx_id, sum: b.s });
  const neg = db.prepare('SELECT id, balance FROM accounts WHERE allow_negative=0 AND balance<0').all();
  for (const n of neg) problems.push({ type: 'negative_balance', account: n.id, balance: n.balance });
  const total = db.prepare('SELECT COALESCE(SUM(balance),0) t FROM accounts').get().t;
  if (total !== 0) problems.push({ type: 'money_not_conserved', total });
  return problems;
}

/** Money supply held by simulated entities = minted - sunk. */
export function moneySupply(db) {
  return db.prepare("SELECT COALESCE(SUM(balance),0) t FROM accounts WHERE kind <> 'system'").get().t;
}

export function recentTransactions(db, accountId, limit = 30) {
  return db.prepare(`SELECT t.id, t.time, t.kind, t.memo, e.amount FROM ledger_entries e JOIN ledger_tx t ON t.id=e.tx_id
    WHERE e.account_id=? ORDER BY t.id DESC LIMIT ?`).all(accountId, limit);
}
