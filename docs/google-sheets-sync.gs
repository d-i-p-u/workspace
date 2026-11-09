/**
 * ODDKULT ⇄ Google Sheets two-way sync (version 2)
 *
 * The website tells this script which tabs and columns exist (GET /api/sheet), so new columns
 * added on the website appear here without changing the script.
 *
 * Website → Sheet: Orders and Products every minute (the sheet is only rewritten when something changed).
 * Sheet → Website: instantly when you edit a column marked ✎
 *   Orders:   Status, Admin note
 *   Products: Price, Show on site, Old price, Stock
 *
 * Install (desktop browser): sheet → Extensions → Apps Script → replace all code with this file →
 * put your admin password below → Save → choose "setup" → Run → Allow.
 */

const ADMIN_PASSWORD = "PUT-YOUR-ADMIN-PASSWORD-HERE";
const SITE = "https://oddkult.com";
const TZ = "Asia/Dhaka";

function book() { return SpreadsheetApp.getActive(); }

function onOpen() {
  try {
    SpreadsheetApp.getUi().createMenu("ODDKULT").addItem("Sync now", "syncNow").addItem("Set up live sync", "setup").addToUi();
  } catch (e) { /* no UI when run from the editor */ }
}

function setup() {
  if (ADMIN_PASSWORD.indexOf("PUT-YOUR") === 0) throw new Error("Put your admin password in ADMIN_PASSWORD at the top first.");
  api("/api/sheet"); // clear error now if the password is wrong
  ScriptApp.getProjectTriggers().forEach((t) => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger("refreshAll").timeBased().everyMinutes(1).create();
  ScriptApp.newTrigger("onSheetEdit").forSpreadsheet(book()).onEdit().create();
  syncNow();
}

function syncNow() {
  PropertiesService.getScriptProperties().deleteAllProperties();
  refreshAll();
  book().toast("Orders and products are up to date.", "ODDKULT", 4);
}

function api(path, method, payload) {
  const opts = { method: method || "get", muteHttpExceptions: true, contentType: "application/json", headers: { "x-admin-key": ADMIN_PASSWORD } };
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
function refreshAll() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(20000)) return;
  try {
    const data = api("/api/sheet");
    const props = PropertiesService.getScriptProperties();
    const meta = {};
    data.tabs.forEach((tab) => {
      meta[tab.name] = { key: tab.key, fields: tab.fields, editable: tab.editable };
      const hash = Utilities.base64Encode(Utilities.computeDigest(Utilities.DigestAlgorithm.MD5, JSON.stringify(tab)));
      if (props.getProperty("h_" + tab.key) === hash) return;
      writeTab(tab);
      props.setProperty("h_" + tab.key, hash);
    });
    props.setProperty("meta", JSON.stringify(meta));
    const d = book().getSheetByName("Dashboard");
    if (d) d.getRange("B3").setValue("Live sync on · last synced " + Utilities.formatDate(new Date(), TZ, "dd MMM yyyy, h:mm a"));
  } finally {
    lock.releaseLock();
  }
}

function writeTab(tab) {
  const sheet = book().getSheetByName(tab.name);
  if (!sheet) throw new Error('The "' + tab.name + '" tab is missing. Do not rename the tabs.');
  const width = tab.headers.length;
  if (sheet.getMaxColumns() < width) sheet.insertColumnsAfter(sheet.getMaxColumns(), width - sheet.getMaxColumns());
  const rows = tab.rows.map((r) => r.map((v, i) => {
    if (v === null || v === undefined) return "";
    if (tab.dates[i]) return v ? Utilities.parseDate(String(v), TZ, "yyyy-MM-dd HH:mm") : "";
    return v;
  }));
  if (rows.length + 1 > sheet.getMaxRows()) sheet.insertRowsAfter(sheet.getMaxRows(), rows.length + 1 - sheet.getMaxRows());
  sheet.getRange(1, 1, 1, width).setValues([tab.headers]);
  sheet.getRange(2, 1, sheet.getMaxRows() - 1, width).clearContent(); // keeps formatting and dropdowns
  if (rows.length) sheet.getRange(2, 1, rows.length, width).setValues(rows);
  const activeCol = tab.fields.indexOf("active");
  if (activeCol >= 0 && rows.length) {
    sheet.getRange(2, activeCol + 1, rows.length, 1).setDataValidation(SpreadsheetApp.newDataValidation().requireCheckbox().build());
  }
}

/* ---------- sheet → website ---------- */
function onSheetEdit(e) {
  const range = e.range;
  const sheet = range.getSheet();
  const meta = JSON.parse(PropertiesService.getScriptProperties().getProperty("meta") || "{}")[sheet.getName()];
  if (!meta || range.getLastRow() < 2) return;
  const lock = LockService.getScriptLock();
  lock.tryLock(20000);
  try {
    const values = range.getValues();
    const single = range.getNumRows() === 1 && range.getNumColumns() === 1;
    const updatedCol = meta.fields.indexOf("updated_bd") + 1;
    for (let r = 0; r < values.length; r++) {
      const row = range.getRow() + r;
      if (row < 2) continue;
      const id = sheet.getRange(row, 1).getValue();
      if (!id) continue;
      for (let c = 0; c < values[r].length; c++) {
        const idx = range.getColumn() + c - 1;
        if (!meta.editable[idx]) continue;
        const cell = sheet.getRange(row, idx + 1);
        const payload = {};
        payload[meta.fields[idx]] = values[r][c];
        try {
          api("/api/sheet/" + meta.key + "/" + encodeURIComponent(id), "patch", payload);
          if (updatedCol > 0) sheet.getRange(row, updatedCol).setValue(new Date());
          PropertiesService.getScriptProperties().deleteProperty("h_" + meta.key);
          cell.setNote(null);
          book().toast("Saved to oddkult.com", "ODDKULT", 2);
        } catch (err) {
          cell.setNote("Not saved to the website: " + err.message);
          if (single && e.oldValue !== undefined) cell.setValue(e.oldValue);
          book().toast("Not saved: " + err.message, "ODDKULT", 6);
        }
      }
    }
  } finally {
    lock.releaseLock();
  }
}
