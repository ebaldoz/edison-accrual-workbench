import { compact, formatOutputDate } from "./handler-kit.js";
import { HandlerRegistry } from "./handler-registry.js";
import { defaultHandlers } from "./handlers/index.js";

export { formatOutputDate } from "./handler-kit.js";
export { HandlerRegistry } from "./handler-registry.js";
export { UsageAccrualHandler } from "./handlers/usage.js";
export { ReceiptAccrualHandler } from "./handlers/receipt.js";

export function validateDataset(sheets, handlers = defaultHandlers) {
  const selected = handlers instanceof HandlerRegistry ? handlers.select() : handlers;
  const required = [...new Set(selected.flatMap(handler => handler.requiredSheets))];
  const missing = required.filter(name => !Array.isArray(sheets?.[name]));
  if (missing.length) throw new Error(`Missing required sheets: ${missing.join(", ")}`);
  return true;
}

function validateAccrual(item, handler) {
  if (!item || typeof item.id !== "string" || !item.id || item.handler !== handler.key || item.side !== handler.side ||
    !Number.isFinite(item.amountUsd) || item.amountUsd < 0 || !["READY", "REVIEW"].includes(item.status) ||
    !Array.isArray(item.lines) || item.lines.length < 2) {
    throw new Error(`Invalid accrual returned by ${handler.key}`);
  }
  let debit = 0;
  let credit = 0;
  for (const line of item.lines) {
    if (line.accrual_id !== item.id || line.handler !== handler.key || line.side !== handler.side ||
      line.review_status !== item.status || line.line_type !== "accrual" || !line.line_id || !line.source_ref ||
      !Number.isFinite(line.debit_usd) || !Number.isFinite(line.credit_usd) || line.debit_usd < 0 || line.credit_usd < 0) {
      throw new Error(`Invalid journal line returned by ${handler.key}`);
    }
    debit += line.debit_usd;
    credit += line.credit_usd;
  }
  if (Math.abs(debit - item.amountUsd) > 0.005 || Math.abs(credit - item.amountUsd) > 0.005) {
    throw new Error(`Unbalanced accrual returned by ${handler.key}: ${item.id}`);
  }
}

export class AccrualEngine {
  constructor(handlers = defaultHandlers) {
    this.registry = handlers instanceof HandlerRegistry ? handlers : new HandlerRegistry(handlers);
  }

  run(sheets, context = {}) {
    const selected = this.registry.select(context.handlers);
    validateDataset(sheets, selected);
    const closeDate = context.closeDate || "2026-03-31";
    const reversalDate = context.reversalDate || "2026-04-01";
    formatOutputDate(closeDate, "posting date");
    formatOutputDate(reversalDate, "reversal date");
    const normalizedContext = { closeDate, reversalDate };
    const accruals = selected.flatMap(handler => {
      const produced = handler.calculate(sheets, normalizedContext);
      if (!Array.isArray(produced)) throw new Error(`Handler ${handler.key} must return an array of accruals.`);
      produced.forEach(item => validateAccrual(item, handler));
      return produced;
    });
    const journalLines = accruals.flatMap(item => item.lines);
    if (new Set(accruals.map(item => item.id)).size !== accruals.length) throw new Error("Duplicate accrual ID across handlers.");
    if (new Set(journalLines.map(line => line.line_id)).size !== journalLines.length) throw new Error("Duplicate journal line ID across handlers.");
    const totals = {
      ar: +accruals.filter(item => item.side === "AR").reduce((sum, item) => sum + item.amountUsd, 0).toFixed(2),
      ap: +accruals.filter(item => item.side === "AP").reduce((sum, item) => sum + item.amountUsd, 0).toFixed(2),
      review: accruals.filter(item => item.status === "REVIEW").length,
      ready: accruals.filter(item => item.status === "READY").length,
    };
    return {
      runId: `HELIX-CLOSE-${compact(closeDate)}`,
      closeDate,
      reversalDate,
      handlerDefinitions: this.registry.definitions(selected),
      accruals,
      journalLines,
      totals,
      control: {
        debit: +journalLines.reduce((sum, line) => sum + line.debit_usd, 0).toFixed(2),
        credit: +journalLines.reduce((sum, line) => sum + line.credit_usd, 0).toFixed(2),
        balanced: Math.abs(journalLines.reduce((sum, line) => sum + line.debit_usd - line.credit_usd, 0)) < 0.005,
      },
    };
  }
}

function sideLines(lines, side) {
  if (!["AR", "AP"].includes(side)) throw new Error("Choose AR or AP for the journal export.");
  // Never emit separate reversing entries, including from legacy line collections.
  return lines.filter(line => line.side === side && line.line_type === "accrual");
}

export function getExportAvailability(lines, side) {
  const selected = sideLines(lines, side);
  if (!selected.length) return { allowed: false, reason: `No ${side} accruals to download.` };
  const pending = new Set(selected.filter(line => line.review_status !== "READY").map(line => line.accrual_id));
  if (pending.size) return { allowed: false, reason: `${side} download locked: ${pending.size} accrual(s) are not Ready.` };
  return { allowed: true, reason: `${side}: all accruals are Ready. Download includes the full side, regardless of filters.` };
}

export function toJournalCsv(lines, side) {
  const availability = getExportAvailability(lines, side);
  if (!availability.allowed) throw new Error(availability.reason);
  const selected = sideLines(lines, side);
  const headers = new Map();
  const lineIds = new Set();
  for (const line of selected) {
    const date = line.reversal_date;
    formatOutputDate(date, `reversal date for ${line.external_id}`);
    formatOutputDate(line.posting_date, `posting date for ${line.external_id}`);
    if (line.external_id !== `HELIX-${line.posting_date.slice(0, 7)}-${side}`) throw new Error("Journal external ID must match its month and side.");
    if (!line.line_id || !line.accrual_id || !line.source_ref) throw new Error("Missing line-level audit references.");
    if (lineIds.has(line.line_id)) throw new Error(`Duplicate audit line ID: ${line.line_id}`);
    lineIds.add(line.line_id);
    const header = JSON.stringify([line.posting_date, date, line.currency]);
    if (headers.has(line.external_id) && headers.get(line.external_id) !== header) {
      throw new Error(`Inconsistent journal header fields for ${line.external_id}`);
    }
    headers.set(line.external_id, header);
  }
  const columns = ["external_id", "line_id", "accrual_id", "line_type", "posting_date", "reversal_date", "account", "debit_usd", "credit_usd", "currency", "transaction_currency", "transaction_amount", "fx_to_usd", "memo", "source_ref", "review_status", "handler", "reviewed_by", "review_note", "reviewed_on", "reviewed_time_utc", "posting_checked_by", "posting_check_evidence", "posting_checked_on", "posting_checked_time_utc", "ap_gl_not_recorded_confirmed"];
  const quote = (value) => {
    const text = typeof value === "string" && /^[=+\-@\t\r]/.test(value) ? `'${value}` : String(value ?? "");
    return `"${text.replaceAll('"', '""')}"`;
  };
  return [columns.join(","), ...selected.map(line => columns.map(column => quote(["posting_date", "reversal_date", "reviewed_on", "posting_checked_on"].includes(column) && line[column] ? formatOutputDate(line[column]) : line[column])).join(","))].join("\n");
}
