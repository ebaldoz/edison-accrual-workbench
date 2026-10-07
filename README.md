# Helix Accrual Workbench

A controller-facing proof of concept for a single accrual engine that handles unbilled usage revenue and goods-received-not-invoiced (GRNI) accruals.

## What it does

- Opens with no workbook or calculated results. Import the supplied XLSX workbook each time the page loads; successful import runs the close automatically.
- Calculates usage-based AR for the unbilled period after the latest Chargebee invoice.
- Converts the EUR customer's USD-valued usage to a transaction-currency view while booking the journal in USD.
- Accrues each receipt's uninvoiced USD balance, subtracting valid matched invoices dated through close rather than excluding its entire PO.
- Flags the seeded usage spike for human review without replacing actual usage.
- Downloads separate AR and AP CSVs with balanced original accrual lines only. Each journal's header-level `reversal_date` repeats on all its rows; no reversing-entry rows are generated.
- Uses one deterministic external ID per year-month and side (e.g. `HELIX-2026-03-AR` and `HELIX-2026-03-AP`). Re-runs reuse these journal IDs, not new journals.
- Preserves the original source-group identifier as `accrual_id`, adds unique `line_id` values ending in `-DR` or `-CR`, and retains `source_ref` on every row for audit.
- Provides source drill-through from each accrual to event or receipt identifiers.
- Allows current-run review of usage flags: verify the source/amount, enter a reviewer name and note, check the confirmation, and choose Mark Ready. Both journal lines become Ready; the original anomaly and amount are preserved. Reviewed items can be reopened with a reason. AP matching exceptions require corrected source data and reimport; they cannot be waived with a review note.
- Disables each side's download until every accrual line on that side is Ready. Empty sides are disabled too. This rule is also checked by the CSV formatter, not just the button.
- Filters the accrual table by Side, Counterparty, Status, and Handler in combination. Filters do not change metrics, the review queue, download readiness, or the rows included in downloads.
- Opens the control-design explanation in a modal from the information button beside the import-status heading or from Controls in the sidebar.

After importing the supplied anchor workbook, the expected results are **AR $362.50** and **AP $100,000.00**. The sample records remain in `dist/anchor-data.js` as automated-test fixtures; the website does not load them at startup.

## Run locally

No build step is required.

```bash
npm test
npm run serve
```

Open `http://localhost:4173` and import the supplied workbook. A valid import calculates the accruals immediately; to recalculate corrected source data, import the corrected workbook. A refresh clears the in-browser workbook and results; import again to continue. The workbook is not saved to a database or browser storage.

## Import workbook requirements

- Import **one Excel workbook** (`.xlsx` or `.xls`), not separate CSV files. The filename does not matter; `Helix_Anchor_Dataset_CANDIDATE.xlsx` is an example, not the only accepted file.
- With the two handlers enabled by default, the workbook must contain the **nine worksheet names below exactly** (including case and underscores). Sheet order does not matter, and extra sheets are allowed. The sample's `gl_accounts` sheet is extra; the current calculations do not require or read it. A newly registered handler may declare additional required sheets; only sheets required by enabled handlers are validated.
- Keep the column headers used by the calculations exactly as shown. The table lists the key fields the app reads, not a complete validation schema; a missing or invalid value can make import fail or produce a Review exception. Other columns from the sample workbook may remain.

| Worksheet | Key columns used by the current calculations |
| --- | --- |
| `customers` | `customer_id`, `name`, `currency` |
| `sku_price_book` | `sku`, `unit`, `list_unit_price_usd` |
| `usage_events` | `event_id`, `customer_id`, `sku`, `quantity`, `occurred_on` |
| `chargebee_invoices` | `customer_id`, `period_end`, `fx_to_usd` |
| `vendors` | `vendor_id`, `name` |
| `purchase_orders` | `po_number`, `vendor_id`, `gl_account` |
| `po_lines` | `po_number`, `po_line_ref` |
| `goods_receipts` | `receipt_id`, `po_number`, `po_line_ref`, `received_on`, `value_usd` |
| `vendor_invoices` | If populated: `invoice_number`, `vendor_id`, `invoice_date`, `status`, `subtotal_usd`, and a `po_number` or `receipt_id` reference. The receipt/PO-line allocation fields are described under [AP calculation and workbook fields](#ap-calculation-and-workbook-fields). |

`vendor_invoices` must exist even when there are no vendor bills yet; it may have **zero data rows**. For AP dates, use real Excel dates or `YYYY-MM-DD` text. The browser app currently fixes the close date to **03/31/2026** and reversal date to **04/01/2026**; neither the filename nor a date inside the workbook changes those settings. A missing required sheet produces a “Missing required sheets” error. The import reads the file in the browser and does not save the workbook or approvals between refreshes.

## Architecture

The browser app separates the close workflow into four layers:

1. **Workbook adapter** converts named XLSX sheets into arrays of records.
2. **Handler registry** validates plugin metadata, rejects duplicate keys, and selects all registered handlers by default (or a requested subset).
3. **Accrual engine** validates only the selected handlers' worksheets and checks each plugin's returned accrual and balanced lines against a common contract.
4. **Handlers** own source-specific accounting logic in separate modules. `UsageAccrualHandler` and `ReceiptAccrualHandler` implement the required scenarios.
5. **Outputs and controls** render the review queue, source evidence, balanced original journal lines, reversal-date metadata, and separate AR/AP CSV downloads. The exporter selects every line by AR/AP side, so multiple handlers on the same side share the monthly journal.

The implementation is static by design: this is a reviewable proof of concept, not a production posting service. Deterministic IDs demonstrate idempotent intent. A production implementation would enforce uniqueness in a database and in NetSuite's external-ID field.

## Where to add or edit a handler

- **Edit AR usage calculations:** `UsageAccrualHandler` in [`dist/handlers/usage.js`](dist/handlers/usage.js) selects unbilled events, groups by customer and SKU, calculates the amount, and flags usage anomalies.
- **Edit AP receipt accruals:** `ReceiptAccrualHandler` in [`dist/handlers/receipt.js`](dist/handlers/receipt.js) turns uninvoiced receipt balances into accruals. Its invoice-to-receipt matching, cutoff, and residual-value rules live in [`dist/ap-matching.js`](dist/ap-matching.js), in `reconcileReceipts()`.

To add a third accrual type (for example, an AP subscription accrual):

1. Create `dist/handlers/your-handler.js`. Export a class or object with a unique `key`, an `AR` or `AP` `side`, a human-readable `label`, a `requiredSheets` array, and `calculate(sheets, context)`. Optional `help` text appears in the Handler information modal. The registry checks this metadata and rejects duplicate keys.
2. Return an array of accrual objects with stable `id`, matching `handler` and `side`, `counterparty`, `source`, `description`, nonnegative `amountUsd`, `READY` or `REVIEW` status, `sourceDetail`, and balanced `lines`. Use [`makeAccrualLines()`](dist/handler-kit.js) to produce the debit/credit pair with source references, deterministic monthly side-level external ID, and close/reversal dates. If Review is possible, provide `reviewTitle` and `reviewSummary`; set `reviewBlocked` when source correction (rather than manual approval) is required.
3. Add one import and one instance in [`dist/handlers/index.js`](dist/handlers/index.js). `new AccrualEngine()` then runs the new handler automatically. The app reads all workbook tabs, validates each enabled handler's `requiredSheets`, shows the handler's label/filter/help, and includes its lines in the AR or AP CSV without new exporter mappings. To run only selected handlers in code, pass `{ handlers: ["YOUR_KEY"] }` to `run()`; only that subset's sheets are required.
4. Add a contract and calculation test. [`tests/plugins.test.mjs`](tests/plugins.test.mjs) demonstrates a third AP subscription-style test handler, including its extra worksheet, shared AP external ID and CSV, validation failures, and download lock when it returns Review. It is a test fixture, **not** a production subscription calculation or a default handler. Run `npm test`.

The plugin boundary is intentionally limited to the existing AR/AP journal sides. A genuinely new journal side, posting policy, or richer custom detail view would still require a deliberate UI/export design change; do not silently map it to AR or AP. Registering a handler that requires a new sheet also requires supplying that sheet in the imported workbook.

## Accounting assumptions

- Close date is 2026-03-31 and reversal date is 2026-04-01.
- Group CSV rows by `external_id` into journals. Map `posting_date`, `reversal_date`, and `currency` to journal-header fields, not journal-line fields. The export checks that these values are consistent within each journal. Map account/debit/credit to line fields. The destination system must process the reversal; the app does not post or schedule one.
- CSV date columns use `MM/DD/YYYY` (e.g. `03/31/2026`, `04/01/2026`); engine dates and source payloads remain ISO. IDs and filenames keep their machine-readable year-month/date tokens.
- Map `line_id`, `accrual_id`, and `source_ref` to line-level audit fields, and `memo` to the line memo. Transaction-currency amounts/rates are source-level reference fields; the journal currency is USD, including Berlin's lines. March AR is one six-line journal; March AP is one two-line journal. No customer/source-level lines are consolidated or discarded.
- Reimporting a monthly external ID requires a deliberate update/reject policy in the destination; the demo does not enforce posting idempotency or retain immutable source snapshots. Archive the source workbook and exported CSV together for audit. Multiple entities/books would need an additional journal-key dimension before production use.
- Usage after each customer's latest invoice period end through close is accrued.
- The price book is USD-denominated. USD is the NetSuite posting currency. For the EUR customer, the UI derives a transaction-currency amount at 1.08 USD/EUR and retains the rate on every line.
- The actual 25-hour spike remains in revenue; it is routed to review rather than smoothed.
- AP calculates receipt-level uninvoiced value using the invoice-date cutoff and matching rules below. This is a proposed accrual, not the additional adjustment after reconciling existing GL postings.
- The partial receipt is capitalized to account 1480 with an offset to accrued expenses 2150.

## AI / ML rationale

For this dataset, a transparent rule is safer than an opaque model. The detector compares an event with its customer/SKU historical baseline and flags values at or above 2x. This catches the seeded spike and gives the reviewer the exact event, baseline, and ratio. With production history, I would evaluate robust z-scores or an isolation model by customer/SKU cohort, version the feature set, and monitor false positives. The accounting amount would remain deterministic and would never be generated by an LLM.

## Test coverage

The tests verify anchor totals, EUR translation, anomaly routing, receipt/line matching, partial and multiple invoices, invoice/receipt cutoff boundaries, ambiguous matches, duplicate allocations, invoice-header reconciliation, invalid fields, over-invoicing, source correction, download gates, deterministic IDs, balanced entries, source references, AR/AP separation, and consistent header reversal dates with no reversal rows.

## Deployment recommendation

This static proof of concept fits static hosting, including the existing private OpenAI Sites deployment. Keep the source repository and deployment private because the exercise is confidential. Use an authenticated email allowlist for any reviewer sharing; an unguessable URL is not access control.

## What I would change for production

- Persist raw source snapshots, normalized records, close runs, decisions, and journal lines in Postgres.
- Use an orchestrator and queues for Chargebee, telemetry, Coupa, FX, and NetSuite integrations.
- Enforce database uniqueness on `(entity, period, handler, source_ref)` and NetSuite external IDs.
- Add legal entity, subsidiary, department, class, location, tax, book, and accounting-period dimensions.
- Extend the implemented receipt/line invoice matching with quantity/value tolerances, returns/credits, posting-period controls, and GL reconciliation.
- Add approvals, role-based access, immutable audit events, observability, retries, and reconciliation back from NetSuite.
- Version handler logic and anomaly policies so every close is reproducible.

## AP calculation and workbook fields

1. Include each goods-receipt line with `received_on <= closeDate` (March 31, 2026 in the demo). Validate receipt identifiers, dates, USD values, and PO/PO-line references. Missing or duplicate receipt/master keys fail the calculation instead of silently exporting bad data.
2. Consider vendor invoices with `invoice_date <= closeDate`. Eligible statuses are `approved`, `posted`, `paid`, and `open` (case-insensitive). Ignore `void`, `voided`, `cancelled`, `canceled`, and `rejected`. Missing/other statuses require Review. This is a prototype invoice-date policy, not a NetSuite posting-date/period policy.
3. Match a supplied `receipt_id`, constrained by any supplied PO/line references. Otherwise use `po_number` plus `po_line_ref` only if they identify one receipt. A PO-only invoice can match only when there is one receipt and one PO line. Uniqueness considers all supplied receipts, including future receipts, to avoid treating a broad reference as unique merely because of the cutoff. No FIFO or proportional split is guessed.
4. Subtract matched invoice USD amounts from that receipt's stored `value_usd`, using integer cents. Multiple invoices can reduce the same receipt. A clean zero balance generates no accrual. A positive balance creates one debit/credit pair, with the existing monthly AP external ID and reversal-date header.
5. Uncertain matches retain a provisional balance and Review. Over-invoicing retains a zero-dollar Review exception, rather than disappearing or creating a negative accrual. Correct the workbook and reimport to resolve matching issues. AP download stays locked until every AP item is Ready; Mark Ready cannot bypass these exceptions.

The supplied workbook has invoice-level columns only and no vendor invoices. It needs no changes to reproduce the $100,000 anchor result. For additional scenarios, add the optional matching/allocation columns to `vendor_invoices`:

| Field | Meaning |
| --- | --- |
| `invoice_number`, `vendor_id` | Required invoice identity. Vendor must match the receipt's PO. |
| `po_number` | Existing PO reference; a PO alone is insufficient when multiple receipts or PO lines exist. |
| `invoice_date`, `status` | Required cutoff date and transaction status. Dates must be real Excel dates or `YYYY-MM-DD`; exported journal dates remain `MM/DD/YYYY`. |
| `subtotal_usd` | Whole invoice's USD subtotal. With one whole-invoice row, this is the matched amount. It must cover the same cost basis as the receipt; tax/FX/price variances are not automatically reconciled. |
| `receipt_id` | Optional explicit goods-receipt reference; recommended for reliable matching. |
| `po_line_ref` | Optional PO-line reference. Required with `receipt_id` when that receipt contains multiple lines. |
| `invoice_line_ref` | Unique allocation-row ID within a vendor/invoice, required for explicit allocations or repeated invoice numbers. |
| `allocated_amount_usd` | The portion allocated to that receipt line. Never repeat the whole invoice amount as each line's allocation. |

For an invoice split across receipts, use one row per allocation with a unique `invoice_line_ref` and the relevant receipt/PO-line reference. Repeat the same header subtotal, invoice date, and status on each row. Allocation amounts must sum exactly to that subtotal at cent precision. Do not include an additional header-only row. Duplicate rows, inconsistent headers, missing amounts/dates/IDs, vendor mismatches, and unresolved receipt references trigger Review. Negative invoice amounts/credits need separate reconciliation and are not netted automatically.

Examples:

- $100,000 received, $40,000 invoiced by close with an unambiguous match → $60,000 AP accrual.
- The same $40,000 invoice dated April 1 → March AP remains $100,000.
- Two receipts on one PO; invoice explicitly covers only the first → only that receipt is reduced, leaving the other eligible for accrual.
- Two receipts with a PO-only invoice → Review, not whole-PO exclusion.

View details shows receipt value, matched invoiced value, residual, matching reasons, and source payloads. `source_ref` retains receipt/PO/line references and adds matched invoice/allocation IDs. AP calculations and transaction reference amounts are USD; the app does not invent a non-USD FX rate. It still trusts the supplied USD values.

## AP production-readiness roadmap

**Receipt/line matching, partial invoice allocation, and invoice-date cutoffs are implemented.** The remaining controls below are not implemented. Before posting an additional AP accrual, determine what was received, what was invoiced by close, and what is already recorded in the general ledger (GL).

### 1. Extend matching and close-date controls

- **Today:** apply the receipt-level rules above, preserve partial residuals, and block unresolved allocations. No whole-PO suppression.
- **Production:** apply a controller-approved as-of-close policy using receipt dates, invoice dates, posting dates/periods, and valid transaction status. Reconcile returns, credits, cancellations, historical receipts, and full source coverage from the integrated systems.
- **Example:** $100,000 received and $40,000 invoiced leaves $60,000 of uninvoiced receipt value to assess. An invoice dated after March 31 does not eliminate the March accrual under the implemented policy. Whether an additional journal is needed still depends on existing GL postings.

### 2. Validate the receipt value

- **Today:** the handler trusts the receipt's stored USD value; it does not independently check received quantity against the PO unit price.
- **Production:** reconcile received quantity × approved unit price to the stored receipt value, using consistent units of measure, governed FX, and documented treatment of discounts, freight, and taxes. Route missing data or differences beyond approved tolerances to Review.
- **Example:** 2 racks × $50,000 = $100,000. A stored receipt value of $120,000 should produce a $20,000 exception in production; that check is not yet implemented.

### 3. Check existing GL postings to prevent double counting

- **Today:** the handler does not check whether NetSuite already recorded the receipt's asset/expense and accrued liability.
- **Production:** reconcile receipt-level GL impact, matched bills, prior manual accruals, and reversals as of close. Generate only the additional adjustment needed to reach the required balance. Use source-linked posting records and enforce duplicate prevention when rerunning a close.
- **Example:** if the full required $100,000 receipt accrual is already recorded, the additional accrual is $0. If $60,000 remains uninvoiced but that balance is already in Accrued Purchases, do not accrue it again. Do not subtract the same invoice effect twice when reconciling invoice data and GL balances.

### Release checks

- Automated prototype tests cover partial invoices, future invoices, multiple receipts per PO, excluded invoice statuses, ambiguous matches, and invalid allocations. Production still needs integrated tests for credit/return reconciliation, quantity-price mismatches, and previously posted receipts.
- Reconcile every proposed adjustment to source records and the GL; retain the calculation, exceptions, reviewer decision, and posting/reversal references in durable storage.
- Obtain controller approval for account mapping and the receipt-to-bill workflow, including whether an entry should reverse. Do not combine a reversing manual accrual with an already-posted receipt accrual for the same amount.

## Known limitations

- Browser-only state; no shared persistence or authentication.
- Review decisions are deliberately scoped to the current import in this tab. Refresh or any successful workbook import resets all approvals; a failed import leaves the prior run unchanged. Reviewer names are self-entered, not authenticated. This is a demo UI control, not a tamper-resistant approval system.
- Current approval details export as `reviewed_by`, `review_note`, `reviewed_on` (MM/DD/YYYY), and `reviewed_time_utc` (24-hour UTC time). Automatically Ready lines have blank review metadata. The on-screen current-run history retains approval/reopen events but is not a permanent audit archive. Preserve approved exports with their source workbook.
- XLSX parsing loads SheetJS from a pinned CDN version.
- FX comes from the latest supplied invoice rather than a governed daily rate source.
- The anomaly baseline is intentionally simple because the anchor has one historical event per customer/SKU.
- CSV field mapping is illustrative and should be aligned to the target NetSuite CSV import template.
