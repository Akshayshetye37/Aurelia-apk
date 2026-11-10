import { z } from "zod";

const stableId = z.union([
  z.string().min(1).max(180).refine(value => value.trim().length > 0 && !/[\u0000-\u001f]/.test(value), "ID must be non-empty and contain no control characters"),
  z.number().int().safe()
]);
const base = z.object({ id: stableId.optional() }).passthrough();

const booking = base.superRefine((row, context) => {
  if (row.st !== undefined && !["res", "in", "done", "cancelled", "checkedin", "checked-in", "checked_in"].includes(row.st)) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["st"], message: "unsupported booking lifecycle state" });
  }
  if (row.status !== undefined && !["reserved", "confirmed", "checked_in", "checked_out", "cancelled"].includes(row.status)) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["status"], message: "unsupported booking lifecycle state" });
  }
});
const room = base.superRefine((row, context) => {
  if (row.s !== undefined && !["ready", "occ", "clean", "out", "maintenance"].includes(row.s)) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["s"], message: "unsupported room lifecycle state" });
  }
});

const inventory = base.superRefine((row, context) => {
  for (const field of ["q", "ro"]) {
    if (row[field] !== undefined && (!Number.isSafeInteger(Number(row[field])) || Number(row[field]) < 0)) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: [field], message: field + " must be a non-negative integer" });
    }
  }
  for (const field of ["u", "price"]) {
    if (row[field] !== undefined && (!Number.isFinite(Number(row[field])) || Number(row[field]) < 0 ||
        Math.abs(Number(row[field]) * 100 - Math.round(Number(row[field]) * 100)) > 1e-7)) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: [field], message: field + " must be a non-negative amount with at most two decimals" });
    }
  }
});

const schemas = {
  booking,
  folio: base,
  guest: base,
  room,
  room_block: base,
  inventory,
  expense: base,
  ledger: base,
  restaurant_table: base,
  restaurant_sale: base,
  settings: base,
  audit: base
};

export const PMS_DOMAIN_SCHEMAS = Object.freeze(schemas);
export const PMS_IMMUTABLE_ENTITY_TYPES = Object.freeze(new Set(["ledger", "audit"]));

export function validatePmsDomainEntity(entityType, value) {
  const schema = PMS_DOMAIN_SCHEMAS[entityType];
  if (!schema) throw new TypeError("Unsupported PMS entity type: " + entityType);
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    const error = new TypeError("Invalid " + entityType + " entity: " + parsed.error.issues.map(issue =>
      (issue.path.join(".") || "entity") + " " + issue.message
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
    if (from === undefined || to === undefined || !transitions[from]?.includes(to)) {
      const error = new Error("Invalid " + entityType + " state transition for " + field + ": " + String(from) + " -> " + String(to));
      error.code = "PMS_INVALID_STATE_TRANSITION";
      error.entityType = entityType;
      error.field = field;
      throw error;
    }
  }
  return true;
}
