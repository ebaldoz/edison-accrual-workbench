// To enable another handler in the browser, import it here and add one instance.
import { UsageAccrualHandler } from "./usage.js?v=20261008-ar-cutoff";
import { ReceiptAccrualHandler } from "./receipt.js";

export const defaultHandlers = [new UsageAccrualHandler(), new ReceiptAccrualHandler()];
