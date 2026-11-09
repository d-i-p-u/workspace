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
