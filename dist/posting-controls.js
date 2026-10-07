import { getExportAvailability, toJournalCsv } from "./engine.js";

function linesForSide(result, side) {
  if (!result || !["AR", "AP"].includes(side)) throw new Error("Choose a calculated AR or AP journal.");
  return result.journalLines.filter(line => line.side === side && line.line_type === "accrual");
}

export function journalIdForSide(result, side) {
  const ids = new Set(linesForSide(result, side).map(line => line.external_id));
  if (ids.size !== 1) throw new Error(`Expected one monthly ${side} journal external ID.`);
  return [...ids][0];
}

function journalSignature(result, side) {
  return JSON.stringify({
    runId: result.runId,
    closeDate: result.closeDate,
    reversalDate: result.reversalDate,
    lines: linesForSide(result, side),
  });
}

export function getPostingAvailability(result, side) {
  if (!result) return { allowed: false, reason: "Import a workbook before downloading." };
  const calculation = getExportAvailability(result.journalLines, side);
  if (!calculation.allowed) return calculation;
  if (side === "AR") return { allowed: true, reason: "AR is Ready for download." };
  const check = result.postingChecks?.[side];
  let currentJournalId;
  try { currentJournalId = journalIdForSide(result, side); }
  catch (error) { return { allowed: false, reason: error.message }; }
  if (!check || check.journalId !== currentJournalId || check.signature !== journalSignature(result, side)) {
    return { allowed: false, reason: "AP receipt/GL reconciliation required before download." };
  }
  return { allowed: true, reason: `AP receipt/GL check recorded by ${check.reviewer}. Ready for download.` };
}

export function recordPostingCheck(result, side, { reviewer, evidence, apGlNotRecorded }, now = new Date()) {
  if (!result) throw new Error("Import a workbook before recording an export check.");
  if (side !== "AP") throw new Error("Only AP requires a receipt/GL export check.");
  const calculation = getExportAvailability(result.journalLines, side);
  if (!calculation.allowed) throw new Error(calculation.reason);
  const name = String(reviewer || "").trim();
  const reference = String(evidence || "").trim();
  if (!name || name.length > 100) throw new Error("Enter the checker’s name (up to 100 characters).");
  if (!reference || reference.length > 1000) throw new Error("Enter a receipt/GL reconciliation evidence reference (up to 1,000 characters).");
  if (apGlNotRecorded !== true) throw new Error("Confirm the proposed AP balance is not already recorded by goods-receipt or other GL postings. If any amount is posted, stop and reconcile it.");
  if (!Number.isFinite(now.getTime())) throw new Error("Invalid export-check time.");
  // Check journal structure before accepting a human sign-off, not only at download time.
  toJournalCsv(result.journalLines, side);
  const check = {
    journalId: journalIdForSide(result, side),
    signature: journalSignature(result, side),
    reviewer: name,
    evidence: reference,
    checkedAt: now.toISOString(),
    apGlNotRecorded: true,
  };
  result.postingChecks ||= {};
  result.postingChecks[side] = check;
  return check;
}

export function revokePostingCheck(result, side) {
  if (!result || !["AR", "AP"].includes(side)) throw new Error("Choose a calculated AR or AP journal.");
  if (result.postingChecks) delete result.postingChecks[side];
}

export function toPostingControlledCsv(result, side) {
  const availability = getPostingAvailability(result, side);
  if (!availability.allowed) throw new Error(availability.reason);
  if (side === "AR") return toJournalCsv(result.journalLines, side);
  const check = result.postingChecks[side];
  const checkedLines = result.journalLines.map(line => line.side === "AP" ? {
    ...line,
    posting_checked_by: check.reviewer,
    posting_check_evidence: check.evidence,
    posting_checked_on: check.checkedAt.slice(0, 10),
    posting_checked_time_utc: check.checkedAt.slice(11, 19),
    ap_gl_not_recorded_confirmed: "Yes",
  } : line);
  return toJournalCsv(checkedLines, side);
}

export function consumePostingControlledCsv(result, side) {
  const csv = toPostingControlledCsv(result, side);
  // A download is not proof of posting. Only AP's human GL check is one-use.
  if (side === "AP") revokePostingCheck(result, side);
  return csv;
}
