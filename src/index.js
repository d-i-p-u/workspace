// ODDKULT storefront worker
// - Serves the static site from /public (Workers static assets)
// - POST /api/orders                → validates a Cash-on-Delivery order, prices it server-side, stores it in D1
// - GET  /api/orders?key=…          → JSON list for the admin page
// - GET  /api/orders.csv?key=…      → CSV feed for Microsoft Excel (Data → From Web), refreshable
// - PATCH /api/orders/:id?key=…     → update order status from the admin page
// Optional: ORDER_WEBHOOK_URL → every new order is POSTed as JSON (Power Automate / Make / Zapier → Excel Online row)

import catalog from "../public/data/products.json";

const STATUSES = ["new", "confirmed", "shipped", "delivered", "cancelled", "returned"];
const BD_PHONE = /^(?:\+?88)?01[3-9]\d{8}$/;

const json = (data, status = 200, extra = {}) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...extra },
  });

const clean = (v, max = 200) => String(v ?? "").replace(/[\u0000-\u001f]/g, " ").trim().slice(0, max);

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

// The live catalogue: products.json plus price / visibility overrides saved from the
// Google Sheet (or any admin client) in the product_overrides table.
// A price override moves the product's base price; colours with their own price move by the same amount.
export async function getCatalog(env) {
  let rows = [];
  try {
    ({ results: rows } = await env.DB.prepare("SELECT product_id, price, active FROM product_overrides").all());
  } catch {
    rows = []; // table not created yet: serve products.json as-is
  }
  const ov = new Map(rows.map((r) => [r.product_id, r]));
  const products = catalog.products
    .filter((p) => (ov.get(p.id)?.active ?? 1) !== 0)
    .map((p) => {
      const o = ov.get(p.id);
      if (!o || o.price == null) return p;
      const delta = o.price - p.price;
      return {
        ...p,
        price: o.price,
        variants: p.variants.map((v) => (v.price != null ? { ...v, price: v.price + delta } : v)),
      };
    });
  return { ...catalog, products };
}

async function listProducts(env) {
  let rows = [];
  try {
    ({ results: rows } = await env.DB.prepare("SELECT product_id, price, active, updated_at FROM product_overrides").all());
  } catch {
    rows = [];
  }
  const ov = new Map(rows.map((r) => [r.product_id, r]));
  return catalog.products.map((p) => {
    const o = ov.get(p.id) || {};
    const collection = catalog.collections.find((c) => c.id === p.collection);
    return {
      id: p.id,
      name: p.name,
      type: p.type,
      collection: collection ? collection.name : p.collection,
      price: o.price ?? p.price,
      default_price: p.price,
      active: (o.active ?? 1) !== 0,
      colors: p.variants.map((v) => v.name + (v.price != null ? ` (+${v.price - p.price})` : "")).join(", "),
      url: `https://oddkult.com/#p-${p.id}`,
      updated_bd: o.updated_at ? toBangladeshTime(o.updated_at) : "",
    };
  });
}

// Price an order using the catalog only — the browser's prices are never trusted.
export function priceOrder(items, zone, cat = catalog) {
  const catalog = cat;
  if (!Array.isArray(items) || items.length === 0) throw new Error("Your bag is empty.");
  if (items.length > 20) throw new Error("Too many line items.");
  const sizes = new Set(catalog.sizes.map((s) => s.id));
  const lines = items.map((it) => {
    const product = catalog.products.find((p) => p.id === it.productId);
    if (!product) throw new Error("Unknown product.");
    const variant = product.variants.find((v) => v.id === it.variantId);
    if (!variant) throw new Error(`Unknown colour for ${product.name}.`);
    if (!sizes.has(it.size)) throw new Error(`Pick a size for ${product.name}.`);
    const qty = Math.trunc(Number(it.qty));
    if (!(qty >= 1 && qty <= 10)) throw new Error("Quantity must be 1–10.");
    const unit = variant.price ?? product.price;
    return {
      productId: product.id,
      variantId: variant.id,
      name: `${product.name} ${product.type}`,
      color: variant.name,
      size: it.size,
      qty,
      unit,
      total: unit * qty,
    };
  });
  const subtotal = lines.reduce((s, l) => s + l.total, 0);
  const d = catalog.delivery;
  const delivery = subtotal >= d.freeOver ? 0 : zone === "inside" ? d.insideDhaka : d.outsideDhaka;
  return { lines, subtotal, delivery, total: subtotal + delivery };
}

function orderId() {
  const t = Date.now().toString(36).toUpperCase().slice(-5);
  const r = crypto.getRandomValues(new Uint8Array(2));
  return `OK-${t}${((r[0] << 8) | r[1]).toString(36).toUpperCase().padStart(3, "0")}`;
}

async function createOrder(request, env, ctx) {
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Invalid request." }, 400);
  }
  if (body.website) return json({ ok: true, id: "OK-THANKS" }); // honeypot: bots fill hidden fields

  const name = clean(body.name, 80);
  const phone = normalisePhone(body.phone);
  const altPhone = body.altPhone ? normalisePhone(body.altPhone) : "";
  const zone = body.zone === "inside" ? "inside" : "outside";
  const district = clean(body.district, 60);
  const address = clean(body.address, 400);
  const note = clean(body.note, 300);

  if (name.length < 2) return json({ error: "Please enter your name." }, 400);
  if (!phone) return json({ error: "Enter a valid Bangladeshi mobile number (01XXXXXXXXX)." }, 400);
  if (body.altPhone && !altPhone) return json({ error: "Alternate number looks wrong." }, 400);
  if (address.length < 8) return json({ error: "Please write your full delivery address." }, 400);
  if (zone === "outside" && district.length < 2) return json({ error: "Please choose your district." }, 400);

  let priced;
  try {
    priced = priceOrder(body.items, zone, await getCatalog(env));
  } catch (e) {
    return json({ error: e.message }, 400);
  }

  // Light abuse guard: max 5 orders per phone per hour.
  const recent = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM orders WHERE phone = ?1 AND created_at > datetime('now','-1 hour')"
  )
    .bind(phone)
    .first();
  if (recent && recent.n >= 5) return json({ error: "Too many orders from this number. Please call us." }, 429);

  const id = orderId();
  const itemsSummary = priced.lines.map((l) => `${l.qty}× ${l.name} (${l.color}, ${l.size})`).join("; ");
  await env.DB.prepare(
    `INSERT INTO orders (id, name, phone, alt_phone, zone, district, address, note, items_json, items_summary,
                         item_count, subtotal, delivery, total, payment, status, ip, user_agent)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, 'COD', 'new', ?15, ?16)`
  )
    .bind(
      id,
      name,
      phone,
      altPhone || "",
      zone,
      zone === "inside" ? "Dhaka" : district,
      address,
      note,
      JSON.stringify(priced.lines),
      itemsSummary,
      priced.lines.reduce((s, l) => s + l.qty, 0),
      priced.subtotal,
      priced.delivery,
      priced.total,
      request.headers.get("cf-connecting-ip") || "",
      clean(request.headers.get("user-agent"), 200)
    )
    .run();

  const record = {
    id,
    created_at: toBangladeshTime(new Date().toISOString().slice(0, 19).replace("T", " ")) + " (Bangladesh time)",
    name,
    phone,
    alt_phone: altPhone || "",
    zone: zone === "inside" ? "Inside Dhaka" : "Outside Dhaka",
    district: zone === "inside" ? "Dhaka" : district,
    address,
    note,
    items: itemsSummary,
    item_count: priced.lines.reduce((s, l) => s + l.qty, 0),
    subtotal: priced.subtotal,
    delivery: priced.delivery,
    total: priced.total,
    payment: "Cash on Delivery",
    status: "new",
  };

  if (env.ORDER_WEBHOOK_URL) {
    ctx.waitUntil(
      fetch(env.ORDER_WEBHOOK_URL, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(record),
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
  const q = status && STATUSES.includes(status)
    ? env.DB.prepare("SELECT * FROM orders WHERE status = ?1 ORDER BY created_at DESC LIMIT ?2").bind(status, limit)
    : env.DB.prepare("SELECT * FROM orders ORDER BY created_at DESC LIMIT ?1").bind(limit);
  const { results } = await q.all();
  return results.map((r) => ({
    ...r,
    created_bd: toBangladeshTime(r.created_at),
    updated_bd: r.updated_at ? toBangladeshTime(r.updated_at) : "",
    admin_note: r.admin_note || "",
    zone: r.zone === "inside" ? "Inside Dhaka" : "Outside Dhaka",
  }));
}

// D1 stores UTC ("YYYY-MM-DD HH:MM:SS"); Bangladesh is UTC+6 with no daylight saving.
export function toBangladeshTime(utc) {
  const d = new Date(String(utc).replace(" ", "T") + "Z");
  if (Number.isNaN(d.getTime())) return String(utc ?? "");
  return new Date(d.getTime() + 6 * 3600 * 1000).toISOString().slice(0, 16).replace("T", " ");
}

function toCSV(rows) {
  const esc = (v) => {
    let s = String(v ?? "");
    if (/^[=+\-@\t\r]/.test(s)) s = "'" + s; // block spreadsheet formula injection
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  // 01712345678 -> 01712-345678 so Excel / Google Sheets keep the leading 0 (they treat it as text)
  const phone = (p) => (/^0\d{10}$/.test(p || "") ? `${p.slice(0, 5)}-${p.slice(5)}` : p || "");
  const head = COLUMNS.map((c) => esc(c[1])).join(",");
  const body = rows
    .map((r) => COLUMNS.map(([k]) => esc(k === "phone" || k === "alt_phone" ? phone(r[k]) : r[k])).join(","))
    .join("\r\n");
  return "﻿" + head + "\r\n" + body + "\r\n"; // BOM so Excel reads Bangla text correctly
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const { pathname } = url;

    if (pathname.startsWith("/api/")) {
      try {
        if (pathname === "/api/orders" && request.method === "POST") return await createOrder(request, env, ctx);

        if (pathname === "/api/orders" && request.method === "GET") {
          if (!isAdmin(request, env)) return json({ error: "Unauthorised" }, 401);
          return json({ orders: await listOrders(env, url), columns: COLUMNS });
        }

        if (pathname === "/api/orders.csv" && request.method === "GET") {
          if (!isAdmin(request, env)) return new Response("Unauthorised", { status: 401 });
          const csv = toCSV(await listOrders(env, url));
          return new Response(csv, {
            headers: {
              "content-type": "text/csv; charset=utf-8",
              "content-disposition": 'inline; filename="oddkult-orders.csv"',
              "cache-control": "no-store",
            },
          });
        }

        // Public catalogue with live prices (used by the storefront)
        if (pathname === "/api/catalog" && request.method === "GET") {
          return json(await getCatalog(env));
        }

        const m = pathname.match(/^\/api\/orders\/(OK-[A-Z0-9]+)$/);
        if (m && request.method === "PATCH") {
          if (!isAdmin(request, env)) return json({ error: "Unauthorised" }, 401);
          const body = await request.json().catch(() => ({}));
          const sets = [];
          const args = [];
          if (body.status !== undefined) {
            const status = String(body.status).trim().toLowerCase();
            if (!STATUSES.includes(status)) return json({ error: `Status must be one of: ${STATUSES.join(", ")}` }, 400);
            sets.push(`status = ?${args.push(status)}`);
          }
          if (body.admin_note !== undefined) sets.push(`admin_note = ?${args.push(clean(body.admin_note, 500))}`);
          if (!sets.length) return json({ error: "Nothing to update" }, 400);
          const res = await env.DB.prepare(
            `UPDATE orders SET ${sets.join(", ")}, updated_at = datetime('now') WHERE id = ?${args.push(m[1])}`
          )
            .bind(...args)
            .run();
          return json({ ok: res.meta.changes === 1 });
        }

        if (pathname === "/api/products" && request.method === "GET") {
          if (!isAdmin(request, env)) return json({ error: "Unauthorised" }, 401);
          return json({ products: await listProducts(env) });
        }

        const pm = pathname.match(/^\/api\/products\/([a-z0-9-]+)$/);
        if (pm && request.method === "PATCH") {
          if (!isAdmin(request, env)) return json({ error: "Unauthorised" }, 401);
          const product = catalog.products.find((p) => p.id === pm[1]);
          if (!product) return json({ error: "Unknown product" }, 404);
          const body = await request.json().catch(() => ({}));
          const cur =
            (await env.DB.prepare("SELECT price, active FROM product_overrides WHERE product_id = ?1").bind(product.id).first()) ||
            { price: null, active: 1 };
          let price = cur.price;
          let active = cur.active;
          if (body.price !== undefined) {
            const n = Math.round(Number(String(body.price).replace(/[^\d.]/g, "")));
            if (!(n >= 50 && n <= 100000)) return json({ error: "Price must be a number between 50 and 100000" }, 400);
            price = n === product.price ? null : n;
          }
          if (body.active !== undefined) {
            const v = String(body.active).trim().toLowerCase();
            active = ["false", "no", "0", "hide", "hidden", "off"].includes(v) ? 0 : 1;
          }
          await env.DB.prepare(
            `INSERT INTO product_overrides (product_id, price, active, updated_at) VALUES (?1, ?2, ?3, datetime('now'))
             ON CONFLICT(product_id) DO UPDATE SET price = excluded.price, active = excluded.active, updated_at = excluded.updated_at`
          )
            .bind(product.id, price, active)
            .run();
          return json({ ok: true, product: (await listProducts(env)).find((p) => p.id === product.id) });
        }

        return json({ error: "Not found" }, 404);
      } catch (e) {
        console.error(e);
        return json({ error: "Something went wrong. Please try again or message us." }, 500);
      }
    }

    return env.ASSETS.fetch(request);
  },
};
