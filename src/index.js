// ODDKULT storefront worker (Cloudflare Workers + D1)
//
// Public
//   GET  /api/catalog                 live catalogue: products, collections, delivery charges, store settings
//   POST /api/orders                  Cash-on-Delivery order (priced and stock-checked on the server)
//   GET  /api/track?id=&phone=        order status for customers
//   GET  /img/u/:id                   images uploaded from the admin panel
// Admin (?key= or x-admin-key header)
//   GET  /api/orders, /api/orders.csv           order list (JSON / CSV for Excel)
//   PATCH /api/orders/:id                       status and/or admin_note (stock follows cancellations)
//   GET/POST /api/admin/products, PUT/DELETE /api/admin/products/:id
//   PATCH /api/products/:id                     quick edits: price, compare_at, stock, active
//   GET/PUT /api/admin/collections, GET/PUT /api/admin/settings
//   POST /api/admin/images                      raw image body → stored in D1
//   GET /api/sheet, PATCH /api/sheet/:tab/:id   Google Sheets two-way sync
// Optional secret ORDER_WEBHOOK_URL: every new order is POSTed as JSON.

import seed from "../public/data/products.json";

const STATUSES = ["new", "confirmed", "shipped", "delivered", "cancelled", "returned"];
const INACTIVE = new Set(["cancelled", "returned"]);
const BD_PHONE = /^(?:\+?88)?01[3-9]\d{8}$/;
const DEFAULT_SETTINGS = {
  delivery_inside: String(seed.delivery.insideDhaka),
  delivery_outside: String(seed.delivery.outsideDhaka),
  free_over: String(seed.delivery.freeOver),
  phone: "01707680854",
  whatsapp: "8801707680854",
  instagram: "",
  facebook: "",
  announcement: "",
};

const json = (data, status = 200, extra = {}) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...extra },
  });
const bad = (msg, status = 400) => json({ error: msg }, status);
const clean = (v, max = 200) => String(v ?? "").replace(/[\u0000-\u001f]/g, " ").trim().slice(0, max);
const int = (v) => {
  if (v === null || v === undefined || String(v).trim() === "") return null;
  const n = Math.round(Number(String(v).replace(/[^\d.-]/g, "")));
  return Number.isFinite(n) ? n : NaN;
};
const slugify = (s) =>
  String(s || "").toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48);

function normalisePhone(p) {
  const digits = String(p || "").replace(/[^\d+]/g, "");
  if (!BD_PHONE.test(digits)) return null;
  return "0" + digits.slice(-10);
}

function isAdmin(request, env) {
  const url = new URL(request.url);
  const key = url.searchParams.get("key") || request.headers.get("x-admin-key") || "";
  return Boolean(env.ADMIN_KEY) && key.length > 0 && timingSafeEqual(key, env.ADMIN_KEY);
}
function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

/* ------------------------------------------------------------------ security */

const SITE = "https://oddkult.com";
const CSP_SITE =
  "default-src 'self'; script-src 'self' https://static.cloudflareinsights.com; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; " +
  "font-src 'self' https://fonts.gstatic.com; img-src 'self' data: blob:; connect-src 'self' https://cloudflareinsights.com; " +
  "frame-ancestors 'none'; base-uri 'self'; form-action 'self'; object-src 'none'; upgrade-insecure-requests";
const SECURITY_HEADERS = {
  "strict-transport-security": "max-age=31536000; includeSubDomains",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
  "referrer-policy": "strict-origin-when-cross-origin",
  "permissions-policy": "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
  "cross-origin-opener-policy": "same-origin",
};
function secure(res, { html = false } = {}) {
  const r = new Response(res.body, res);
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) r.headers.set(k, v);
  if (html || (r.headers.get("content-type") || "").includes("text/html")) r.headers.set("content-security-policy", CSP_SITE);
  return r;
}
const clientIP = (request) => request.headers.get("cf-connecting-ip") || "unknown";

// Fixed-window counter in D1. Returns true when `key` has gone over `limit` within `windowSec`.
async function overLimit(env, key, limit, windowSec, { count = true } = {}) {
  const now = Math.floor(Date.now() / 1000);
  if (!count) {
    const r = await env.DB.prepare("SELECT n, reset FROM rate_limits WHERE k = ?1").bind(key).first();
    return Boolean(r && r.reset >= now && r.n > limit);
  }
  const r = await env.DB.prepare(
    `INSERT INTO rate_limits (k, n, reset) VALUES (?1, 1, ?2)
     ON CONFLICT(k) DO UPDATE SET n = CASE WHEN reset < ?3 THEN 1 ELSE n + 1 END,
                                  reset = CASE WHEN reset < ?3 THEN ?2 ELSE reset END
     RETURNING n`
  )
    .bind(key, now + windowSec, now)
    .first();
  return Boolean(r && r.n > limit);
}

// Text that starts with = + - @ would run as a formula in Excel / Google Sheets.
const sheetSafe = (v) => (typeof v === "string" && /^[=+\-@\t\r]/.test(v) ? "'" + v : v);
const SAFE_IMAGE = /^(u\/[a-z0-9]+\.(webp|jpg|png)|[a-z0-9][a-z0-9._-]{0,60})$/i;

// D1 stores UTC ("YYYY-MM-DD HH:MM:SS"); Bangladesh is UTC+6 with no daylight saving.
export function toBangladeshTime(utc) {
  const d = new Date(String(utc).replace(" ", "T") + "Z");
  if (Number.isNaN(d.getTime())) return String(utc ?? "");
  return new Date(d.getTime() + 6 * 3600 * 1000).toISOString().slice(0, 16).replace("T", " ");
}

/* ------------------------------------------------------------------ first-run setup */

// Creates the catalogue tables and fills them from products.json the first time (idempotent).
let seeded = null;
function ensureSeeded(env) {
  if (!seeded) seeded = seedOnce(env).catch((e) => { seeded = null; console.error("seed failed", e); });
  return seeded;
}
async function seedOnce(env) {
  await env.DB.batch([
    env.DB.prepare("CREATE TABLE IF NOT EXISTS products (id TEXT PRIMARY KEY, name TEXT NOT NULL, type TEXT, collection TEXT NOT NULL, price INTEGER NOT NULL, compare_at INTEGER, badge TEXT, tagline TEXT, description TEXT, details TEXT, variants TEXT NOT NULL, stock INTEGER, active INTEGER NOT NULL DEFAULT 1, sort INTEGER NOT NULL DEFAULT 0, created_at TEXT, updated_at TEXT)"),
    env.DB.prepare("CREATE TABLE IF NOT EXISTS collections (id TEXT PRIMARY KEY, name TEXT NOT NULL, blurb TEXT, cover TEXT, sort INTEGER NOT NULL DEFAULT 0)"),
    env.DB.prepare("CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT)"),
    env.DB.prepare("CREATE TABLE IF NOT EXISTS images (id TEXT PRIMARY KEY, content_type TEXT NOT NULL, data BLOB NOT NULL, created_at TEXT)"),
    env.DB.prepare("CREATE TABLE IF NOT EXISTS rate_limits (k TEXT PRIMARY KEY, n INTEGER NOT NULL, reset INTEGER NOT NULL)"),
  ]);
  const done = await env.DB.prepare("SELECT value FROM settings WHERE key = 'catalogue_seeded'").first();
  if (done) return;
  const overrides = new Map();
  try {
    const { results } = await env.DB.prepare("SELECT product_id, price, active FROM product_overrides").all();
    for (const r of results) overrides.set(r.product_id, r);
  } catch { /* older table not present */ }
  await env.DB.batch([
    ...seed.collections.map((c, i) =>
      env.DB.prepare("INSERT OR IGNORE INTO collections (id, name, blurb, cover, sort) VALUES (?1, ?2, ?3, ?4, ?5)").bind(c.id, c.name, c.blurb || "", c.cover || null, i)
    ),
    ...seed.products.map((p, i) => {
      const o = overrides.get(p.id) || {};
      return env.DB.prepare(
        `INSERT OR IGNORE INTO products (id, name, type, collection, price, compare_at, badge, tagline, description, details, variants, stock, active, sort, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, NULL, ?6, ?7, ?8, ?9, ?10, NULL, ?11, ?12, datetime('now'), datetime('now'))`
      ).bind(p.id, p.name, p.type || "", p.collection, o.price ?? p.price, p.badge || "", p.tagline || "", p.description || "",
        JSON.stringify(p.details || []), JSON.stringify(p.variants), o.active === 0 ? 0 : 1, i);
    }),
    ...Object.entries({ phone: DEFAULT_SETTINGS.phone, whatsapp: DEFAULT_SETTINGS.whatsapp }).map(([k, v]) =>
      env.DB.prepare("INSERT OR IGNORE INTO settings (key, value) VALUES (?1, ?2)").bind(k, v)
    ),
    env.DB.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('catalogue_seeded', datetime('now'))"),
  ]);
}

/* ------------------------------------------------------------------ catalogue */

function rowToProduct(r) {
  return {
    id: r.id,
    name: r.name,
    type: r.type || "",
    collection: r.collection,
    price: r.price,
    compareAt: r.compare_at ?? null,
    badge: r.badge || "",
    tagline: r.tagline || "",
    description: r.description || "",
    details: safeJSON(r.details, []),
    variants: safeJSON(r.variants, []),
    stock: r.stock ?? null,
    active: r.active !== 0,
    sort: r.sort ?? 0,
    updated_at: r.updated_at || "",
  };
}
function safeJSON(s, d) {
  try {
    return s ? JSON.parse(s) : d;
  } catch {
    return d;
  }
}

async function getSettings(env) {
  const out = { ...DEFAULT_SETTINGS };
  try {
    const { results } = await env.DB.prepare("SELECT key, value FROM settings").all();
    for (const r of results) out[r.key] = r.value;
  } catch {
    /* table missing: defaults */
  }
  return out;
}

async function loadProducts(env, { includeHidden = false } = {}) {
  try {
    const { results } = await env.DB.prepare(
      `SELECT * FROM products ${includeHidden ? "" : "WHERE active = 1"} ORDER BY sort, created_at`
    ).all();
    if (results.length || includeHidden) return results.map(rowToProduct);
  } catch {
    /* table missing */
  }
  // Fallback before the database is seeded.
  return seed.products.map((p, i) => ({ ...p, compareAt: null, stock: null, active: true, sort: i }));
}

async function loadCollections(env) {
  try {
    const { results } = await env.DB.prepare("SELECT id, name, blurb, cover FROM collections ORDER BY sort, name").all();
    if (results.length) return results.map((c) => ({ id: c.id, name: c.name, blurb: c.blurb || "", cover: c.cover || undefined }));
  } catch {
    /* table missing */
  }
  return seed.collections;
}

export async function getCatalog(env, opts = {}) {
  const [products, collections, settings] = await Promise.all([loadProducts(env, opts), loadCollections(env), getSettings(env)]);
  return {
    currency: "BDT",
    sizes: seed.sizes,
    delivery: {
      insideDhaka: Number(settings.delivery_inside) || 0,
      outsideDhaka: Number(settings.delivery_outside) || 0,
      freeOver: Number(settings.free_over) || 0,
    },
    store: {
      phone: settings.phone,
      whatsapp: settings.whatsapp,
      instagram: settings.instagram,
      facebook: settings.facebook,
      announcement: settings.announcement,
    },
    collections,
    products,
  };
}

// Price an order using the catalogue only; the browser's prices are never trusted.
export function priceOrder(items, zone, cat) {
  if (!Array.isArray(items) || items.length === 0) throw new Error("Your bag is empty.");
  if (items.length > 20) throw new Error("Too many line items.");
  const sizes = new Set(cat.sizes.map((s) => s.id));
  const wanted = new Map();
  const lines = items.map((it) => {
    const product = cat.products.find((p) => p.id === it.productId);
    if (!product) throw new Error("One of the items is no longer available. Please remove it from your bag.");
    const variant = product.variants.find((v) => v.id === it.variantId);
    if (!variant) throw new Error(`Unknown colour for ${product.name}.`);
    if (!sizes.has(it.size)) throw new Error(`Pick a size for ${product.name}.`);
    const qty = Math.trunc(Number(it.qty));
    if (!(qty >= 1 && qty <= 10)) throw new Error("Quantity must be 1–10.");
    wanted.set(product.id, (wanted.get(product.id) || 0) + qty);
    if (product.stock !== null && product.stock !== undefined && wanted.get(product.id) > product.stock) {
      throw new Error(product.stock > 0 ? `Only ${product.stock} left of ${product.name}.` : `${product.name} is sold out.`);
    }
    const unit = variant.price ?? product.price;
    return {
      productId: product.id,
      variantId: variant.id,
      name: `${product.name} ${product.type}`.trim(),
      color: variant.name,
      size: it.size,
      qty,
      unit,
      total: unit * qty,
    };
  });
  const subtotal = lines.reduce((s, l) => s + l.total, 0);
  const d = cat.delivery;
  const delivery = d.freeOver && subtotal >= d.freeOver ? 0 : zone === "inside" ? d.insideDhaka : d.outsideDhaka;
  return { lines, subtotal, delivery, total: subtotal + delivery };
}

async function adjustStock(env, lines, sign) {
  const stmts = lines.map((l) =>
    env.DB.prepare("UPDATE products SET stock = MAX(stock + ?1, 0), updated_at = datetime('now') WHERE id = ?2 AND stock IS NOT NULL").bind(
      sign * l.qty,
      l.productId
    )
  );
  if (stmts.length) await env.DB.batch(stmts);
}

/* ------------------------------------------------------------------ orders */

function orderId() {
  const t = Date.now().toString(36).toUpperCase().slice(-5);
  const r = crypto.getRandomValues(new Uint8Array(2));
  return `OK-${t}${((r[0] << 8) | r[1]).toString(36).toUpperCase().padStart(3, "0")}`;
}

async function createOrder(request, env, ctx) {
  // JSON only: blocks cross-site form posts (a form can't send application/json without a CORS preflight)
  if (!(request.headers.get("content-type") || "").toLowerCase().startsWith("application/json")) return bad("Invalid request.", 415);
  if (Number(request.headers.get("content-length") || 0) > 20000) return bad("Request too large.", 413);
  if (await overLimit(env, `order:${clientIP(request)}`, 15, 3600)) return bad("Too many orders from this device. Please call or WhatsApp us.", 429);
  let body;
  try {
    body = await request.json();
  } catch {
    return bad("Invalid request.");
  }
  if (body.website) return json({ ok: true, id: "OK-THANKS" }); // honeypot

  const name = clean(body.name, 80);
  const phone = normalisePhone(body.phone);
  const altPhone = body.altPhone ? normalisePhone(body.altPhone) : "";
  const zone = body.zone === "inside" ? "inside" : "outside";
  const district = clean(body.district, 60);
  const address = clean(body.address, 400);
  const note = clean(body.note, 300);

  if (name.length < 2) return bad("Please enter your name.");
  if (!phone) return bad("Enter a valid Bangladeshi mobile number (01XXXXXXXXX).");
  if (body.altPhone && !altPhone) return bad("Alternate number looks wrong.");
  if (address.length < 8) return bad("Please write your full delivery address.");
  if (zone === "outside" && district.length < 2) return bad("Please choose your district.");

  let priced;
  try {
    priced = priceOrder(body.items, zone, await getCatalog(env));
  } catch (e) {
    return bad(e.message);
  }

  const recent = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM orders WHERE phone = ?1 AND created_at > datetime('now','-1 hour')"
  )
    .bind(phone)
    .first();
  if (recent && recent.n >= 5) return bad("Too many orders from this number. Please call us.", 429);

  const id = orderId();
  const itemsSummary = priced.lines.map((l) => `${l.qty}× ${l.name} (${l.color}, ${l.size})`).join("; ");
  const itemCount = priced.lines.reduce((s, l) => s + l.qty, 0);
  await env.DB.prepare(
    `INSERT INTO orders (id, name, phone, alt_phone, zone, district, address, note, items_json, items_summary,
                         item_count, subtotal, delivery, total, payment, status, ip, user_agent)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, 'COD', 'new', ?15, ?16)`
  )
    .bind(
      id, name, phone, altPhone || "", zone, zone === "inside" ? "Dhaka" : district, address, note,
      JSON.stringify(priced.lines), itemsSummary, itemCount, priced.subtotal, priced.delivery, priced.total,
      request.headers.get("cf-connecting-ip") || "", clean(request.headers.get("user-agent"), 200)
    )
    .run();
  await adjustStock(env, priced.lines, -1);

  if (env.ORDER_WEBHOOK_URL) {
    ctx.waitUntil(
      fetch(env.ORDER_WEBHOOK_URL, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          id, name, phone, alt_phone: altPhone || "", zone: zone === "inside" ? "Inside Dhaka" : "Outside Dhaka",
          district: zone === "inside" ? "Dhaka" : district, address, note, items: itemsSummary, item_count: itemCount,
          subtotal: priced.subtotal, delivery: priced.delivery, total: priced.total, payment: "Cash on Delivery", status: "new",
        }),
      }).catch(() => {})
    );
  }
  return json({ ok: true, id, total: priced.total, delivery: priced.delivery, subtotal: priced.subtotal });
}

const COLUMNS = [
  ["id", "Order ID"],
  ["created_bd", "Date (Bangladesh time)"],
  ["status", "Status"],
  ["name", "Customer"],
  ["phone", "Phone"],
  ["alt_phone", "Alt Phone"],
  ["zone", "Zone"],
  ["district", "District"],
  ["address", "Address"],
  ["items_summary", "Items"],
  ["item_count", "Qty"],
  ["subtotal", "Subtotal (BDT)"],
  ["delivery", "Delivery (BDT)"],
  ["total", "COD Total (BDT)"],
  ["payment", "Payment"],
  ["note", "Customer note"],
  ["admin_note", "Admin note"],
  ["updated_bd", "Last updated"],
];

async function listOrders(env, url) {
  const status = url.searchParams.get("status");
  const limit = Math.min(Number(url.searchParams.get("limit")) || 2000, 10000);
  const q =
    status && STATUSES.includes(status)
      ? env.DB.prepare("SELECT * FROM orders WHERE status = ?1 ORDER BY created_at DESC LIMIT ?2").bind(status, limit)
      : env.DB.prepare("SELECT * FROM orders ORDER BY created_at DESC LIMIT ?1").bind(limit);
  const { results } = await q.all();
  return results.map((r) => ({
    ...r,
    created_bd: toBangladeshTime(r.created_at),
    updated_bd: r.updated_at ? toBangladeshTime(r.updated_at) : "",
    admin_note: r.admin_note || "",
    zone: r.zone === "inside" ? "Inside Dhaka" : "Outside Dhaka",
    items: safeJSON(r.items_json, []),
  }));
}

async function updateOrder(env, id, body) {
  const order = await env.DB.prepare("SELECT status, items_json FROM orders WHERE id = ?1").bind(id).first();
  if (!order) return bad("Order not found", 404);
  const sets = [];
  const args = [];
  let newStatus = null;
  if (body.status !== undefined) {
    newStatus = String(body.status).trim().toLowerCase();
    if (!STATUSES.includes(newStatus)) return bad(`Status must be one of: ${STATUSES.join(", ")}`);
    sets.push(`status = ?${args.push(newStatus)}`);
  }
  if (body.admin_note !== undefined) sets.push(`admin_note = ?${args.push(clean(body.admin_note, 500))}`);
  if (!sets.length) return bad("Nothing to update");
  await env.DB.prepare(`UPDATE orders SET ${sets.join(", ")}, updated_at = datetime('now') WHERE id = ?${args.push(id)}`)
    .bind(...args)
    .run();
  if (newStatus && INACTIVE.has(newStatus) !== INACTIVE.has(order.status)) {
    // cancelled/returned puts the items back in stock; reactivating takes them out again
    await adjustStock(env, safeJSON(order.items_json, []), INACTIVE.has(newStatus) ? 1 : -1);
  }
  return json({ ok: true });
}

function toCSV(rows) {
  const esc = (v) => {
    let s = String(v ?? "");
    if (/^[=+\-@\t\r]/.test(s)) s = "'" + s; // block spreadsheet formula injection
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const phone = (p) => (/^0\d{10}$/.test(p || "") ? `${p.slice(0, 5)}-${p.slice(5)}` : p || "");
  const head = COLUMNS.map((c) => esc(c[1])).join(",");
  const body = rows
    .map((r) => COLUMNS.map(([k]) => esc(k === "phone" || k === "alt_phone" ? phone(r[k]) : r[k])).join(","))
    .join("\r\n");
  return "﻿" + head + "\r\n" + body + "\r\n";
}

/* ------------------------------------------------------------------ admin: products */

function readProductInput(b, existing = {}) {
  const errors = [];
  const name = clean(b.name ?? existing.name, 60);
  if (name.length < 2) errors.push("Product name is required.");
  const price = int(b.price ?? existing.price);
  if (!(price >= 50 && price <= 100000)) errors.push("Price must be between 50 and 100000.");
  const compareAt = b.compareAt !== undefined ? int(b.compareAt) : existing.compareAt ?? null;
  if (compareAt !== null && (Number.isNaN(compareAt) || compareAt <= price)) errors.push("Old price must be higher than the price (or empty).");
  const stock = b.stock !== undefined ? int(b.stock) : existing.stock ?? null;
  if (stock !== null && (Number.isNaN(stock) || stock < 0)) errors.push("Stock must be 0 or more (or empty for unlimited).");
  const variantsIn = Array.isArray(b.variants) ? b.variants : existing.variants || [];
  const seen = new Set();
  const variants = variantsIn
    .map((v) => {
      const vname = clean(v.name, 40);
      let id = slugify(v.id || vname) || "default";
      while (seen.has(id)) id += "-2";
      seen.add(id);
      const vp = v.price === "" || v.price === undefined || v.price === null ? undefined : int(v.price);
      return {
        id,
        name: vname || "Default",
        swatch: /^#[0-9a-f]{6}$/i.test(v.swatch || "") ? v.swatch : "#141414",
        ...(vp && vp > 0 ? { price: vp } : {}),
        images: (Array.isArray(v.images) ? v.images : []).map((x) => clean(x, 80)).filter((x) => SAFE_IMAGE.test(x)).slice(0, 8),
      };
    })
    .filter((v) => v.images.length);
  if (!variants.length) errors.push("Add at least one colour with a photo.");
  const details = (Array.isArray(b.details) ? b.details : String(b.details ?? "").split("\n"))
    .map((d) => clean(d, 140))
    .filter(Boolean)
    .slice(0, 12);
  return {
    errors,
    value: {
      name,
      type: clean(b.type ?? existing.type, 60),
      collection: slugify(b.collection ?? existing.collection) || "punk",
      price,
      compare_at: compareAt,
      badge: clean(b.badge ?? existing.badge, 24),
      tagline: clean(b.tagline ?? existing.tagline, 140),
      description: clean(b.description ?? existing.description, 1200),
      details: JSON.stringify(b.details !== undefined ? details : existing.details || []),
      variants: JSON.stringify(variants),
      stock,
      active: b.active === undefined ? (existing.active === false ? 0 : 1) : b.active === false || b.active === "false" || b.active === 0 ? 0 : 1,
    },
  };
}

async function saveProduct(env, id, v, isNew) {
  if (isNew) {
    const maxSort = await env.DB.prepare("SELECT COALESCE(MAX(sort), 0) AS s FROM products").first();
    await env.DB.prepare(
      `INSERT INTO products (id, name, type, collection, price, compare_at, badge, tagline, description, details, variants, stock, active, sort, created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, datetime('now'), datetime('now'))`
    )
      .bind(id, v.name, v.type, v.collection, v.price, v.compare_at, v.badge, v.tagline, v.description, v.details, v.variants, v.stock, v.active, (maxSort?.s || 0) + 1)
      .run();
  } else {
    await env.DB.prepare(
      `UPDATE products SET name=?2, type=?3, collection=?4, price=?5, compare_at=?6, badge=?7, tagline=?8, description=?9,
       details=?10, variants=?11, stock=?12, active=?13, updated_at=datetime('now') WHERE id=?1`
    )
      .bind(id, v.name, v.type, v.collection, v.price, v.compare_at, v.badge, v.tagline, v.description, v.details, v.variants, v.stock, v.active)
      .run();
  }
}

async function getProduct(env, id) {
  const r = await env.DB.prepare("SELECT * FROM products WHERE id = ?1").bind(id).first();
  return r ? rowToProduct(r) : null;
}

// Quick edits (admin list toggles and the Google Sheet)
async function patchProduct(env, id, body) {
  const p = await getProduct(env, id);
  if (!p) return bad("Unknown product", 404);
  const sets = [];
  const args = [];
  if (body.price !== undefined) {
    const n = int(body.price);
    if (!(n >= 50 && n <= 100000)) return bad("Price must be a number between 50 and 100000");
    sets.push(`price = ?${args.push(n)}`);
    // colours with their own price move by the same amount
    const delta = n - p.price;
    if (delta) {
      const vs = p.variants.map((v) => (v.price ? { ...v, price: v.price + delta } : v));
      sets.push(`variants = ?${args.push(JSON.stringify(vs))}`);
    }
  }
  if (body.compareAt !== undefined || body.compare_at !== undefined) {
    const n = int(body.compareAt ?? body.compare_at);
    if (n !== null && (Number.isNaN(n) || n <= 0)) return bad("Old price must be a number (or empty)");
    sets.push(`compare_at = ?${args.push(n)}`);
  }
  if (body.stock !== undefined) {
    const n = int(body.stock);
    if (n !== null && (Number.isNaN(n) || n < 0)) return bad("Stock must be 0 or more (empty = unlimited)");
    sets.push(`stock = ?${args.push(n)}`);
  }
  if (body.active !== undefined) {
    const v = String(body.active).trim().toLowerCase();
    sets.push(`active = ?${args.push(["false", "no", "0", "hide", "hidden", "off"].includes(v) ? 0 : 1)}`);
  }
  if (!sets.length) return bad("Nothing to update");
  await env.DB.prepare(`UPDATE products SET ${sets.join(", ")}, updated_at = datetime('now') WHERE id = ?${args.push(id)}`)
    .bind(...args)
    .run();
  return json({ ok: true, product: await getProduct(env, id) });
}

/* ------------------------------------------------------------------ admin: images */

const IMAGE_TYPES = { "image/webp": "webp", "image/jpeg": "jpg", "image/png": "png" };

async function uploadImage(request, env) {
  const type = (request.headers.get("content-type") || "").split(";")[0].trim();
  if (!IMAGE_TYPES[type]) return bad("Upload a JPG, PNG or WebP image.");
  const buf = await request.arrayBuffer();
  if (buf.byteLength < 200) return bad("That image looks empty.");
  if (buf.byteLength > 1500 * 1024) return bad("Image is too large (max 1.5 MB after resizing).");
  const rand = [...crypto.getRandomValues(new Uint8Array(6))].map((b) => b.toString(16).padStart(2, "0")).join("");
  const id = `${Date.now().toString(36)}${rand}.${IMAGE_TYPES[type]}`;
  await env.DB.prepare("INSERT INTO images (id, content_type, data, created_at) VALUES (?1, ?2, ?3, datetime('now'))")
    .bind(id, type, buf)
    .run();
  return json({ ok: true, id: `u/${id}`, url: `/img/u/${id}` });
}

async function serveImage(env, id) {
  const r = await env.DB.prepare("SELECT content_type, data FROM images WHERE id = ?1").bind(id).first();
  if (!r) return new Response("Not found", { status: 404 });
  return new Response(r.data, {
    headers: { "content-type": r.content_type, "cache-control": "public, max-age=31536000, immutable" },
  });
}

/* ------------------------------------------------------------------ Google Sheet API */

const SHEET_TABS = {
  orders: {
    name: "Orders",
    columns: [
      ["id", "Order ID"], ["created_bd", "Date (Bangladesh time)", "date"], ["status", "Status ✎", "edit"],
      ["admin_note", "Admin note ✎", "edit"], ["name", "Customer"], ["phone", "Phone"], ["alt_phone", "Alt phone"],
      ["zone", "Zone"], ["district", "District"], ["address", "Address"], ["items_summary", "Items"], ["item_count", "Qty"],
      ["subtotal", "Subtotal (BDT)"], ["delivery", "Delivery (BDT)"], ["total", "COD total (BDT)"], ["payment", "Payment"],
      ["note", "Customer note"], ["updated_bd", "Last updated", "date"],
    ],
  },
  products: {
    name: "Products",
    columns: [
      // Order kept compatible with the first sync script; new columns are appended.
      ["id", "Product ID"], ["name", "Name"], ["type", "Type"], ["collection", "Collection"], ["price", "Price (BDT) ✎", "edit"],
      ["active", "Show on site ✎", "edit"], ["sold", "Units sold"], ["colors", "Colours"], ["url", "Product link"],
      ["updated_bd", "Last updated", "date"], ["compare_at", "Old price ✎", "edit"], ["stock", "Stock ✎", "edit"],
    ],
  },
};

async function sheetData(env, url) {
  const [orders, products, collections] = await Promise.all([listOrders(env, url), loadProducts(env, { includeHidden: true }), loadCollections(env)]);
  const colName = (id) => collections.find((c) => c.id === id)?.name || id;
  const sold = {};
  for (const o of orders) {
    if (INACTIVE.has(o.status)) continue;
    for (const l of o.items) sold[l.productId] = (sold[l.productId] || 0) + (l.qty || 0);
  }
  const productRows = products.map((p) => ({
    sold: sold[p.id] || 0,
    id: p.id,
    name: p.name,
    type: p.type,
    collection: colName(p.collection),
    price: p.price,
    compare_at: p.compareAt ?? "",
    stock: p.stock ?? "",
    active: p.active,
    colors: p.variants.map((v) => v.name + (v.price && v.price !== p.price ? ` (৳${v.price})` : "")).join(", "),
    url: `https://oddkult.com/#p-${p.id}`,
    updated_bd: p.updated_at ? toBangladeshTime(p.updated_at) : "",
  }));
  const tab = (key, rows) => ({
    key,
    name: SHEET_TABS[key].name,
    headers: SHEET_TABS[key].columns.map((c) => c[1]),
    fields: SHEET_TABS[key].columns.map((c) => c[0]),
    editable: SHEET_TABS[key].columns.map((c) => c[2] === "edit"),
    dates: SHEET_TABS[key].columns.map((c) => c[2] === "date"),
    rows: rows.map((r) => SHEET_TABS[key].columns.map(([f]) => sheetSafe(r[f] ?? ""))),
  });
  return { version: 2, tabs: [tab("orders", orders), tab("products", productRows)] };
}

/* ------------------------------------------------------------------ router */

/* ------------------------------------------------------------------ search engines (SEO) */

const absImg = (id) => (!id ? `${SITE}/brand/og-image.jpg` : id.startsWith("u/") ? `${SITE}/img/${id}` : id.includes(".") ? `${SITE}/img/products/${id}` : `${SITE}/img/products/${id}.webp`);
const escHtml = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
// JSON inside <script> must not be able to close the tag
const ldJSON = (obj) => JSON.stringify(obj).replace(/</g, "\\u003c");

function productLD(p, cat) {
  const colName = cat.collections.find((c) => c.id === p.collection)?.name || p.collection;
  const prices = p.variants.map((v) => v.price ?? p.price);
  return {
    "@type": "Product",
    name: `${p.name} ${p.type}`.trim(),
    url: `${SITE}/p/${p.id}`,
    image: [...new Set(p.variants.flatMap((v) => v.images))].slice(0, 6).map(absImg),
    description: p.description || p.tagline || `${p.name} ${p.type} by ODDKULT`,
    sku: p.id,
    brand: { "@type": "Brand", name: "ODDKULT" },
    category: `${colName} belts`,
    color: p.variants.map((v) => v.name).join(", "),
    offers: {
      "@type": "AggregateOffer",
      priceCurrency: "BDT",
      lowPrice: Math.min(...prices),
      highPrice: Math.max(...prices),
      offerCount: p.variants.length,
      availability: p.stock === 0 ? "https://schema.org/OutOfStock" : "https://schema.org/InStock",
      url: `${SITE}/p/${p.id}`,
      seller: { "@type": "Organization", name: "ODDKULT" },
      areaServed: "BD",
    },
  };
}

// Serves index.html with page-specific title, description, canonical URL, social preview and
// structured data, so Google sees real product information in the HTML.
async function seoPage(request, env, product) {
  const cat = await getCatalog(env);
  const page = await env.ASSETS.fetch(new Request(new URL("/", request.url)));
  const org = {
    "@type": "OnlineStore",
    "@id": `${SITE}/#store`,
    name: "ODDKULT",
    url: `${SITE}/`,
    logo: `${SITE}/brand/instagram-profile-1080.png`,
    image: `${SITE}/brand/og-image.jpg`,
    description: "ODDKULT is a punk and cult accessories brand from Dhaka, Bangladesh: studded, cross, rose and western belts with cash on delivery across Bangladesh.",
    telephone: cat.store.phone ? `+88${cat.store.phone}` : undefined,
    address: { "@type": "PostalAddress", addressLocality: "Dhaka", addressCountry: "BD" },
    areaServed: "BD",
    currenciesAccepted: "BDT",
    paymentAccepted: "Cash on delivery",
    sameAs: [cat.store.instagram, cat.store.facebook].filter(Boolean),
  };
  let title, desc, canonical, image, ld;
  if (product) {
    const price = Math.min(...product.variants.map((v) => v.price ?? product.price));
    title = `${product.name} ${product.type} | ODDKULT Bangladesh`;
    desc = `${product.name} ${product.type} by ODDKULT: ${product.tagline || product.description}`.slice(0, 150) + ` ৳${price.toLocaleString("en-IN")}, cash on delivery across Bangladesh.`;
    canonical = `${SITE}/p/${product.id}`;
    image = absImg(product.variants[0]?.images[0]);
    ld = { "@context": "https://schema.org", "@graph": [org, productLD(product, cat), {
      "@type": "BreadcrumbList",
      itemListElement: [
        { "@type": "ListItem", position: 1, name: "ODDKULT", item: `${SITE}/` },
        { "@type": "ListItem", position: 2, name: `${product.name} ${product.type}`, item: canonical },
      ],
    }] };
  } else {
    title = "ODDKULT | Punk & Cult Belts and Accessories in Bangladesh";
    desc = "ODDKULT: punk and cult belts from Dhaka. Studded, cross, rose, dragon and western buckle belts from ৳650. Cash on delivery all over Bangladesh.";
    canonical = `${SITE}/`;
    image = `${SITE}/brand/og-image.jpg`;
    ld = { "@context": "https://schema.org", "@graph": [
      org,
      { "@type": "WebSite", "@id": `${SITE}/#website`, name: "ODDKULT", url: `${SITE}/`, publisher: { "@id": `${SITE}/#store` }, inLanguage: "en" },
      { "@type": "ItemList", name: "ODDKULT belts", itemListElement: cat.products.map((p, i) => ({ "@type": "ListItem", position: i + 1, url: `${SITE}/p/${p.id}`, name: `${p.name} ${p.type}` })) },
    ] };
  }
  const meta = (attr, key, val) => `<meta ${attr}="${key}" content="${escHtml(val)}">`;
  const head = [
    `<link rel="canonical" href="${canonical}">`,
    meta("property", "og:type", product ? "product" : "website"),
    meta("property", "og:site_name", "ODDKULT"),
    meta("property", "og:url", canonical),
    meta("property", "og:image", image),
    meta("name", "twitter:card", "summary_large_image"),
    meta("name", "twitter:title", title),
    meta("name", "twitter:description", desc),
    meta("name", "twitter:image", image),
    `<script type="application/ld+json">${ldJSON(ld)}</script>`,
  ].join("\n  ");
  const out = new HTMLRewriter()
    .on("title", { element(el) { el.setInnerContent(title); } })
    .on('meta[name="description"]', { element(el) { el.setAttribute("content", desc); } })
    .on('meta[property="og:title"]', { element(el) { el.setAttribute("content", title); } })
    .on('meta[property="og:description"]', { element(el) { el.setAttribute("content", desc); } })
    .on('meta[property="og:image"]', { element(el) { el.remove(); } })
    .on("head", { element(el) { el.append(head, { html: true }); } })
    .transform(page);
  const res = new Response(out.body, out);
  res.headers.set("content-type", "text/html; charset=utf-8");
  res.headers.set("cache-control", "public, max-age=0, must-revalidate");
  return res;
}

async function sitemap(env) {
  const cat = await getCatalog(env);
  const day = new Date().toISOString().slice(0, 10);
  const urls = [`<url><loc>${SITE}/</loc><lastmod>${day}</lastmod><changefreq>daily</changefreq><priority>1.0</priority></url>`].concat(
    cat.products.map((p) =>
      `<url><loc>${SITE}/p/${p.id}</loc><lastmod>${(p.updated_at || day).slice(0, 10)}</lastmod><changefreq>weekly</changefreq><priority>0.8</priority>` +
      [...new Set(p.variants.flatMap((v) => v.images))].slice(0, 5).map((im) => `<image:image><image:loc>${absImg(im)}</image:loc></image:image>`).join("") +
      `</url>`
    )
  );
  return new Response(
    `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:image="http://www.google.com/schemas/sitemap-image/1.1">\n${urls.join("\n")}\n</urlset>\n`,
    { headers: { "content-type": "application/xml; charset=utf-8", "cache-control": "public, max-age=3600" } }
  );
}

/* ------------------------------------------------------------------ router */

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    // Cloudflare tells us the visitor's scheme; local dev has no such header and is left alone
    if (request.headers.get("x-forwarded-proto") === "http") {
      url.protocol = "https:";
      return Response.redirect(url.toString(), 301);
    }
    if (url.hostname === "www.oddkult.com") {
      url.hostname = "oddkult.com";
      return Response.redirect(url.toString(), 301);
    }
    return secure(await handle(request, env, ctx, url));
  },
};

async function handle(request, env, ctx, url) {
    const { pathname } = url;
    const method = request.method;

    if (pathname.startsWith("/img/u/") && method === "GET") {
      return serveImage(env, decodeURIComponent(pathname.slice(7)));
    }

    // Pages Google should index with real titles and product data
    if (method === "GET" && (pathname === "/" || pathname === "/index.html" || pathname.startsWith("/p/") || pathname === "/sitemap.xml")) {
      try {
        await ensureSeeded(env);
        if (pathname === "/sitemap.xml") return await sitemap(env);
        if (pathname.startsWith("/p/")) {
          const id = pathname.slice(3).replace(/\/+$/, "");
          const product = (await loadProducts(env)).find((p) => p.id === id);
          if (!product) {
            const nf = await env.ASSETS.fetch(new Request(new URL("/404.html", request.url)));
            return new Response(nf.body, { status: 404, headers: { "content-type": "text/html; charset=utf-8" } });
          }
          return await seoPage(request, env, product);
        }
        return await seoPage(request, env, null);
      } catch (e) {
        console.error("seo page failed", e);
        return env.ASSETS.fetch(request);
      }
    }

    if (!pathname.startsWith("/api/")) return env.ASSETS.fetch(request);

    try {
      await ensureSeeded(env);
      // ---------- public
      if (pathname === "/api/catalog" && method === "GET") return json(await getCatalog(env));
      if (pathname === "/api/orders" && method === "POST") return await createOrder(request, env, ctx);
      if (pathname === "/api/track" && method === "GET") {
        if (await overLimit(env, `track:${clientIP(request)}`, 30, 600)) return bad("Too many lookups. Please wait a few minutes.", 429);
        const id = clean(url.searchParams.get("id"), 20).toUpperCase();
        const phone = normalisePhone(url.searchParams.get("phone"));
        if (!id || !phone) return bad("Enter your order ID and phone number.");
        const o = await env.DB.prepare("SELECT id, status, total, items_summary, created_at, updated_at FROM orders WHERE id = ?1 AND phone = ?2")
          .bind(id, phone)
          .first();
        if (!o) return bad("We couldn't find that order. Check the order ID and phone number.", 404);
        return json({
          id: o.id, status: o.status, total: o.total, items: o.items_summary,
          placed: toBangladeshTime(o.created_at), updated: o.updated_at ? toBangladeshTime(o.updated_at) : "",
        });
      }

      // ---------- admin (10 wrong passwords from one device → locked for 15 minutes)
      const authKey = `authfail:${clientIP(request)}`;
      if (await overLimit(env, authKey, 10, 900, { count: false })) {
        return bad("Too many wrong passwords. Try again in 15 minutes.", 429);
      }
      if (!isAdmin(request, env)) {
        await overLimit(env, authKey, 10, 900);
        return pathname === "/api/orders.csv" ? new Response("Unauthorised", { status: 401 }) : bad("Unauthorised", 401);
      }

      if (pathname === "/api/orders" && method === "GET") return json({ orders: await listOrders(env, url), columns: COLUMNS });
      if (pathname === "/api/orders.csv" && method === "GET") {
        return new Response(toCSV(await listOrders(env, url)), {
          headers: { "content-type": "text/csv; charset=utf-8", "content-disposition": 'inline; filename="oddkult-orders.csv"', "cache-control": "no-store" },
        });
      }
      let m = pathname.match(/^\/api\/orders\/(OK-[A-Z0-9]+)$/);
      if (m && method === "PATCH") return await updateOrder(env, m[1], await request.json().catch(() => ({})));

      if (pathname === "/api/admin/products" && method === "GET") {
        return json({ products: await loadProducts(env, { includeHidden: true }), collections: await loadCollections(env), sizes: seed.sizes });
      }
      if (pathname === "/api/admin/products" && method === "POST") {
        const b = await request.json().catch(() => ({}));
        const { errors, value } = readProductInput(b);
        if (errors.length) return bad(errors.join(" "));
        let id = slugify(b.id || value.name) || "product";
        const base = id;
        for (let i = 2; await getProduct(env, id); i++) id = `${base}-${i}`;
        await saveProduct(env, id, value, true);
        return json({ ok: true, product: await getProduct(env, id) });
      }
      m = pathname.match(/^\/api\/admin\/products\/([a-z0-9-]+)$/);
      if (m && method === "PUT") {
        const existing = await getProduct(env, m[1]);
        if (!existing) return bad("Unknown product", 404);
        const { errors, value } = readProductInput(await request.json().catch(() => ({})), existing);
        if (errors.length) return bad(errors.join(" "));
        await saveProduct(env, m[1], value, false);
        return json({ ok: true, product: await getProduct(env, m[1]) });
      }
      if (m && method === "DELETE") {
        await env.DB.prepare("DELETE FROM products WHERE id = ?1").bind(m[1]).run();
        return json({ ok: true });
      }
      m = pathname.match(/^\/api\/products\/([a-z0-9-]+)$/);
      if (m && method === "PATCH") return await patchProduct(env, m[1], await request.json().catch(() => ({})));

      if (pathname === "/api/admin/collections" && method === "GET") return json({ collections: await loadCollections(env) });
      if (pathname === "/api/admin/collections" && method === "PUT") {
        const list = ((await request.json().catch(() => ({}))).collections || [])
          .map((c, i) => ({ id: slugify(c.id || c.name), name: clean(c.name, 30), blurb: clean(c.blurb, 120), cover: clean(c.cover, 80), sort: i }))
          .filter((c) => c.id && c.name);
        if (!list.length) return bad("Keep at least one category.");
        if (new Set(list.map((c) => c.id)).size !== list.length) return bad("Two categories have the same name.");
        await env.DB.batch([
          env.DB.prepare("DELETE FROM collections"),
          ...list.map((c) =>
            env.DB.prepare("INSERT INTO collections (id, name, blurb, cover, sort) VALUES (?1, ?2, ?3, ?4, ?5)").bind(c.id, c.name, c.blurb, c.cover || null, c.sort)
          ),
        ]);
        return json({ ok: true, collections: await loadCollections(env) });
      }

      if (pathname === "/api/admin/settings" && method === "GET") return json({ settings: await getSettings(env) });
      if (pathname === "/api/admin/settings" && method === "PUT") {
        const b = (await request.json().catch(() => ({}))).settings || {};
        const out = {};
        for (const k of Object.keys(DEFAULT_SETTINGS)) {
          if (b[k] === undefined) continue;
          let v = clean(b[k], k === "announcement" ? 200 : 120);
          if (["delivery_inside", "delivery_outside", "free_over"].includes(k)) {
            const n = int(v);
            if (n === null || Number.isNaN(n) || n < 0) return bad("Delivery charges must be 0 or more.");
            v = String(n);
          }
          if (k === "whatsapp" && v) {
            const p = normalisePhone(v);
            if (!p) return bad("WhatsApp number looks wrong. Use 01XXXXXXXXX.");
            v = "88" + p;
          }
          if (k === "phone" && v && !normalisePhone(v)) return bad("Phone number looks wrong. Use 01XXXXXXXXX.");
          if ((k === "instagram" || k === "facebook") && v && !/^https:\/\/(www\.)?(instagram|facebook)\.com\//i.test(v)) {
            return bad(`${k === "instagram" ? "Instagram" : "Facebook"} link must start with https://${k}.com/`);
          }
          out[k] = v;
        }
        await env.DB.batch(
          Object.entries(out).map(([k, v]) =>
            env.DB.prepare("INSERT INTO settings (key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value = excluded.value").bind(k, v)
          )
        );
        return json({ ok: true, settings: await getSettings(env) });
      }

      if (pathname === "/api/admin/images" && method === "POST") return await uploadImage(request, env);

      if (pathname === "/api/sheet" && method === "GET") return json(await sheetData(env, url));
      m = pathname.match(/^\/api\/sheet\/(orders|products)\/([A-Za-z0-9-]+)$/);
      if (m && method === "PATCH") {
        const body = await request.json().catch(() => ({}));
        return m[1] === "orders" ? await updateOrder(env, m[2], body) : await patchProduct(env, m[2], body);
      }

      // older clients (sync script v1)
      if (pathname === "/api/products" && method === "GET") {
        const t = (await sheetData(env, url)).tabs[1];
        return json({
          products: t.rows.map((r) => {
            const o = Object.fromEntries(t.fields.map((f, i) => [f, r[i]]));
            return { ...o, default_price: o.sold }; // v1 script column 7 now shows units sold
          }),
        });
      }

      return bad("Not found", 404);
    } catch (e) {
      console.error(e);
      return bad("Something went wrong. Please try again or message us.", 500);
    }
}
