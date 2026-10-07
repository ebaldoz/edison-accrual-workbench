export const anchorData = {
  customers: [
    { customer_id: "CUS-1001", name: "Acme Robotics Inc.", currency: "USD", country: "US", status: "active", billing_anchor: "2024-11-03" },
    { customer_id: "CUS-1002", name: "Berlin Labs GmbH", currency: "EUR", country: "DE", status: "active", billing_anchor: "2025-01-12" },
    { customer_id: "CUS-1003", name: "Cobra Systems LLC", currency: "USD", country: "US", status: "churned", billing_anchor: "2025-06-08" }
  ],
  sku_price_book: [
    { sku: "GPU-H100-HR", unit: "hour", list_unit_price_usd: 4.5, category: "Compute" },
    { sku: "STORAGE-TB-DAY", unit: "TB-day", list_unit_price_usd: 0.1, category: "Storage" },
    { sku: "INFERENCE-1K-TOKENS", unit: "1k-tokens", list_unit_price_usd: 0.02, category: "Inference" }
  ],
  usage_events: [
    { event_id: "evt_h0001", customer_id: "CUS-1001", sku: "GPU-H100-HR", quantity: 10, occurred_on: "2026-03-28" },
    { event_id: "evt_h0002", customer_id: "CUS-1002", sku: "STORAGE-TB-DAY", quantity: 200, occurred_on: "2026-03-28" },
    { event_id: "evt_h0003", customer_id: "CUS-1003", sku: "INFERENCE-1K-TOKENS", quantity: 5000, occurred_on: "2026-03-28" },
    { event_id: "evt_u0001", customer_id: "CUS-1001", sku: "GPU-H100-HR", quantity: 10, occurred_on: "2026-03-29" },
    { event_id: "evt_u0002", customer_id: "CUS-1001", sku: "GPU-H100-HR", quantity: 25, occurred_on: "2026-03-30" },
    { event_id: "evt_u0003", customer_id: "CUS-1001", sku: "GPU-H100-HR", quantity: 10, occurred_on: "2026-03-31" },
    { event_id: "evt_u0004", customer_id: "CUS-1002", sku: "STORAGE-TB-DAY", quantity: 200, occurred_on: "2026-03-29" },
    { event_id: "evt_u0005", customer_id: "CUS-1002", sku: "STORAGE-TB-DAY", quantity: 200, occurred_on: "2026-03-30" },
    { event_id: "evt_u0006", customer_id: "CUS-1002", sku: "STORAGE-TB-DAY", quantity: 200, occurred_on: "2026-03-31" },
    { event_id: "evt_u0007", customer_id: "CUS-1003", sku: "INFERENCE-1K-TOKENS", quantity: 5000, occurred_on: "2026-03-29" }
  ],
  chargebee_invoices: [
    { invoice_id: "INV-2026-0291", customer_id: "CUS-1001", period_start: "2026-03-22", period_end: "2026-03-28", issued_at: "2026-03-29T00:00:00Z", subtotal_usd: 315, currency: "USD", fx_to_usd: 1 },
    { invoice_id: "INV-2026-0292", customer_id: "CUS-1002", period_start: "2026-03-22", period_end: "2026-03-28", issued_at: "2026-03-29T00:00:00Z", subtotal_usd: 140, currency: "EUR", fx_to_usd: 1.08 },
    { invoice_id: "INV-2026-0293", customer_id: "CUS-1003", period_start: "2026-03-22", period_end: "2026-03-28", issued_at: "2026-03-29T00:00:00Z", subtotal_usd: 700, currency: "USD", fx_to_usd: 1 }
  ],
  vendors: [{ vendor_id: "VEN-DELL-01", name: "DataMetric Hardware Co.", category: "hardware", currency: "USD", default_gl_account: "1480", default_department: "GPU Cloud Infra" }],
  gl_accounts: [
    { account_code: "1480", name: "Computer Equipment — GPU Servers", type: "Asset" },
    { account_code: "2150", name: "Accrued Expenses — AP", type: "Liability" },
    { account_code: "1310", name: "Accrued Revenue", type: "Asset" },
    { account_code: "4010", name: "Compute Services Revenue", type: "Revenue" }
  ],
  purchase_orders: [{ po_number: "PO-2026-0188", vendor_id: "VEN-DELL-01", po_type: "Goods", department: "GPU Cloud Infra", gl_account: "1480", currency: "USD", po_total_usd: 250000, po_status: "Open" }],
  po_lines: [{ po_number: "PO-2026-0188", po_line_ref: "L1", description: "GPU Server Rack — 8x H100 SXM5", qty: 5, uom: "each", unit_price_usd: 50000, line_total_usd: 250000 }],
  goods_receipts: [{ receipt_id: "GR-2026-0042", po_number: "PO-2026-0188", po_line_ref: "L1", received_qty: 2, received_on: "2026-03-25", value_usd: 100000, notes: "Partial receipt — 2 of 5 racks delivered" }],
  vendor_invoices: []
};
