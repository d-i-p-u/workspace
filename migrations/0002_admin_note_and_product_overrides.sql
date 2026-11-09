-- Run once on databases created before November 2026:
-- npx wrangler d1 execute oddkult-orders --remote --file=migrations/0002_admin_note_and_product_overrides.sql
ALTER TABLE orders ADD COLUMN admin_note TEXT;
CREATE TABLE IF NOT EXISTS product_overrides (
  product_id TEXT PRIMARY KEY,
  price      INTEGER,
  active     INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT
);
