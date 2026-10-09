# Helix Accrual Workbench

A controller-facing proof of concept for a single accrual engine that handles unbilled usage revenue and goods-received-not-invoiced (GRNI) accruals.

## What it does

- Opens with no workbook or calculated results. Import the supplied XLSX workbook each time the page loads; successful import runs the close automatically.
- Selects a close period using a year and a 3-column by 4-row grid of abbreviated months. The posting date is that month's last calendar day; the reversal date is the first calendar day of the following month, including across years. The initial selection is March 2026. Changing to a different period clears the imported workbook, accruals, totals, review decisions, and downloads; the user must import a workbook for that period.
- Calculates usage-based AR for the unbilled period after the latest Chargebee invoice.
- Converts the EUR customer's USD-valued usage to a transaction-currency view while booking the journal in USD.
- Accrues each receipt's uninvoiced USD balance, subtracting valid matched invoices dated through close rather than excluding its entire PO.
- Flags the seeded usage spike for human review without replacing actual usage.
- Downloads separate AR and AP CSVs with balanced original accrual lines only. Each journal's header-level `reversal_date` repeats on all its rows; no reversing-entry rows are generated. AR downloads when all its accruals are Ready; AP also needs a current receipt/GL reconciliation check.
- Uses one deterministic external ID per year-month and side (e.g. `HELIX-2026-03-AR` and `HELIX-2026-03-AP`). Re-runs reuse these journal IDs, not new journals.
- Preserves the original source-group identifier as `accrual_id`, adds unique `line_id` values ending in `-DR` or `-CR`, and retains `source_ref` on every row for audit.
- Provides source drill-through: click an accrual's **View**, expand a **Source data** group, then a record to inspect all imported fields. AR includes accrued events, historical baseline events, the latest billing/FX invoice, price, and customer. AP includes the receipt, matched invoice/allocation records, invoice exceptions, PO, PO line, and vendor. These are workbook snapshots, not live NetSuite links. **Source Payload** is collapsed by default and can be expanded separately.
- Shows at most 25 accruals per page with Previous/Next controls and a **Go to page** dropdown. The table heading reports the visible range, not just the total. Filters and new imports reset to page 1; period changes clear the workspace. Pagination does not affect totals, reviews, or CSV contents. Versioned CSS/JavaScript entry URLs prevent cached older assets from mixing with a newer page; bump their `v` value in `dist/index.html` when publishing interface updates.
- Allows current-run review of usage flags: verify the source/amount, enter a reviewer name and note, check the confirmation, and choose Mark Ready. Both journal lines become Ready; the original anomaly and amount are preserved. Reviewed items can be reopened with a reason. AP matching exceptions require corrected source data and reimport; they cannot be waived with a review note.
- Disables each side's download until every accrual line on that side is Ready. Empty sides are disabled too. This rule is also checked by the CSV formatter, not just the button.
- Before AP export, the controller must attest to an as-of-close receipt/accrued-liability GL reconciliation confirming none of the proposed amount is already recorded. The app does not query NetSuite: if this cannot be confirmed, do not export AP. The AP checker, evidence, and UTC check time are repeated on its exported lines. Downloading AP does not clear a valid check, so the same CSV can be downloaded again without graying out. NetSuite, not a self-entered app checkbox, rejects a duplicate journal external ID when imported as **Add** with that field mapped.
- Filters the accrual table by Side, Counterparty, Status, and Handler in combination. Filters do not change metrics, the review queue, download readiness, or the rows included in downloads.
- The Review queue has independent 25-item pages and numeric page selection. Both Accruals and Review queue fit their contents without a minimum height; their internal scroll areas are capped at 48% of the viewport height or 32rem, whichever is smaller. Empty results shrink to their messages. Clear filters sits beside the filter controls on desktop; controls wrap on smaller screens.
- Opens the control-design explanation in a modal from the information button beside the import-status heading or from Controls in the sidebar.

For the default March 2026 period, importing the supplied anchor workbook produces **AR $362.50** and **AP $100,000.00**. After selecting another period and importing a workbook, results may differ because that month's end is the calculation cutoff. Sample records for automated tests live in `tests/fixtures/anchor-data.js`, outside the deployable `dist/` directory; the website does not load them.

## Run locally

To use the hosted app, open [Helix Accrual Workbench on GitHub Pages](https://ebaldoz.github.io/helix-accrual-workbench/). No local setup is needed. Import a workbook in the page; the browser processes it without uploading it to GitHub Pages, and a refresh starts with a blank workspace.

To run the same site locally, install Node.js 22 (for the tests) and Python 3 (for the web server). From the repository root, run:

```bash
npm test
npm run serve
```

No build step or `npm install` is required. Leave the server running and open [http://localhost:4173](http://localhost:4173). An internet connection is needed to load the spreadsheet parser from jsDelivr. Local edits do not change the GitHub Pages site; the deployment workflow publishes changes to `dist/` after they reach `main` and its tests pass.

On either site, choose the period to the left of Import workbook, then import the supplied workbook. A valid import calculates the accruals immediately. Resolve any Review items. AR can then be downloaded; for AP, use **Check AP receipt / GL** and record the reconciliation before downloading. After a check is recorded, the button reads **View AP check**. Its dialog shows the checker, time, and evidence; **Recheck** explicitly replaces the check, while **Revoke check** locks AP download again. Repeat downloads do not require rechecking. Import the CSV in NetSuite using **Add**, with `external_id` mapped to Journal Entry External ID. Changing to another period clears the workbook and results; import a workbook for the new period to calculate it. To recalculate corrected source data, import the corrected workbook. A refresh also clears the in-browser workbook, results, and AP check. The workbook is not saved to a database or browser storage.

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

`vendor_invoices` must exist even when there are no vendor bills yet; it may have **zero data rows**. For AP dates, use real Excel dates or `YYYY-MM-DD` text. The browser period picker defaults to March 2026 (posting **03/31/2026**, reversal **04/01/2026**); neither the filename nor a date inside the workbook overrides the selected period. A missing required sheet produces a “Missing required sheets” error. The import reads the file in the browser and does not save the workbook or approvals between refreshes.

## Architecture

The browser app separates the close workflow into six parts:

1. **Workbook adapter** converts named XLSX sheets into arrays of records.
2. **Handler registry** validates plugin metadata, rejects duplicate keys, and selects all registered handlers by default (or a requested subset).
3. **Accrual engine** validates only the selected handlers' worksheets and checks each plugin's returned accrual and balanced lines against a common contract.
4. **Handlers** own source-specific accounting logic in separate modules. `UsageAccrualHandler` and `ReceiptAccrualHandler` implement the required scenarios.
5. **Posting controls** require a current human receipt/GL reconciliation only for AP. The check remains valid across repeat downloads of the same AP journal, but is invalidated when AP lines change and reset by reimport, period change, refresh, or explicit revocation. It is an attestation, not a live ledger lookup. NetSuite's Add-only import is the duplicate-external-ID blocker for both sides.
6. **Outputs and controls** render the review queue, source evidence, balanced original journal lines, reversal-date metadata, and separate AR/AP CSV downloads. The exporter selects every line by AR/AP side, so multiple handlers on the same side share the monthly journal.

The implementation is static by design: this is a reviewable proof of concept, not a production posting service. Deterministic IDs and NetSuite's Add-only duplicate rejection can block a second import of the *same monthly journal ID*, provided the CSV field is mapped correctly. The app itself cannot verify a posting, prevent a user from changing the ID, or detect a similar journal/manual entry under a different ID. A production integration should read back posting status and enforce its own source-level uniqueness and reconciliation policy.

### Data model and technology choices

- **Source records:** named workbook sheets hold customer, SKU, usage, invoice, PO, receipt, and vendor facts. `event_id` and `receipt_id` remain traceable in `source_ref` and the detail view. The browser parses the workbook into sheet-specific row arrays; it does not persist or modify the source file.
- **Close result:** one in-memory run has `runId`, `closeDate`, `reversalDate`, `accruals`, `journalLines`, totals, and a balance control. Each accrual has a stable ID, handler/side, source payload, amount, and calculation-review status. Its debit and credit lines share `accrual_id` but have distinct `line_id` values. All lines on one side/period share a monthly `external_id`.
- **Human controls:** current-run review decisions apply to individual accruals; an AP receipt/GL check applies to the whole AP journal. That check records the checker, evidence reference, and time, and is bound to the exact AP journal contents. It is neither authenticated nor durable in this prototype. AR has no manual pre-export check.
- **Technology rationale:** static HTML/CSS and ES modules keep the calculation and plugin boundary easy to inspect without a server or build step. SheetJS parses XLSX in the browser, so source files need not be uploaded to a service. Node's built-in test runner checks calculations, plugin contracts, review controls, and CSV output without extra test infrastructure. Private static hosting suits this demonstration; the trade-off is no shared database, live NetSuite lookup, verified identity, or in-app authoritative duplicate-post lock.

### Future database period scope

There is **no accruals database in this prototype**. When persistence is added, each calculated accrual should carry an accounting-period key such as `2026-03` (plus entity/book dimensions if applicable). The Accruals table, review queue, totals, export checks, and CSV exports must query only the selected period—for example, `WHERE period_key = :selected_period`—and must never carry rows or decisions from a previously selected month into the new view. Imported source snapshots and close runs should be linked to that period so the month-specific calculation remains auditable.

## Where to add or edit a handler

- **Edit AR usage calculations:** `UsageAccrualHandler` in [`dist/handlers/usage.js`](dist/handlers/usage.js) selects unbilled events, groups by customer and SKU, calculates the amount, and flags usage anomalies.
- **Edit AP receipt accruals:** `ReceiptAccrualHandler` in [`dist/handlers/receipt.js`](dist/handlers/receipt.js) turns uninvoiced receipt balances into accruals. Its invoice-to-receipt matching, cutoff, and residual-value rules live in [`dist/ap-matching.js`](dist/ap-matching.js), in `reconcileReceipts()`.

To add a third accrual type (for example, an AP subscription accrual):

1. Create `dist/handlers/your-handler.js`. Export a class or object with a unique `key`, an `AR` or `AP` `side`, a human-readable `label`, a `requiredSheets` array, and `calculate(sheets, context)`. Optional `help` text appears in the Handler information modal. The registry checks this metadata and rejects duplicate keys.
2. Return an array of accrual objects with stable `id`, matching `handler` and `side`, `counterparty`, `source`, `description`, nonnegative `amountUsd`, `READY` or `REVIEW` status, `sourceDetail`, and balanced `lines`. Use [`makeAccrualLines()`](dist/handler-kit.js) to produce the debit/credit pair with source references, deterministic monthly side-level external ID, and close/reversal dates. If Review is possible, provide `reviewTitle` and `reviewSummary`; set `reviewBlocked` when source correction (rather than manual approval) is required.
3. Add one import and one instance in [`dist/handlers/index.js`](dist/handlers/index.js). `new AccrualEngine()` then runs the new handler automatically. The app reads all workbook tabs, validates each enabled handler's `requiredSheets`, shows the handler's label/filter/help, and includes its lines in the AR or AP CSV without new exporter mappings. To run only selected handlers in code, pass `{ handlers: ["YOUR_KEY"] }` to `run()`; only that subset's sheets are required.
4. Add a contract and calculation test. [`tests/plugins.test.mjs`](tests/plugins.test.mjs) demonstrates a third AP subscription-style test handler, including its extra worksheet, shared AP external ID and CSV, validation failures, and download lock when it returns Review. It is a test fixture, **not** a production subscription calculation or a default handler. Run `npm test`.

For structured drill-through, a new handler can also return `sourceRecords: [{ sheet: "worksheet_name", label: "Calculation inputs", rows: [originalSourceRow] }]` on each accrual. The detail view automatically renders these expandable records; no UI routing change is needed. Keep `sourceDetail` for the separate, collapsed raw payload. The built-in AR/AP source groups are resolved in `dist/accrual-view.js`.

The plugin boundary is intentionally limited to the existing AR/AP journal sides. A genuinely new journal side, posting policy, or richer custom detail view would still require a deliberate UI/export design change; do not silently map it to AR or AP. Registering a handler that requires a new sheet also requires supplying that sheet in the imported workbook.

## Accounting assumptions

- The selected period's month-end is the posting date and calculation cutoff; the reversal date is the first calendar day of the next month (not adjusted for weekends or holidays). March 2026 is the initial selection.
- Group CSV rows by `external_id` into journals. Map `posting_date`, `reversal_date`, and `currency` to journal-header fields, not journal-line fields. The export checks that these values are consistent within each journal. Map account/debit/credit to line fields. The destination system must process the reversal; the app does not post or schedule one.
- CSV date columns use `MM/DD/YYYY` (e.g. `03/31/2026`, `04/01/2026`); engine dates and source payloads remain ISO. IDs and filenames keep their machine-readable year-month/date tokens.
- Map `line_id`, `accrual_id`, and `source_ref` to line-level audit fields, and `memo` to the line memo. The `posting_checked_by`, `posting_check_evidence`, `posting_checked_on`, `posting_checked_time_utc`, and `ap_gl_not_recorded_confirmed` fields carry self-entered **AP-only** GL evidence; AR leaves them blank. Map them only to appropriate custom/audit fields or retain them in the archived export. Transaction-currency amounts/rates are source-level reference fields; the journal currency is USD, including Berlin's lines. March AR is one six-line journal; March AP is one two-line journal. No customer/source-level lines are consolidated or discarded.
- For a new close journal, map `external_id` to **Journal Entry External ID** on every CSV row and select **Add** in NetSuite's CSV Import Assistant. Do **not** select **Update** or **Add or Update** for this posting flow; those modes can modify an existing journal. NetSuite should reject an Add attempt when the external ID already exists. Inspect the import result/error before treating a journal as posted. [Oracle: journal-entry CSV identifiers](https://docs.oracle.com/en/cloud/saas/netsuite/ns-online-help/section_1534489651.html), [data-handling modes](https://docs.oracle.com/en/cloud/saas/netsuite/ns-online-help/section_N345294.html), and [duplicate-ID error](https://docs.oracle.com/en/cloud/saas/netsuite/ns-online-help/section_4570011199.html).
- Reimporting a monthly external ID requires a deliberate **reject-or-reconcile** policy. If NetSuite rejects it, locate the existing journal and reconcile its amount/status; do not change the external ID merely to bypass the blocker. A correction to a posted month needs an approved adjustment, reversal, or controlled update process. The static app cannot prevent alternate IDs, manual entries, or duplicate source coverage under another journal. Archive the source workbook, AP check evidence (if applicable), import result, and CSV together. Multiple entities/books would need an additional journal-key dimension before production use.
- Usage after each customer's latest invoice period end through close is accrued.
- The price book is USD-denominated. USD is the NetSuite posting currency. For the EUR customer, the UI derives a transaction-currency amount at 1.08 USD/EUR and retains the rate on every line.
- The actual 25-hour spike remains in revenue; it is routed to review rather than smoothed.
- AP calculates receipt-level uninvoiced value using the invoice-date cutoff and matching rules below. This is a **proposed balance**, not an additional adjustment after reconciling existing GL postings. Before AP export, check whether the goods receipt or another entry already recorded any of that balance. If so, do not attest or download; this prototype cannot calculate a partial incremental adjustment.
- The partial receipt is capitalized to account 1480 with an offset to accrued expenses 2150.

## AI / ML rationale

For this dataset, a transparent rule is safer than an opaque model. The detector compares an event with its customer/SKU historical baseline and flags values at or above 2x. This catches the seeded spike and gives the reviewer the exact event, baseline, and ratio. With production history, I would evaluate robust z-scores or an isolation model by customer/SKU cohort, version the feature set, and monitor false positives. The accounting amount would remain deterministic and would never be generated by an LLM.

## Test coverage

The tests verify anchor totals, EUR translation, anomaly routing, receipt/line matching, partial and multiple invoices, invoice/receipt cutoff boundaries, ambiguous matches, duplicate allocations, invoice-header reconciliation, invalid fields, over-invoicing, source correction, AR calculation-ready downloads, AP GL-check gating/invalidation and repeat downloads with unchanged evidence in CSV, deterministic IDs, balanced entries, source references, AR/AP separation, selected-period month-end and next-month dates (including leap years and year rollover), and consistent header reversal dates with no reversal rows. NetSuite's actual import rejection is an external system behavior, not tested by this static app.

## Deployment recommendation

This static proof of concept is live on [GitHub Pages](https://ebaldoz.github.io/helix-accrual-workbench/) and remains available on the existing private OpenAI Sites deployment. The [Pages workflow](.github/workflows/deploy-pages.yml) runs automated tests and publishes the `dist` app while excluding `anchor-data.js`, which contains sample test records. Workbook import and calculations run in the visitor’s browser; GitHub Pages does not store the imported file or review decisions. The GitHub Pages site is public even though this source repository remains private. For confidential reviewer access, use the private deployment with an authenticated allowlist; an unguessable URL is not access control.

## What I would change for production

- Persist raw source snapshots, normalized records, close runs, decisions, and journal lines in Postgres.
- Use an orchestrator and queues for Chargebee, telemetry, Coupa, FX, and NetSuite integrations.
- Enforce database uniqueness on `(entity, period, handler, source_ref)`, retain NetSuite Add-only external-ID rejection with posting-status readback, and replace the self-entered AP GL check with a live GL reconciliation.
- Add legal entity, subsidiary, department, class, location, tax, book, and accounting-period dimensions.
- Extend the implemented receipt/line invoice matching with quantity/value tolerances, returns/credits, posting-period controls, and GL reconciliation.
- Add approvals, role-based access, immutable audit events, observability, retries, and reconciliation back from NetSuite.
- Version handler logic and anomaly policies so every close is reproducible.

## AP calculation and workbook fields

1. Include each goods-receipt line with `received_on <= closeDate` (March 31, 2026 in the demo). Validate receipt identifiers, dates, USD values, and PO/PO-line references. Missing or duplicate receipt/master keys fail the calculation instead of silently exporting bad data.
2. Consider vendor invoices with `invoice_date <= closeDate`. Eligible statuses are `approved`, `posted`, `paid`, and `open` (case-insensitive). Ignore `void`, `voided`, `cancelled`, `canceled`, and `rejected`. Missing/other statuses require Review. This is a prototype invoice-date policy, not a NetSuite posting-date/period policy.
3. Match a supplied `receipt_id`, constrained by any supplied PO/line references. Otherwise use `po_number` plus `po_line_ref` only if they identify one receipt. A PO-only invoice can match only when there is one receipt and one PO line. Uniqueness considers all supplied receipts, including future receipts, to avoid treating a broad reference as unique merely because of the cutoff. No FIFO or proportional split is guessed.
4. Subtract matched invoice USD amounts from that receipt's stored `value_usd`, using integer cents. Multiple invoices can reduce the same receipt. A clean zero balance generates no accrual. A positive proposed balance creates one debit/credit pair, with the existing monthly AP external ID and reversal-date header. This is not yet net of any liability already posted from the goods receipt.
5. Uncertain matches retain a provisional balance and Review. Over-invoicing retains a zero-dollar Review exception, rather than disappearing or creating a negative accrual. Correct the workbook and reimport to resolve matching issues. AP download stays locked until every AP item is Ready **and** the receipt/GL check is recorded; Mark Ready cannot bypass matching exceptions. NetSuite Add-only import separately blocks an existing monthly external ID.

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

- **Today:** the handler does not automatically check whether NetSuite already recorded the receipt's asset/expense and accrued liability. AP CSV download requires a controller to record a receipt/GL reconciliation attestation and evidence reference confirming none of the proposed balance is already recorded. If there is an existing or partial posting, do not attest; the app does not calculate the additional adjustment.
- **Production:** reconcile receipt-level GL impact, matched bills, prior manual accruals, and reversals as of close. Generate only the additional adjustment needed to reach the required balance. Use source-linked posting records and enforce duplicate prevention when rerunning a close.
- **Example:** if the full required $100,000 receipt accrual is already recorded, the additional accrual is $0. If $60,000 remains uninvoiced but that balance is already in Accrued Purchases, do not accrue it again. Do not subtract the same invoice effect twice when reconciling invoice data and GL balances.

### Release checks

- Automated prototype tests cover partial invoices, future invoices, multiple receipts per PO, excluded invoice statuses, ambiguous matches, and invalid allocations. Production still needs integrated tests for credit/return reconciliation, quantity-price mismatches, and previously posted receipts.
- Reconcile every proposed adjustment to source records and the GL; retain the calculation, exceptions, reviewer decision, and posting/reversal references in durable storage.
- Obtain controller approval for account mapping and the receipt-to-bill workflow, including whether an entry should reverse. Do not combine a reversing manual accrual with an already-posted receipt accrual for the same amount.

## Known limitations

- Browser-only state; no shared persistence or authentication. The AP receipt/GL check is self-entered and reset on a new calculation. The app itself cannot verify NetSuite's duplicate-ID rejection or GL balances.
- Review decisions are deliberately scoped to the current calculation in this tab. Refresh, a successful change to another period, or a successful workbook import clears approvals; a period change also clears the imported workbook and all results. A failed import or invalid period selection leaves the prior run unchanged. Reviewer names are self-entered, not authenticated. This is a demo UI control, not a tamper-resistant approval system.
- Current approval details export as `reviewed_by`, `review_note`, `reviewed_on` (MM/DD/YYYY), and `reviewed_time_utc` (24-hour UTC time). AP GL-check details use separate `posting_checked_*` fields and an AP GL confirmation field; these are blank on AR lines. Automatically Ready lines have blank calculation-review metadata. The on-screen current-run history retains approval/reopen events but is not a permanent audit archive. Preserve approved exports with their source workbook and external evidence.
- XLSX parsing loads SheetJS from a pinned CDN version.
- FX comes from the latest supplied invoice rather than a governed daily rate source.
- The anomaly baseline is intentionally simple because the anchor has one historical event per customer/SKU.
- CSV field mapping is illustrative and should be aligned to the target NetSuite CSV import template.
