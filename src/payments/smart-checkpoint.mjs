/**
 * Local-first Smart Checkpoint for folio reconciliation.
 *
 * This is a domain boundary, not a gateway client. Provider evidence must be
 * independently verified by the provider-supported mechanism before it is
 * counted. The repository adapter must implement transactFolio atomically
 * (for example, one IndexedDB readwrite transaction or SQLite transaction).
 *
 * No network service or Aurelia-owned backend is required by this module.
 */

const ROLES = Object.freeze({
  STAFF: new Set(["staff", "manager", "owner", "admin"]),
  MANAGER: new Set(["manager", "owner", "admin"])
});
const PAYMENT_STATES = new Set(["VERIFIED", "POSTED"]);
const SAFE_ID = /^[^\u0000-\u001f\u007f]{1,160}$/;

function fail(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}
function id(value, label) {
  if (typeof value !== "string" || !SAFE_ID.test(value) || !value.trim()) {
    throw new TypeError("Invalid " + label);
  }
  return value.trim();
}
function paise(value, label, { zero = false } = {}) {
  if (!Number.isSafeInteger(value) || value < (zero ? 0 : 1)) {
    throw new TypeError(label + " must be an integer number of paise");
  }
  return value;
}
function actor(input) {
  const userId = id(input?.userId, "staff user ID");
  const role = String(input?.role || "").toLowerCase();
  if (!ROLES.STAFF.has(role)) throw fail("STAFF_PERMISSION_REQUIRED", "An authorized staff account is required");
  return { userId, role };
}
function sumLines(lines, acceptedKinds, label) {
  if (!Array.isArray(lines)) throw new TypeError(label + " must be an array");
  return lines.reduce((sum, row) => {
    if (!row || typeof row !== "object" || !acceptedKinds.has(row.kind)) {
      throw new TypeError("Invalid " + label + " entry");
    }
    const amount = paise(row.amountPaise, label + " amount");
    return sum + amount;
  }, 0);
}

export function calculateFolioCheckpoint(folio) {
  if (!folio || typeof folio !== "object" || Array.isArray(folio)) throw new TypeError("Folio is required");
  const folioId = id(folio.folioId, "folio ID");
  if (!Number.isSafeInteger(folio.version) || folio.version < 0) throw new TypeError("Folio version must be a non-negative integer");
  const charges = sumLines(folio.chargeLines || [], new Set(["CHARGE"]), "charge lines");
  const discounts = sumLines(folio.adjustmentLines || [], new Set(["DISCOUNT", "CREDIT"]), "adjustments");
  if (discounts > charges) throw fail("CREDITS_EXCEED_CHARGES", "Folio credits cannot exceed gross charges");
  if (!Array.isArray(folio.paymentEntries || [])) throw new TypeError("Payment entries must be an array");
  let verifiedPaymentsPaise = 0;
  let refundsPaise = 0;
  let unverifiedCount = 0;
  for (const entry of folio.paymentEntries || []) {
    if (!entry || typeof entry !== "object") throw new TypeError("Invalid payment entry");
    const amount = paise(entry.amountPaise, "payment amount");
    if (entry.kind === "REFUND") {
      if (PAYMENT_STATES.has(entry.status)) refundsPaise += amount;
      else unverifiedCount += 1;
    } else if (entry.kind === "PAYMENT") {
      if (PAYMENT_STATES.has(entry.status)) verifiedPaymentsPaise += amount;
      else unverifiedCount += 1;
    } else throw new TypeError("Payment entry kind must be PAYMENT or REFUND");
  }
  const netChargesPaise = charges - discounts;
  const remainingDuePaise = netChargesPaise - verifiedPaymentsPaise + refundsPaise;
  const state = unverifiedCount > 0 ? "PENDING_REVIEW"
    : remainingDuePaise > 0 ? "PARTIALLY_PAID"
    : remainingDuePaise < 0 ? "OVERPAID" : "SETTLEMENT_READY";
  return Object.freeze({
    folioId, version: folio.version, currency: String(folio.currency || "INR").toUpperCase(),
    grossChargesPaise: charges, creditsPaise: discounts, netChargesPaise,
    verifiedPaymentsPaise, refundsPaise, remainingDuePaise,
    unverifiedCount, state, isSettled: folio.status === "SETTLED"
  });
}

export class SmartCheckpoint {
  constructor({ repository, now = () => new Date().toISOString() } = {}) {
    if (!repository || typeof repository.readFolio !== "function" ||
        typeof repository.transactFolio !== "function") {
      throw new TypeError("A local folio repository with readFolio and atomic transactFolio is required");
    }
    this.repository = repository;
    this.now = now;
  }

  async inspect(folioId) {
    const folio = await this.repository.readFolio(id(folioId, "folio ID"));
    if (!folio) throw fail("FOLIO_NOT_FOUND", "Folio was not found");
    return calculateFolioCheckpoint(folio);
  }

  async recordPayment({ folioId, expectedVersion, amountPaise, method, reference = "", staff, paymentId }) {
    const who = actor(staff);
    const amount = paise(amountPaise, "payment amount");
    const paymentMethod = id(method, "payment method");
    const ref = reference == null ? "" : String(reference).trim();
    if (ref.length > 256 || /[\u0000-\u001f\u007f]/.test(ref)) throw new TypeError("Invalid payment reference");
    const identity = id(paymentId, "payment ID");
    return this.mutate(folioId, expectedVersion, folio => {
      const checkpoint = calculateFolioCheckpoint(folio);
      if (checkpoint.state === "PENDING_REVIEW") throw fail("PAYMENT_REVIEW_REQUIRED", "Unverified payment evidence must be reviewed before adding another payment");
      if (checkpoint.remainingDuePaise <= 0 || amount > checkpoint.remainingDuePaise) {
        throw fail("PAYMENT_AMOUNT_MISMATCH", "Payment must be positive and cannot exceed the current outstanding balance");
      }
      const prior = (folio.paymentEntries || []).find(row => row.paymentId === identity);
      if (prior) {
        if (prior.amountPaise !== amount || prior.method !== paymentMethod || prior.kind !== "PAYMENT") {
          throw fail("PAYMENT_IDEMPOTENCY_CONFLICT", "Payment ID was already used with different details");
        }
        return { duplicate: true, folio, checkpoint };
      }
      const entry = {
        paymentId: identity, kind: "PAYMENT", status: "POSTED", amountPaise: amount,
        method: paymentMethod, reference: ref, source: "STAFF_RECORDED",
        recordedBy: who.userId, recordedAt: this.now()
      };
      folio.paymentEntries = [...(folio.paymentEntries || []), entry];
      folio.auditTrail = [...(folio.auditTrail || []), {
        action: "PAYMENT_RECORDED", actorId: who.userId, actorRole: who.role,
        at: this.now(), amountPaise: amount, paymentId: identity, folioVersion: expectedVersion
      }];
      return { duplicate: false, folio };
    });
  }

  async approveWriteOff({ folioId, expectedVersion, amountPaise, reason, staff, adjustmentId }) {
    const who = actor(staff);
    if (!ROLES.MANAGER.has(who.role)) throw fail("MANAGER_APPROVAL_REQUIRED", "Only a manager or owner may authorize a write-off");
    const amount = paise(amountPaise, "write-off amount");
    const note = String(reason || "").trim();
    if (note.length < 5 || note.length > 500 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(note)) {
      throw new TypeError("A write-off reason of 5 to 500 characters is required");
    }
    const identity = id(adjustmentId, "adjustment ID");
    return this.mutate(folioId, expectedVersion, folio => {
      const checkpoint = calculateFolioCheckpoint(folio);
      if (checkpoint.state === "PENDING_REVIEW") throw fail("PAYMENT_REVIEW_REQUIRED", "Unverified payment evidence must be resolved first");
      if (checkpoint.remainingDuePaise <= 0 || amount > checkpoint.remainingDuePaise) {
        throw fail("WRITE_OFF_AMOUNT_MISMATCH", "Write-off cannot exceed the outstanding balance");
      }
      const prior = (folio.adjustmentLines || []).find(row => row.adjustmentId === identity);
      if (prior) {
        if (prior.amountPaise !== amount || prior.kind !== "CREDIT") throw fail("ADJUSTMENT_IDEMPOTENCY_CONFLICT", "Adjustment ID was reused");
        return { duplicate: true, folio };
      }
      folio.adjustmentLines = [...(folio.adjustmentLines || []), {
        adjustmentId: identity, kind: "CREDIT", amountPaise: amount,
        reason: note, authorizedBy: who.userId, authorizedAt: this.now()
      }];
      folio.auditTrail = [...(folio.auditTrail || []), {
        action: "WRITE_OFF_APPROVED", actorId: who.userId, actorRole: who.role,
        at: this.now(), amountPaise: amount, reason: note,
        adjustmentId: identity, folioVersion: expectedVersion
      }];
      return { duplicate: false, folio };
    });
  }

  async approveSettlement({ folioId, expectedVersion, staff }) {
    const who = actor(staff);
    return this.mutate(folioId, expectedVersion, folio => {
      const checkpoint = calculateFolioCheckpoint(folio);
      if (checkpoint.state !== "SETTLEMENT_READY" || checkpoint.remainingDuePaise !== 0) {
        throw fail("FOLIO_NOT_SETTLEABLE", "Folio must have a zero balance and no unverified payment evidence");
      }
      if (folio.status === "SETTLED") return { duplicate: true, folio };
      folio.status = "SETTLED";
      folio.settledAt = this.now();
      folio.settledBy = who.userId;
      folio.auditTrail = [...(folio.auditTrail || []), {
        action: "FOLIO_SETTLED", actorId: who.userId, actorRole: who.role,
        at: this.now(), folioVersion: expectedVersion,
        reconciliationMethod: "LOCAL_SMART_CHECKPOINT"
      }];
      return { duplicate: false, folio };
    });
  }

  async mutate(folioId, expectedVersion, operation) {
    const key = id(folioId, "folio ID");
    if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 0) throw new TypeError("Expected folio version is required");
    return this.repository.transactFolio(key, async current => {
      if (!current) throw fail("FOLIO_NOT_FOUND", "Folio was not found");
      if (current.version !== expectedVersion) throw fail("FOLIO_VERSION_CONFLICT", "Folio changed while it was being reviewed; refresh before approving");
      if (current.status === "SETTLED") throw fail("FOLIO_ALREADY_SETTLED", "Settled folios cannot be modified");
      const result = operation(current) || {};
      if (result.duplicate) return { ...result, checkpoint: calculateFolioCheckpoint(current), version: current.version };
      current.version += 1;
      const checkpoint = calculateFolioCheckpoint(current);
      current.reconciliationState = checkpoint.state;
      return { ...result, checkpoint, version: current.version };
    });
  }
}
