// Current-run review decisions only. No identity verification or durable approval store.
export function filterAccruals(accruals, filters = {}) {
  const query = String(filters.counterparty ?? "").trim().toLowerCase();
  return accruals.filter(item =>
    String(item.counterparty ?? "").toLowerCase().includes(query) &&
    ["side", "status", "handler"].every(key => !filters[key] || item[key] === filters[key])
  );
}

export function reviewAccrual(result, id, { reviewer, note, confirmed, action = "approve" }, now = new Date()) {
  const item = result.accruals.find(accrual => accrual.id === id);
  if (!item) throw new Error("Accrual not found. Reopen the current accrual and try again.");
  if (!["approve", "reopen"].includes(action)) throw new Error("Unknown review action.");
  if (action === "approve" && item.status !== "REVIEW") throw new Error("Only Review accruals can be marked Ready.");
  if (action === "approve" && item.reviewBlocked) throw new Error("Correct the AP invoice matching data and reimport the workbook before marking Ready. A review note cannot resolve an unknown allocation.");
  if (action === "reopen" && (item.status !== "READY" || !item.review)) throw new Error("Only a reviewed accrual can be reopened.");
  const name = String(reviewer || "").trim();
  const reason = String(note || "").trim();
  if (!name || name.length > 100) throw new Error("Enter a reviewer name (up to 100 characters).");
  if (!reason || reason.length > 1000) throw new Error("Enter a review note (up to 1,000 characters).");
  if (confirmed !== true) throw new Error("Confirm that you checked the source records and amount.");
  const reviewedAt = now.toISOString();
  const decision = { action, reviewer: name, note: reason, reviewedAt };
  result.reviewLog ||= [];
  result.reviewLog.push({ accrualId: id, ...decision });
  item.status = action === "approve" ? "READY" : "REVIEW";
  item.review = action === "approve" ? decision : null;
  const metadata = action === "approve" ? {
    reviewed_by: name,
    review_note: reason,
    reviewed_on: reviewedAt.slice(0, 10),
    reviewed_time_utc: reviewedAt.slice(11, 19),
  } : { reviewed_by: "", review_note: "", reviewed_on: "", reviewed_time_utc: "" };
  // Update both views of the lines, even if callers supplied independent copies.
  for (const line of [...item.lines, ...result.journalLines.filter(line => line.accrual_id === id)]) {
    Object.assign(line, metadata, { review_status: item.status });
  }
  result.totals.ready = result.accruals.filter(accrual => accrual.status === "READY").length;
  result.totals.review = result.accruals.filter(accrual => accrual.status === "REVIEW").length;
  return item;
}
