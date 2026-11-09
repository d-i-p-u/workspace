/**
 * ODDKULT ⇄ Google Sheets two-way sync
 *
 * Website → Sheet:  Orders every minute, Products every 15 minutes, plus "ODDKULT → Sync now".
 * Sheet → Website:  instantly when you edit
 *   • Orders:   Status ✎ (dropdown) and Admin note ✎
 *   • Products: Price (BDT) ✎ and Show on site ✎ (checkbox)
 *
 * Install once (about 2 minutes), in a desktop browser:
 *  1. Open the "ODDKULT Orders" sheet → Extensions → Apps Script.
 *  2. Delete everything in the editor and paste this whole file.
 *  3. Replace PUT-YOUR-ADMIN-PASSWORD-HERE below with your admin password (the ADMIN_KEY in Cloudflare).
 *  4. Save (disk icon). In the function menu at the top pick "setup", then click Run.
 *  5. Google asks for permission: Review permissions → your account → Advanced →
 *     "Go to Untitled project (unsafe)" → Allow. It is your own script; Google shows this for every new script.
 *  Done. Reload the sheet: an "ODDKULT" menu appears with "Sync now".
 */

const ADMIN_PASSWORD = "PUT-YOUR-ADMIN-PASSWORD-HERE";
const SITE = "https://oddkult.com";
const TZ = "Asia/Dhaka";

// Column order must match the header row the sheet was built with.
const ORDER_FIELDS = ["id", "created_bd", "status", "admin_note", "name", "phone", "alt_phone", "zone", "district",
  "address", "items_summary", "item_count", "subtotal", "delivery", "total", "payment", "note", "updated_bd"];
const PRODUCT_FIELDS = ["id", "name", "type", "collection", "price", "active", "default_price", "colors", "url", "updated_bd"];
const ORDER_EDITABLE = { 3: "status", 4: "admin_note" };   // 1-based column numbers
const PRODUCT_EDITABLE = { 5: "price", 6: "active" };
const DATE_FIELDS = { created_bd: true, updated_bd: true };

/* ---------- menu ---------- */
function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu("ODDKULT")
    .addItem("Sync now", "syncNow")
    .addItem("Set up live sync", "setup")
    .addToUi();
}

function syncNow() {
  refreshOrders(true);
  refreshProducts();
  SpreadsheetApp.getActive().toast("Orders and products are up to date.", "ODDKULT", 4);
}

/* ---------- one-time setup ---------- */
function setup() {
  if (ADMIN_PASSWORD.indexOf("PUT-YOUR") === 0) {
    throw new Error("Put your admin password in ADMIN_PASSWORD at the top of the script first.");
  }
  api("/api/products"); // fails early with a clear message if the password is wrong
  const ss = SpreadsheetApp.getActive();
  ScriptApp.getProjectTriggers().forEach((t) => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger("refreshOrders").timeBased().everyMinutes(1).create();
  ScriptApp.newTrigger("refreshProducts").timeBased().everyMinutes(15).create();
  ScriptApp.newTrigger("onSheetEdit").forSpreadsheet(ss).onEdit().create();
  PropertiesService.getScriptProperties().deleteProperty("ordersHash");
  syncNow();
}

/* ---------- website API ---------- */
function api(path, method, payload) {
  const opts = {
    method: method || "get",
    muteHttpExceptions: true,
    contentType: "application/json",
    headers: { "x-admin-key": ADMIN_PASSWORD },
  };
  if (payload) opts.payload = JSON.stringify(payload);
  const res = UrlFetchApp.fetch(SITE + path, opts);
  const code = res.getResponseCode();
  let body = {};
  try { body = JSON.parse(res.getContentText()); } catch (e) { body = {}; }
  if (code === 401) throw new Error("Wrong admin password in the script (ADMIN_PASSWORD).");
  if (code !== 200) throw new Error(body.error || "The website answered " + code + ".");
  return body;
}

/* ---------- website → sheet ---------- */
function refreshOrders(force) {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(20000)) return;
  try {
    const orders = api("/api/orders").orders || [];
    const hash = Utilities.base64Encode(Utilities.computeDigest(Utilities.DigestAlgorithm.MD5, JSON.stringify(orders)));
    const props = PropertiesService.getScriptProperties();
    if (force === true || props.getProperty("ordersHash") !== hash) {
      writeTable("Orders", orders.map((o) => ORDER_FIELDS.map((f) => cellValue(f, o[f]))), ORDER_FIELDS.length);
      props.setProperty("ordersHash", hash);
    }
    stamp();
  } finally {
    lock.releaseLock();
  }
}

function refreshProducts() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(20000)) return;
  try {
    const products = api("/api/products").products || [];
    const rows = products.map((p) => PRODUCT_FIELDS.map((f) => cellValue(f, p[f])));
    const sheet = writeTable("Products", rows, PRODUCT_FIELDS.length);
    if (rows.length) {
      sheet.getRange(2, 6, rows.length, 1).setDataValidation(SpreadsheetApp.newDataValidation().requireCheckbox().build());
    }
    stamp();
  } finally {
    lock.releaseLock();
  }
}

function cellValue(field, v) {
  if (v === null || v === undefined) return "";
  if (DATE_FIELDS[field]) return v ? Utilities.parseDate(String(v), TZ, "yyyy-MM-dd HH:mm") : "";
  return v;
}

function writeTable(name, rows, width) {
  const sheet = SpreadsheetApp.getActive().getSheetByName(name);
  if (!sheet) throw new Error('The "' + name + '" tab is missing. Do not rename the tabs.');
  const maxRows = sheet.getMaxRows();
  if (rows.length + 1 > maxRows) sheet.insertRowsAfter(maxRows, rows.length + 1 - maxRows);
  sheet.getRange(2, 1, sheet.getMaxRows() - 1, width).clearContent(); // keeps formatting and dropdowns
  if (rows.length) sheet.getRange(2, 1, rows.length, width).setValues(rows);
  return sheet;
}

function stamp() {
  const d = SpreadsheetApp.getActive().getSheetByName("Dashboard");
  if (d) d.getRange("B3").setValue("Live sync on · last synced " + Utilities.formatDate(new Date(), TZ, "dd MMM yyyy, h:mm a"));
}

/* ---------- sheet → website (installable onEdit trigger) ---------- */
function onSheetEdit(e) {
  const range = e.range;
  const sheet = range.getSheet();
  const name = sheet.getName();
  const map = name === "Orders" ? ORDER_EDITABLE : name === "Products" ? PRODUCT_EDITABLE : null;
  if (!map || range.getLastRow() < 2) return;

  const lock = LockService.getScriptLock();
  lock.tryLock(20000);
  try {
    const values = range.getValues();
    const single = range.getNumRows() === 1 && range.getNumColumns() === 1;
    for (let r = 0; r < values.length; r++) {
      const row = range.getRow() + r;
      if (row < 2) continue;
      const id = sheet.getRange(row, 1).getValue();
      if (!id) continue;
      for (let c = 0; c < values[r].length; c++) {
        const col = range.getColumn() + c;
        const field = map[col];
        if (!field) continue;
        const cell = sheet.getRange(row, col);
        const payload = {};
        payload[field] = values[r][c];
        try {
          if (name === "Orders") {
            api("/api/orders/" + encodeURIComponent(id), "patch", payload);
            sheet.getRange(row, ORDER_FIELDS.length).setValue(new Date());
            PropertiesService.getScriptProperties().deleteProperty("ordersHash");
          } else {
            api("/api/products/" + encodeURIComponent(id), "patch", payload);
            sheet.getRange(row, PRODUCT_FIELDS.length).setValue(new Date());
          }
          cell.setNote(null);
          SpreadsheetApp.getActive().toast("Saved to oddkult.com", "ODDKULT", 2);
        } catch (err) {
          cell.setNote("Not saved to the website: " + err.message);
          if (single && e.oldValue !== undefined) cell.setValue(e.oldValue);
          SpreadsheetApp.getActive().toast("Not saved: " + err.message, "ODDKULT", 6);
        }
      }
    }
  } finally {
    lock.releaseLock();
  }
}
