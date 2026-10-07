import { asNumber, compact, isoDate, makeAccrualLines } from "../handler-kit.js";

function latestInvoiceByCustomer(invoices) {
  const result = new Map();
  for (const invoice of invoices) {
    const prior = result.get(invoice.customer_id);
    if (!prior || isoDate(invoice.period_end) > isoDate(prior.period_end)) result.set(invoice.customer_id, invoice);
  }
  return result;
}

export class UsageAccrualHandler {
  key = "AR_USAGE";
  side = "AR";
  label = "Usage accrual";
  help = "Accrues unbilled customer usage by customer and SKU after the latest invoice period end.";
  requiredSheets = ["customers", "sku_price_book", "usage_events", "chargebee_invoices"];

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
        side: this.side,
        counterparty: customer.name,
        source: sourceRef,
        description: `${group.quantity.toLocaleString()} ${price.unit} of ${group.sku}`,
        amountUsd: usd,
        transactionAmount,
        transactionCurrency: customer.currency,
        fx,
        status,
        anomaly: group.anomalies[0] || null,
        reviewTitle: "Usage spike",
        reviewSummary: group.anomalies.length ? `${group.anomalies[0].event_id} recorded ${group.anomalies[0].quantity} units vs ${group.anomalies[0].baseline} baseline. Actual usage remains in the accrual.` : "",
        sourceDetail: group,
        lines: makeAccrualLines({ id, side: this.side, closeDate: context.closeDate, reversalDate: context.reversalDate, debit: "1310", credit: "4010", amount: usd, currencyAmount: transactionAmount, currency: customer.currency, fx, memo: `Unbilled usage - ${customer.name}`, sourceRef, status, handler: this.key }),
      };
    });
  }
}
