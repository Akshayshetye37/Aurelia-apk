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
  live_collection_enabled: false,
  automatic_settlement: false,
  native_settlement_bridge: false,
  refund_processing: false
});

export const PAYMENT_CONTROL_IDS = Object.freeze([
  "emergency_stop",
  "manual_posting",
  "test_collection",
  "live_collection",
  "live_collection_enabled",
  "automatic_settlement",
  "native_settlement_bridge",
  "refund_processing"
]);

const CONTROL_SET = new Set(PAYMENT_CONTROL_IDS);
const TENANT_ID = /^[A-Za-z0-9_-]{6,64}$/;
const MAX_REASON = 500;

export function normalizePaymentControls(data) {
  const updatedAt = data?.updatedAt instanceof Date
    ? data.updatedAt
    : data?.updatedAt?.toDate?.();
  const metadataValid = updatedAt instanceof Date &&
    Number.isFinite(updatedAt.getTime()) &&
    typeof data?.updatedBy === "string" && data.updatedBy.length > 0;
  if (!data || typeof data !== "object" || Array.isArray(data) ||
      data.schemaVersion !== 1 || !metadataValid ||
      PAYMENT_CONTROL_IDS.some(key => key !== "live_collection_enabled" && typeof data[key] !== "boolean") ||
      (data.live_collection_enabled !== undefined && typeof data.live_collection_enabled !== "boolean")) {
    return { ...PAYMENT_CONTROL_DEFAULTS, controlState: "INVALID_FAIL_CLOSED" };
  }
  return {
    schemaVersion: 1,
    ...Object.fromEntries(PAYMENT_CONTROL_IDS.map(key => [key, data[key] ?? PAYMENT_CONTROL_DEFAULTS[key]])),
    controlState: "CONFIGURED"
  };
}

export function paymentControlAllows(controls, control) {
  if (!CONTROL_SET.has(control)) throw new TypeError("Unknown payment control");
  if (controls?.controlState && controls.controlState !== "CONFIGURED") return false;
  const state = normalizePaymentControls(controls);
  return state.controlState === "CONFIGURED" &&
    state.emergency_stop === false &&
    state[control] === true &&
    (control !== "live_collection" || state.live_collection_enabled === true);
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
  db, tenantId, actor, changes, reason, now = () => new Date(),
  releaseApprovalRefs = {}, validateReleaseApproval = () => false
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
  // The emergency stop is a permanent operator kill switch. This API can
  // engage it, but no generic flag update can disengage it.
  if (changes.emergency_stop === false) {
    throw Object.assign(new Error("Emergency stop release is not available through this API"), {
      code: "PAYMENT_EMERGENCY_STOP_RELEASE_FORBIDDEN"
    });
  }

  const controlRef = db.doc("paymentControls/" + tenantId);
  const auditRef = controlRef.collection("audit").doc();
  const controlsRequiringApproval = keys.filter(control =>
    control !== "emergency_stop" && control !== "live_collection_enabled" && changes[control] === true
  );
  return db.runTransaction(async tx => {
    const snap = await tx.get(controlRef);
    const approvalSnaps = [];
    for (const control of controlsRequiringApproval) {
      const ref = releaseApprovalRefs[control];
      if (!ref) throw Object.assign(new Error("Release approval reference is required"), {
        code: "PAYMENT_CONTROL_RELEASE_APPROVAL_REQUIRED"
      });
      approvalSnaps.push(await tx.get(ref));
    }
    for (let index = 0; index < controlsRequiringApproval.length; index += 1) {
      const control = controlsRequiringApproval[index];
      const approvalSnap = approvalSnaps[index];
      if (!approvalSnap.exists ||
          typeof validateReleaseApproval !== "function" ||
          validateReleaseApproval(approvalSnap.data(), control) !== true) {
        throw Object.assign(new Error("Payment control release evidence is missing or invalid"), {
          code: "PAYMENT_CONTROL_RELEASE_APPROVAL_REQUIRED"
        });
      }
    }
    const current = snap.exists
      ? normalizePaymentControls(snap.data())
      : { ...PAYMENT_CONTROL_DEFAULTS, controlState: "UNCONFIGURED" };
    if (current.controlState === "INVALID_FAIL_CLOSED") {
      throw Object.assign(new Error("Stored payment control document is invalid"), { code: "PAYMENT_CONTROLS_INVALID" });
    }
    // The tenant-facing switch can only be enabled after the independent,
    // internally approved live_collection release gate is already active.
    if (changes.live_collection_enabled === true &&
        (current.live_collection !== true || current.emergency_stop !== false)) {
      throw Object.assign(new Error("Live collection has not been internally authorised"), {
        code: "PAYMENT_LIVE_COLLECTION_NOT_AUTHORISED"
      });
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
    return {
      controls: {
        ...next,
        updatedAt: timestamp,
        updatedBy: actor.uid,
        controlState: "CONFIGURED"
      },
      audit
    };
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
