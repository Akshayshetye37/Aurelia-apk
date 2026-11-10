import { z } from "zod";

const stableId = z.string().trim().min(1).max(180).refine(value => !/[\u0000-\u001f]/.test(value), "ID contains control characters");
const base = z.object({ id: stableId }).passthrough();

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
  booking: base,
  folio: base,
  guest: base,
  room: base,
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
