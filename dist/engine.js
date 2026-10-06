import { reconcileReceipts } from "./ap-matching.js";

const REQUIRED_SHEETS = [
  "customers",
  "sku_price_book",
  "usage_events",
  "chargebee_invoices",
  "vendors",
  "purchase_orders",
  "po_lines",
  "goods_receipts",
  "vendor_invoices",
];

const asNumber = (value, field) => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`Invalid numeric value for ${field}`);
  return parsed;
};

const isoDate = (value) => {
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value || "").slice(0, 10);
};

const compact = (value) => String(value).replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-|-$/g, "");

// Keep ISO dates inside the engine; format only display/export values, without timezone conversion.
export function formatOutputDate(value, field = "date") {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value || "") || !Number.isFinite(Date.parse(`${value}T00:00:00Z`)) || new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) !== value) {
    throw new Error(`Missing or invalid ${field}`);
  }
  const [year, month, day] = value.split("-");
  return `${month}/${day}/${year}`;
}

export function validateDataset(sheets) {
  const missing = REQUIRED_SHEETS.filter((name) => !Array.isArray(sheets[name]));
  if (missing.length) throw new Error(`Missing required sheets: ${missing.join(", ")}`);
  return true;
}

function latestInvoiceByCustomer(invoices) {
  const result = new Map();
  for (const invoice of invoices) {
    const prior = result.get(invoice.customer_id);
    if (!prior || isoDate(invoice.period_end) > isoDate(prior.period_end)) {
      result.set(invoice.customer_id, invoice);
    }
  }
  return result;
}

function makeLines({ id, closeDate, reversalDate, debit, credit, amount, currencyAmount, currency, fx, memo, sourceRef, status, handler }) {
  formatOutputDate(closeDate, "posting date");
  formatOutputDate(reversalDate, "reversal date");
  const side = { AR_USAGE: "AR", AP_GRNI: "AP" }[handler];
  if (!side) throw new Error(`No journal side configured for ${handler}`);
  const common = {
    external_id: `HELIX-${closeDate.slice(0, 7)}-${side}`,
    accrual_id: id,
    close_date: closeDate,
    // Journal-header metadata, repeated identically on each flat-file line.
    reversal_date: reversalDate,
    currency: "USD",
    transaction_currency: currency,
    transaction_amount: currencyAmount,
    fx_to_usd: fx,
    memo,
    source_ref: sourceRef,
    review_status: status,
    handler,
  };
  return [
    { ...common, line_id: `${id}-DR`, line_type: "accrual", posting_date: closeDate, account: debit, debit_usd: amount, credit_usd: 0 },
    { ...common, line_id: `${id}-CR`, line_type: "accrual", posting_date: closeDate, account: credit, debit_usd: 0, credit_usd: amount },
  ];
}

export class UsageAccrualHandler {
  constructor() { this.key = "AR_USAGE"; }

  canHandle(kind) { return kind === this.key; }

  calculate(sheets, context) {
    const customerById = new Map(sheets.customers.map((row) => [row.customer_id, row]));
    const priceBySku = new Map(sheets.sku_price_book.map((row) => [row.sku, row]));
    const invoiceByCustomer = latestInvoiceByCustomer(sheets.chargebee_invoices);
    const close = context.closeDate;
    const baseline = new Map();

    for (const event of sheets.usage_events) {
      const invoice = invoiceByCustomer.get(event.customer_id);
      if (!invoice || isoDate(event.occurred_on) > isoDate(invoice.period_end)) continue;
      const key = `${event.customer_id}|${event.sku}`;
      const item = baseline.get(key) || { total: 0, count: 0 };
      item.total += asNumber(event.quantity, "usage quantity");
      item.count += 1;
      baseline.set(key, item);
    }

    const groups = new Map();
    for (const event of sheets.usage_events) {
      const invoice = invoiceByCustomer.get(event.customer_id);
      if (!invoice) throw new Error(`No billing history for ${event.customer_id}`);
      const occurred = isoDate(event.occurred_on);
      if (occurred <= isoDate(invoice.period_end) || occurred > close) continue;
      const key = `${event.customer_id}|${event.sku}`;
      const group = groups.get(key) || { customer_id: event.customer_id, sku: event.sku, quantity: 0, events: [], anomalies: [] };
      const quantity = asNumber(event.quantity, "usage quantity");
      group.quantity += quantity;
      group.events.push(event.event_id);
      const history = baseline.get(key);
      const average = history?.count ? history.total / history.count : null;
      if (average !== null && quantity >= average * 2) {
        group.anomalies.push({ event_id: event.event_id, occurred_on: occurred, quantity, baseline: average, reason: `${quantity} vs ${average} baseline` });
      }
      groups.set(key, group);
    }

    return [...groups.values()].map((group) => {
      const customer = customerById.get(group.customer_id);
      const price = priceBySku.get(group.sku);
      if (!customer || !price) throw new Error(`Missing master data for ${group.customer_id}/${group.sku}`);
      const invoice = invoiceByCustomer.get(group.customer_id);
      const fx = asNumber(invoice.fx_to_usd || 1, "FX rate");
      const usd = +(group.quantity * asNumber(price.list_unit_price_usd, "unit price")).toFixed(2);
      const transactionAmount = +(usd / fx).toFixed(2);
      const status = group.anomalies.length ? "REVIEW" : "READY";
      const id = `HELIX-${compact(context.closeDate)}-AR-${compact(group.customer_id)}-${compact(group.sku)}`;
      const sourceRef = group.events.join("|");
      return {
        id,
        handler: this.key,
        side: "AR",
        counterparty: customer.name,
        source: sourceRef,
        description: `${group.quantity.toLocaleString()} ${price.unit} of ${group.sku}`,
        amountUsd: usd,
        transactionAmount,
        transactionCurrency: customer.currency,
        fx,
        status,
        anomaly: group.anomalies[0] || null,
        sourceDetail: group,
        lines: makeLines({ id, closeDate: context.closeDate, reversalDate: context.reversalDate, debit: "1310", credit: "4010", amount: usd, currencyAmount: transactionAmount, currency: customer.currency, fx, memo: `Unbilled usage - ${customer.name}`, sourceRef, status, handler: this.key }),
      };
    });
  }
}

export class ReceiptAccrualHandler {
  constructor() { this.key = "AP_GRNI"; }

  canHandle(kind) { return kind === this.key; }

  calculate(sheets, context) {
    const vendorById = new Map(sheets.vendors.map((row) => [row.vendor_id, row]));
    return reconcileReceipts(sheets, context.closeDate)
      .filter(record => record.residualCents > 0 || record.issues.length)
      .map(({ receipt, po, receiptCents, invoicedCents, residualCents, matches, issues, invoiceExceptions }) => {
        const vendor = vendorById.get(po.vendor_id);
        const usd = residualCents / 100;
        const multipleLines = sheets.goods_receipts.filter(row => row.receipt_id === receipt.receipt_id).length > 1;
        const id = `HELIX-${compact(context.closeDate)}-AP-${compact(receipt.receipt_id)}${multipleLines ? `-${compact(receipt.po_number)}-${compact(receipt.po_line_ref)}` : ""}`;
        const sourceRef = [receipt.receipt_id, receipt.po_number, receipt.po_line_ref, ...matches.map(row => `INV:${row.invoice_number}${row.invoice_line_ref ? `:${row.invoice_line_ref}` : ""}`)].join("|");
        const status = issues.length ? "REVIEW" : "READY";
        return {
          id,
          handler: this.key,
          side: "AP",
          counterparty: vendor?.name || po.vendor_id,
          source: sourceRef,
          description: `${receipt.receipt_id} · ${receipt.po_number}/${receipt.po_line_ref} · ${matches.length ? "partially invoiced" : "uninvoiced receipt"}${issues.length ? " · provisional amount" : ""}`,
          amountUsd: usd,
          transactionAmount: usd,
          transactionCurrency: "USD",
          fx: 1,
          status,
          reviewBlocked: issues.length > 0,
          reviewReasons: issues,
          matching: { receiptValueUsd: receiptCents / 100, matchedInvoiceUsd: invoicedCents / 100, residualUsd: usd, provisional: issues.length > 0, invoices: matches },
          anomaly: null,
          sourceDetail: { receipt, matchedInvoices: matches, invoiceExceptions, matchingIssues: issues, cutoffBasis: "invoice_date <= closeDate; no GL posting check" },
          lines: makeLines({ id, closeDate: context.closeDate, reversalDate: context.reversalDate, debit: po.gl_account, credit: "2150", amount: usd, currencyAmount: usd, currency: "USD", fx: 1, memo: `Uninvoiced receipt - ${receipt.po_number}/${receipt.po_line_ref}`, sourceRef, status, handler: this.key }),
        };
      });
  }
}

export class AccrualEngine {
  constructor(handlers = [new UsageAccrualHandler(), new ReceiptAccrualHandler()]) {
    this.handlers = handlers;
  }

  run(sheets, context = {}) {
    validateDataset(sheets);
    const closeDate = context.closeDate || "2026-03-31";
    const reversalDate = context.reversalDate || "2026-04-01";
    const selected = context.handlers || ["AR_USAGE", "AP_GRNI"];
    const normalizedContext = { closeDate, reversalDate };
    const accruals = selected.flatMap((kind) => {
      const handler = this.handlers.find((candidate) => candidate.canHandle(kind));
      if (!handler) throw new Error(`No handler registered for ${kind}`);
      return handler.calculate(sheets, normalizedContext);
    });
    const journalLines = accruals.flatMap((item) => item.lines);
    const totals = {
      ar: +accruals.filter((item) => item.side === "AR").reduce((sum, item) => sum + item.amountUsd, 0).toFixed(2),
      ap: +accruals.filter((item) => item.side === "AP").reduce((sum, item) => sum + item.amountUsd, 0).toFixed(2),
      review: accruals.filter((item) => item.status === "REVIEW").length,
      ready: accruals.filter((item) => item.status === "READY").length,
    };
    return {
      runId: `HELIX-CLOSE-${compact(closeDate)}`,
      closeDate,
      reversalDate,
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

export function getExportAvailability(lines, side) {
  const handler = { AR: "AR_USAGE", AP: "AP_GRNI" }[side];
  if (!handler || !["AR", "AP"].includes(side)) throw new Error("Choose AR or AP for the journal export.");
  const selected = lines.filter(line => line.handler === handler && line.line_type === "accrual");
  if (!selected.length) return { allowed: false, reason: `No ${side} accruals to download.` };
  const pending = new Set(selected.filter(line => line.review_status !== "READY").map(line => line.accrual_id));
  if (pending.size) return { allowed: false, reason: `${side} download locked: ${pending.size} accrual(s) are not Ready.` };
  return { allowed: true, reason: `${side}: all accruals are Ready. Download includes the full side, regardless of filters.` };
}

export function toJournalCsv(lines, side) {
  const availability = getExportAvailability(lines, side);
  if (!availability.allowed) throw new Error(availability.reason);
  const handler = { AR: "AR_USAGE", AP: "AP_GRNI" }[side];
  // Never emit separate reversing entries, including from legacy line collections.
  const selected = lines.filter(line => line.handler === handler && line.line_type === "accrual");
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
  const columns = ["external_id", "line_id", "accrual_id", "line_type", "posting_date", "reversal_date", "account", "debit_usd", "credit_usd", "currency", "transaction_currency", "transaction_amount", "fx_to_usd", "memo", "source_ref", "review_status", "handler", "reviewed_by", "review_note", "reviewed_on", "reviewed_time_utc"];
  const quote = (value) => {
    // User-entered notes/names must remain literal text in spreadsheet software.
    const text = typeof value === "string" && /^[=+\-@\t\r]/.test(value) ? `'${value}` : String(value ?? "");
    return `"${text.replaceAll('"', '""')}"`;
  };
  return [columns.join(","), ...selected.map((line) => columns.map((column) => quote(["posting_date", "reversal_date", "reviewed_on"].includes(column) && line[column] ? formatOutputDate(line[column]) : line[column])).join(","))].join("\n");
}
