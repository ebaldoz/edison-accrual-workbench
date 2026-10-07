// Shared accounting primitives for independently registered accrual handlers.
export const asNumber = (value, field) => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`Invalid numeric value for ${field}`);
  return parsed;
};

export const isoDate = (value) => {
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value || "").slice(0, 10);
};

export const compact = (value) => String(value).replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-|-$/g, "");

// Keep ISO dates inside the engine; format only display/export values.
export function formatOutputDate(value, field = "date") {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value || "") || !Number.isFinite(Date.parse(`${value}T00:00:00Z`)) || new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) !== value) {
    throw new Error(`Missing or invalid ${field}`);
  }
  const [year, month, day] = value.split("-");
  return `${month}/${day}/${year}`;
}

export function makeAccrualLines({ id, side, handler, closeDate, reversalDate, debit, credit, amount, currencyAmount, currency, fx, memo, sourceRef, status }) {
  if (!["AR", "AP"].includes(side)) throw new Error(`Unsupported journal side: ${side}`);
  formatOutputDate(closeDate, "posting date");
  formatOutputDate(reversalDate, "reversal date");
  const common = {
    external_id: `HELIX-${closeDate.slice(0, 7)}-${side}`,
    accrual_id: id,
    close_date: closeDate,
    reversal_date: reversalDate,
    currency: "USD",
    transaction_currency: currency,
    transaction_amount: currencyAmount,
    fx_to_usd: fx,
    memo,
    source_ref: sourceRef,
    review_status: status,
    handler,
    side,
  };
  return [
    { ...common, line_id: `${id}-DR`, line_type: "accrual", posting_date: closeDate, account: debit, debit_usd: amount, credit_usd: 0 },
    { ...common, line_id: `${id}-CR`, line_type: "accrual", posting_date: closeDate, account: credit, debit_usd: 0, credit_usd: amount },
  ];
}
