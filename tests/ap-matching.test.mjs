import test from "node:test";
import assert from "node:assert/strict";
import { AccrualEngine, toJournalCsv, getExportAvailability } from "../dist/engine.js";
import { anchorData } from "./fixtures/anchor-data.js";
import { reviewAccrual } from "../dist/review.js";
const fixture = () => structuredClone(anchorData);
const invoice = (changes = {}) => ({ invoice_number: "INV-1", vendor_id: "VEN-DELL-01", po_number: "PO-2026-0188", invoice_date: "2026-03-30", subtotal_usd: 40000, status: "approved", ...changes });
const run = data => new AccrualEngine().run(data, { handlers: ["AP_GRNI"] });
const receipt2 = (data, changes = {}) => data.goods_receipts.push({ ...data.goods_receipts[0], receipt_id: "GR-2", value_usd: 50000, received_qty: 1, ...changes });

test("partial invoice leaves residual, original journal pair, dates and invoice audit references", () => {
  const data = fixture(); data.vendor_invoices = [invoice()];
  const result = run(data), ap = result.accruals[0];
  assert.equal(ap.amountUsd, 60000); assert.equal(ap.status, "READY");
  assert.equal(ap.matching.matchedInvoiceUsd, 40000);
  assert.equal(ap.lines.length, 2); assert.equal(result.control.balanced, true);
  const csv = toJournalCsv(result.journalLines, "AP");
  assert.match(csv, /GR-2026-0042\|PO-2026-0188\|L1\|INV:INV-1/);
  assert.match(csv, /03\/31\/2026/); assert.match(csv, /04\/01\/2026/);
});
test("invoice for one receipt does not suppress another receipt on the same PO", () => {
  const data = fixture(); receipt2(data);
  data.vendor_invoices = [invoice({ receipt_id: "GR-2026-0042", subtotal_usd: 100000 })];
  const result = run(data);
  assert.equal(result.accruals.length, 1); assert.equal(result.totals.ap, 50000);
  assert.match(result.accruals[0].source, /^GR-2\|/);
});
test("invoice date cutoff is inclusive, accepts Excel dates, and ignores later invoices", () => {
  for (const [invoice_date, expected] of [["2026-03-31",60000],["2026-04-01",100000],[new Date("2026-03-31T00:00:00Z"),60000]]) {
    const data = fixture(); data.vendor_invoices = [invoice({ invoice_date })];
    assert.equal(run(data).totals.ap, expected);
  }
});
test("future receipts are excluded but prevent a falsely unique PO-only match", () => {
  const data = fixture(); receipt2(data, { received_on: "2026-04-01" });
  assert.equal(run(data).totals.ap, 100000);
  data.vendor_invoices = [invoice()];
  assert.equal(run(data).accruals[0].status, "REVIEW");
});
test("PO line matches only its unique receipt", () => {
  const data = fixture();
  data.po_lines.push({ ...data.po_lines[0], po_line_ref: "L2" }); receipt2(data, { po_line_ref: "L2" });
  data.vendor_invoices = [invoice({ po_line_ref: "L1", subtotal_usd: 100000 })];
  assert.equal(run(data).totals.ap, 50000); assert.equal(run(data).accruals[0].status, "READY");
});
test("PO-only invoice on a multi-line PO is not assumed to cover its sole receipt", () => {
  const data = fixture(); data.po_lines.push({ ...data.po_lines[0], po_line_ref: "L2" });
  data.vendor_invoices = [invoice()]; assert.equal(run(data).accruals[0].status, "REVIEW");
});
test("multiple invoices sum using cents without changing receipt IDs on rerun", () => {
  const data = fixture(); data.vendor_invoices = [invoice({subtotal_usd: 12345.67}), invoice({invoice_number: "INV-2", subtotal_usd: 7654.33})];
  const first = run(data); assert.equal(first.totals.ap, 80000);
  data.vendor_invoices.reverse(); assert.deepEqual(run(data), first);
});
test("ambiguous PO/line invoices stay Review, lock export and cannot be manually waived", () => {
  for (const match of [{}, {po_line_ref: "L1"}]) {
    const data = fixture(); receipt2(data); data.vendor_invoices = [invoice(match)];
    const result = run(data); assert.equal(result.totals.ap, 150000);
    assert.ok(result.accruals.every(row => row.status === "REVIEW"));
    assert.equal(getExportAvailability(result.journalLines, "AP").allowed, false);
    assert.throws(() => toJournalCsv(result.journalLines, "AP"), /not Ready/);
    assert.throws(() => reviewAccrual(result, result.accruals[0].id, {reviewer:"Test",note:"checked",confirmed:true}), /Correct the source data/);
  }
});
test("explicit allocations split an invoice across receipts without repeating its subtotal", () => {
  const data = fixture(); receipt2(data);
  data.vendor_invoices = [invoice({receipt_id:"GR-2026-0042", invoice_line_ref:"A1", allocated_amount_usd:30000}), invoice({receipt_id:"GR-2",invoice_line_ref:"A2",allocated_amount_usd:10000})];
  const result = run(data); assert.deepEqual(result.accruals.map(row => row.amountUsd), [70000,40000]);
  assert.ok(result.accruals.every(row => row.status === "READY"));
});
test("duplicate invoice headers or allocations never double count", () => {
  for (const extra of [{}, {receipt_id:"GR-2026-0042", invoice_line_ref:"A1", allocated_amount_usd:40000}]) {
    const data = fixture(); data.vendor_invoices = [invoice(extra),invoice(extra)];
    const ap = run(data).accruals[0]; assert.equal(ap.amountUsd,100000); assert.equal(ap.status,"REVIEW");
  }
});
test("allocation totals must reconcile to a consistent invoice header", () => {
  for (const change of [{allocated_amount_usd:20000},{subtotal_usd:50000},{invoice_date:"2026-03-29"},{status:"draft"}]) {
    const data=fixture(); receipt2(data);
    data.vendor_invoices=[invoice({receipt_id:"GR-2026-0042",invoice_line_ref:"A1",allocated_amount_usd:30000}),invoice({receipt_id:"GR-2",invoice_line_ref:"A2",allocated_amount_usd:10000,...change})];
    assert.equal(run(data).totals.review,2,JSON.stringify(change));
  }
});
test("missing/invalid invoice fields and unknown statuses produce actionable Review", () => {
  for (const change of [{invoice_date:""},{invoice_date:"2026-02-30"},{invoice_date:"03/30/2026"},{subtotal_usd:""},{subtotal_usd:-2},{subtotal_usd:"abc"},{status:"draft"},{status:""},{vendor_id:"wrong"},{invoice_number:""},{receipt_id:"missing"},{po_number:""},{allocated_amount_usd:100}]) {
    const data = fixture(); data.vendor_invoices = [invoice(change)];
    const ap = run(data).accruals[0]; assert.equal(ap.status,"REVIEW", JSON.stringify(change));
    assert.equal(ap.amountUsd,100000); assert.ok(ap.reviewReasons.length);
  }
});
test("void/cancelled/rejected invoices do not reduce a receipt", () => {
  for (const status of ["void","voided","cancelled","canceled","rejected"]) {
    const data = fixture(); data.vendor_invoices = [invoice({status})];
    const ap = run(data).accruals[0]; assert.equal(ap.amountUsd,100000); assert.equal(ap.status,"READY");
  }
});
test("approved, posted, paid and open are eligible invoice statuses", () => {
  for (const status of ["approved","posted","paid","open"," Approved "]) {
    const data = fixture(); data.vendor_invoices = [invoice({status})]; assert.equal(run(data).totals.ap,60000);
  }
});
test("over-invoicing retains zero-dollar Review and blocks AP export", () => {
  const data = fixture(); data.vendor_invoices = [invoice({subtotal_usd:100001})];
  const result = run(data); assert.equal(result.accruals.length,1);
  assert.equal(result.totals.ap,0); assert.equal(result.accruals[0].status,"REVIEW");
  assert.equal(getExportAvailability(result.journalLines,"AP").allowed,false);
});
test("full match plus an uncertain invoice does not disappear from Review", () => {
  const data = fixture(); data.vendor_invoices = [invoice({subtotal_usd:100000}),invoice({invoice_number:"INV-2",invoice_date:""})];
  const ap = run(data).accruals[0]; assert.equal(ap.amountUsd,0); assert.equal(ap.status,"REVIEW");
});
test("correcting an ambiguous invoice and rerunning clears Review", () => {
  const data = fixture(); receipt2(data); data.vendor_invoices = [invoice()];
  assert.equal(run(data).totals.review,2);
  data.vendor_invoices[0].receipt_id = "GR-2026-0042";
  const result = run(data); assert.equal(result.totals.ap,110000); assert.equal(result.totals.review,0);
  assert.equal(getExportAvailability(result.journalLines,"AP").allowed,true);
});
test("multiple lines of one receipt retain unique accrual and line IDs", () => {
  const data = fixture(); data.po_lines.push({...data.po_lines[0],po_line_ref:"L2"});
  receipt2(data,{receipt_id:"GR-2026-0042",po_line_ref:"L2"});
  const result=run(data); assert.equal(new Set(result.accruals.map(row=>row.id)).size,2);
  assert.doesNotThrow(()=>toJournalCsv(result.journalLines,"AP"));
  data.vendor_invoices=[invoice({receipt_id:"GR-2026-0042"})];
  assert.equal(run(data).totals.review,2);
  data.vendor_invoices[0].po_line_ref="L1"; assert.equal(run(data).totals.review,0);
});
test("invalid or duplicate receipt data fails calculation instead of exporting silently", () => {
  for (const change of [{received_on:""},{received_on:"2026-02-30"},{value_usd:""},{value_usd:-1},{po_line_ref:"unknown"}]) {
    const data = fixture(); Object.assign(data.goods_receipts[0],change); assert.throws(()=>run(data));
  }
  const data=fixture(); data.goods_receipts.push({...data.goods_receipts[0]}); assert.throws(()=>run(data),/duplicate receipt/);
});
