/**
 * ODDKULT → Google Sheets live sync (every minute)
 *
 * How to install (one time, about 2 minutes):
 *  1. Open the "ODDKULT Orders" Google Sheet in a desktop browser.
 *  2. Extensions → Apps Script. Delete everything in the editor and paste this whole file.
 *  3. Replace PUT-YOUR-ADMIN-PASSWORD-HERE below with your admin password (the ADMIN_KEY in Cloudflare).
 *  4. Click Save (disk icon), choose "setup" in the function menu at the top, click Run.
 *  5. Google asks for permission: Review permissions → your account → Advanced →
 *     "Go to ODDKULT sync (unsafe)" → Allow. (It is your own script; Google shows this for every new script.)
 *  Done. The Orders tab now refreshes every minute, even when the sheet is closed.
 */

const ADMIN_PASSWORD = "PUT-YOUR-ADMIN-PASSWORD-HERE";
const FEED_URL = "https://oddkult.com/api/orders.csv?key=" + encodeURIComponent(ADMIN_PASSWORD);
const SHEET_NAME = "Orders";

function setup() {
  // Remove old triggers for this function, then refresh every minute.
  ScriptApp.getProjectTriggers()
    .filter((t) => t.getHandlerFunction() === "refreshOrders")
    .forEach((t) => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger("refreshOrders").timeBased().everyMinutes(1).create();
  refreshOrders();
}

function refreshOrders() {
  const res = UrlFetchApp.fetch(FEED_URL, { muteHttpExceptions: true });
  if (res.getResponseCode() !== 200) {
    throw new Error("Orders feed returned " + res.getResponseCode() + ". Check ADMIN_PASSWORD.");
  }
  const text = res.getContentText("UTF-8").replace(/^﻿/, "");
  const rows = Utilities.parseCsv(text).filter((r) => r.length > 1 || (r[0] || "").trim() !== "");
  if (!rows.length) return;

  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(SHEET_NAME) || ss.insertSheet(SHEET_NAME);
  const width = rows[0].length;
  const data = rows.map((r) => {
    const row = r.slice(0, width);
    while (row.length < width) row.push("");
    return row;
  });

  // Keep phone numbers as text so the leading 0 stays.
  sheet.getRange(1, 5, Math.max(data.length, 1), 2).setNumberFormat("@");
  sheet.getRange(2, 11, Math.max(data.length, 1), 4).setNumberFormat("#,##0");

  sheet.getRange(1, 1, sheet.getMaxRows(), Math.max(width, sheet.getLastColumn() || 1)).clearContent();
  sheet.getRange(1, 1, data.length, width).setValues(data);

  // Numbers as numbers (Qty, Subtotal, Delivery, COD Total) for the Summary tab.
  if (data.length > 1) {
    const nums = sheet.getRange(2, 11, data.length - 1, 4);
    nums.setValues(nums.getValues().map((r) => r.map((v) => (v === "" ? "" : Number(v)))));
  }
  sheet.setFrozenRows(1);
  sheet.getRange("R1").setValue("Last synced: " + Utilities.formatDate(new Date(), "Asia/Dhaka", "yyyy-MM-dd HH:mm"));
}
