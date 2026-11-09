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
  ip            TEXT,
  user_agent    TEXT
);
CREATE INDEX IF NOT EXISTS idx_orders_created ON orders (created_at);
CREATE INDEX IF NOT EXISTS idx_orders_phone ON orders (phone, created_at);
