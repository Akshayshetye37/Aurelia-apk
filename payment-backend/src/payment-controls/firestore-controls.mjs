/**
 * Firestore-backed payment control plane.
 *
 * The server is authoritative. Missing, malformed, stale or unreadable state
 * resolves to the locked defaults. Callers must not cache an allow decision.
 */
export const PAYMENT_CONTROL_DEFAULTS = Object.freeze({
  schemaVersion: 1,
  emergency_stop: true,
  manual_posting: false,
  test_collection: false,
  live_collection: false,
  automatic_settlement: false,
  native_settlement_bridge: false,
  refund_processing: false
});

export const PAYMENT_CONTROL_IDS = Object.freeze([
  "emergency_stop",
  "manual_posting",
  "test_collection",
  "live_collection",
  "automatic_settlement",
  "native_settlement_bridge",
  "refund_processing"
]);

const CONTROL_SET = new Set(PAYMENT_CONTROL_IDS);
const TENANT_ID = /^[A-Za-z0-9_-]{6,64}$/;
const MAX_REASON = 500;

export function normalizePaymentControls(data) {
  if (!data || typeof data !== "object" || Array.isArray(data) ||
      data.schemaVersion !== 1 ||
      PAYMENT_CONTROL_IDS.some(key => typeof data[key] !== "boolean")) {
    return { ...PAYMENT_CONTROL_DEFAULTS, controlState: "INVALID_FAIL_CLOSED" };
  }
  return {
    schemaVersion: 1,
    ...Object.fromEntries(PAYMENT_CONTROL_IDS.map(key => [key, data[key]])),
    controlState: "CONFIGURED"
  };
}

export function paymentControlAllows(controls, control) {
  if (!CONTROL_SET.has(control)) throw new TypeError("Unknown payment control");
  if (controls?.controlState && controls.controlState !== "CONFIGURED") return false;
  const state = normalizePaymentControls(controls);
  return state.controlState === "CONFIGURED" &&
    state.emergency_stop === false &&
    state[control] === true;
}

export async function readPaymentControls({ db, tenantId }) {
  if (!db || !TENANT_ID.test(tenantId || "")) {
    return { ...PAYMENT_CONTROL_DEFAULTS, controlState: "INVALID_CONTEXT" };
  }
  try {
    const snap = await db.doc("paymentControls/" + tenantId).get();
    if (!snap.exists) return { ...PAYMENT_CONTROL_DEFAULTS, controlState: "UNCONFIGURED" };
    return normalizePaymentControls(snap.data());
  } catch {
    return { ...PAYMENT_CONTROL_DEFAULTS, controlState: "READ_FAILED" };
  }
}

/**
 * Atomically changes one or more controls and appends immutable audit records.
 * Authorization is deliberately supplied by the already-authenticated route.
 */
export async function updatePaymentControls({
  db, tenantId, actor, changes, reason, now = () => new Date()
}) {
  if (!db || !TENANT_ID.test(tenantId || "")) throw new TypeError("Invalid tenant context");
  if (!actor || typeof actor.uid !== "string" || !actor.uid ||
      typeof actor.email !== "string" || !actor.email) {
    throw new TypeError("Verified actor identity is required");
  }
  if (!changes || typeof changes !== "object" || Array.isArray(changes)) {
    throw new TypeError("Control changes are required");
  }
  const keys = Object.keys(changes);
  if (!keys.length || keys.some(key => !CONTROL_SET.has(key)) ||
      keys.some(key => typeof changes[key] !== "boolean")) {
    throw new TypeError("Only explicit boolean payment controls may be changed");
  }
  if (typeof reason !== "string" || !reason.trim() || reason.trim().length > MAX_REASON) {
    throw new TypeError("A reason of 1 to 500 characters is required");
  }

  const controlRef = db.doc("paymentControls/" + tenantId);
  const auditRef = controlRef.collection("audit").doc();
  return db.runTransaction(async tx => {
    const snap = await tx.get(controlRef);
    const current = snap.exists
      ? normalizePaymentControls(snap.data())
      : { ...PAYMENT_CONTROL_DEFAULTS, controlState: "UNCONFIGURED" };
    if (current.controlState === "INVALID_FAIL_CLOSED") {
      throw Object.assign(new Error("Stored payment control document is invalid"), { code: "PAYMENT_CONTROLS_INVALID" });
    }
    const next = { ...PAYMENT_CONTROL_DEFAULTS };
    for (const key of PAYMENT_CONTROL_IDS) next[key] = current[key] ?? PAYMENT_CONTROL_DEFAULTS[key];
    for (const [key, value] of Object.entries(changes)) next[key] = value;
    if (next.emergency_stop === true) {
      // Emergency stop dominates; other flags are retained as configured.
    }
    const timestamp = now();
    if (!(timestamp instanceof Date) || !Number.isFinite(timestamp.getTime())) {
      throw new TypeError("Invalid audit timestamp");
    }
    const audit = keys.map(control => ({
      tenantId,
      control,
      from: current[control] ?? PAYMENT_CONTROL_DEFAULTS[control],
      to: changes[control],
      actorUid: actor.uid,
      actorEmail: actor.email,
      reason: reason.trim(),
      at: timestamp.toISOString()
    }));
    tx.set(controlRef, {
      schemaVersion: 1,
      ...next,
      updatedAt: timestamp,
      updatedBy: actor.uid
    });
    tx.set(auditRef, {
      tenantId,
      entries: audit,
      actorUid: actor.uid,
      actorEmail: actor.email,
      reason: reason.trim(),
      at: timestamp
    });
    return { controls: { ...next, controlState: "CONFIGURED" }, audit };
  });
}

export function assertPaymentControl(controls, control) {
  if (paymentControlAllows(controls, control)) return;
  const error = new Error("Payment operation blocked by the central payment safety controls");
  error.code = controls?.controlState === "READ_FAILED"
    ? "PAYMENT_CONTROLS_UNAVAILABLE"
    : controls?.emergency_stop !== false
      ? "PAYMENT_EMERGENCY_STOP"
      : "PAYMENT_CONTROL_DISABLED";
  throw error;
}
