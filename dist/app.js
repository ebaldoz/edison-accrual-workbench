import { AccrualEngine, validateDataset, formatOutputDate, getExportAvailability } from "./engine.js";
import { filterAccruals, reviewAccrual } from "./review.js";
import { MONTHS, periodDates, periodLabel } from "./period.js";
import { paginateAccruals, sourceRecordsFor } from "./accrual-view.js";
import { getPostingAvailability, journalIdForSide, recordPostingCheck, revokePostingCheck, toPostingControlledCsv } from "./posting-controls.js";

const engine = new AccrualEngine();
let result;
let importedSheets;
let accrualPage = 1;
let selectedPeriod = { year: 2026, month: 3 };
let selectedId = null;
const filters = { side: "", counterparty: "", status: "", handler: "" };

const money = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });
const number = new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 });
const $ = (selector) => document.querySelector(selector);

function handlerLabel(key) {
  return result?.handlerDefinitions.find(handler => handler.key === key)?.label || key;
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>'"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[char]);
}

function showImportedResult(filename) {
  accrualPage = 1;
  selectedId = null;
  $("#detail-panel").classList.remove("open");
  $("#overlay").classList.remove("show");
  $("#detail-panel").inert = true;
  $("main").inert = false;
  $("#sidebar").inert = false;
  $("#run-state").textContent = "Calculation complete — no entries posted";
  $("#dataset-name").textContent = filename;
  $("#import-error").hidden = true;
  const handlerOptions = result.handlerDefinitions.map(handler => `<option value="${escapeHtml(handler.key)}">${escapeHtml(handler.label)}</option>`).join("");
  $("#filter-handler").innerHTML = `<option value="">All handlers</option>${handlerOptions}`;
  if (!result.handlerDefinitions.some(handler => handler.key === filters.handler)) filters.handler = "";
  $("#filter-handler").value = filters.handler;
  $("#additional-handler-help").innerHTML = result.handlerDefinitions
    .filter(handler => !["AR_USAGE", "AP_GRNI"].includes(handler.key))
    .map(handler => `<h3>${escapeHtml(handler.label)} <code>${escapeHtml(handler.key)}</code></h3><p>${escapeHtml(handler.help || `${handler.side} accrual handler. See its source module for its calculation rules.`)}</p>`).join("");
  render();
}

function renderEmpty() {
  $("#run-dot").className = "pulse pending";
  for (const id of ["ar-total", "ap-total", "ready-total", "review-total"]) $(`#${id}`).textContent = "—";
  $("#nav-review").textContent = "";
  $("#ar-caption").textContent = "Import a workbook to calculate";
  $("#ap-caption").textContent = "Import a workbook to calculate";
  $("#ready-caption").textContent = "Import a workbook to calculate";
  $("#review-caption").textContent = "Import a workbook to calculate";
  $("#balance-state").textContent = "Awaiting import";
  $("#balance-state").className = "control pending";
  $("#accrual-count").textContent = "No workbook loaded";
  $("#accrual-body").innerHTML = '<tr><td colspan="6" class="empty">Import an XLSX workbook to see accruals.</td></tr>';
  $("#accrual-pagination").hidden = true;
  $("#review-list").innerHTML = '<div class="empty">Import an XLSX workbook to see review items.</div>';
  for (const side of ["ar", "ap"]) {
    $(`#export-${side}-csv`).disabled = true;
    $(`#export-${side}-reason`).textContent = "Import a workbook before downloading.";
    $(`#export-${side}-id`).hidden = true;
  }
  $("#check-ap-export").disabled = true;
  $("#check-ap-export").textContent = "Check AP receipt / GL";
  for (const key of Object.keys(filters)) $(`#filter-${key}`).disabled = true;
  $("#clear-filters").disabled = true;
}

function clearImportedResult() {
  result = undefined;
  importedSheets = undefined;
  accrualPage = 1;
  selectedId = null;
  $("#detail-panel").classList.remove("open");
  $("#overlay").classList.remove("show");
  $("#detail-panel").inert = true;
  $("#detail-body").replaceChildren();
  $("#detail-title").textContent = "";
  $("#detail-subtitle").textContent = "";
  $("main").inert = false;
  $("#sidebar").inert = false;
  $("#file-input").value = "";
  $("#run-state").textContent = "Import workbook to begin";
  $("#dataset-name").textContent = "No workbook loaded";
  $("#import-error").textContent = "";
  $("#import-error").hidden = true;
  $("#filter-handler").innerHTML = '<option value="">All handlers</option>';
  $("#additional-handler-help").replaceChildren();
  for (const key of Object.keys(filters)) {
    filters[key] = "";
    $(`#filter-${key}`).value = "";
  }
  renderEmpty();
}

function render() {
  if (!result) { renderEmpty(); return; }
  $("#run-dot").className = result.control.balanced ? "pulse good" : "pulse bad";
  for (const key of Object.keys(filters)) $(`#filter-${key}`).disabled = false;
  $("#clear-filters").disabled = false;
  $("#ar-total").textContent = money.format(result.totals.ar);
  $("#ap-total").textContent = money.format(result.totals.ap);
  $("#ready-total").textContent = result.totals.ready;
  $("#review-total").textContent = result.totals.review;
  $("#nav-review").textContent = result.totals.review;
  $("#ar-caption").textContent = `${result.accruals.filter(item => item.side === "AR").length} AR accrual(s)`;
  $("#ap-caption").textContent = `${result.accruals.filter(item => item.side === "AP").length} AP accrual(s)`;
  $("#ready-caption").textContent = "Calculation-ready; AP ledger check is separate";
  $("#review-caption").textContent = "Items requiring verification";
  $("#balance-state").textContent = result.control.balanced ? "Balanced" : "Out of balance";
  $("#balance-state").className = result.control.balanced ? "control good" : "control bad";
  const visible = filterAccruals(result.accruals, filters);
  const page = paginateAccruals(visible, accrualPage);
  accrualPage = page.page;
  $("#accrual-pagination").hidden = !visible.length;
  $("#accrual-page-status").textContent = `Showing ${page.start}–${page.end} of ${page.total} · Page ${page.page} of ${page.pages}`;
  $("#accrual-prev").disabled = page.page === 1;
  $("#accrual-next").disabled = page.page === page.pages;
  const pageSelect = $("#accrual-page-select");
  pageSelect.innerHTML = Array.from({ length: page.pages }, (_, index) => `<option value="${index + 1}">Page ${index + 1} of ${page.pages}</option>`).join("");
  pageSelect.value = String(page.page);
  $("#accrual-count").textContent = visible.length ? `Showing ${page.start}–${page.end} of ${visible.length}${visible.length !== result.accruals.length ? ` filtered (${result.accruals.length} total)` : " accruals"}` : `0 matching accruals (${result.accruals.length} total)`;
  for (const side of ["AR", "AP"]) {
    const calculated = getExportAvailability(result.journalLines, side);
    const state = getPostingAvailability(result, side);
    const key = side.toLowerCase();
    if (side === "AP") {
      $("#check-ap-export").disabled = !calculated.allowed;
      $("#check-ap-export").textContent = state.allowed ? "View AP check" : "Check AP receipt / GL";
      $("#check-ap-export").title = !calculated.allowed ? calculated.reason : state.allowed ? "View the recorded AP receipt / GL check" : "Reconcile AP receipt and GL balances";
    }
    $(`#export-${key}-csv`).disabled = !state.allowed;
    $(`#export-${key}-csv`).title = state.reason;
    $(`#export-${key}-reason`).textContent = state.reason;
    const id = $(`#export-${key}-id`);
    id.hidden = !calculated.allowed;
    if (calculated.allowed) id.textContent = `Monthly external ID: ${journalIdForSide(result, side)}`;
  }

  $("#accrual-body").innerHTML = visible.length ? page.items.map((item) => `
    <tr data-id="${escapeHtml(item.id)}" class="${selectedId === item.id ? "selected" : ""}">
      <td><span class="side ${item.side.toLowerCase()}">${item.side}</span></td>
      <td><strong>${escapeHtml(item.counterparty)}</strong><small>${escapeHtml(item.description)}</small></td>
      <td><span class="handler">${escapeHtml(handlerLabel(item.handler))}</span></td>
      <td class="amount">${money.format(item.amountUsd)}${item.transactionCurrency !== "USD" ? `<small>${number.format(item.transactionAmount)} ${item.transactionCurrency} @ ${item.fx}</small>` : ""}</td>
      <td><span class="status ${item.status.toLowerCase()}">${item.status}</span></td>
      <td><button class="row-open" aria-label="Open ${escapeHtml(item.counterparty)} details">View →</button></td>
    </tr>`).join("") : `<tr><td colspan="6" class="empty">No accruals match these filters. Clear filters to see all accruals.</td></tr>`;

  document.querySelectorAll("#accrual-body tr[data-id]").forEach((row) => row.addEventListener("click", () => openDetail(row.dataset.id)));
  renderReview();
}

function reviewSection(item) {
  if (item.reviewBlocked) return `<section class="review-decision"><h3>Correct source data to continue</h3><p>This amount needs a source correction. Fix the issues shown above, then import the corrected workbook. Mark Ready is unavailable until they are resolved. The ${escapeHtml(item.side)} download remains locked, including for a zero-dollar exception.</p></section>`;
  if (item.status !== "REVIEW" && !item.review) return "";
  const approved = item.status === "READY" && item.review;
  const history = (result.reviewLog || []).filter(event => event.accrualId === item.id);
  return `<section class="review-decision"><h3>${approved ? "Review recorded" : "Complete review"}</h3>
    <p>${escapeHtml(item.reviewInstructions || "Check the source records and amount before marking Ready.")} This does not post the journal.</p>
    ${approved ? `<p class="review-approved">Ready — reviewed by ${escapeHtml(item.review.reviewer)} on ${formatOutputDate(item.review.reviewedAt.slice(0,10))} at ${item.review.reviewedAt.slice(11,19)} UTC.<br>${escapeHtml(item.review.note)}</p>` : ""}
    <form id="review-form">
      <label for="reviewer-name">Reviewer name</label><input id="reviewer-name" name="reviewer" required maxlength="100" autocomplete="name" />
      <label for="review-note">${approved ? "Reason for reopening" : "Review note / evidence reference"}</label><textarea id="review-note" name="note" required maxlength="1000" rows="3"></textarea>
      <label class="review-confirm"><input id="review-confirm" type="checkbox" required />I checked the source records and amount.</label>
      <p id="review-error" role="alert" hidden></p>
      <button class="review-submit" type="submit">${approved ? "Reopen review" : "Mark Ready"}</button>
    </form>
    <p class="session-note">Current calculation only. Changing period clears this workbook and its approvals; refresh or reimport also resets approvals. Names are self-entered, not verified identities.</p>
    ${history.length ? `<details><summary>Review history for this run (${history.length})</summary><ul>${history.map(event => `<li>${event.action === "approve" ? "Marked Ready" : "Reopened"} by ${escapeHtml(event.reviewer)} · ${formatOutputDate(event.reviewedAt.slice(0,10))} ${event.reviewedAt.slice(11,19)} UTC — ${escapeHtml(event.note)}</li>`).join("")}</ul></details>` : ""}
  </section>`;
}

function renderReview() {
  const reviews = result.accruals.filter((item) => item.status === "REVIEW");
  $("#review-list").innerHTML = reviews.length ? reviews.map((item) => `
    <button class="review-card" data-id="${escapeHtml(item.id)}">
      <span class="review-icon">!</span>
      <span><strong>${escapeHtml(item.reviewTitle || handlerLabel(item.handler))} · ${escapeHtml(item.counterparty)}</strong><small>${escapeHtml(item.reviewSummary || item.description)}</small></span>
      <span class="review-amount">${money.format(item.amountUsd)}</span>
    </button>`).join("") : `<div class="empty">No items require review.</div>`;
  document.querySelectorAll(".review-card").forEach((card) => card.addEventListener("click", () => openDetail(card.dataset.id)));
}

function openDetail(id) {
  selectedId = id;
  const item = result.accruals.find((row) => row.id === id);
  if (!item) return;
  $("#detail-title").textContent = item.counterparty;
  $("#detail-subtitle").textContent = `Monthly journal: ${item.lines[0].external_id}`;
  $("#detail-body").innerHTML = `
    <div class="detail-total"><span>${item.reviewBlocked ? "Provisional balance" : "Accrual amount"}</span><strong>${money.format(item.amountUsd)}</strong></div>
    <dl>
      <div><dt>Handler</dt><dd>${escapeHtml(item.handler)}</dd></div>
      <div><dt>Accrual ID</dt><dd>${escapeHtml(item.id)}</dd></div>
      <div><dt>Review status</dt><dd><span class="status ${item.status.toLowerCase()}">${item.status}</span></dd></div>
      <div><dt>Source references</dt><dd>${escapeHtml(item.source)}</dd></div>
      <div><dt>Posting date</dt><dd>${formatOutputDate(result.closeDate)}</dd></div>
      <div><dt>Reversal date</dt><dd>${formatOutputDate(result.reversalDate)}</dd></div>
    </dl>
    ${item.anomaly ? `<div class="callout"><strong>Review reason</strong><p>${escapeHtml(item.anomaly.event_id)} is ${number.format(item.anomaly.quantity / item.anomaly.baseline)}× its historical baseline. The engine preserves actual quantity and routes the accrual for review.</p></div>` : ""}
    ${item.matching ? `<section><h3>Receipt-to-invoice calculation</h3><p>Receipt value ${money.format(item.matching.receiptValueUsd)} − matched invoices through ${formatOutputDate(result.closeDate)} ${money.format(item.matching.matchedInvoiceUsd)} = ${money.format(item.amountUsd)}${item.reviewBlocked ? " (provisional; negative residuals are shown as zero)" : " uninvoiced"}.</p><p>Invoice-date cutoff only. This is a proposed uninvoiced balance, not an additional journal approved for posting. Before AP export, reconcile the receipt and accrued-liability GL balance in NetSuite. If any proposed amount is already recorded, stop; this app cannot calculate the incremental adjustment.</p>${item.reviewBlocked ? `<div class="callout"><strong>Matching issues — source correction required</strong><ul>${item.reviewReasons.map(reason => `<li>${escapeHtml(reason)}</li>`).join("")}</ul></div>` : ""}</section>` : ""}
    ${reviewSection(item)}
    <h3>Journal preview</h3>
    <div class="mini-table">${item.lines.map((line) => `<div><span>${escapeHtml(line.line_type)} · ${line.account}</span><span>${line.debit_usd ? `Dr ${money.format(line.debit_usd)}` : `Cr ${money.format(line.credit_usd)}`}</span><small class="audit-line">Line ID: ${escapeHtml(line.line_id)}</small></div>`).join("")}</div>
    ${renderSourceRecords(item)}
    <details class="source-payload"><summary>Source Payload</summary>
    <pre>${escapeHtml(JSON.stringify(item.sourceDetail, null, 2))}</pre></details>`;
  $("#detail-panel").classList.add("open");
  $("#overlay").classList.add("show");
  $("#detail-panel").inert = false;
  $("main").inert = true;
  $("#sidebar").inert = true;
  const form = $("#review-form");
  if (form) form.addEventListener("submit", event => {
    event.preventDefault();
    try {
      reviewAccrual(result, id, { reviewer: $("#reviewer-name").value, note: $("#review-note").value, confirmed: $("#review-confirm").checked, action: item.status === "REVIEW" ? "approve" : "reopen" });
      revokePostingCheck(result, item.side);
      $("#run-state").textContent = item.status === "READY" ? "Review recorded — no entries posted" : "Review reopened — side download locked";
      openDetail(id);
    } catch (error) {
      $("#review-error").textContent = error.message;
      $("#review-error").hidden = false;
    }
  });
  render();
  $("#close-detail").focus();
}

function renderSourceRecords(item) {
  const groups = sourceRecordsFor(item, importedSheets);
  return `<section class="source-records"><h3>Source data</h3><p>Imported workbook records used by this accrual. Expand a group, then a record to inspect every original field. These are workbook snapshots, not live NetSuite records.</p>${groups.length ? groups.map(group => `<details><summary>${escapeHtml(group.label)} (${group.rows.length}) · ${escapeHtml(group.sheet)}</summary>${group.rows.length ? group.rows.map((row, index) => `<details class="source-record"><summary>${escapeHtml(row.event_id || row.receipt_id || row.invoice_number || row.po_number || row.customer_id || row.vendor_id || row.sku || `Record ${index + 1}`)} · Record ${index + 1}</summary><dl>${Object.entries(row).map(([key, value]) => `<div><dt>${escapeHtml(key)}</dt><dd>${escapeHtml(value instanceof Date ? value.toISOString() : typeof value === "object" ? JSON.stringify(value) : value)}</dd></div>`).join("")}</dl></details>`).join("") : `<p>No records in this group.</p>`}</details>`).join("") : `<p>This handler does not supply structured source records. See Source Payload below.</p>`}</section>`;
}

function closeDetail() {
  if (!selectedId) return;
  const priorId = selectedId;
  selectedId = null;
  $("#detail-panel").classList.remove("open");
  $("#overlay").classList.remove("show");
  $("#detail-panel").inert = true;
  $("main").inert = false;
  $("#sidebar").inert = false;
  render();
  const row = [...document.querySelectorAll("#accrual-body tr[data-id]")].find(row => row.dataset.id === priorId);
  (row?.querySelector("button") || $("#filter-status")).focus();
}

function downloadCsv(side) {
  let csv;
  try { csv = toPostingControlledCsv(result, side); } catch (error) {
    $("#import-error").textContent = error.message;
    $("#import-error").hidden = false;
    return;
  }
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `helix-${side.toLowerCase()}-journal-${result.closeDate}.csv`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  render();
}

async function importWorkbook(file) {
  if (!window.XLSX) throw new Error("The workbook parser did not load. Check your network connection and try again.");
  const workbook = window.XLSX.read(await file.arrayBuffer(), { type: "array", cellDates: true });
  const sheets = {};
  for (const name of workbook.SheetNames) {
    sheets[name] = window.XLSX.utils.sheet_to_json(workbook.Sheets[name], { defval: "", raw: true });
  }
  validateDataset(sheets);
  const nextResult = engine.run(sheets, periodDates(selectedPeriod.year, selectedPeriod.month));
  result = nextResult;
  importedSheets = sheets;
  showImportedResult(file.name);
}

function updatePeriodDisplay() {
  const { year, month } = selectedPeriod;
  const dates = periodDates(year, month);
  $("#period-selected").textContent = periodLabel(year, month);
  $("#period-eyebrow").textContent = `${MONTHS[month - 1].toUpperCase()} ${year} CLOSE`;
  $("#close-date").dateTime = dates.closeDate;
  $("#close-date").textContent = formatOutputDate(dates.closeDate);
  $("#reversal-date").dateTime = dates.reversalDate;
  $("#reversal-date").textContent = formatOutputDate(dates.reversalDate);
}

function renderPeriodMonths() {
  const year = Number($("#period-year").value);
  $("#period-year-prev").disabled = year <= 1900;
  $("#period-year-next").disabled = year >= 2100;
  $("#period-months").innerHTML = MONTHS.map((name, index) => {
    const month = index + 1;
    const pressed = selectedPeriod.year === year && selectedPeriod.month === month;
    return `<button type="button" data-month="${month}" aria-label="${name} ${Number.isInteger(year) ? year : ""}" aria-pressed="${pressed}">${name}</button>`;
  }).join("");
}

function selectPeriod(month) {
  const year = Number($("#period-year").value);
  try {
    periodDates(year, month);
    if (year !== selectedPeriod.year || month !== selectedPeriod.month) {
      selectedPeriod = { year, month };
      clearImportedResult();
      updatePeriodDisplay();
    }
    $("#period-error").hidden = true;
    $("#period-picker").open = false;
    $("#period-picker summary").focus();
  } catch (error) {
    $("#period-error").textContent = error.message;
    $("#period-error").hidden = false;
  }
}

$("#period-picker").addEventListener("toggle", event => {
  if (!event.currentTarget.open) return;
  $("#period-year").value = selectedPeriod.year;
  $("#period-error").hidden = true;
  renderPeriodMonths();
});
$("#period-year").addEventListener("input", () => { $("#period-error").hidden = true; renderPeriodMonths(); });
for (const [id, offset] of [["period-year-prev", -1], ["period-year-next", 1]]) {
  $(`#${id}`).addEventListener("click", () => {
    const current = Number($("#period-year").value);
    $("#period-year").value = Math.min(2100, Math.max(1900, (Number.isInteger(current) && current >= 1900 && current <= 2100 ? current : selectedPeriod.year) + offset));
    renderPeriodMonths();
  });
}
$("#period-months").addEventListener("click", event => {
  const button = event.target.closest("button[data-month]");
  if (button) selectPeriod(Number(button.dataset.month));
});
$("#period-picker").addEventListener("keydown", event => {
  if (event.key === "Escape") { event.stopPropagation(); $("#period-picker").open = false; $("#period-picker summary").focus(); }
});
document.addEventListener("click", event => {
  if (!$("#period-picker").contains(event.target)) $("#period-picker").open = false;
});

$("#export-ar-csv").addEventListener("click", () => downloadCsv("AR"));
$("#export-ap-csv").addEventListener("click", () => downloadCsv("AP"));
let postingCheckSide = null;
let postingCheckOpener = null;
function openPostingCheck(side, opener) {
  if (side !== "AP" || !result || !getExportAvailability(result.journalLines, side).allowed) return;
  postingCheckSide = side;
  postingCheckOpener = opener;
  $("#posting-check-form").reset();
  $("#posting-check-error").hidden = true;
  $("#posting-check-title").textContent = "AP receipt / GL check";
  $("#posting-check-journal").textContent = `Monthly external ID: ${journalIdForSide(result, side)}`;
  const currentCheck = getPostingAvailability(result, side).allowed ? result.postingChecks?.[side] : null;
  $("#posting-check-summary").hidden = !currentCheck;
  $("#posting-check-form").hidden = Boolean(currentCheck);
  $("#posting-check-existing").textContent = currentCheck
    ? "A check is recorded for this AP journal. You can download the AP CSV again without rechecking."
    : "No current check is recorded for this AP journal.";
  if (currentCheck) {
    $("#posting-check-summary-name").textContent = currentCheck.reviewer;
    $("#posting-check-summary-time").textContent = `${formatOutputDate(currentCheck.checkedAt.slice(0, 10))} ${currentCheck.checkedAt.slice(11, 19)} UTC`;
    $("#posting-check-summary-evidence").textContent = currentCheck.evidence;
  }
  $("#posting-check").showModal();
  $("#posting-check-title").focus();
}
$("#check-ap-export").addEventListener("click", event => openPostingCheck("AP", event.currentTarget));
$("#recheck-posting-check").addEventListener("click", () => {
  $("#posting-check-summary").hidden = true;
  $("#posting-check-form").hidden = false;
  $("#posting-check-existing").textContent = "Record a new check to replace the current one. Until then, the current check remains valid.";
  $("#posting-check-name").focus();
});
$("#posting-check-form").addEventListener("submit", event => {
  event.preventDefault();
  try {
    recordPostingCheck(result, postingCheckSide, {
      reviewer: $("#posting-check-name").value,
      evidence: $("#posting-check-evidence").value,
      apGlNotRecorded: $("#posting-check-gl").checked,
    });
    $("#posting-check").close();
    render();
  } catch (error) {
    $("#posting-check-error").textContent = error.message;
    $("#posting-check-error").hidden = false;
  }
});
$("#revoke-posting-check").addEventListener("click", () => {
  revokePostingCheck(result, postingCheckSide);
  $("#posting-check").close();
  render();
});
$("#close-posting-check").addEventListener("click", () => $("#posting-check").close());
$("#posting-check").addEventListener("close", () => postingCheckOpener?.focus());
for (const key of Object.keys(filters)) {
  $(`#filter-${key}`).addEventListener(key === "counterparty" ? "input" : "change", event => { filters[key] = event.target.value; accrualPage = 1; render(); });
}
$("#clear-filters").addEventListener("click", () => {
  accrualPage = 1;
  for (const key of Object.keys(filters)) { filters[key] = ""; $(`#filter-${key}`).value = ""; }
  render();
});
for (const [id, change] of [["accrual-prev", -1], ["accrual-next", 1]]) {
  $(`#${id}`).addEventListener("click", () => {
    accrualPage += change;
    render();
    // If the last Next button became disabled, retain keyboard focus on Previous.
    ($(`#${id}`).disabled ? $(change > 0 ? "#accrual-prev" : "#accrual-next") : $(`#${id}`)).focus();
  });
}
$("#accrual-page-select").addEventListener("change", event => {
  accrualPage = Number(event.target.value);
  render();
  $("#accrual-page-select").focus();
});
$("#close-detail").addEventListener("click", closeDetail);
$("#overlay").addEventListener("click", closeDetail);
// A native modal keeps focus inside the help and makes the background inert.
let helpOpener = null;
document.querySelectorAll("[data-help]").forEach(button => button.addEventListener("click", () => {
  helpOpener = button;
  const isStatus = button.dataset.help === "status";
  $("#column-help-title").textContent = isStatus ? "Status & Review calculation" : "Handler values";
  $("#handler-help").hidden = isStatus;
  $("#status-help").hidden = !isStatus;
  $("#column-help").showModal();
  $("#column-help").scrollTop = 0;
  $("#column-help-title").focus();
}));
$("#close-help").addEventListener("click", () => $("#column-help").close());
$("#column-help").addEventListener("close", () => helpOpener?.focus());
$("#column-help").addEventListener("keydown", event => {
  if (event.key === "Escape") event.stopPropagation();
});
let controlsHelpOpener = null;
function openControlsHelp(opener) {
  controlsHelpOpener = opener;
  $("#controls-help").showModal();
  $("#controls-help").scrollTop = 0;
  $("#controls-help-title").focus();
}
$("#import-info").addEventListener("click", event => openControlsHelp(event.currentTarget));
$("#nav-controls").addEventListener("click", event => {
  if (window.matchMedia("(max-width: 680px)").matches) setSidebar(true);
  openControlsHelp(event.currentTarget);
});
$("#close-controls-help").addEventListener("click", () => $("#controls-help").close());
$("#controls-help").addEventListener("close", () => controlsHelpOpener?.focus());
$("#controls-help").addEventListener("keydown", event => {
  if (event.key === "Escape") event.stopPropagation();
});
$("#file-input").addEventListener("change", async (event) => {
  const file = event.target.files[0];
  if (!file) return;
  try {
    await importWorkbook(file);
  } catch (error) {
    $("#import-error").textContent = error.message;
    $("#import-error").hidden = false;
  } finally {
    // Permit selecting the same corrected file again without a page refresh.
    event.target.value = "";
  }
});

// A display preference only; this is not an accounting or posting ledger.
let sidebarCollapsed = window.matchMedia("(max-width: 900px)").matches;
try {
  const preference = localStorage.getItem("helix.sidebar.collapsed");
  if (preference !== null) sidebarCollapsed = preference === "true";
} catch { /* The navigation remains usable when storage is unavailable. */ }
function setSidebar(collapsed) {
  sidebarCollapsed = collapsed;
  document.body.classList.toggle("sidebar-collapsed", collapsed);
  const label = collapsed ? "Expand sidebar" : "Collapse sidebar";
  $("#sidebar-toggle").setAttribute("aria-expanded", String(!collapsed));
  $("#sidebar-toggle").setAttribute("aria-label", label);
  $("#sidebar-toggle").title = label;
  $("#toggle-icon").textContent = collapsed ? "»" : "«";
  try { localStorage.setItem("helix.sidebar.collapsed", String(collapsed)); } catch { /* Optional preference. */ }
}
$("#sidebar-toggle").addEventListener("click", () => setSidebar(!sidebarCollapsed));
function updateNavigation() {
  const current = location.hash || "#workspace";
  document.querySelectorAll("#sidebar-nav a").forEach(link => {
    const active = link.getAttribute("href") === current;
    link.classList.toggle("active", active);
    if (active) link.setAttribute("aria-current", "location");
    else link.removeAttribute("aria-current");
  });
}
document.querySelectorAll("#sidebar-nav a").forEach(link => link.addEventListener("click", () => {
  if (window.matchMedia("(max-width: 680px)").matches) setSidebar(true);
}));
window.addEventListener("hashchange", updateNavigation);
document.addEventListener("keydown", event => {
  if (event.key === "Tab" && selectedId) {
    const controls = [...$("#detail-panel").querySelectorAll('button, input, textarea, select, summary, [tabindex="0"]')].filter(element => !element.disabled && !element.hidden && element.getClientRects().length);
    const first = controls[0], last = controls[controls.length - 1];
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  }
  if (event.key === "Escape") {
    closeDetail();
    if (window.matchMedia("(max-width: 680px)").matches) setSidebar(true);
  }
});
setSidebar(sidebarCollapsed);
updateNavigation();
updatePeriodDisplay();
clearImportedResult();
