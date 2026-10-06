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
  const common = {
    external_id: id,
    close_date: closeDate,
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
    { ...common, line_type: "accrual", posting_date: closeDate, account: debit, debit_usd: amount, credit_usd: 0 },
    { ...common, line_type: "accrual", posting_date: closeDate, account: credit, debit_usd: 0, credit_usd: amount },
    { ...common, line_type: "reversal", posting_date: reversalDate, account: credit, debit_usd: amount, credit_usd: 0 },
    { ...common, line_type: "reversal", posting_date: reversalDate, account: debit, debit_usd: 0, credit_usd: amount },
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
    const poById = new Map(sheets.purchase_orders.map((row) => [row.po_number, row]));
    const vendorById = new Map(sheets.vendors.map((row) => [row.vendor_id, row]));
    const invoicedPo = new Set(sheets.vendor_invoices.filter((row) => row.po_number).map((row) => row.po_number));
    return sheets.goods_receipts
      .filter((receipt) => isoDate(receipt.received_on) <= context.closeDate && !invoicedPo.has(receipt.po_number))
      .map((receipt) => {
        const po = poById.get(receipt.po_number);
        if (!po) throw new Error(`Missing PO ${receipt.po_number}`);
        const vendor = vendorById.get(po.vendor_id);
        const usd = +asNumber(receipt.value_usd, "receipt value").toFixed(2);
        const id = `HELIX-${compact(context.closeDate)}-AP-${compact(receipt.receipt_id)}`;
        const sourceRef = `${receipt.receipt_id}|${receipt.po_number}|${receipt.po_line_ref}`;
        return {
          id,
          handler: this.key,
          side: "AP",
          counterparty: vendor?.name || po.vendor_id,
          source: sourceRef,
          description: `${receipt.received_qty} received on ${receipt.po_number} (${receipt.notes || "uninvoiced receipt"})`,
          amountUsd: usd,
          transactionAmount: usd,
          transactionCurrency: po.currency || "USD",
          fx: 1,
          status: "READY",
          anomaly: null,
          sourceDetail: receipt,
          lines: makeLines({ id, closeDate: context.closeDate, reversalDate: context.reversalDate, debit: po.gl_account, credit: "2150", amount: usd, currencyAmount: usd, currency: po.currency || "USD", fx: 1, memo: `Uninvoiced receipt - ${receipt.po_number}`, sourceRef, status: "READY", handler: this.key }),
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

export function toJournalCsv(lines) {
  const columns = ["external_id", "line_type", "posting_date", "account", "debit_usd", "credit_usd", "currency", "transaction_currency", "transaction_amount", "fx_to_usd", "memo", "source_ref", "review_status", "handler"];
  const quote = (value) => `"${String(value ?? "").replaceAll('"', '""')}"`;
  return [columns.join(","), ...lines.map((line) => columns.map((column) => quote(line[column])).join(","))].join("\n");
}
