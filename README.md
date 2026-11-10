# ODDKULT — Punk & Cult Accessories (Bangladesh)

The ODDKULT online store: Drop 001 has 13 belts in 3 collections (Punk, Cult, Retro), cash on delivery only,
and every order is sent to Microsoft Excel.

```
public/                 Static storefront (no build step)
  index.html            Home, collections, shop, product view, bag, checkout
  admin/index.html      Orders admin: status updates, Excel download, live Excel link
  data/products.json    Product catalogue: names, prices, colours, images, delivery charges
  img/products/         Product photos (optimised WebP, from Google Drive "ODDKULT PRODUCTS")
  brand/                Logo pack (from Google Drive "ODDKULT-Logo-Pack")
src/index.js            Cloudflare Worker: order API, D1 storage, CSV feed for Excel
schema.sql              D1 database table
```

## Prices and delivery

Edit `public/data/products.json`. The server recalculates every order total from this file, so customers
can't change prices in their browser.

| Design | Collection | Price (BDT) |
|---|---|---|
| Hook Slim Clasp Belt | Retro | 650 |
| Horseshoe Braided Suede Belt | Retro | 1,090 |
| Saint Engraved Western Belt | Cult | 1,190 |
| Dagger Tip Western Belt | Cult | 1,290 |
| Braid Cross Woven Belt | Punk | 1,350 |
| Iron Cross Stud Belt | Punk | 1,390 |
| Blood Rose Buckle Belt | Cult | 1,450 |
| Fleur Cross Buckle Belt | Cult | 1,450 |
| Reliquary Oval Buckle Belt | Cult | 1,550 |
| Chain Gang Braided Belt | Punk | 1,590 |
| Wyvern Dragon Buckle Belt | Punk | 1,690 (studded 1,790) |
| Holy Slab Cross Studded Belt | Punk | 1,790 |
| Longhorn Rodeo Studded Belt | Cult | 1,850 |

Delivery costs ৳70 inside Dhaka and ৳130 outside Dhaka. It is free on orders over ৳2,500.

Put your WhatsApp, phone and social links in `CONFIG` at the top of `public/js/app.js`.

## Run locally

```bash
npm install
npm run db:local
echo "ADMIN_KEY=choose-a-long-secret" > .dev.vars
npm run dev
```

Then open the store at http://localhost:8787 and the admin page at http://localhost:8787/admin/.

## Deploy (Cloudflare Workers + D1, free tier)

```bash
npx wrangler d1 create oddkult-orders
```

Copy the `database_id` it prints into `wrangler.jsonc`, then run:

```bash
npm run db:remote
```

```bash
npx wrangler secret put ADMIN_KEY
```

```bash
npm run deploy
```

## Orders → Microsoft Excel

Every order is saved in the database. There are three ways to get orders into Excel:

1. **Live Excel sheet (recommended, free).** In Excel go to **Data → Get Data → From Web** and paste
   `https://YOUR-SITE/api/orders.csv?key=YOUR_ADMIN_KEY`.
   Then open **Queries & Connections → Properties** and tick *Refresh every 5 minutes* and
   *Refresh data when opening the file*. New orders then appear in the sheet automatically.
   The admin page shows this link with a Copy button.
2. **Download .xlsx.** Open `/admin/`, enter your key and click **Download Excel (.xlsx)**.
3. **Excel Online / OneDrive row per order (optional).** Set a webhook secret:
   `npx wrangler secret put ORDER_WEBHOOK_URL`
   Point it at a Power Automate flow ("When an HTTP request is received" → "Add a row into a table"),
   or at a Make or Zapier scenario. The Worker POSTs each new order as JSON with these fields:
   `id, created_at, name, phone, alt_phone, zone, district, address, note, items, item_count, subtotal, delivery, total, payment, status`.

Excel columns: Order ID, Date, Status, Customer, Phone, Alt Phone, Zone, District, Address, Items, Qty,
Subtotal, Delivery, COD Total, Payment, Note.

## Editing products and categories (no coding)

Everything on the shop comes from **`public/data/products.json`**: collections (categories), products,
prices, colours, images and delivery charges. Edit it on GitHub (open the file → pencil icon → change →
**Commit changes**). Cloudflare redeploys automatically in about a minute.

- **Change a price:** edit `"price": 1450`. A colour can have its own `"price"` too (see Wyvern).
- **New category:** add `{ "id": "chains", "name": "Chains", "blurb": "..." }` to `collections`.
  Its tile, filter button and menu links appear automatically. Optional `"cover": "p06"` picks the tile image.
- **Move a product to another category:** change its `"collection"` to that category's `id`.
- **New product:** copy an existing product block, give it a new `"id"` (lowercase-with-dashes), then
  change the name, type, price, collection, text and variants.
- **New photos:** upload square JPG/PNG/WebP files to `public/img/products/` (Add file → Upload files),
  then reference them **with the extension**, e.g. `"images": ["skull-chain.jpg"]`.
  Existing names like `"p06"` (no extension) are our optimised photo pairs.
- **Remove a product:** delete its block. Mind the commas between blocks: a broken JSON file shows
  "Couldn't load products".

### বাংলায় সংক্ষেপে
- পেমেন্ট শুধু ক্যাশ অন ডেলিভারি। ডেলিভারি চার্জ ঢাকার ভিতরে ৳৭০, বাইরে ৳১৩০, আর ৳২,৫০০-এর বেশি অর্ডারে ফ্রি।
- নতুন অর্ডার এলে সেটা Excel-এ আসে। Excel-এ **Data → From Web**-এ গিয়ে admin পেজের লিংকটা দিন, তাহলে প্রতি ৫ মিনিটে নিজে থেকেই আপডেট হবে।
- দাম বদলাতে চাইলে `public/data/products.json` ফাইলে দাম এডিট করুন।

## Security

- Security headers on every response: HSTS, CSP (`script-src 'self'`), X-Frame-Options DENY, nosniff,
  Referrer-Policy, Permissions-Policy (`public/_headers` for static files, `secure()` in the Worker).
- HTTP → HTTPS and www → apex redirects.
- Orders: JSON only (blocks cross-site form posts), 20 KB body limit, 15 orders per device per hour,
  5 per phone per hour, honeypot field. Prices and stock are always checked on the server.
- Order tracking: 30 lookups per device per 10 minutes; needs order ID **and** phone.
- Admin: password via `x-admin-key` header; 10 wrong passwords from one device lock it for 15 minutes.
  Use a long password in the `ADMIN_KEY` variable (Cloudflare → workspace → Settings).
- Text starting with `= + - @` is neutralised before it reaches Excel or Google Sheets.
- Product image references are validated; uploads accept only JPG/PNG/WebP up to 1.5 MB.

## Search engines (SEO)

- Every product has its own page: `https://oddkult.com/p/<product-id>` with its own title, description,
  social preview image and Product structured data (price in BDT, stock, images, brand).
- Home page carries OnlineStore + WebSite + ItemList structured data, generated from the live catalogue.
- `https://oddkult.com/sitemap.xml` lists the home page and every visible product (with images);
  `robots.txt` points to it and keeps `/admin/` and `/api/` out of search.
