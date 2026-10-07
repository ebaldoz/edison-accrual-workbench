import { reconcileReceipts } from "../ap-matching.js";
import { compact, makeAccrualLines } from "../handler-kit.js";

export class ReceiptAccrualHandler {
  key = "AP_GRNI";
  side = "AP";
  label = "GR not invoiced";
  help = "Accrues the uninvoiced value of each goods receipt through the close date.";
  requiredSheets = ["vendors", "purchase_orders", "po_lines", "goods_receipts", "vendor_invoices"];

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
          side: this.side,
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
          reviewTitle: "Invoice matching",
          reviewSummary: issues.join(" "),
          matching: { receiptValueUsd: receiptCents / 100, matchedInvoiceUsd: invoicedCents / 100, residualUsd: usd, provisional: issues.length > 0, invoices: matches },
          anomaly: null,
          sourceDetail: { receipt, matchedInvoices: matches, invoiceExceptions, matchingIssues: issues, cutoffBasis: "invoice_date <= closeDate; no GL posting check" },
          lines: makeAccrualLines({ id, side: this.side, closeDate: context.closeDate, reversalDate: context.reversalDate, debit: po.gl_account, credit: "2150", amount: usd, currencyAmount: usd, currency: "USD", fx: 1, memo: `Uninvoiced receipt - ${receipt.po_number}/${receipt.po_line_ref}`, sourceRef, status, handler: this.key }),
        };
      });
  }
}
