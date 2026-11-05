// SQLite persistence: schema, versioned migrations, transactions, backups.
import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';

export const SCHEMA_VERSION = 1;

const MIGRATIONS = {
  1: `
  CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);

  CREATE TABLE locations (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, settlement TEXT, region TEXT, kind TEXT NOT NULL,
    description TEXT NOT NULL, tags TEXT NOT NULL DEFAULT '[]', art TEXT, x REAL, y REAL,
    data TEXT NOT NULL DEFAULT '{}'
  );
  CREATE TABLE routes (
    from_id TEXT NOT NULL REFERENCES locations(id), to_id TEXT NOT NULL REFERENCES locations(id),
    minutes INTEGER NOT NULL CHECK(minutes > 0), mode TEXT NOT NULL DEFAULT 'walk', risk REAL NOT NULL DEFAULT 0,
    cost INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(from_id, to_id)
  );

  CREATE TABLE characters (
    id TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK(kind IN ('player','npc')), name TEXT NOT NULL,
    role TEXT, tier INTEGER NOT NULL DEFAULT 1, location_id TEXT REFERENCES locations(id),
    attributes TEXT NOT NULL, health INTEGER NOT NULL DEFAULT 100 CHECK(health BETWEEN 0 AND 100),
    fatigue INTEGER NOT NULL DEFAULT 0 CHECK(fatigue BETWEEN 0 AND 100),
    last_meal INTEGER NOT NULL DEFAULT 0, alive INTEGER NOT NULL DEFAULT 1,
    traits TEXT NOT NULL DEFAULT '[]', goals TEXT NOT NULL DEFAULT '[]', schedule TEXT NOT NULL DEFAULT '{}',
    persona TEXT NOT NULL DEFAULT '', data TEXT NOT NULL DEFAULT '{}', busy_until INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE factions (id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT NOT NULL, data TEXT NOT NULL DEFAULT '{}');
  CREATE TABLE faction_members (faction_id TEXT NOT NULL REFERENCES factions(id), character_id TEXT NOT NULL REFERENCES characters(id), rank TEXT NOT NULL DEFAULT 'member', PRIMARY KEY(faction_id, character_id));
  CREATE TABLE reputation (faction_id TEXT NOT NULL REFERENCES factions(id), character_id TEXT NOT NULL, value INTEGER NOT NULL DEFAULT 0 CHECK(value BETWEEN -100 AND 100), PRIMARY KEY(faction_id, character_id));

  -- Ledger: balances are a cache of entries; reconciled by tests and the integrity checker.
  CREATE TABLE accounts (
    id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, kind TEXT NOT NULL, name TEXT NOT NULL,
    balance INTEGER NOT NULL DEFAULT 0, allow_negative INTEGER NOT NULL DEFAULT 0,
    CHECK (allow_negative = 1 OR balance >= 0)
  );
  CREATE TABLE ledger_tx (
    id INTEGER PRIMARY KEY, time INTEGER NOT NULL, turn_id INTEGER, kind TEXT NOT NULL, memo TEXT NOT NULL,
    idem_key TEXT UNIQUE
  );
  CREATE TABLE ledger_entries (
    tx_id INTEGER NOT NULL REFERENCES ledger_tx(id), account_id TEXT NOT NULL REFERENCES accounts(id),
    amount INTEGER NOT NULL CHECK(amount <> 0)
  );
  CREATE INDEX ix_entries_account ON ledger_entries(account_id);

  CREATE TABLE item_types (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, category TEXT NOT NULL, base_value INTEGER NOT NULL CHECK(base_value >= 0),
    weight REAL NOT NULL DEFAULT 1, stackable INTEGER NOT NULL DEFAULT 1, commodity INTEGER NOT NULL DEFAULT 0,
    slot TEXT, tags TEXT NOT NULL DEFAULT '[]', description TEXT NOT NULL DEFAULT '', data TEXT NOT NULL DEFAULT '{}',
    created_by TEXT
  );
  CREATE TABLE items (
    id INTEGER PRIMARY KEY, type_id TEXT NOT NULL REFERENCES item_types(id), quantity INTEGER NOT NULL CHECK(quantity > 0),
    owner_id TEXT NOT NULL, holder_kind TEXT NOT NULL CHECK(holder_kind IN ('character','location','business','hidden')),
    holder_id TEXT NOT NULL, equipped TEXT, condition INTEGER NOT NULL DEFAULT 100 CHECK(condition BETWEEN 0 AND 100),
    stolen INTEGER NOT NULL DEFAULT 0, data TEXT NOT NULL DEFAULT '{}'
  );
  CREATE INDEX ix_items_holder ON items(holder_kind, holder_id);
  CREATE TABLE item_log (
    id INTEGER PRIMARY KEY, time INTEGER NOT NULL, turn_id INTEGER, type_id TEXT NOT NULL, delta INTEGER NOT NULL,
    reason TEXT NOT NULL CHECK(reason IN ('init','produce','consume','gather','destroy','transfer')),
    from_holder TEXT, to_holder TEXT, memo TEXT
  );

  CREATE TABLE skills (
    character_id TEXT NOT NULL REFERENCES characters(id), skill TEXT NOT NULL, xp REAL NOT NULL DEFAULT 0 CHECK(xp >= 0),
    rank INTEGER NOT NULL DEFAULT 0 CHECK(rank BETWEEN 0 AND 10), daily_xp REAL NOT NULL DEFAULT 0, daily_day INTEGER NOT NULL DEFAULT -1,
    specialization TEXT, PRIMARY KEY(character_id, skill)
  );
  CREATE TABLE training_log (
    id INTEGER PRIMARY KEY, time INTEGER NOT NULL, character_id TEXT NOT NULL, skill TEXT NOT NULL,
    method TEXT NOT NULL, minutes INTEGER NOT NULL, xp REAL NOT NULL, note TEXT
  );

  CREATE TABLE turns (
    id INTEGER PRIMARY KEY, time_before INTEGER NOT NULL, time_after INTEGER, input TEXT NOT NULL,
    interpretation TEXT, source TEXT, outcome TEXT, narration TEXT, status TEXT NOT NULL DEFAULT 'open',
    created_real TEXT NOT NULL
  );
  CREATE TABLE events (
    id INTEGER PRIMARY KEY, turn_id INTEGER, time INTEGER NOT NULL, kind TEXT NOT NULL, actor_id TEXT, target_id TEXT,
    location_id TEXT, summary TEXT NOT NULL, data TEXT NOT NULL DEFAULT '{}',
    visibility TEXT NOT NULL CHECK(visibility IN ('public','witnessed','private','secret')),
    importance INTEGER NOT NULL DEFAULT 3 CHECK(importance BETWEEN 0 AND 10), cause_id INTEGER
  );
  CREATE INDEX ix_events_time ON events(time);
  CREATE TABLE rolls (
    id INTEGER PRIMARY KEY, turn_id INTEGER, time INTEGER NOT NULL, actor_id TEXT, label TEXT NOT NULL,
    kind TEXT NOT NULL, tn INTEGER, bonus INTEGER, dice TEXT, total INTEGER, margin INTEGER, degree TEXT NOT NULL,
    mods TEXT NOT NULL, probability TEXT NOT NULL, rng_counter INTEGER, opponent TEXT
  );

  CREATE TABLE facts (
    id TEXT PRIMARY KEY, subject TEXT NOT NULL, content TEXT NOT NULL, truth INTEGER NOT NULL CHECK(truth IN (0,1)),
    secrecy INTEGER NOT NULL DEFAULT 0 CHECK(secrecy BETWEEN 0 AND 2), tags TEXT NOT NULL DEFAULT '[]',
    created_at INTEGER NOT NULL DEFAULT 0, data TEXT NOT NULL DEFAULT '{}'
  );
  CREATE TABLE knowledge (
    holder_id TEXT NOT NULL, fact_id TEXT NOT NULL REFERENCES facts(id),
    belief TEXT NOT NULL CHECK(belief IN ('known','rumor','suspected')), confidence REAL NOT NULL CHECK(confidence BETWEEN 0 AND 1),
    source TEXT NOT NULL, source_id TEXT, learned_at INTEGER NOT NULL, PRIMARY KEY(holder_id, fact_id)
  );

  CREATE TABLE memories (
    id INTEGER PRIMARY KEY, owner_id TEXT NOT NULL, time INTEGER NOT NULL, event_id INTEGER,
    kind TEXT NOT NULL CHECK(kind IN ('episodic','summary','semantic')), summary TEXT NOT NULL,
    participants TEXT NOT NULL DEFAULT '[]', location_id TEXT, importance INTEGER NOT NULL CHECK(importance BETWEEN 0 AND 10),
    valence REAL NOT NULL DEFAULT 0, confidence REAL NOT NULL DEFAULT 1, topic TEXT NOT NULL DEFAULT '',
    source TEXT NOT NULL DEFAULT 'witnessed', consolidated INTEGER NOT NULL DEFAULT 0, pinned INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX ix_mem_owner ON memories(owner_id, consolidated);
  CREATE VIRTUAL TABLE memories_fts USING fts5(summary, topic, content='memories', content_rowid='id');
  CREATE TRIGGER mem_ai AFTER INSERT ON memories BEGIN
    INSERT INTO memories_fts(rowid, summary, topic) VALUES (new.id, new.summary, new.topic);
  END;
  CREATE TRIGGER mem_ad AFTER DELETE ON memories BEGIN
    INSERT INTO memories_fts(memories_fts, rowid, summary, topic) VALUES('delete', old.id, old.summary, old.topic);
  END;
  CREATE TRIGGER mem_au AFTER UPDATE OF summary, topic ON memories BEGIN
    INSERT INTO memories_fts(memories_fts, rowid, summary, topic) VALUES('delete', old.id, old.summary, old.topic);
    INSERT INTO memories_fts(rowid, summary, topic) VALUES (new.id, new.summary, new.topic);
  END;

  CREATE TABLE relationships (
    from_id TEXT NOT NULL, to_id TEXT NOT NULL,
    trust INTEGER NOT NULL DEFAULT 0, affection INTEGER NOT NULL DEFAULT 0, respect INTEGER NOT NULL DEFAULT 0,
    fear INTEGER NOT NULL DEFAULT 0, rivalry INTEGER NOT NULL DEFAULT 0, familiarity INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY(from_id, to_id),
    CHECK(trust BETWEEN -100 AND 100 AND affection BETWEEN -100 AND 100 AND respect BETWEEN -100 AND 100
      AND fear BETWEEN 0 AND 100 AND rivalry BETWEEN 0 AND 100 AND familiarity BETWEEN 0 AND 100)
  );
  CREATE TABLE relationship_log (
    id INTEGER PRIMARY KEY, time INTEGER NOT NULL, from_id TEXT NOT NULL, to_id TEXT NOT NULL, dim TEXT NOT NULL,
    delta INTEGER NOT NULL, reason TEXT NOT NULL, event_id INTEGER
  );

  CREATE TABLE contracts (
    id INTEGER PRIMARY KEY, kind TEXT NOT NULL CHECK(kind IN ('employment','loan','rent','request','partnership','investment')),
    party_a TEXT NOT NULL, party_b TEXT NOT NULL, title TEXT NOT NULL, terms TEXT NOT NULL DEFAULT '{}',
    status TEXT NOT NULL CHECK(status IN ('offered','active','completed','breached','defaulted','cancelled')),
    created_at INTEGER NOT NULL, due_at INTEGER, data TEXT NOT NULL DEFAULT '{}'
  );

  CREATE TABLE businesses (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, owner_id TEXT NOT NULL, kind TEXT NOT NULL, location_id TEXT NOT NULL,
    founded_at INTEGER NOT NULL, status TEXT NOT NULL CHECK(status IN ('active','paused','bankrupt','closed')),
    data TEXT NOT NULL DEFAULT '{}'
  );

  CREATE TABLE projects (
    id INTEGER PRIMARY KEY, owner_id TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('research','invention','investigation')),
    title TEXT NOT NULL, description TEXT NOT NULL, skill TEXT NOT NULL, tn INTEGER NOT NULL,
    progress INTEGER NOT NULL DEFAULT 0, required INTEGER NOT NULL CHECK(required > 0),
    status TEXT NOT NULL CHECK(status IN ('active','completed','abandoned')), created_at INTEGER NOT NULL,
    data TEXT NOT NULL DEFAULT '{}'
  );

  CREATE TABLE markets (
    settlement TEXT NOT NULL, type_id TEXT NOT NULL REFERENCES item_types(id), target_stock INTEGER NOT NULL,
    daily_demand INTEGER NOT NULL, price INTEGER NOT NULL CHECK(price >= 0), PRIMARY KEY(settlement, type_id)
  );
  CREATE TABLE price_history (settlement TEXT NOT NULL, type_id TEXT NOT NULL, day INTEGER NOT NULL, price INTEGER NOT NULL, stock INTEGER NOT NULL, PRIMARY KEY(settlement, type_id, day));

  CREATE TABLE plans (
    id INTEGER PRIMARY KEY, turn_id INTEGER, created_at INTEGER NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('pending','confirmed','cancelled','done')), data TEXT NOT NULL
  );
  CREATE TABLE npc_decisions (
    id INTEGER PRIMARY KEY, time INTEGER NOT NULL, npc_id TEXT NOT NULL, decision TEXT NOT NULL, reasons TEXT NOT NULL, outcome TEXT
  );
  CREATE TABLE journal (
    id INTEGER PRIMARY KEY, time INTEGER NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('note','opportunity','consequence','plan','discovery')),
    title TEXT NOT NULL, body TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'open', ref TEXT, UNIQUE(kind, ref)
  );
  `,
};

export function openDatabase(file, { readonly = false } = {}) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new Database(file, { readonly });
  if (file !== ':memory:') db.pragma('journal_mode = WAL');
  db.pragma('synchronous = FULL');
  db.pragma('foreign_keys = ON');
  if (!readonly) migrate(db);
  cacheStatements(db);
  return db;
}

/**
 * better-sqlite3 allocates a native statement for every prepare() call, which is
 * only released when the JS wrapper is garbage-collected. In long simulations the JS
 * heap stays small, GC rarely runs, and native memory grows without bound. Caching
 * statements by SQL text makes memory use flat.
 */
export function cacheStatements(db, max = 2000) {
  if (db._stmtCache) return db;
  const raw = db.prepare.bind(db);
  const cache = new Map();
  db._stmtCache = cache;
  db.prepare = (sql) => {
    let st = cache.get(sql);
    if (!st) {
      st = raw(sql);
      if (cache.size >= max) cache.delete(cache.keys().next().value);
      cache.set(sql, st);
    }
    return st;
  };
  return db;
}

export function migrate(db) {
  let v = db.pragma('user_version', { simple: true });
  if (v > SCHEMA_VERSION) throw new Error(`Save was created by a newer SATURN (schema ${v} > ${SCHEMA_VERSION}).`);
  while (v < SCHEMA_VERSION) {
    const next = v + 1;
    const sql = MIGRATIONS[next];
    if (!sql) throw new Error(`Missing migration ${next}`);
    db.transaction(() => {
      db.exec(sql);
      db.pragma(`user_version = ${next}`);
    })();
    v = next;
  }
}

export function getMeta(db, key, fallback = null) {
  const r = db.prepare('SELECT value FROM meta WHERE key=?').get(key);
  return r ? JSON.parse(r.value) : fallback;
}
export function setMeta(db, key, value) {
  db.prepare('INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, JSON.stringify(value));
}

export const J = {
  parse(s, fallback) {
    if (s == null) return fallback;
    try { return JSON.parse(s); } catch { return fallback; }
  },
  str: (v) => JSON.stringify(v ?? null),
};

/** Online backup of a live database into `dest` (consistent snapshot). */
export async function backupTo(db, dest) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const tmp = dest + '.tmp';
  if (fs.existsSync(tmp)) fs.rmSync(tmp);
  await db.backup(tmp);
  fs.renameSync(tmp, dest);
  return dest;
}

export function integrityCheck(db) {
  return db.pragma('integrity_check', { simple: true });
}
