import test from "node:test";
import assert from "node:assert/strict";
import { AccrualEngine, ReceiptAccrualHandler, UsageAccrualHandler, toJournalCsv } from "../dist/engine.js";
import { anchorData } from "../dist/anchor-data.js";

test("anchor accruals reconcile to expected AR and AP amounts", () => {
  const result = new AccrualEngine().run(structuredClone(anchorData));
  assert.equal(result.totals.ar, 362.5);
  assert.equal(result.totals.ap, 100000);
  assert.equal(result.control.balanced, true);
});

test("EUR customer is translated to USD and retains transaction currency", () => {
  const result = new AccrualEngine().run(structuredClone(anchorData));
  const berlin = result.accruals.find((item) => item.counterparty === "Berlin Labs GmbH");
  assert.equal(berlin.amountUsd, 60);
  assert.equal(berlin.transactionAmount, 55.56);
  assert.equal(berlin.transactionCurrency, "EUR");
  assert.equal(berlin.fx, 1.08);
});

test("seeded usage spike is flagged but actual quantity remains accrued", () => {
  const result = new AccrualEngine().run(structuredClone(anchorData));
  const acme = result.accruals.find((item) => item.counterparty === "Acme Robotics Inc.");
  assert.equal(acme.status, "REVIEW");
  assert.equal(acme.anomaly.event_id, "evt_u0002");
  assert.equal(acme.amountUsd, 202.5);
});

test("partial receipt accrues receipt value, not full PO", () => {
  const result = new AccrualEngine().run(structuredClone(anchorData));
  const ap = result.accruals.find((item) => item.side === "AP");
  assert.equal(ap.amountUsd, 100000);
  assert.notEqual(ap.amountUsd, 250000);
});

test("vendor invoice suppresses the GRNI accrual", () => {
  const sheets = structuredClone(anchorData);
  sheets.vendor_invoices.push({ invoice_number: "DM-100", vendor_id: "VEN-DELL-01", po_number: "PO-2026-0188", invoice_date: "2026-03-30", subtotal_usd: 100000, status: "approved" });
  const result = new AccrualEngine().run(sheets);
  assert.equal(result.totals.ap, 0);
});

test("reruns produce deterministic external IDs", () => {
  const engine = new AccrualEngine([new UsageAccrualHandler(), new ReceiptAccrualHandler()]);
  const first = engine.run(structuredClone(anchorData));
  const second = engine.run(structuredClone(anchorData));
  assert.deepEqual(first.journalLines.map((line) => line.external_id), second.journalLines.map((line) => line.external_id));
  assert.equal(new Set(first.accruals.map((item) => item.id)).size, first.accruals.length);
});

test("journal export includes source references and reversals", () => {
  const result = new AccrualEngine().run(structuredClone(anchorData));
  const csv = toJournalCsv(result.journalLines);
  assert.match(csv, /evt_u0001/);
  assert.match(csv, /GR-2026-0042/);
  assert.match(csv, /reversal/);
  assert.match(csv, /2026-04-01/);
});
