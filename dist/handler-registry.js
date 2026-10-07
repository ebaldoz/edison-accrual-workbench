// A handler is a module with key, side, label, requiredSheets, and calculate().
// Registering it is the only routing change needed for a new accrual type.
export class HandlerRegistry {
  constructor(handlers = []) {
    this.handlers = new Map();
    handlers.forEach(handler => this.register(handler));
  }

  register(handler) {
    if (!handler || typeof handler.key !== "string" || !handler.key.trim() ||
      !["AR", "AP"].includes(handler.side) || typeof handler.label !== "string" || !handler.label.trim() ||
      !Array.isArray(handler.requiredSheets) || handler.requiredSheets.some(name => typeof name !== "string" || !name.trim()) ||
      typeof handler.calculate !== "function") {
      throw new Error("Invalid handler plugin: expected key, AR/AP side, label, requiredSheets, and calculate().");
    }
    if (this.handlers.has(handler.key)) throw new Error(`Duplicate handler key: ${handler.key}`);
    this.handlers.set(handler.key, handler);
    return this;
  }

  select(keys) {
    const selected = keys ?? [...this.handlers.keys()];
    if (!Array.isArray(selected) || !selected.length || new Set(selected).size !== selected.length) {
      throw new Error("Choose one or more distinct handlers.");
    }
    return selected.map(key => {
      const handler = this.handlers.get(key);
      if (!handler) throw new Error(`No handler registered for ${key}`);
      return handler;
    });
  }

  definitions(handlers = [...this.handlers.values()]) {
    return handlers.map(({ key, side, label, help }) => ({ key, side, label, help: help || "" }));
  }
}
