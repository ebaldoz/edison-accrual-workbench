import test from "node:test";
import assert from "node:assert/strict";
import { periodDates, periodLabel } from "../dist/period.js";
import { AccrualEngine, toJournalCsv } from "../dist/engine.js";
import { anchorData } from "./fixtures/anchor-data.js";
import { reviewAccrual } from "../dist/review.js";

test("selected periods use month end and the first day of the next month", () => {
  assert.deepEqual(periodDates(2026, 3), { closeDate: "2026-03-31", reversalDate: "2026-04-01" });
  assert.deepEqual(periodDates(2028, 2), { closeDate: "2028-02-29", reversalDate: "2028-03-01" });
  assert.deepEqual(periodDates(2026, 12), { closeDate: "2026-12-31", reversalDate: "2027-01-01" });
  assert.equal(periodLabel(2026, 3), "Mar 2026");
  assert.throws(() => periodDates(2026, 13), /valid month/);
  assert.throws(() => periodDates(2101, 1), /year from 1900/);
});

test("selected period dates flow to journal lines and exported CSV", () => {
  const dates = periodDates(2026, 4);
  const result = new AccrualEngine().run(structuredClone(anchorData), dates);
  assert.ok(result.journalLines.length > 0);
  assert.ok(result.journalLines.every(line => line.posting_date === "2026-04-30" && line.reversal_date === "2026-05-01"));
  assert.ok(result.journalLines.every(line => line.external_id.endsWith("2026-04-AR") || line.external_id.endsWith("2026-04-AP")));
  for (const item of result.accruals.filter(item => item.status === "REVIEW")) {
    reviewAccrual(result, item.id, { reviewer: "Period test", note: "Source verified", confirmed: true });
  }
  for (const side of ["AR", "AP"]) {
    const csv = toJournalCsv(result.journalLines, side);
    assert.match(csv, /"04\/30\/2026","05\/01\/2026"/);
  }
});
