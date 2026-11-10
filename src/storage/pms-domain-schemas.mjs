import { z } from "zod";

const stableId = z.union([
  z.string().min(1).max(180).refine(value => value.trim().length > 0 && !/[\u0000-\u001f]/.test(value), "ID must be non-empty and contain no control characters"),
  z.number().int().safe()
]);
const base = z.object({ id: stableId.optional() }).passthrough();

const amountMajor = z.unknown().optional();
const booking = z.object({
  id: stableId,
  g: z.string().trim().min(1).max(180),
  room: z.union([z.string().trim().min(1).max(80), z.number().int().safe()]),
  in: z.number().int().safe(),
  out: z.number().int().safe(),
  st: z.enum(["res", "in", "done", "cancelled", "checkedin", "checked-in", "checked_in"]),
  rate: amountMajor,
  p: amountMajor,
  ch: z.array(z.unknown()).optional(),
  pays: z.array(z.unknown()).optional(),
  folioId: z.string().min(1).max(180).optional(),
  checkInTime: z.string().regex(/^([01]\\d|2[0-3]):[0-5]\\d$/).optional(),
  checkOutTime: z.string().regex(/^([01]\\d|2[0-3]):[0-5]\\d$/).optional(),
  scheduledCheckIn: z.string().max(40).optional(),
  scheduledCheckOut: z.string().max(40).optional(),
  actualCheckInAt: z.string().max(40).optional(),
  actualCheckInDate: z.string().max(20).optional(),
  actualCheckOutAt: z.string().max(40).optional(),
  actualCheckOutDate: z.string().max(20).optional(),
  gatewayPayments: z.array(z.record(z.unknown())).optional(),
  oc: z.array(z.record(z.unknown())).optional(),
  veh: z.array(z.record(z.unknown())).optional(),
  img: z.string().max(20_000_000).optional(),
  imgKey: z.string().max(180).optional(),
  demo: z.boolean().optional(),
  bookedAt: z.string().max(40).optional(),
  createdAt: z.string().max(40).optional(),
  updatedAt: z.string().max(40).optional(),
  cancelledAt: z.string().max(40).optional(),
  cancelledStatus: z.string().max(80).optional(),
  cancellationAccountingCommitted: z.boolean().optional(),
  refundStatus: z.string().max(80).optional(),
  refundRecordedAt: z.string().max(40).optional(),
  refundPayableJournalRecorded: z.boolean().optional(),
  refund_amount: amountMajor,
  refund_date: z.string().max(40).optional(),
  refund_settlement_confirmed: z.boolean().optional(),
  refund_transaction_reference: z.string().max(180).optional(),
  retentionJournalRecorded: z.boolean().optional(),
  retention_fee_retained: amountMajor,
  original_amount_paid: amountMajor,
  paymentSnapshot: z.unknown().optional(),
  dc: z.unknown().optional(),
  protectedNew: z.boolean().optional(),
  retired: z.boolean().optional(),
  retiredAt: z.string().max(40).optional()
}).strict().superRefine((row, context) => {
  if (row.out <= row.in) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["out"], message: "check-out offset must be after check-in offset" });
  }
});
const guest = z.object({
  id: stableId.optional(),
  n: z.string().trim().min(1).max(180),
  ph: z.string().max(80).optional(),
  em: z.string().max(254).optional(),
  idt: z.string().max(80).optional(),
  idn: z.string().max(160).optional(),
  occ: z.array(z.object({
    n: z.string().max(180).optional(),
    dob: z.string().max(32).optional(),
    rel: z.string().max(80).optional()
  }).strict()).optional(),
  veh: z.array(z.object({
    reg: z.string().max(40).optional(),
    ty: z.string().max(80).optional()
  }).strict()).optional(),
  img: z.string().max(20_000_000).optional(),
  imgKey: z.string().max(180).optional(),
  demo: z.boolean().optional(),
  retired: z.boolean().optional(),
  retiredAt: z.string().max(40).optional(),
  // Explicitly retained import aliases; unknown top-level keys are rejected.
  name: z.string().max(180).optional(),
  guestName: z.string().max(180).optional(),
  fullName: z.string().max(180).optional(),
  phone: z.string().max(80).optional(),
  email: z.string().max(254).optional(),
  vehicles: z.array(z.unknown()).optional(),
  dob: z.string().max(32).optional()
}).strict();

const room = z.object({
  id: stableId.optional(),
  n: z.union([z.string().trim().min(1).max(80), z.number().int().safe()]),
  t: z.string().trim().min(1).max(120),
  r: z.number().finite().nonnegative().refine(value =>
    Math.abs(value * 100 - Math.round(value * 100)) <= 1e-7,
    "room rate must have at most two decimal places"),
  s: z.enum(["ready", "occ", "clean", "out", "maintenance"]),
  demo: z.boolean().optional(),
  status_changed: z.union([z.string(), z.number(), z.boolean()]).optional(),
  retired: z.boolean().optional(),
  retiredAt: z.string().max(40).optional()
}).strict();

const payment = z.object({
  id: stableId,
  bookingId: stableId,
  folioId: z.string().min(1).max(180),
  transactionId: z.string().min(1).max(180),
  provider: z.enum(["razorpay", "cashfree", "payu", "phonepe", "paytm", "jiopay"]),
  environment: z.enum(["test", "live", "uat", "staging", "production"]),
  amountMinor: z.number().int().safe().positive(),
  currency: z.literal("INR"),
  status: z.enum(["created", "pending", "authorized", "captured", "failed", "refund_pending", "partially_refunded", "refunded", "unknown"]),
  providerOrderId: z.string().max(180).optional(),
  providerPaymentId: z.string().max(180).optional(),
  idempotencyKey: z.string().min(1).max(180),
  providerEventId: z.string().max(180).optional(),
  refundIdempotencyKey: z.string().max(180).optional(),
  refundAmountMinor: z.number().int().safe().nonnegative().optional(),
  createdAt: z.string().max(40),
  updatedAt: z.string().max(40).optional(),
  retired: z.boolean().optional(),
  retiredAt: z.string().max(40).optional(),
  metadata: z.record(z.unknown()).optional()
}).strict().superRefine((row, context) => {
  const environments = {
    razorpay: ["test", "live"], cashfree: ["test", "live"], payu: ["test", "live"],
    phonepe: ["uat", "production"], paytm: ["staging", "production"], jiopay: ["uat", "production"]
  };
  if (!environments[row.provider]?.includes(row.environment)) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["environment"], message: "provider environment is invalid" });
  }
  if (row.refundAmountMinor !== undefined && row.refundAmountMinor > row.amountMinor) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["refundAmountMinor"], message: "refund cannot exceed captured amount" });
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
  payment,\n  folio: z.object({
    id: stableId,
    bookingId: stableId,
    paymentRows: z.array(z.unknown()),
    paidPaise: z.number().int().safe().nonnegative(),
    balanceDuePaise: z.number().int().safe().nonnegative(),
    updatedAt: z.string().max(40).optional(),
    retired: z.boolean().optional(),
    retiredAt: z.string().max(40).optional(),
    legacySourceEvidence: z.object({
      legacyPaidTotal: z.unknown(),
      legacyPaymentRows: z.array(z.unknown())
    }).strict().optional()
  }).strict(),
  guest,
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
  }),
  payment: Object.freeze({
    status: Object.freeze({
      created: ["pending", "authorized", "captured", "failed", "unknown"],
      pending: ["authorized", "captured", "failed", "unknown"],
      authorized: ["captured", "failed", "unknown"],
      captured: ["refund_pending", "partially_refunded", "refunded"],
      failed: [],
      refund_pending: ["partially_refunded", "refunded", "captured", "unknown"],
      partially_refunded: ["refund_pending", "refunded"],
      refunded: [],
      unknown: ["pending", "authorized", "captured", "failed", "refund_pending"]
    })
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
