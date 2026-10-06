const text = value => String(value ?? "").trim();
const date = value => {
  const result = value instanceof Date && Number.isFinite(value.getTime()) ? value.toISOString().slice(0, 10) : text(value);
  return /^\d{4}-\d{2}-\d{2}$/.test(result) && Number.isFinite(Date.parse(result)) && new Date(result).toISOString().slice(0, 10) === result ? result : null;
};
const cents = value => text(value) !== "" && Number.isFinite(Number(value)) && Number(value) >= 0 && Number.isSafeInteger(Math.round(Number(value) * 100)) ? Math.round(Number(value) * 100) : null;

// One invoice row is either a whole invoice or an explicitly identified allocation.
// Never allocate a PO/header amount across several receipts by guessing a split.
export function reconcileReceipts(sheets, closeDate) {
  if (!date(closeDate)) throw new Error("Invalid AP close date.");
  const unique = (rows, key, label) => {
    const keys = new Set();
    for (const row of rows) {
      const id = key(row);
      if (!id || keys.has(id)) throw new Error(`Missing or duplicate ${label}: ${id}`);
      keys.add(id);
    }
  };
  unique(sheets.purchase_orders, row => text(row.po_number), "PO number");
  unique(sheets.po_lines, row => text(row.po_number) && text(row.po_line_ref) && JSON.stringify([text(row.po_number), text(row.po_line_ref)]), "PO line");
  unique(sheets.goods_receipts, row => text(row.receipt_id) && text(row.po_number) && text(row.po_line_ref) && JSON.stringify([text(row.receipt_id), text(row.po_number), text(row.po_line_ref)]), "receipt line");
  const records = sheets.goods_receipts.map(receipt => {
    const receivedOn = date(receipt.received_on);
    if (!receivedOn) throw new Error(`Missing or invalid received_on for ${receipt.receipt_id}. Use an Excel date or YYYY-MM-DD.`);
    const po = sheets.purchase_orders.find(row => text(row.po_number) === text(receipt.po_number));
    if (!po) throw new Error(`Missing PO ${receipt.po_number}`);
    if (!sheets.po_lines.some(row => text(row.po_number) === text(receipt.po_number) && text(row.po_line_ref) === text(receipt.po_line_ref))) throw new Error(`Missing PO line for ${receipt.receipt_id}`);
    const receiptCents = cents(receipt.value_usd);
    if (receiptCents === null) throw new Error(`Invalid receipt value for ${receipt.receipt_id}`);
    return { receipt, po, receivedOn, receiptCents, invoicedCents: 0, matches: [], issues: [], invoiceExceptions: [] };
  });
  const invoiceGroups = new Map();
  for (const invoice of sheets.vendor_invoices) {
    const key = JSON.stringify([text(invoice.vendor_id), text(invoice.invoice_number)]);
    const group = invoiceGroups.get(key) || [];
    group.push(invoice);
    invoiceGroups.set(key, group);
  }
  for (const invoice of sheets.vendor_invoices) {
    const status = text(invoice.status).toLowerCase();
    if (["void", "voided", "cancelled", "canceled", "rejected"].includes(status)) continue;
    const invoiceDate = date(invoice.invoice_date);
    if (invoiceDate && invoiceDate > closeDate) continue;
    const poNumber = text(invoice.po_number), receiptId = text(invoice.receipt_id), line = text(invoice.po_line_ref);
    const related = records.filter(record => (poNumber && text(record.receipt.po_number) === poNumber) || (receiptId && text(record.receipt.receipt_id) === receiptId));
    const fallback = related.length ? related : records.filter(record => !text(invoice.vendor_id) || text(record.po.vendor_id) === text(invoice.vendor_id));
    const flag = (targets, reason) => {
      for (const record of targets.filter(item => item.receivedOn <= closeDate)) {
        record.issues.push(`${text(invoice.invoice_number) || "Invoice without ID"}: ${reason}`);
        record.invoiceExceptions.push({ reason, source: invoice });
      }
    };
    const candidates = records.filter(record =>
      (!poNumber || text(record.receipt.po_number) === poNumber) &&
      (!receiptId || text(record.receipt.receipt_id) === receiptId) &&
      (!line || text(record.receipt.po_line_ref) === line));
    // A PO with no supplied receipts has nothing to accrue in this dataset.
    if (poNumber && !receiptId && !related.length) continue;
    if (!poNumber && !receiptId) { flag(fallback, "missing PO/receipt reference; add an explicit match."); continue; }
    if (!invoiceDate) { flag(fallback, "missing or invalid invoice_date; use an Excel date or YYYY-MM-DD."); continue; }
    if (!text(invoice.invoice_number) || !text(invoice.vendor_id)) { flag(fallback, "invoice_number and vendor_id are required."); continue; }
    if (!["approved", "posted", "paid", "open"].includes(status)) { flag(fallback, "invoice status is not approved, posted, paid, or open; verify its close treatment."); continue; }
    const group = invoiceGroups.get(JSON.stringify([text(invoice.vendor_id), text(invoice.invoice_number)]));
    const explicitAllocation = text(invoice.allocated_amount_usd) !== "";
    if (group.length > 1 && (group.some(row => !text(row.invoice_line_ref) || text(row.allocated_amount_usd) === "") || new Set(group.map(row => text(row.invoice_line_ref))).size !== group.length)) {
      flag(fallback, "repeated invoice needs a unique invoice_line_ref and allocated_amount_usd on every allocation row (do not repeat the header subtotal)."); continue;
    }
    if (explicitAllocation && !text(invoice.invoice_line_ref)) { flag(fallback, "allocated_amount_usd requires a unique invoice_line_ref."); continue; }
    if (explicitAllocation) {
      const header = cents(invoice.subtotal_usd);
      const allocated = group.map(row => cents(row.allocated_amount_usd));
      if (header === null || allocated.some(value => value === null) || allocated.reduce((sum, value) => sum + value, 0) !== header || group.some(row => cents(row.subtotal_usd) !== header || date(row.invoice_date) !== invoiceDate || text(row.status).toLowerCase() !== status)) {
        flag(fallback, "invoice allocations must sum to the invoice subtotal_usd, with consistent subtotal, date, and status on every row."); continue;
      }
    }
    const amount = cents(explicitAllocation ? invoice.allocated_amount_usd : invoice.subtotal_usd);
    if (amount === null) { flag(fallback, "missing, negative, or invalid USD invoice amount; credits require separate reconciliation."); continue; }
    const poLineCount = sheets.po_lines.filter(row => text(row.po_number) === poNumber).length;
    if (candidates.length !== 1 || (!receiptId && !line && poLineCount !== 1)) {
      flag(fallback, "ambiguous or unmatched receipt allocation; add receipt_id and, where needed, po_line_ref with the allocated USD amount."); continue;
    }
    const target = candidates[0];
    if (text(target.po.vendor_id) !== text(invoice.vendor_id)) { flag(fallback, "vendor does not match the receipt's PO."); continue; }
    // Include future receipts in candidate selection so cutoff cannot make a broad match falsely unique.
    if (target.receivedOn > closeDate) continue;
    target.invoicedCents += amount;
    target.matches.push({ invoice_number: invoice.invoice_number, invoice_line_ref: invoice.invoice_line_ref || null, invoice_date: invoiceDate, amount_usd: amount / 100, match_basis: receiptId ? "receipt" : line ? "unique PO line" : "unique single-line PO", source: invoice });
  }
  return records.filter(record => record.receivedOn <= closeDate).map(record => {
    if (record.invoicedCents > record.receiptCents) record.issues.push("Matched invoice value exceeds receipt value; reconcile the allocation or credit before export.");
    record.matches.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
    record.invoiceExceptions.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
    record.issues = [...new Set(record.issues)].sort();
    return { ...record, residualCents: Math.max(0, record.receiptCents - record.invoicedCents) };
  });
}
