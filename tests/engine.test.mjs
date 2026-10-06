import test from "node:test";
import assert from "node:assert/strict";
import { AccrualEngine, ReceiptAccrualHandler, UsageAccrualHandler, toJournalCsv, formatOutputDate, getExportAvailability } from "../dist/engine.js";
import { reviewAccrual, filterAccruals } from "../dist/review.js";
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

test("Review help formula matches the inclusive 2x per-event historical average", () => {
  const sheets = structuredClone(anchorData);
  sheets.usage_events.push({ ...sheets.usage_events[0], event_id: "extra-history", quantity: 20, occurred_on: "2026-03-27" });
  const event = sheets.usage_events.find(item => item.event_id === "evt_u0002");
  event.quantity = 30;
  const flagged = new AccrualEngine().run(sheets).accruals[0];
  assert.equal(flagged.anomaly.baseline, 15);
  assert.equal(flagged.status, "REVIEW");
  assert.equal(flagged.amountUsd, 225);
  event.quantity = 29.99;
  assert.equal(new AccrualEngine().run(sheets).accruals[0].status, "READY");
});

test("Review help accurately describes absent and zero historical baselines", () => {
  const sheets = structuredClone(anchorData);
  sheets.usage_events[0].quantity = 0;
  assert.equal(new AccrualEngine().run(sheets).accruals[0].anomaly.baseline, 0);
  sheets.usage_events = sheets.usage_events.filter(event => !event.event_id.startsWith("evt_h"));
  assert.equal(new AccrualEngine().run(sheets).accruals[0].status, "READY");
});

test("partial receipt accrues receipt value, not full PO", () => {
  const result = new AccrualEngine().run(structuredClone(anchorData));
  const ap = result.accruals.find((item) => item.side === "AP");
  assert.equal(ap.amountUsd, 100000);
  assert.notEqual(ap.amountUsd, 250000);
});

test("full invoice unambiguously matching the sole receipt leaves no GRNI accrual", () => {
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

function csvRows(csv) {
  const [header, ...rows] = csv.split("\n");
  const columns = header.split(",");
  return rows.map(row => {
    const values = [...row.matchAll(/"((?:[^"]|"")*)"(?:,|$)/g)].map(match => match[1].replaceAll('""', '"'));
    assert.equal(values.length, columns.length);
    return Object.fromEntries(columns.map((column, index) => [column, values[index]]));
  });
}

const reviewEvidence = { reviewer: "Test Reviewer", note: "Verified source events and price book in test fixture.", confirmed: true };
function readyResult(context) {
  const result = new AccrualEngine().run(structuredClone(anchorData), context);
  for (const item of result.accruals.filter(item => item.status === "REVIEW")) {
    reviewAccrual(result, item.id, reviewEvidence, new Date("2026-04-01T10:20:30Z"));
  }
  return result;
}

test("AR and AP CSVs have only their own balanced original journal lines", () => {
  const result = readyResult();
  assert.equal(result.journalLines.length, 8);
  for (const [side, handler, count, total] of [["AR", "AR_USAGE", 6, 362.5], ["AP", "AP_GRNI", 2, 100000]]) {
    const csv = toJournalCsv(result.journalLines, side);
    const rows = csvRows(csv);
    assert.equal(rows.length, count);
    assert.equal(rows.reduce((sum, row) => sum + Number(row.debit_usd), 0), total);
    assert.equal(rows.reduce((sum, row) => sum + Number(row.credit_usd), 0), total);
    for (const row of rows) {
      assert.equal(row.handler, handler);
      assert.equal(row.line_type, "accrual");
      assert.equal(row.posting_date, "03/31/2026");
      assert.equal(row.reversal_date, "04/01/2026");
      assert.equal(row.external_id, `HELIX-2026-03-${side}`);
    }
    for (const id of new Set(rows.map(row => row.external_id))) {
      const journal = rows.filter(row => row.external_id === id);
      assert.equal(journal.length, count);
      assert.equal(new Set(journal.map(row => row.reversal_date)).size, 1);
      assert.equal(journal.reduce((sum, row) => sum + Number(row.debit_usd) - Number(row.credit_usd), 0), 0);
    }
  }
  assert.match(toJournalCsv(result.journalLines, "AR"), /evt_u0001/);
  assert.doesNotMatch(toJournalCsv(result.journalLines, "AR"), /GR-2026-0042/);
  assert.match(toJournalCsv(result.journalLines, "AP"), /GR-2026-0042/);
  assert.doesNotMatch(toJournalCsv(result.journalLines, "AP"), /evt_u0001/);
  assert.doesNotMatch(toJournalCsv(result.journalLines, "AR"), /"REVIEW"/);
});

test("exports respect a supplied journal reversal date", () => {
  const result = readyResult({ reversalDate: "2026-04-02" });
  for (const side of ["AR", "AP"]) {
    assert.ok(csvRows(toJournalCsv(result.journalLines, side)).every(row => row.reversal_date === "04/02/2026"));
  }
});

test("export rejects missing, invalid, or inconsistent journal-header dates", () => {
  const result = readyResult();
  for (const date of [undefined, "", "2026-02-30", "not-a-date"]) {
    const lines = structuredClone(result.journalLines);
    lines[0].reversal_date = date;
    assert.throws(() => toJournalCsv(lines, "AR"), /invalid reversal date/);
  }
  const lines = structuredClone(result.journalLines);
  lines[0].reversal_date = "2026-04-02";
  assert.throws(() => toJournalCsv(lines, "AR"), /Inconsistent journal header/);
});

test("export requires an explicit side and blocks an empty side", () => {
  assert.throws(() => toJournalCsv([]), /Choose AR or AP/);
  assert.throws(() => toJournalCsv([], "ALL"), /Choose AR or AP/);
  assert.throws(() => toJournalCsv([], "AP"), /No AP accruals/);
  assert.equal(getExportAvailability([], "AP").allowed, false);
});

test("legacy reversal rows cannot leak into the export", () => {
  const result = readyResult();
  const oldReversal = { ...result.journalLines[0], line_type: "reversal", posting_date: "2026-04-01" };
  assert.equal(toJournalCsv([...result.journalLines, oldReversal], "AR"), toJournalCsv(result.journalLines, "AR"));
});

test("CSV preserves commas and quotes in source descriptions", () => {
  const result = readyResult();
  result.journalLines[0].memo = 'Usage, "review required"';
  assert.equal(csvRows(toJournalCsv(result.journalLines, "AR"))[0].memo, 'Usage, "review required"');
});

test("one external ID per month and side, distinct across months and years", () => {
  const engine = new AccrualEngine();
  for (const date of ["2026-03-30", "2026-03-31", "2026-04-30", "2027-03-31"]) {
    const result = readyResult({ closeDate: date });
    for (const side of ["AR", "AP"]) {
      const rows = csvRows(toJournalCsv(result.journalLines, side));
      assert.deepEqual([...new Set(rows.map(row => row.external_id))], [`HELIX-${date.slice(0, 7)}-${side}`]);
    }
  }
});

test("each journal line retains its unique audit ID and exact source-group relationship", () => {
  const result = readyResult();
  assert.equal(new Set(result.journalLines.map(line => line.line_id)).size, 8);
  for (const item of result.accruals) {
    const rows = csvRows(toJournalCsv(result.journalLines, item.side)).filter(row => row.accrual_id === item.id);
    assert.equal(rows.length, 2);
    assert.deepEqual(rows.map(row => row.line_id), [`${item.id}-DR`, `${item.id}-CR`]);
    assert.ok(rows.every(row => row.source_ref === item.source));
  }
  const shuffled = structuredClone(anchorData);
  shuffled.usage_events.reverse();
  const rerun = new AccrualEngine().run(shuffled);
  assert.deepEqual(rerun.journalLines.map(line => line.line_id).sort(), result.journalLines.map(line => line.line_id).sort());
});

test("monthly journal rejects differing header dates across customer accruals", () => {
  const result = readyResult();
  result.journalLines[2].reversal_date = "2026-04-02";
  result.journalLines[3].reversal_date = "2026-04-02";
  assert.throws(() => toJournalCsv(result.journalLines, "AR"), /Inconsistent journal header/);
});

test("audit metadata is required and duplicate line IDs are rejected", () => {
  const result = readyResult();
  for (const field of ["line_id", "accrual_id", "source_ref"]) {
    const lines = structuredClone(result.journalLines);
    delete lines[0][field];
    assert.throws(() => toJournalCsv(lines, "AR"), /Missing line-level audit/);
  }
  assert.throws(() => toJournalCsv([...result.journalLines, result.journalLines[0]], "AR"), /Duplicate audit line ID/);
});

test("date formatting is zero-padded, validates dates, and never changes internal ISO values", () => {
  assert.equal(formatOutputDate("2026-01-09"), "01/09/2026");
  assert.equal(formatOutputDate("2028-02-29"), "02/29/2028");
  assert.equal(formatOutputDate("2026-12-31"), "12/31/2026");
  assert.throws(() => formatOutputDate("2026-02-29"), /invalid date/);
  const result = readyResult();
  const before = structuredClone(result.journalLines);
  toJournalCsv(result.journalLines, "AR");
  assert.deepEqual(result.journalLines, before);
});

test("an unresolved AR review blocks its full export without blocking AP", () => {
  const result = new AccrualEngine().run(structuredClone(anchorData));
  assert.equal(getExportAvailability(result.journalLines, "AR").allowed, false);
  assert.equal(getExportAvailability(result.journalLines, "AP").allowed, true);
  assert.throws(() => toJournalCsv(result.journalLines, "AR"), /AR download locked/);
  assert.equal(csvRows(toJournalCsv(result.journalLines, "AP")).length, 2);
});

test("review requires name, note, and explicit confirmation without partial mutation", () => {
  const result = new AccrualEngine().run(structuredClone(anchorData));
  const item = result.accruals.find(item => item.status === "REVIEW");
  const before = structuredClone(result);
  for (const input of [{ reviewer: "  " }, { note: "  " }, { confirmed: false }]) {
    assert.throws(() => reviewAccrual(result, item.id, { ...reviewEvidence, ...input }));
    assert.deepEqual(result, before);
  }
});

test("mark Ready changes both lines, preserves amounts/sources, and exports review evidence", () => {
  const original = new AccrualEngine().run(structuredClone(anchorData));
  const result = readyResult();
  assert.equal(result.totals.ready, 4);
  assert.equal(result.totals.review, 0);
  assert.equal(result.totals.ar, original.totals.ar);
  assert.deepEqual(result.accruals[0].anomaly, original.accruals[0].anomaly);
  assert.deepEqual(result.control, original.control);
  assert.deepEqual(result.journalLines.map(line => [line.line_id, line.source_ref, line.debit_usd, line.credit_usd]), original.journalLines.map(line => [line.line_id, line.source_ref, line.debit_usd, line.credit_usd]));
  assert.equal(getExportAvailability(result.journalLines, "AR").allowed, true);
  const rows = csvRows(toJournalCsv(result.journalLines, "AR"));
  for (const row of rows.slice(0, 2)) {
    assert.equal(row.review_status, "READY");
    assert.equal(row.reviewed_by, "Test Reviewer");
    assert.equal(row.review_note, reviewEvidence.note);
    assert.equal(row.reviewed_on, "04/01/2026");
    assert.equal(row.reviewed_time_utc, "10:20:30");
  }
  assert.ok(rows.slice(2).every(row => row.reviewed_by === ""));
});

test("reopening re-locks the side and preserves current-run review history", () => {
  const result = readyResult();
  const item = result.accruals.find(item => item.review);
  reviewAccrual(result, item.id, { ...reviewEvidence, action: "reopen", note: "Source needs another check." });
  assert.equal(item.status, "REVIEW");
  assert.ok(item.lines.every(line => line.review_status === "REVIEW" && line.reviewed_by === ""));
  assert.equal(result.totals.review, 1);
  assert.equal(result.reviewLog.length, 2);
  assert.throws(() => toJournalCsv(result.journalLines, "AR"), /download locked/);
});

test("new calculations reset approvals even when source IDs are identical", () => {
  const approved = readyResult();
  const rerun = new AccrualEngine().run(structuredClone(anchorData));
  assert.equal(approved.accruals[0].id, rerun.accruals[0].id);
  assert.equal(rerun.accruals[0].status, "REVIEW");
  assert.equal(rerun.accruals[0].review, undefined);
  assert.equal(getExportAvailability(rerun.journalLines, "AR").allowed, false);
});

test("filters combine across all four fields and cannot unlock an unfiltered side", () => {
  const result = new AccrualEngine().run(structuredClone(anchorData));
  assert.equal(filterAccruals(result.accruals).length, 4);
  assert.equal(filterAccruals(result.accruals, { side: "AR" }).length, 3);
  assert.equal(filterAccruals(result.accruals, { counterparty: "Berlin Labs GmbH" }).length, 1);
  assert.equal(filterAccruals(result.accruals, { status: "REVIEW" }).length, 1);
  assert.equal(filterAccruals(result.accruals, { handler: "AP_GRNI" }).length, 1);
  assert.equal(filterAccruals(result.accruals, { side: "AR", counterparty: "Berlin Labs GmbH", status: "READY", handler: "AR_USAGE" }).length, 1);
  assert.equal(filterAccruals(result.accruals, { side: "AP", status: "REVIEW" }).length, 0);
  assert.equal(filterAccruals(result.accruals, { side: "AR", status: "READY" }).length, 2);
  assert.throws(() => toJournalCsv(result.journalLines, "AR"), /download locked/);
  assert.equal(result.accruals.length, 4);
});

test("counterparty search matches partial names regardless of case and surrounding spaces", () => {
  const { accruals } = new AccrualEngine().run(structuredClone(anchorData));
  for (const query of ["ber", "LABS", "  bErLiN  ", "GmbH"]) {
    assert.deepEqual(filterAccruals(accruals, { counterparty: query }).map(item => item.counterparty), ["Berlin Labs GmbH"]);
  }
  assert.equal(filterAccruals(accruals, { counterparty: "hardware" })[0].side, "AP");
  assert.equal(filterAccruals(accruals, { counterparty: "" }).length, 4);
  assert.equal(filterAccruals(accruals, { counterparty: "   " }).length, 4);
  assert.equal(filterAccruals(accruals, { counterparty: "no matching company" }).length, 0);
  assert.equal(filterAccruals(accruals, { counterparty: ".*" }).length, 0);
});

test("partial counterparty search combines with dropdown filters without changing results or export gates", () => {
  const result = new AccrualEngine().run(structuredClone(anchorData));
  const before = structuredClone(result);
  assert.equal(filterAccruals(result.accruals, { counterparty: "labs", side: "AR", status: "READY", handler: "AR_USAGE" }).length, 1);
  assert.equal(filterAccruals(result.accruals, { counterparty: "labs", side: "AP" }).length, 0);
  assert.equal(filterAccruals(result.accruals, { counterparty: "labs", status: "REVIEW" }).length, 0);
  assert.equal(filterAccruals(result.accruals, { counterparty: "labs", handler: "AP_GRNI" }).length, 0);
  assert.equal(getExportAvailability(result.journalLines, "AR").allowed, false);
  assert.equal(getExportAvailability(result.journalLines, "AP").allowed, true);
  assert.deepEqual(result, before);
});

test("any non-Ready line blocks export, including an unexpected status", () => {
  const result = readyResult();
  result.journalLines[1].review_status = "UNKNOWN";
  assert.throws(() => toJournalCsv(result.journalLines, "AR"), /download locked/);
});

test("review notes are exported as literal text, not spreadsheet formulas", () => {
  const result = new AccrualEngine().run(structuredClone(anchorData));
  reviewAccrual(result, result.accruals[0].id, { ...reviewEvidence, note: '=HYPERLINK("https://example.com","not a formula")' });
  const note = csvRows(toJournalCsv(result.journalLines, "AR"))[0].review_note;
  assert.ok(note.startsWith("'="));
});
