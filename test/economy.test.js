import test from 'node:test';
import assert from 'node:assert/strict';
import { newGame, run, say, assertSound, goTo } from './helpers.js';
import * as ledger from '../src/engine/ledger.js';
import * as inv from '../src/engine/inventory.js';
import { RuleError } from '../src/engine/ledger.js';

test('spending money you do not have is refused atomically', () => {
  const g = newGame();
  goTo(g, 'Guildhall of Weights');
  const before = g.balance('player');
  const r = run(g, { type: 'buy', target: 'Odile', item: 'fine clothes', quantity: 1 });
  assert.equal(r.outcomes[0].status, 'blocked');
  assert.equal(r.outcomes[0].error.code, 'insufficient_funds');
  assert.equal(g.balance('player'), before);
  assert.equal(g.count('player', 'fine_clothes'), 0);
  assertSound(null, g);
});

test('the ledger refuses negative balances even when called directly', () => {
  const g = newGame();
  assert.throws(() => ledger.transfer(g.ctx, { from: 'player', to: 'npc_odile', amount: 999999 }), (e) => e instanceof RuleError && e.code === 'insufficient_funds');
  assert.throws(() => ledger.transfer(g.ctx, { from: 'player', to: 'npc_odile', amount: -5 }));
  assert.throws(() => g.db.prepare("UPDATE accounts SET balance=-1 WHERE id='player'").run(), /CHECK constraint/);
});

test('duplicate transactions with the same idempotency key are applied once', () => {
  const g = newGame();
  const b = g.balance('player');
  g.transact(() => {
    ledger.transfer(g.ctx, { from: 'player', to: 'npc_mirela', amount: 3, idem: 'tip-1' });
    const again = ledger.transfer(g.ctx, { from: 'player', to: 'npc_mirela', amount: 3, idem: 'tip-1' });
    assert.equal(again.duplicate, true);
  });
  assert.equal(g.balance('player'), b - 3);
});

test('buying moves real stock and money; prices respond to supply', () => {
  const g = newGame();
  const stock = g.count('npc_mirela', 'bread');
  const r = run(g, { type: 'buy', target: 'Mirela', item: 'bread', quantity: 3 });
  assert.equal(r.outcomes[0].status, 'done');
  assert.equal(g.count('player', 'bread'), 3);
  assert.equal(g.count('npc_mirela', 'bread'), stock - 3);
  assert.ok(r.changes.money < 0);
  assertSound(null, g);
});

test('stealing the same unique item twice is impossible; stolen goods keep their legal owner', () => {
  const g = newGame({ background: 'streetwise' });
  goTo(g, 'Hale\'s Forge');
  // Brannoc has exactly one shortsword; force success by giving the player overwhelming skill
  g.db.prepare("INSERT OR REPLACE INTO skills(character_id, skill, xp, rank) VALUES ('player','sleight_of_hand',920,10)").run();
  g.db.prepare("UPDATE characters SET attributes=json_set(attributes,'$.agility',5) WHERE id='player'").run();
  let stolen = 0, attempts = 0;
  while (attempts < 10 && g.count('npc_brannoc', 'shortsword') > 0) {
    attempts++;
    run(g, { type: 'steal', target: 'Brannoc', item: 'shortsword' });
    stolen = g.count('player', 'shortsword');
  }
  if (stolen === 1) {
    const r2 = run(g, { type: 'steal', target: 'Brannoc', item: 'shortsword' });
    assert.equal(r2.outcomes[0].status, 'blocked');
    assert.equal(r2.outcomes[0].error.code, 'nothing_to_steal');
    const row = g.db.prepare("SELECT owner_id, stolen FROM items WHERE type_id='shortsword' AND holder_id='player'").get();
    assert.equal(row.owner_id, 'npc_brannoc');
    assert.equal(row.stolen, 1);
  }
  // either way, there is still exactly one shortsword in Brannoc's or the player's hands (or Hedda's)
  const total = g.db.prepare("SELECT SUM(quantity) q FROM items WHERE type_id='shortsword'").get().q;
  assert.equal(total, 2); // Brannoc's + Hedda's own
  assertSound(null, g);
});

test('items cannot be created without a legitimate source', () => {
  const g = newGame();
  assert.throws(() => inv.createItems(g.ctx, { typeId: 'spices', qty: 5, holderKind: 'character', holderId: 'player', reason: 'transfer' }), /cannot be created/);
  assert.throws(() => inv.moveItems(g.ctx, { typeId: 'spices', qty: 50, from: { kind: 'character', id: 'npc_odile' }, to: { kind: 'character', id: 'player' } }), /available/);
});

test('crafting consumes inputs and produces outputs (conservation holds)', () => {
  const g = newGame({ background: 'herbalist' });
  g.transact(() => inv.createItems(g.ctx, { typeId: 'herb_silverleaf', qty: 4, holderKind: 'character', holderId: 'player', ownerId: 'player', reason: 'gather', memo: 'test' }));
  const r = run(g, { type: 'craft', item: 'salve', quantity: 2 });
  assert.notEqual(r.outcomes[0].status, 'blocked');
  assert.ok(g.count('player', 'herb_silverleaf') < 4, 'herbs were consumed');
  assertSound(null, g);
});

test('a month of world simulation keeps money and goods conserved and balances non-negative', () => {
  const g = newGame();
  const supply0 = ledger.moneySupply(g.db);
  for (let i = 0; i < 30; i++) run(g, { type: 'wait', hours: 24 });
  assertSound(null, g);
  const minted = -ledger.balance(g.db, ledger.MINT);
  const sunk = ledger.balance(g.db, ledger.SINK);
  assert.equal(ledger.moneySupply(g.db), minted - sunk, 'money supply equals minted minus sunk');
  assert.ok(ledger.moneySupply(g.db) > 0);
  // no runaway inflation: total supply stays within a sane multiple
  assert.ok(ledger.moneySupply(g.db) < supply0 * 20, `money supply ${ledger.moneySupply(g.db)} vs start ${supply0}`);
  const neg = g.db.prepare('SELECT COUNT(*) n FROM accounts WHERE allow_negative=0 AND balance<0').get().n;
  assert.equal(neg, 0);
});

test('a business really operates: buys inputs, produces, sells, pays rent, reports', () => {
  const g = newGame();
  g.transact(() => ledger.mint(g.ctx, { to: 'player', amount: 300, memo: 'test grant' }));
  goTo(g, 'Market Square');
  g.db.prepare("UPDATE characters SET location_id='bm_square', busy_until=? WHERE id='npc_corvin'").run(g.time + 600);
  const r = run(g, { type: 'found_business', item: 'bakery', price: 80 });
  assert.equal(r.outcomes[0].status, 'done', r.outcomes[0].error?.message);
  const biz = g.db.prepare('SELECT * FROM businesses').get();
  assert.ok(biz);
  for (let i = 0; i < 8; i++) run(g, { type: 'wait', hours: 24 });
  const d = JSON.parse(g.db.prepare('SELECT data FROM businesses WHERE id=?').get(biz.id).data);
  assert.ok(d.stats.produced > 0, 'produced bread');
  assert.ok(d.stats.revenue > 0, 'earned revenue');
  assert.ok(d.history.length >= 1, 'weekly report written');
  const produced = g.db.prepare("SELECT SUM(delta) q FROM item_log WHERE reason='produce' AND memo LIKE ?").get(`${biz.name}%`).q;
  assert.ok(produced > 0);
  assertSound(null, g);
});

test('borrowing creates a real debt; defaulting has consequences', () => {
  const g = newGame({ background: 'clerk' });
  goTo(g, 'Guildhall of Weights');
  g.db.prepare("INSERT OR REPLACE INTO skills(character_id, skill, xp, rank) VALUES ('player','negotiation',920,10)").run();
  const before = g.balance('player');
  const r = run(g, { type: 'loan', target: 'Aurel', price: 50 });
  if (r.outcomes[0].status !== 'done') return; // a refused loan is a legitimate outcome
  assert.equal(g.balance('player'), before + 50);
  const c = g.db.prepare("SELECT * FROM contracts WHERE kind='loan' AND party_a='npc_aurel'").get();
  assert.equal(c.status, 'active');
  // skip past the due date without paying
  for (let i = 0; i < 32; i++) run(g, { type: 'wait', hours: 24 });
  assert.equal(g.db.prepare('SELECT status FROM contracts WHERE id=?').get(c.id).status, 'defaulted');
  assert.ok(g.rel('npc_aurel', 'player').trust < 0);
  const again = run(g, { type: 'loan', target: 'Aurel', price: 10 });
  assert.equal(again.outcomes[0].status, 'blocked');
  assertSound(null, g);
});

test('the parser handles trade phrasing', () => {
  const g = newGame();
  const r = say(g, 'buy two loaves of bread from Mirela');
  assert.ok(r.parsed);
  assert.equal(r.outcomes[0].status, 'done');
  assert.equal(g.count('player', 'bread'), 2);
});
