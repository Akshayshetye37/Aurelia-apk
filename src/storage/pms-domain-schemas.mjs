const stableId = value =>
  (typeof value === "string" && value.length > 0 && value.length <= 180 &&
   value.trim().length > 0 && !/[\u0000-\u001f]/.test(value)) ||
  (typeof value === "number" && Number.isSafeInteger(value));

const isRecord = value => value !== null && typeof value === "object" && !Array.isArray(value);
const issue = (path, message) => ({ code: "custom", path, message });

function validateBase(row, issues) {
  if (!isRecord(row)) {
    issues.push(issue([], "entity must be an object"));
    return;
  }
  if (row.id !== undefined && !stableId(row.id)) {
    issues.push(issue(["id"], "ID must be non-empty, safe, and contain no control characters"));
  }
}

function validateBooking(row, issues) {
  validateBase(row, issues);
  if (!isRecord(row)) return;
  if (row.st !== undefined && !["res", "in", "done", "cancelled", "checkedin", "checked-in", "checked_in"].includes(row.st)) {
    issues.push(issue(["st"], "unsupported booking lifecycle state"));
  }
  if (row.status !== undefined && !["reserved", "confirmed", "checked_in", "checked_out", "cancelled"].includes(row.status)) {
    issues.push(issue(["status"], "unsupported booking lifecycle state"));
  }
}

function validateRoom(row, issues) {
  validateBase(row, issues);
  if (!isRecord(row)) return;
  if (row.s !== undefined && !["ready", "occ", "clean", "out", "maintenance"].includes(row.s)) {
    issues.push(issue(["s"], "unsupported room lifecycle state"));
  }
}

function validateInventory(row, issues) {
  validateBase(row, issues);
  if (!isRecord(row)) return;
  for (const field of ["q", "ro"]) {
    if (row[field] !== undefined && (!Number.isSafeInteger(Number(row[field])) || Number(row[field]) < 0)) {
      issues.push(issue([field], field + " must be a non-negative integer"));
    }
  }
  for (const field of ["u", "price"]) {
    if (row[field] !== undefined && (!Number.isFinite(Number(row[field])) || Number(row[field]) < 0 ||
        Math.abs(Number(row[field]) * 100 - Math.round(Number(row[field]) * 100)) > 1e-7)) {
      issues.push(issue([field], field + " must be a non-negative amount with at most two decimals"));
    }
  }
}

function validateFolioSequence(row, issues) {
  validateBase(row, issues);
  if (!isRecord(row)) return;
  if (typeof row.financialYear !== "string" || !/^FY[0-9]{4}-[0-9]{2}$/.test(row.financialYear)) {
    issues.push(issue(["financialYear"], "invalid financial year"));
  }
  if (!Number.isSafeInteger(row.nextNumber) || row.nextNumber < 1) {
    issues.push(issue(["nextNumber"], "nextNumber must be a positive safe integer"));
  }
}

const validators = {
  booking: validateBooking,
  folio: validateBase,
  guest: validateBase,
  room: validateRoom,
  room_block: validateBase,
  inventory: validateInventory,
  expense: validateBase,
  ledger: validateBase,
  restaurant_table: validateBase,
  restaurant_sale: validateBase,
  settings: validateBase,
  audit: validateBase,
  folio_sequence: validateFolioSequence
};

const schemas = Object.fromEntries(Object.entries(validators).map(([type, validate]) => [
  type,
  Object.freeze({
    safeParse(value) {
      const issues = [];
      validate(value, issues);
      return issues.length
        ? { success: false, error: { issues } }
        : { success: true, data: value };
    }
  })
]));

export const PMS_DOMAIN_SCHEMAS = Object.freeze(schemas);
export const PMS_IMMUTABLE_ENTITY_TYPES = Object.freeze(new Set(["ledger", "audit"]));

export function validatePmsDomainEntity(entityType, value) {
  const schema = PMS_DOMAIN_SCHEMAS[entityType];
  if (!schema) throw new TypeError("Unsupported PMS entity type: " + entityType);
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    const error = new TypeError("Invalid " + entityType + " entity: " + parsed.error.issues.map(item =>
      (item.path.join(".") || "entity") + " " + item.message
    ).join("; "));
    error.code = "PMS_DOMAIN_VALIDATION_FAILED";
    error.issues = parsed.error.issues;
    throw error;
  }
  return parsed.data;
}

const TRANSITIONS = Object.freeze({
  booking: Object.freeze({
    st: Object.freeze({ res: ["in", "done", "cancelled"], in: ["done"], checkedin: ["done"], "checked-in": ["done"], checked_in: ["done"], done: [], cancelled: [] }),
    status: Object.freeze({ reserved: ["confirmed", "cancelled"], confirmed: ["checked_in", "cancelled"], checked_in: ["checked_out"], checked_out: [], cancelled: [] })
  }),
  room: Object.freeze({
    s: Object.freeze({ ready: ["occ", "clean", "out", "maintenance"], occ: ["clean", "out", "maintenance"], clean: ["ready", "out", "maintenance"], out: ["ready", "maintenance"], maintenance: ["ready", "out"] })
  })
});

export const PMS_STATE_TRANSITIONS = TRANSITIONS;

export function assertPmsStateTransition(entityType, previous, next) {
  const domains = TRANSITIONS[entityType];
  if (!domains || !previous) return true;
  for (const [field, transitions] of Object.entries(domains)) {
    const from = previous[field], to = next?.[field];
    if (from === to) continue;
    if (from === undefined && to === undefined) continue;
    if (from === undefined && to !== undefined && Object.prototype.hasOwnProperty.call(transitions, to)) continue;
    if (to === undefined || !transitions[from]?.includes(to)) {
      const error = new Error("Invalid " + entityType + " state transition for " + field + ": " + String(from) + " -> " + String(to));
      error.code = "PMS_INVALID_STATE_TRANSITION";
      error.entityType = entityType;
      error.field = field;
      throw error;
    }
  }
  return true;
}
