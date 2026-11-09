/**
 * Canonical expense read projection. Mutations are performed by the
 * transactional commitExpenseMutation service; this adapter makes verified
 * canonical expense records authoritative during startup hydration.
 */
const clone = value => typeof structuredClone === "function"
  ? structuredClone(value)
  : JSON.parse(JSON.stringify(value));
const expenseId = (row, index) => {
  const rawId = row?.id ?? "legacy-expense-" + index;
  if (typeof rawId !== "string" && !Number.isSafeInteger(rawId)) {
    throw new TypeError("Expense ID must be a string or safe integer.");
  }
  const id = String(rawId);
  if (!id.trim() || id.length > 180 || /[\u0000-\u001f]/.test(id)) {
    throw new TypeError("Expense requires a stable valid ID.");
  }
  return id;
};

export class PmsExpenseRepository {
  constructor({ bridge } = {}) {
    if (!bridge || typeof bridge.listEntities !== "function") {
      throw new TypeError("A bound canonical PMS repository bridge is required.");
    }
    this.bridge = bridge;
  }

  async list() {
    const rows = await this.bridge.listEntities("expense");
    if (!Array.isArray(rows)) throw new Error("Canonical expense repository returned an invalid entity list.");
    const ids = new Set();
    return rows.map(row => {
      if (!row || row.type !== "expense" || typeof row.id !== "string" ||
          !Number.isSafeInteger(row.version) || row.version < 1 ||
          !row.data || typeof row.data !== "object" || Array.isArray(row.data) ||
          String(row.data.id) !== row.id || ids.has(row.id)) {
        throw new Error("Canonical expense repository contains an invalid or duplicate entity.");
      }
      ids.add(row.id);
      return clone(row.data);
    });
  }

  async hydrateSnapshot(snapshot, { enabled = true } = {}) {
    if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot) || !Array.isArray(snapshot.exp)) {
      throw new TypeError("A complete PMS snapshot with an expense collection is required.");
    }
    const hydrated = clone(snapshot);
    if (!enabled) return hydrated;
    const canonical = await this.list();
    if (!canonical.length && hydrated.exp.length) {
      throw Object.assign(new Error("Canonical expense entities are missing for the verified migration."), {
        code: "EXPENSE_ENTITY_MISSING"
      });
    }
    const byId = new Map(canonical.map(row => [String(row.id), row]));
    const used = new Set();
    const ordered = hydrated.exp.map((row, index) => {
      const id = expenseId(row, index);
      const stored = byId.get(id);
      if (!stored) {
        throw Object.assign(new Error("Canonical expense " + id + " is missing; recovery is required."), {
          code: "EXPENSE_ENTITY_MISSING", expenseId: id
        });
      }
      used.add(id);
      return clone(stored);
    });
    for (const row of canonical) if (!used.has(String(row.id))) ordered.push(clone(row));
    hydrated.exp = ordered;
    return hydrated;
  }
}
