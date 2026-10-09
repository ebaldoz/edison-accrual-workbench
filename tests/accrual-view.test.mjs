import test from "node:test";
import assert from "node:assert/strict";
import { paginateAccruals, sourceRecordsFor } from "../dist/accrual-view.js";
import { AccrualEngine } from "../dist/engine.js";
import { filterAccruals } from "../dist/review.js";
import { anchorData } from "./fixtures/anchor-data.js";

test("pagination displays 25 at most, traverses all records once, without modifying input", () => {
  const items = Array.from({ length: 69 }, (_, id) => ({ id }));
  const pages = [1, 2, 3].map(page => paginateAccruals(items, page));
  assert.deepEqual(pages.map(page => page.items.length), [25, 25, 19]);
  assert.deepEqual(pages.flatMap(page => page.items), items);
  assert.deepEqual([pages[2].start, pages[2].end, pages[2].pages], [51, 69, 3]);
  assert.equal(items.length, 69);
});

test("empty, exact-boundary, and filtered pages clamp safely", () => {
  assert.deepEqual(paginateAccruals([], 4), { items: [], page: 1, pages: 1, start: 0, end: 0, total: 0 });
  const items = Array.from({ length: 50 }, (_, id) => ({ id, side: id < 10 ? "AR" : "AP" }));
  assert.equal(paginateAccruals(items, 99).page, 2);
  assert.equal(paginateAccruals(items, -1).page, 1);
  assert.equal(paginateAccruals(filterAccruals(items, { side: "AR" }), 3).page, 1);
});

test("AR drill-through exposes exact accrued events and all pricing/cutoff/baseline inputs", () => {
  const sheets = structuredClone(anchorData);
  const item = new AccrualEngine().run(sheets).accruals.find(row => row.side === "AR");
  const groups = sourceRecordsFor(item, sheets);
  assert.deepEqual(groups[0].rows.map(row => row.event_id), item.sourceDetail.events);
  assert.deepEqual(groups[0].rows, sheets.usage_events.filter(row => item.sourceDetail.events.includes(row.event_id)));
  assert.ok(groups[1].rows.length);
  assert.equal(groups[2].rows[0].customer_id, item.sourceDetail.customer_id);
  assert.equal(groups[3].rows[0].sku, item.sourceDetail.sku);
  assert.equal(groups[4].rows[0].name, item.counterparty);
});

test("AP drill-through includes original receipt, invoice, PO, line, and vendor", () => {
  const sheets = structuredClone(anchorData);
  const receipt = sheets.goods_receipts[0];
  sheets.vendor_invoices.push({ invoice_number: "TEST-PARTIAL", vendor_id: sheets.purchase_orders[0].vendor_id, receipt_id: receipt.receipt_id, po_number: receipt.po_number, invoice_date: "2026-03-31", subtotal_usd: 1000, status: "approved" });
  const item = new AccrualEngine().run(sheets).accruals.find(row => row.side === "AP");
  const groups = sourceRecordsFor(item, sheets);
  assert.deepEqual(groups[0].rows, [receipt]);
  assert.equal(groups[1].rows[0].invoice_number, "TEST-PARTIAL");
  assert.deepEqual(groups[3].rows, [sheets.purchase_orders[0]]);
  assert.deepEqual(groups[4].rows, [sheets.po_lines[0]]);
  assert.equal(groups[5].rows[0].vendor_id, sheets.purchase_orders[0].vendor_id);
});

test("plugins may supply their own source records; unknown handlers have safe fallback", () => {
  const sourceRecords = [{ sheet: "custom", label: "Contract", rows: [{ id: "1" }] }];
  assert.equal(sourceRecordsFor({ handler: "CUSTOM", sourceRecords }, {}), sourceRecords);
  assert.deepEqual(sourceRecordsFor({ handler: "CUSTOM" }, {}), []);
});
