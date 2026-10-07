import test from "node:test";
import assert from "node:assert/strict";
import { AccrualEngine, HandlerRegistry, ReceiptAccrualHandler, UsageAccrualHandler, getExportAvailability, toJournalCsv } from "../dist/engine.js";
import { makeAccrualLines } from "../dist/handler-kit.js";
import { anchorData } from "../dist/anchor-data.js";

// A third handler lives outside the engine. It uses only the public plugin contract.
class ExampleSubscriptionHandler {
  key = "AP_SUBSCRIPTION";
  side = "AP";
  label = "Subscription accrual";
  help = "Accrues each unpaid monthly subscription contract.";
  requiredSheets = ["subscription_contracts"];

  calculate(sheets, context) {
    return sheets.subscription_contracts.map(contract => {
      const id = `HELIX-${context.closeDate}-AP-SUB-${contract.contract_id}`;
      const amount = contract.monthly_amount_usd;
      const sourceRef = contract.contract_id;
      return {
        id,
        handler: this.key,
        side: this.side,
        counterparty: contract.vendor_name,
        source: sourceRef,
        description: "Uninvoiced monthly subscription",
        amountUsd: amount,
        transactionAmount: amount,
        transactionCurrency: "USD",
        fx: 1,
        status: "READY",
        sourceDetail: contract,
        lines: makeAccrualLines({ id, side: this.side, handler: this.key, closeDate: context.closeDate, reversalDate: context.reversalDate, debit: "6150", credit: "2150", amount, currencyAmount: amount, currency: "USD", fx: 1, memo: "Subscription accrual", sourceRef, status: "READY" }),
      };
    });
  }
}

const withSubscription = () => ({
  ...structuredClone(anchorData),
  subscription_contracts: [{ contract_id: "SUB-1", vendor_name: "Example Vendor", monthly_amount_usd: 50 }],
});

test("a third registered AP handler runs automatically and joins the AP monthly CSV", () => {
  const registry = new HandlerRegistry([new UsageAccrualHandler(), new ReceiptAccrualHandler()]);
  registry.register(new ExampleSubscriptionHandler());
  const result = new AccrualEngine(registry).run(withSubscription());
  assert.equal(result.totals.ar, 362.5);
  assert.equal(result.totals.ap, 100050);
  assert.equal(result.control.balanced, true);
  assert.deepEqual(result.handlerDefinitions.map(handler => handler.key), ["AR_USAGE", "AP_GRNI", "AP_SUBSCRIPTION"]);
  assert.equal(result.handlerDefinitions[2].label, "Subscription accrual");
  const ap = result.journalLines.filter(line => line.side === "AP");
  assert.equal(ap.length, 4);
  assert.deepEqual([...new Set(ap.map(line => line.external_id))], ["HELIX-2026-03-AP"]);
  assert.match(toJournalCsv(result.journalLines, "AP"), /AP_SUBSCRIPTION/);
  assert.equal(getExportAvailability(result.journalLines, "AP").allowed, true);
});

test("a selected plugin validates only its own sheets", () => {
  const engine = new AccrualEngine([new UsageAccrualHandler(), new ExampleSubscriptionHandler()]);
  const sheets = { subscription_contracts: [{ contract_id: "SUB-1", vendor_name: "Example Vendor", monthly_amount_usd: 50 }] };
  const result = engine.run(sheets, { handlers: ["AP_SUBSCRIPTION"] });
  assert.equal(result.totals.ap, 50);
  assert.deepEqual(result.handlerDefinitions.map(handler => handler.key), ["AP_SUBSCRIPTION"]);
  assert.throws(() => engine.run({}, { handlers: ["AP_SUBSCRIPTION"] }), /Missing required sheets: subscription_contracts/);
  assert.throws(() => engine.run(sheets, { handlers: ["UNKNOWN"] }), /No handler registered/);
});

test("registry rejects duplicate or incomplete plugins", () => {
  const registry = new HandlerRegistry([new ExampleSubscriptionHandler()]);
  assert.throws(() => registry.register(new ExampleSubscriptionHandler()), /Duplicate handler key/);
  assert.throws(() => registry.register({ key: "BAD", calculate() { return []; } }), /Invalid handler plugin/);
});

test("plugin result contract rejects wrong side and unbalanced lines", () => {
  const bad = new ExampleSubscriptionHandler();
  const original = bad.calculate.bind(bad);
  bad.calculate = (sheets, context) => {
    const items = original(sheets, context);
    items[0].lines[0].debit_usd = 49;
    return items;
  };
  assert.throws(() => new AccrualEngine([bad]).run(withSubscription()), /Unbalanced accrual/);
  bad.calculate = (sheets, context) => {
    const items = original(sheets, context);
    items[0].side = "AR";
    return items;
  };
  assert.throws(() => new AccrualEngine([bad]).run(withSubscription()), /Invalid accrual/);
});

test("an unresolved review in a new AP handler locks the whole AP export", () => {
  const handler = new ExampleSubscriptionHandler();
  const original = handler.calculate.bind(handler);
  handler.calculate = (sheets, context) => original(sheets, context).map(item => ({
    ...item,
    status: "REVIEW",
    reviewTitle: "Subscription evidence",
    reviewSummary: "Confirm the March invoice has not arrived.",
    lines: item.lines.map(line => ({ ...line, review_status: "REVIEW" })),
  }));
  const result = new AccrualEngine([new ReceiptAccrualHandler(), handler]).run(withSubscription());
  assert.equal(getExportAvailability(result.journalLines, "AP").allowed, false);
  assert.throws(() => toJournalCsv(result.journalLines, "AP"), /download locked/);
});
