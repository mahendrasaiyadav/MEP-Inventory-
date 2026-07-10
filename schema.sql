-- MEP Inventory — D1 schema
-- Run once in Cloudflare dashboard: D1 → mep-db → Console tab → paste all → Run.

CREATE TABLE IF NOT EXISTS engineers (
  name_key    TEXT PRIMARY KEY,   -- lowercase name, unique per engineer
  name        TEXT NOT NULL,
  designation TEXT,
  deleted     INTEGER NOT NULL DEFAULT 0,
  updated_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS transactions (
  id            TEXT PRIMARY KEY,  -- client-generated unique id
  date          TEXT,
  time          TEXT,
  engineer      TEXT,
  cat           TEXT,
  desc          TEXT,
  spec          TEXT,
  uom           TEXT,
  qty           REAL,
  stock_before  REAL,
  stock_after   REAL,
  remarks       TEXT,
  created_at    INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS settings (
  key         TEXT PRIMARY KEY,
  value       TEXT,
  updated_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS materials_meta (
  id          INTEGER PRIMARY KEY CHECK (id = 1),
  version     INTEGER NOT NULL DEFAULT 0,
  updated_at  INTEGER
);

INSERT OR IGNORE INTO materials_meta (id, version, updated_at) VALUES (1, 0, 0);
