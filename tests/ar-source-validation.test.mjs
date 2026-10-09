import test from "node:test";
import assert from "node:assert/strict";
import { AccrualEngine } from "../dist/engine.js";
import { sourceRecordsFor } from "../dist/accrual-view.js";
import { anchorData } from "./fixtures/anchor-data.js";

const run = sheets => new AccrualEngine().run(sheets);

test("duplicate accrued and historical event IDs are rejected, not double counted", () => {
  for (const id of ["evt_u0001", "evt_h0001"]) {
    const sheets = structuredClone(anchorData);
    sheets.usage_events.push({ ...sheets.usage_events.find(row => row.event_id === id) });
    assert.throws(() => run(sheets), /Duplicate usage event_id/);
  }
});

test("missing and whitespace-equivalent usage IDs require source correction", () => {
  const sheets = structuredClone(anchorData);
  sheets.usage_events.push({ ...sheets.usage_events[0], event_id: " evt_h0001 " });
  assert.throws(() => run(sheets), /Duplicate usage event_id/);
  sheets.usage_events.pop();
  for (const id of [undefined, "", " "]) {
    sheets.usage_events[0].event_id = id;
    assert.throws(() => run(sheets), /Missing usage event_id/);
  }
});

test("future invoices cannot reduce a past close or change its source drill-through", () => {
  const sheets = structuredClone(anchorData);
  sheets.chargebee_invoices.push({ ...sheets.chargebee_invoices[0], invoice_id: "FUTURE", period_end: "2026-04-04", issued_at: "2026-04-05T00:00:00Z", fx_to_usd: 9 });
  const result = run(sheets);
  assert.equal(result.totals.ar, 362.5);
  const item = result.accruals.find(row => row.sourceDetail.customer_id === "CUS-1001");
  const groups = sourceRecordsFor(item, sheets);
  assert.equal(groups[2].rows[0].invoice_id, "INV-2026-0291");
  assert.deepEqual(groups[1].rows.map(row => row.event_id), ["evt_h0001"]);
});

test("late-issued invoices with a March period end are still excluded from March", () => {
  const sheets = structuredClone(anchorData);
  sheets.chargebee_invoices.push({ ...sheets.chargebee_invoices[0], period_end: "2026-03-31", issued_at: "2026-04-01T00:00:00Z" });
  assert.equal(run(sheets).totals.ar, 362.5);
});

test("an early-issued invoice covering a future period is not a close cutoff", () => {
  const sheets = structuredClone(anchorData);
  sheets.chargebee_invoices.push({ ...sheets.chargebee_invoices[0], period_end: "2026-04-04", issued_at: "2026-03-31T00:00:00Z" });
  assert.equal(run(sheets).totals.ar, 362.5);
});

test("invoice issuance cutoff includes close day and normalizes timezones to UTC", () => {
  const sheets = structuredClone(anchorData);
  const invoice = { ...sheets.chargebee_invoices[0], period_end: "2026-03-29", issued_at: "2026-03-31T23:59:59Z" };
  sheets.chargebee_invoices.push(invoice);
  assert.equal(run(sheets).totals.ar, 317.5);
  invoice.issued_at = "2026-03-31T23:30:00-02:00";
  assert.equal(run(sheets).totals.ar, 362.5);
  invoice.issued_at = new Date("2026-03-31T23:59:59Z");
  assert.equal(run(sheets).totals.ar, 317.5);
});

test("missing or invalid invoice cutoff dates stop calculation", () => {
  for (const value of [undefined, "bad-date", "2026-02-30", "2026-03-31T12:00:00", new Date("invalid")]) {
    const sheets = structuredClone(anchorData);
    sheets.chargebee_invoices[0].issued_at = value;
    assert.throws(() => run(sheets), /billing issued_at/);
  }
  const sheets = structuredClone(anchorData);
  sheets.chargebee_invoices[0].period_end = "bad-date";
  assert.throws(() => run(sheets), /billing period_end/);
});

test("customers without eligible billing history cannot silently lose close usage", () => {
  const sheets = structuredClone(anchorData);
  sheets.chargebee_invoices[0].issued_at = "2026-04-01";
  assert.throws(() => run(sheets), /No billing history issued by 2026-03-31 for CUS-1001/);
});

test("churned status alone does not discard earned usage", () => {
  const sheets = structuredClone(anchorData);
  const item = run(sheets).accruals.find(row => row.counterparty === "Cobra Systems LLC");
  assert.equal(item.amountUsd, 100);
  assert.equal(item.source, "evt_u0007");
});
