CREATE TABLE IF NOT EXISTS orders (
  id            TEXT PRIMARY KEY,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT,
  name          TEXT NOT NULL,
  phone         TEXT NOT NULL,
  alt_phone     TEXT,
  zone          TEXT NOT NULL,           -- 'inside' | 'outside' (Dhaka)
  district      TEXT,
  address       TEXT NOT NULL,
  note          TEXT,
  items_json    TEXT NOT NULL,
  items_summary TEXT NOT NULL,
  item_count    INTEGER NOT NULL,
  subtotal      INTEGER NOT NULL,
  delivery      INTEGER NOT NULL,
  total         INTEGER NOT NULL,
  payment       TEXT NOT NULL DEFAULT 'COD',
  status        TEXT NOT NULL DEFAULT 'new',
  admin_note    TEXT,
  ip            TEXT,
  user_agent    TEXT
);
CREATE INDEX IF NOT EXISTS idx_orders_created ON orders (created_at);
CREATE INDEX IF NOT EXISTS idx_orders_phone ON orders (phone, created_at);

-- Price / visibility overrides edited from the Google Sheet or admin tools
CREATE TABLE IF NOT EXISTS product_overrides (
  product_id TEXT PRIMARY KEY,
  price      INTEGER,
  active     INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT
);

CREATE TABLE IF NOT EXISTS products (id TEXT PRIMARY KEY, name TEXT NOT NULL, type TEXT, collection TEXT NOT NULL, price INTEGER NOT NULL, compare_at INTEGER, badge TEXT, tagline TEXT, description TEXT, details TEXT, variants TEXT NOT NULL, stock INTEGER, active INTEGER NOT NULL DEFAULT 1, sort INTEGER NOT NULL DEFAULT 0, created_at TEXT, updated_at TEXT);
CREATE TABLE IF NOT EXISTS collections (id TEXT PRIMARY KEY, name TEXT NOT NULL, blurb TEXT, cover TEXT, sort INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE IF NOT EXISTS images (id TEXT PRIMARY KEY, content_type TEXT NOT NULL, data BLOB NOT NULL, created_at TEXT);
-- then seed with migrations/0003_catalogue_in_d1.sql
