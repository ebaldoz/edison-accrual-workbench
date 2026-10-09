import { isoDate } from "./handler-kit.js";

export const PAGE_SIZE = 25;

export function paginateAccruals(items, requestedPage = 1) {
  const pages = Math.max(1, Math.ceil(items.length / PAGE_SIZE));
  const page = Math.max(1, Math.min(pages, Math.trunc(requestedPage) || 1));
  const offset = (page - 1) * PAGE_SIZE;
  return { items: items.slice(offset, offset + PAGE_SIZE), page, pages,
    start: items.length ? offset + 1 : 0, end: Math.min(offset + PAGE_SIZE, items.length), total: items.length };
}

// Keep drill-through separate from calculations. Custom plugins can supply the
// same [{ sheet, label, rows }] sourceRecords contract without changing this UI.
export function sourceRecordsFor(item, sheets) {
  if (Array.isArray(item.sourceRecords)) return item.sourceRecords;
  const group = (sheet, label, rows) => ({ sheet, label, rows: rows.filter(Boolean) });
  if (item.handler === "AR_USAGE") {
    const { customer_id, sku, events } = item.sourceDetail;
    const ids = new Set(events);
    const invoices = sheets.chargebee_invoices.filter(row => row.customer_id === customer_id);
    const latest = [...invoices].sort((a, b) => isoDate(b.period_end).localeCompare(isoDate(a.period_end)))[0];
    return [
      group("usage_events", "Accrued usage events", sheets.usage_events.filter(row => ids.has(row.event_id))),
      group("usage_events", "Historical events used for anomaly baseline", sheets.usage_events.filter(row => row.customer_id === customer_id && row.sku === sku && latest && isoDate(row.occurred_on) <= isoDate(latest.period_end))),
      group("chargebee_invoices", "Billing cutoff and FX reference", [latest]),
      group("sku_price_book", "Unit price", sheets.sku_price_book.filter(row => row.sku === sku)),
      group("customers", "Customer", sheets.customers.filter(row => row.customer_id === customer_id)),
    ];
  }
  if (item.handler === "AP_GRNI") {
    const { receipt, matchedInvoices, invoiceExceptions } = item.sourceDetail;
    const po = sheets.purchase_orders.find(row => row.po_number === receipt.po_number);
    return [
      group("goods_receipts", "Accrued receipt", [receipt]),
      group("vendor_invoices", "Matched invoice / allocation records", matchedInvoices.map(row => row.source)),
      group("vendor_invoices", "Invoice records requiring correction", invoiceExceptions.map(row => row.source)),
      group("purchase_orders", "Purchase order", [po]),
      group("po_lines", "Purchase order line", sheets.po_lines.filter(row => row.po_number === receipt.po_number && String(row.po_line_ref) === String(receipt.po_line_ref))),
      group("vendors", "Vendor", sheets.vendors.filter(row => row.vendor_id === po?.vendor_id)),
    ];
  }
  return [];
}
