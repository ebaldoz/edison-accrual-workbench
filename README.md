# Edison Accrual Workbench

A take-home demo that calculates unbilled customer revenue (AR) and uninvoiced goods receipts (AP), then exports journal-entry CSV files for NetSuite. It does not post entries to NetSuite.

## Open the app

[Open Edison Accrual Workbench on GitHub Pages](https://ebaldoz.github.io/edison-accrual-workbench/).

No installation or local server is needed.

1. Choose the accounting month.
2. Click **Import workbook** and select your Excel file. Calculations run automatically.
3. Open **View** on an accrual to see its calculation and source records.
4. Resolve items marked **Review**. Usage flags can be approved with a reviewer name and explanation. AP matching problems need a corrected workbook and a new import.
5. Before downloading AP, use **Check AP receipt / GL** to record evidence that the proposed amount is not already in the general ledger. If it is already recorded, do not confirm the check or export it.
6. Download the AR or AP CSV when all items on that side are **Ready**.

Files are processed in your browser, not uploaded to GitHub Pages. Refreshing or changing the month clears the workbook, results, and approvals. Import again to start a new calculation.

For March 2026, the original anchor workbook produces **AR $362.50** and **AP $100,000.00**, before review and export checks.

## Import workbook requirements

Use one `.xlsx` or `.xls` file. Its filename does not matter. The default handlers require these nine tabs, with names and column headers spelled exactly as below. Extra tabs are allowed; tab order does not matter.

| Tab | Main columns the app reads |
| --- | --- |
| `customers` | `customer_id`, `name`, `currency` |
| `sku_price_book` | `sku`, `unit`, `list_unit_price_usd` |
| `usage_events` | `event_id`, `customer_id`, `sku`, `quantity`, `occurred_on` |
| `chargebee_invoices` | `customer_id`, `period_end`, `issued_at`, `fx_to_usd` |
| `vendors` | `vendor_id`, `name` |
| `purchase_orders` | `po_number`, `vendor_id`, `gl_account` |
| `po_lines` | `po_number`, `po_line_ref` |
| `goods_receipts` | `receipt_id`, `po_number`, `po_line_ref`, `received_on`, `value_usd` |
| `vendor_invoices` | When populated: `invoice_number`, `vendor_id`, `invoice_date`, `status`, `subtotal_usd`, and a `po_number` or `receipt_id` reference |

The `vendor_invoices` tab is required even if it has no data rows. This table lists the main fields, not every validation rule. Invalid or unclear data may stop the import or create a Review item.

For AP dates, use Excel dates or `YYYY-MM-DD` text. The month selected in the app controls the close date—not the filename. A new handler may require additional tabs.

For AR, every usage row needs a unique, nonempty `event_id`. Duplicate IDs stop the import rather than silently counting the event twice. Billing invoices need valid `period_end` and `issued_at` values. Use Excel dates or `YYYY-MM-DD`; timestamps must include a timezone, such as `2026-03-29T00:00:00Z`. The handler uses only invoices issued by the selected close whose billing period also ends by close. A customer with usage through close but no eligible billing history stops the calculation; the app does not guess their billing cutoff.

## Accounting assumptions

- **Churn:** customer status alone does not remove earned revenue. The app trusts the usage feed to contain valid billable events, including usage earned before cancellation. It does not check a cancellation date or flag post-cancellation usage. Review that source data before importing; a churned customer is not automatically a zero-dollar accrual.
- **AR cutoff:** accrue usage after the latest eligible invoice's period end through the selected month-end. Invoice timestamps are compared using UTC dates, including the whole close day.
- **Amounts:** AR uses actual usage × the USD price book. AP uses the uninvoiced receipt balance from the supplied USD values. AP needs a separate ledger reconciliation before export.
- **Reversals:** the current export uses the next month's first calendar day and a repeated `reversal_date`, not separate reversal rows. This differs from a first-business-day calendar; NetSuite must process the reversal.

## How the code is organized

| File | Purpose |
| --- | --- |
| [`dist/app.js`](dist/app.js) | Workbook import, screen controls, and review dialogs |
| [`dist/engine.js`](dist/engine.js) | Runs the registered handlers and checks their results |
| [`dist/handlers/index.js`](dist/handlers/index.js) | Registers the enabled handlers |
| [`dist/handlers/usage.js`](dist/handlers/usage.js) | AR usage calculations |
| [`dist/handlers/receipt.js`](dist/handlers/receipt.js) | AP receipt accruals |
| [`dist/ap-matching.js`](dist/ap-matching.js) | Matches invoices to receipts |
| [`dist/handler-kit.js`](dist/handler-kit.js) | Shared helpers for journal lines and handler checks |
| [`dist/accrual-view.js`](dist/accrual-view.js) | Pagination and source drill-through |
| [`dist/posting-controls.js`](dist/posting-controls.js) | AP reconciliation check before export |
| [`tests/`](tests/) | Automated tests and sample test data |

### Data model and design choices

The data flows through four steps: **workbook records → handler calculations → accruals and journal lines → review and CSV export**.

- **Source records** keep the original customer, usage, invoice, PO, receipt, and vendor fields from the workbook.
- **An accrual** holds its amount, AR/AP side, handler, source references, and Ready/Review status. AR groups by customer and SKU; AP works at receipt-line level.
- **Journal lines** keep each accrual's debit/credit pair and share one monthly AR or AP journal ID. Source references connect the output back to the imported records.
- **Review decisions** and the AP ledger check belong to the current calculation. They are kept in memory and reset on refresh or reimport. A future database would separate all results and decisions by accounting month.

The app uses plain HTML, CSS, and JavaScript modules to keep this small demo easy to inspect, without a server or build step. SheetJS reads Excel files in the browser so the workbook does not need to be uploaded. Registered handlers keep accounting rules separate from the screen and engine. The built-in Node test runner checks the rules without extra test packages. GitHub Pages provides a simple live demo; the trade-off is no saved state, verified identity, or live ledger access.

### Add or edit a handler

A handler is a separate module for one type of accrual. You can use a class or an object; inheritance is not required.

1. Edit the existing usage or receipt handler, or create `dist/handlers/your-handler.js`.
2. Give it a unique `key`, an `AR` or `AP` `side`, a `label`, a `requiredSheets` list, and a `calculate(sheets, context)` method. Optional `help` text appears in the Handler information window.
3. Return accruals with a stable `id`, `handler`, `side`, `counterparty`, `source`, `description`, nonnegative `amountUsd`, `READY` or `REVIEW` status, `sourceDetail`, and balanced journal `lines`. Use `makeAccrualLines()` from `dist/handler-kit.js` for the debit and credit lines. For Review items, add `reviewTitle` and `reviewSummary`; use `reviewBlocked` when the source must be corrected instead of manually approved.
4. Import and register the handler in `dist/handlers/index.js`. The engine runs it automatically; you do not need to rewrite the engine or CSV exporter.
5. Add tests. [`tests/plugins.test.mjs`](tests/plugins.test.mjs) has an example third handler. That subscription example is test-only, not an enabled app feature.

To show original records in the detail window, return `sourceRecords: [{ sheet: "tab_name", label: "Calculation inputs", rows: [originalRow] }]`. Keep `sourceDetail` for the separate, collapsed Source Payload.

Handlers currently support AR and AP only. Supply any additional tabs a new handler requires.

## Journal output and safeguards

- Each month has one AR journal ID and one AP journal ID, such as `HELIX-2026-03-AR`. Repeating a calculation uses the same IDs.
- Each accrual keeps its debit and credit lines. `accrual_id` links the pair, `line_id` identifies each line, and `source_ref` points back to the source records.
- Journals use USD. Dates use `MM/DD/YYYY`. Posting is the selected month's last day; reversal is the next month's first calendar day, without a weekend or holiday adjustment.
- There are no reversal rows. The same `reversal_date` appears on every row of a journal; NetSuite must handle the reversal.
- Filters and 25-item pages change only what you see. Downloads include the entire AR or AP side, not just the displayed rows.
- In NetSuite, group rows by `external_id` and map it to **Journal Entry External ID**. Map posting date, reversal date, and currency as header fields; account, debit, credit, and audit references as line fields.
- Use NetSuite's **Add** import mode, not **Update** or **Add or Update**, for a new journal. An existing external ID should be rejected. Check the import result; do not change an ID just to bypass a duplicate error. See [Oracle's import-mode documentation](https://docs.oracle.com/en/cloud/saas/netsuite/ns-online-help/section_N345294.html).

## Anomaly detection

There is no AI model in the app. A simple rule flags usage at or above twice the historical average for the same customer and SKU. The actual usage amount stays unchanged; a person reviews the flag. This makes the calculation easy to explain and test.

The 2× threshold is a demo choice, not a threshold supplied by Helix or an accounting standard. It catches the seeded spike and lets a reviewer see the exact event and comparison. The small dataset does not support training or tuning a reliable model. The rule compares individual events, so event size and a short history can cause false alarms; without history it does not flag a spike, and a zero baseline flags any nonnegative event. With more history, I would compare consistent daily totals and measure missed spikes and false alarms before choosing a better threshold. No LLM calculates journal amounts.

## Automated tests

The repository currently has **77 automated tests**. They check amounts, currency conversion, usage flags, receipt/invoice matching, date cutoffs, duplicate data, balanced entries, source references, plugin rules, review controls, pagination, and CSV output. AR regression tests also cover duplicate event IDs, future and late-issued invoices, UTC cutoffs, the exact invoice shown in source drill-through, and preserving earned usage for churned customers.

GitHub runs the tests before deploying the site from `main`. Open the repository's **Actions** tab and select the latest deployment: a green check means the workflow passed. The tests do not test a real NetSuite import.

## Publishing

[The GitHub Pages workflow](.github/workflows/deploy-pages.yml) tests the code and publishes the files in `dist/` when changes reach `main`. Test fixtures are not part of the published site.

## With more time

- Save source snapshots, calculations, review history, and posting results by accounting month in a database.
- Add verified reviewers and source-level duplicate controls, and read posting status and receipt/GL balances from NetSuite.
- Add stronger source validation, cancellation-date checks, receipt quantity/price checks, and a business-day reversal calendar.
- Improve anomaly detection using more history and measured results; keep accounting amounts deterministic.

## Known limitations

- This is a demo, with no database, user login, saved approvals, or live NetSuite connection.
- Reviewer names and AP check evidence are entered by the user; the app cannot verify them or check the ledger itself.
- AP trusts the supplied USD receipt values. It does not independently check quantity × price or calculate an additional adjustment for amounts already posted.
- Currency rates come from the supplied invoices. The usage anomaly rule uses a simple historical baseline.
- CSV mappings must be checked against your NetSuite import template. The app cannot prevent duplicate entries under a different external ID.
- An internet connection is needed to load the workbook parser. Save the workbook, exported CSV, review evidence, and NetSuite import result separately if you need an audit record.
