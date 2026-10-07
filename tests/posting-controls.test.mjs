import test from "node:test";
import assert from "node:assert/strict";
import { AccrualEngine } from "../dist/engine.js";
import { anchorData } from "../dist/anchor-data.js";
import { reviewAccrual } from "../dist/review.js";
import { getPostingAvailability, journalIdForSide, recordPostingCheck, revokePostingCheck, toPostingControlledCsv } from "../dist/posting-controls.js";

const run = () => new AccrualEngine().run(structuredClone(anchorData));
const evidence = { reviewer: "Controller A", evidence: "GL reconciliation GR-2026-0042 as of 03/31/2026", apGlNotRecorded: true };
const checkedAt = new Date("2026-04-01T10:20:30Z");

test("calculated AP stays proposed and download is locked until the receipt/GL check", () => {
  const result = run();
  assert.equal(result.totals.ap, 100000);
  assert.equal(result.accruals.find(item => item.side === "AP").status, "READY");
  assert.equal(getPostingAvailability(result, "AP").allowed, false);
  assert.match(getPostingAvailability(result, "AP").reason, /receipt\/GL/);
  assert.throws(() => toPostingControlledCsv(result, "AP"), /reconciliation required/);
  assert.equal(journalIdForSide(result, "AP"), "HELIX-2026-03-AP");
});

test("AP check requires evidence and no already-recorded GL amount, not a manual external-ID search", () => {
  const result = run();
  assert.throws(() => recordPostingCheck(result, "AP", { ...evidence, evidence: "" }), /evidence reference/);
  assert.throws(() => recordPostingCheck(result, "AP", { ...evidence, apGlNotRecorded: false }), /already recorded/);
  assert.throws(() => recordPostingCheck(result, "AR", evidence), /Only AP/);
  assert.equal(getPostingAvailability(result, "AP").allowed, false);
  recordPostingCheck(result, "AP", evidence, checkedAt);
  assert.equal(getPostingAvailability(result, "AP").allowed, true);
});

test("a recorded AP check unlocks export and puts its evidence on every CSV line", () => {
  const result = run();
  recordPostingCheck(result, "AP", evidence, checkedAt);
  assert.equal(getPostingAvailability(result, "AP").allowed, true);
  const csv = toPostingControlledCsv(result, "AP");
  assert.match(csv, /posting_checked_by,posting_check_evidence,posting_checked_on,posting_checked_time_utc,ap_gl_not_recorded_confirmed/);
  assert.equal(csv.split("\n").length, 3);
  assert.equal(csv.match(/"Controller A"/g)?.length, 2);
  assert.equal(csv.match(/"04\/01\/2026","10:20:30","Yes"/g)?.length, 2);
});

test("the current AP receipt/GL check permits repeat downloads of unchanged CSV", () => {
  const result = run();
  recordPostingCheck(result, "AP", evidence, checkedAt);
  const first = toPostingControlledCsv(result, "AP");
  assert.match(first, /HELIX-2026-03-AP/);
  assert.equal(getPostingAvailability(result, "AP").allowed, true);
  assert.equal(toPostingControlledCsv(result, "AP"), first);
  assert.equal(getPostingAvailability(result, "AP").allowed, true);
});

test("AR review must finish before download, but no manual export check is needed", () => {
  const result = run();
  assert.equal(getPostingAvailability(result, "AR").allowed, false);
  reviewAccrual(result, result.accruals.find(item => item.side === "AR" && item.status === "REVIEW").id,
    { reviewer: "Controller A", note: "Verified usage event", confirmed: true });
  assert.equal(getPostingAvailability(result, "AR").allowed, true);
  assert.equal(getPostingAvailability(result, "AP").allowed, false);
  const first = toPostingControlledCsv(result, "AR");
  assert.match(first, /HELIX-2026-03-AR/);
  assert.equal(toPostingControlledCsv(result, "AR"), first);
  assert.doesNotMatch(first, /"Controller A","GL reconciliation/);
});

test("changed journal evidence invalidates a prior check, and revocation relocks export", () => {
  const result = run();
  recordPostingCheck(result, "AP", evidence, checkedAt);
  result.journalLines.find(line => line.side === "AP").debit_usd = 99999;
  assert.equal(getPostingAvailability(result, "AP").allowed, false);
  assert.throws(() => toPostingControlledCsv(result, "AP"), /reconciliation required/);
  const fresh = run();
  recordPostingCheck(fresh, "AP", evidence, checkedAt);
  revokePostingCheck(fresh, "AP");
  assert.equal(getPostingAvailability(fresh, "AP").allowed, false);
  assert.equal(getPostingAvailability(run(), "AP").allowed, false);
});

test("reopening a reviewed usage accrual locks AR again", () => {
  const result = run();
  const item = result.accruals.find(accrual => accrual.side === "AR" && accrual.status === "REVIEW");
  reviewAccrual(result, item.id, { reviewer: "Controller A", note: "Verified usage", confirmed: true });
  assert.equal(getPostingAvailability(result, "AR").allowed, true);
  reviewAccrual(result, item.id, { reviewer: "Controller A", note: "Need another source check", confirmed: true, action: "reopen" });
  assert.equal(getPostingAvailability(result, "AR").allowed, false);
  assert.throws(() => toPostingControlledCsv(result, "AR"), /not Ready/);
});

test("a receipt matching Review cannot be bypassed by a journal export check", () => {
  const sheets = structuredClone(anchorData);
  sheets.vendor_invoices.push({ invoice_number: "INV-X", vendor_id: "VEN-DELL-01", po_number: "PO-2026-0188", invoice_date: "2026-03-30", status: "approved", subtotal_usd: "" });
  const result = new AccrualEngine().run(sheets);
  assert.equal(result.accruals.find(item => item.side === "AP").status, "REVIEW");
  assert.throws(() => recordPostingCheck(result, "AP", evidence), /not Ready/);
});
