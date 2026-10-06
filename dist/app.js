import { anchorData } from "./anchor-data.js";
import { AccrualEngine, toJournalCsv, validateDataset, formatOutputDate, getExportAvailability } from "./engine.js";
import { filterAccruals, reviewAccrual } from "./review.js";

const engine = new AccrualEngine();
let data = anchorData;
let result;
let selectedId = null;
let datasetName = "Anchor dataset";
const filters = { side: "", counterparty: "", status: "", handler: "" };

const money = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });
const number = new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 });
const $ = (selector) => document.querySelector(selector);

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>'"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[char]);
}

function runClose() {
  result = engine.run(data, { closeDate: "2026-03-31", reversalDate: "2026-04-01" });
  selectedId = null;
  $("#detail-panel").classList.remove("open");
  $("#overlay").classList.remove("show");
  $("#detail-panel").inert = true;
  $("main").inert = false;
  $("#sidebar").inert = false;
  $("#run-state").textContent = "Calculation complete — no entries posted";
  $("#dataset-name").textContent = datasetName;
  $("#import-error").hidden = true;
  render();
}

function render() {
  $("#ar-total").textContent = money.format(result.totals.ar);
  $("#ap-total").textContent = money.format(result.totals.ap);
  $("#ready-total").textContent = result.totals.ready;
  $("#review-total").textContent = result.totals.review;
  $("#nav-review").textContent = result.totals.review;
  $("#ar-caption").textContent = `${result.accruals.filter(item => item.side === "AR").length} customer / SKU accruals`;
  $("#ap-caption").textContent = `${result.accruals.filter(item => item.side === "AP").length} uninvoiced receipt accrual(s)`;
  $("#balance-state").textContent = result.control.balanced ? "Balanced" : "Out of balance";
  $("#balance-state").className = result.control.balanced ? "control good" : "control bad";
  const visible = filterAccruals(result.accruals, filters);
  $("#accrual-count").textContent = `${visible.length} of ${result.accruals.length} accruals`;
  for (const side of ["AR", "AP"]) {
    const state = getExportAvailability(result.journalLines, side);
    const key = side.toLowerCase();
    $(`#export-${key}-csv`).disabled = !state.allowed;
    $(`#export-${key}-csv`).title = state.reason;
    $(`#export-${key}-reason`).textContent = state.reason;
  }

  $("#accrual-body").innerHTML = visible.length ? visible.map((item) => `
    <tr data-id="${escapeHtml(item.id)}" class="${selectedId === item.id ? "selected" : ""}">
      <td><span class="side ${item.side.toLowerCase()}">${item.side}</span></td>
      <td><strong>${escapeHtml(item.counterparty)}</strong><small>${escapeHtml(item.description)}</small></td>
      <td><span class="handler">${item.handler === "AR_USAGE" ? "Usage accrual" : "GR not invoiced"}</span></td>
      <td class="amount">${money.format(item.amountUsd)}${item.transactionCurrency !== "USD" ? `<small>${number.format(item.transactionAmount)} ${item.transactionCurrency} @ ${item.fx}</small>` : ""}</td>
      <td><span class="status ${item.status.toLowerCase()}">${item.status}</span></td>
      <td><button class="row-open" aria-label="Open ${escapeHtml(item.counterparty)} details">View →</button></td>
    </tr>`).join("") : `<tr><td colspan="6" class="empty">No accruals match these filters. Clear filters to see all accruals.</td></tr>`;

  document.querySelectorAll("#accrual-body tr[data-id]").forEach((row) => row.addEventListener("click", () => openDetail(row.dataset.id)));
  renderReview();
}

function reviewSection(item) {
  if (item.reviewBlocked) return `<section class="review-decision"><h3>Correct source data to continue</h3><p>This amount is provisional. Fix the invoice references, dates, status, or allocated amounts described above, then import the corrected workbook. Mark Ready is unavailable until the matching issues are resolved. AP download remains locked, including for a zero-dollar exception.</p></section>`;
  if (item.status !== "REVIEW" && !item.review) return "";
  const approved = item.status === "READY" && item.review;
  const history = (result.reviewLog || []).filter(event => event.accrualId === item.id);
  return `<section class="review-decision"><h3>${approved ? "Review recorded" : "Complete review"}</h3>
    <p>Check the source records, quantity, rate, and amount before marking Ready. This does not post the journal.</p>
    ${approved ? `<p class="review-approved">Ready — reviewed by ${escapeHtml(item.review.reviewer)} on ${formatOutputDate(item.review.reviewedAt.slice(0,10))} at ${item.review.reviewedAt.slice(11,19)} UTC.<br>${escapeHtml(item.review.note)}</p>` : ""}
    <form id="review-form">
      <label for="reviewer-name">Reviewer name</label><input id="reviewer-name" name="reviewer" required maxlength="100" autocomplete="name" />
      <label for="review-note">${approved ? "Reason for reopening" : "Review note / evidence reference"}</label><textarea id="review-note" name="note" required maxlength="1000" rows="3"></textarea>
      <label class="review-confirm"><input id="review-confirm" type="checkbox" required />I checked the source records and amount.</label>
      <p id="review-error" role="alert" hidden></p>
      <button class="review-submit" type="submit">${approved ? "Reopen review" : "Mark Ready"}</button>
    </form>
    <p class="session-note">Current run only. Refresh, Run close, or a new workbook import resets approvals. Names are self-entered, not verified identities.</p>
    ${history.length ? `<details><summary>Review history for this run (${history.length})</summary><ul>${history.map(event => `<li>${event.action === "approve" ? "Marked Ready" : "Reopened"} by ${escapeHtml(event.reviewer)} · ${formatOutputDate(event.reviewedAt.slice(0,10))} ${event.reviewedAt.slice(11,19)} UTC — ${escapeHtml(event.note)}</li>`).join("")}</ul></details>` : ""}
  </section>`;
}

function renderReview() {
  const reviews = result.accruals.filter((item) => item.status === "REVIEW");
  $("#review-list").innerHTML = reviews.length ? reviews.map((item) => `
    <button class="review-card" data-id="${escapeHtml(item.id)}">
      <span class="review-icon">!</span>
      <span><strong>${item.side === "AP" ? "Invoice matching" : "Usage spike"} · ${escapeHtml(item.counterparty)}</strong><small>${item.side === "AP" ? escapeHtml(item.reviewReasons.join(" ")) : `${escapeHtml(item.anomaly.event_id)} recorded ${number.format(item.anomaly.quantity)} units vs ${number.format(item.anomaly.baseline)} baseline. Actual usage remains in the accrual.`}</small></span>
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
    ${item.matching ? `<section><h3>Receipt-to-invoice calculation</h3><p>Receipt value ${money.format(item.matching.receiptValueUsd)} − matched invoices through ${formatOutputDate(result.closeDate)} ${money.format(item.matching.matchedInvoiceUsd)} = ${money.format(item.amountUsd)}${item.reviewBlocked ? " (provisional; negative residuals are shown as zero)" : " uninvoiced"}.</p><p>Invoice-date cutoff only. Existing GL postings have not been checked.</p>${item.reviewBlocked ? `<div class="callout"><strong>Matching issues — source correction required</strong><ul>${item.reviewReasons.map(reason => `<li>${escapeHtml(reason)}</li>`).join("")}</ul></div>` : ""}</section>` : ""}
    ${reviewSection(item)}
    <h3>Journal preview</h3>
    <div class="mini-table">${item.lines.map((line) => `<div><span>${escapeHtml(line.line_type)} · ${line.account}</span><span>${line.debit_usd ? `Dr ${money.format(line.debit_usd)}` : `Cr ${money.format(line.credit_usd)}`}</span><small class="audit-line">Line ID: ${escapeHtml(line.line_id)}</small></div>`).join("")}</div>
    <h3>Source payload</h3>
    <pre>${escapeHtml(JSON.stringify(item.sourceDetail, null, 2))}</pre>`;
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
  try { csv = toJournalCsv(result.journalLines, side); } catch (error) {
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
}

async function importWorkbook(file) {
  if (!window.XLSX) throw new Error("The workbook parser did not load. Check your network connection and try again.");
  const workbook = window.XLSX.read(await file.arrayBuffer(), { type: "array", cellDates: true });
  const sheets = {};
  for (const name of workbook.SheetNames) {
    sheets[name] = window.XLSX.utils.sheet_to_json(workbook.Sheets[name], { defval: "", raw: true });
  }
  validateDataset(sheets);
  engine.run(sheets, { closeDate: "2026-03-31", reversalDate: "2026-04-01" });
  data = sheets;
  datasetName = file.name;
  runClose();
}

$("#run-close").addEventListener("click", () => {
  try { runClose(); } catch (error) {
    $("#import-error").textContent = error.message;
    $("#import-error").hidden = false;
  }
});
$("#export-ar-csv").addEventListener("click", () => downloadCsv("AR"));
$("#export-ap-csv").addEventListener("click", () => downloadCsv("AP"));
for (const key of Object.keys(filters)) {
  $(`#filter-${key}`).addEventListener(key === "counterparty" ? "input" : "change", event => { filters[key] = event.target.value; render(); });
}
$("#clear-filters").addEventListener("click", () => {
  for (const key of Object.keys(filters)) { filters[key] = ""; $(`#filter-${key}`).value = ""; }
  render();
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
$("#file-input").addEventListener("change", async (event) => {
  const file = event.target.files[0];
  if (!file) return;
  try {
    await importWorkbook(file);
  } catch (error) {
    $("#import-error").textContent = error.message;
    $("#import-error").hidden = false;
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
    const controls = [...$("#detail-panel").querySelectorAll('button, input, textarea, select, summary, [tabindex="0"]')].filter(element => !element.disabled && !element.hidden);
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
runClose();
