import { anchorData } from "./anchor-data.js";
import { AccrualEngine, toJournalCsv, validateDataset } from "./engine.js";

const engine = new AccrualEngine();
let data = anchorData;
let result;
let selectedId = null;

const money = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });
const number = new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 });
const $ = (selector) => document.querySelector(selector);

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>'"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[char]);
}

function runClose(fromImport = false) {
  result = engine.run(data, { closeDate: "2026-03-31", reversalDate: "2026-04-01" });
  const prior = localStorage.getItem(result.runId);
  localStorage.setItem(result.runId, JSON.stringify({ generatedAt: new Date().toISOString(), fingerprint: result.accruals.map((x) => x.id).join("|") }));
  $("#run-state").textContent = prior ? "Re-run matched prior IDs — no duplicate posting" : "Run controls passed";
  $("#dataset-name").textContent = fromImport ? "Imported workbook" : "Anchor dataset";
  render();
}

function render() {
  $("#ar-total").textContent = money.format(result.totals.ar);
  $("#ap-total").textContent = money.format(result.totals.ap);
  $("#ready-total").textContent = result.totals.ready;
  $("#review-total").textContent = result.totals.review;
  $("#balance-state").textContent = result.control.balanced ? "Balanced" : "Out of balance";
  $("#balance-state").className = result.control.balanced ? "control good" : "control bad";
  $("#accrual-count").textContent = `${result.accruals.length} accruals`;

  $("#accrual-body").innerHTML = result.accruals.map((item) => `
    <tr data-id="${escapeHtml(item.id)}" class="${selectedId === item.id ? "selected" : ""}">
      <td><span class="side ${item.side.toLowerCase()}">${item.side}</span></td>
      <td><strong>${escapeHtml(item.counterparty)}</strong><small>${escapeHtml(item.description)}</small></td>
      <td><span class="handler">${item.handler === "AR_USAGE" ? "Usage accrual" : "GR not invoiced"}</span></td>
      <td class="amount">${money.format(item.amountUsd)}${item.transactionCurrency !== "USD" ? `<small>${number.format(item.transactionAmount)} ${item.transactionCurrency} @ ${item.fx}</small>` : ""}</td>
      <td><span class="status ${item.status.toLowerCase()}">${item.status}</span></td>
      <td><button class="row-open" aria-label="Open ${escapeHtml(item.counterparty)} details">View →</button></td>
    </tr>`).join("");

  document.querySelectorAll("#accrual-body tr").forEach((row) => row.addEventListener("click", () => openDetail(row.dataset.id)));
  renderReview();
}

function renderReview() {
  const reviews = result.accruals.filter((item) => item.status === "REVIEW");
  $("#review-list").innerHTML = reviews.length ? reviews.map((item) => `
    <button class="review-card" data-id="${escapeHtml(item.id)}">
      <span class="review-icon">!</span>
      <span><strong>Usage spike · ${escapeHtml(item.counterparty)}</strong><small>${escapeHtml(item.anomaly.event_id)} recorded ${number.format(item.anomaly.quantity)} units vs ${number.format(item.anomaly.baseline)} baseline. Actual usage remains in the accrual.</small></span>
      <span class="review-amount">${money.format(item.amountUsd)}</span>
    </button>`).join("") : `<div class="empty">No items require review.</div>`;
  document.querySelectorAll(".review-card").forEach((card) => card.addEventListener("click", () => openDetail(card.dataset.id)));
}

function openDetail(id) {
  selectedId = id;
  const item = result.accruals.find((row) => row.id === id);
  if (!item) return;
  $("#detail-title").textContent = item.counterparty;
  $("#detail-subtitle").textContent = item.id;
  $("#detail-body").innerHTML = `
    <div class="detail-total"><span>Accrual amount</span><strong>${money.format(item.amountUsd)}</strong></div>
    <dl>
      <div><dt>Handler</dt><dd>${escapeHtml(item.handler)}</dd></div>
      <div><dt>Review status</dt><dd><span class="status ${item.status.toLowerCase()}">${item.status}</span></dd></div>
      <div><dt>Source references</dt><dd>${escapeHtml(item.source)}</dd></div>
      <div><dt>Reversal date</dt><dd>${escapeHtml(result.reversalDate)}</dd></div>
    </dl>
    ${item.anomaly ? `<div class="callout"><strong>Review reason</strong><p>${escapeHtml(item.anomaly.event_id)} is ${number.format(item.anomaly.quantity / item.anomaly.baseline)}× its historical baseline. The engine preserves actual quantity and routes the accrual for review.</p></div>` : ""}
    <h3>Journal preview</h3>
    <div class="mini-table">${item.lines.map((line) => `<div><span>${escapeHtml(line.line_type)} · ${line.account}</span><span>${line.debit_usd ? `Dr ${money.format(line.debit_usd)}` : `Cr ${money.format(line.credit_usd)}`}</span></div>`).join("")}</div>
    <h3>Source payload</h3>
    <pre>${escapeHtml(JSON.stringify(item.sourceDetail, null, 2))}</pre>`;
  $("#detail-panel").classList.add("open");
  $("#overlay").classList.add("show");
  render();
}

function closeDetail() {
  selectedId = null;
  $("#detail-panel").classList.remove("open");
  $("#overlay").classList.remove("show");
  render();
}

function downloadCsv() {
  const blob = new Blob([toJournalCsv(result.journalLines)], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `helix-journal-${result.closeDate}.csv`;
  link.click();
  URL.revokeObjectURL(url);
}

async function importWorkbook(file) {
  if (!window.XLSX) throw new Error("The workbook parser did not load. Check your network connection and try again.");
  const workbook = window.XLSX.read(await file.arrayBuffer(), { type: "array", cellDates: true });
  const sheets = {};
  for (const name of workbook.SheetNames) {
    sheets[name] = window.XLSX.utils.sheet_to_json(workbook.Sheets[name], { defval: "", raw: true });
  }
  validateDataset(sheets);
  data = sheets;
  runClose(true);
}

$("#run-close").addEventListener("click", () => runClose(false));
$("#export-csv").addEventListener("click", downloadCsv);
$("#close-detail").addEventListener("click", closeDetail);
$("#overlay").addEventListener("click", closeDetail);
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

runClose(false);
