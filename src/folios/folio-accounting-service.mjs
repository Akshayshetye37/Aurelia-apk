import { assertCompatibilityUiAllowed } from "../storage/pms-authority-state.mjs";

const clone = value => value == null ? value : structuredClone(value);
const text = value => String(value ?? "").trim();
const fail = (code, message) => Object.assign(new Error(message), { code });
const safeId = (value, label) => {
  const id = text(value);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,179}$/.test(id)) throw new TypeError("Invalid " + label);
  return id;
};
const paise = (value, label) => {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0) throw new TypeError(label + " must be a non-negative integer in paise");
  return number;
};
const stableJson = value => {
  if (Array.isArray(value)) return "[" + value.map(stableJson).join(",") + "]";
  if (value && typeof value === "object") return "{" + Object.keys(value).sort().map(k => JSON.stringify(k) + ":" + stableJson(value[k])).join(",") + "}";
  return JSON.stringify(value);
};
async function digest(value, cryptoImpl) {
  if (!cryptoImpl?.subtle || typeof TextEncoder !== "function") throw new Error("Web Crypto is required to issue a durable invoice");
  const bytes = await cryptoImpl.subtle.digest("SHA-256", new TextEncoder().encode(stableJson(value)));
  return Array.from(new Uint8Array(bytes), b => b.toString(16).padStart(2, "0")).join("");
}
export function financialYearFor(value) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) throw new TypeError("A valid invoice issue date is required");
  const year = date.getUTCFullYear();
  const start = date.getUTCMonth() >= 3 ? year : year - 1;
  return "FY" + start + "-" + String((start + 1) % 100).padStart(2, "0");
}
function amountFromPayment(row) {
  if (row?.amountPaise != null) return paise(row.amountPaise, "Payment amount");
  const amount = Number(row?.a ?? row?.amount ?? 0);
  if (!Number.isFinite(amount) || amount < 0 || Math.abs(amount * 100 - Math.round(amount * 100)) > 1e-7) {
    throw new TypeError("Legacy payment amount is malformed");
  }
  return Math.round(amount * 100);
}
export function reconcileLegacyPaymentTotals(booking) {
  if (!booking || typeof booking !== "object") throw new TypeError("Booking is required");
  const scalar = Number(booking.p || 0);
  if (!Number.isFinite(scalar) || scalar < 0 || Math.abs(scalar * 100 - Math.round(scalar * 100)) > 1e-7) {
    throw fail("LEGACY_PAYMENT_TOTAL_INVALID", "Legacy booking paid total is invalid; invoice issuance is blocked.");
  }
  const scalarPaise = Math.round(scalar * 100);
  const rows = Array.isArray(booking.pays) ? booking.pays : [];
  const rowsPaise = rows.reduce((sum, row) => sum + amountFromPayment(row), 0);
  return Object.freeze({
    scalarPaise, rowsPaise, matched: scalarPaise === rowsPaise,
    differencePaise: scalarPaise - rowsPaise,
    rowCount: rows.length
  });
}
function eventPayload(operation, details, at) {
  return { operation, ...clone(details), at };
}
async function batchCommit(bridge, changes) {
  return bridge.mutateEntities(changes);
}
function existingVersion(row) { return row?.version ?? 0; }

/**
 * Invoice number allocation and immutable invoice evidence are committed in
 * the same optimistic multi-entity transaction. A racing issuer retries from
 * the new sequence version; a failed issuance never consumes a number.
 */
export async function issueFolioInvoice({
  bridge, folioId, booking, invoice, now = () => new Date().toISOString(),
  cryptoImpl = globalThis.crypto, prefix = "INV", maxRetries = 8
} = {}) {
  if (!bridge || typeof bridge.fetchEntity !== "function" || typeof bridge.mutateEntities !== "function") {
    throw new TypeError("A bound transactional repository bridge is required");
  }
  await assertCompatibilityUiAllowed(bridge);
  const targetFolioId = safeId(folioId, "folio ID");
  const bookingId = safeId(booking?.id, "booking ID");
  if (!invoice || typeof invoice !== "object" || !Array.isArray(invoice.lineItems) || !invoice.totals) {
    throw new TypeError("A complete calculated invoice snapshot is required");
  }
  if (invoice.lineItems.some(line => !line.taxProfile || !line.taxProfile.id)) {
    throw fail("TAX_PROFILE_MISSING", "Every invoice charge requires an explicit configured tax profile, including an explicit zero-rate/exempt profile.");
  }
  const paymentReconciliation = reconcileLegacyPaymentTotals(booking);
  if (!paymentReconciliation.matched) {
    throw fail("LEGACY_PAYMENT_RECONCILIATION_REQUIRED",
      "Invoice issuance blocked: booking.p and booking.pays differ by " +
      paymentReconciliation.differencePaise + " paise. Reconcile historical payments first.");
  }
  const issuedAt = new Date(now()).toISOString();
  const financialYear = financialYearFor(issuedAt);
  const sequenceId = "gst-invoice-sequence-" + financialYear;
  const folioRow = await bridge.fetchEntity("folio", targetFolioId);
  if (folioRow?.data?.invoiceIssued) {
    const previous = folioRow.data.invoiceIssued;
    if (previous.bookingId !== bookingId) throw fail("FOLIO_BOOKING_MISMATCH", "The folio belongs to another booking.");
    return Object.freeze({ duplicate: true, invoice: clone(previous), folioVersion: folioRow.version });
  }
  for (let attempt = 0; attempt < maxRetries; attempt += 1) {
    const sequenceRow = await bridge.fetchEntity("folio_sequence", sequenceId);
    const nextNumber = sequenceRow?.data?.nextNumber ?? 1;
    if (!Number.isSafeInteger(nextNumber) || nextNumber < 1 || nextNumber >= Number.MAX_SAFE_INTEGER) {
      throw fail("INVOICE_SEQUENCE_EXHAUSTED", "The financial-year invoice sequence is invalid or exhausted.");
    }
    const invoiceNumber = text(prefix).replace(/[^A-Za-z0-9-]/g, "").slice(0, 12) + "/" + financialYear + "/" + String(nextNumber).padStart(6, "0");
    const issuedInvoice = Object.freeze({
      ...clone(invoice), invoiceNumber, financialYear, issuedAt,
      folioNumber: targetFolioId, bookingId,
      paymentReconciliation
    });
    const invoiceHash = await digest(issuedInvoice, cryptoImpl);
    const ledgerId = "invoice-issued-" + financialYear + "-" + String(nextNumber).padStart(8, "0");
    const auditId = "invoice-audit-" + financialYear + "-" + String(nextNumber).padStart(8, "0");
    const currentFolio = await bridge.fetchEntity("folio", targetFolioId);
    if (currentFolio?.data?.invoiceIssued) return Object.freeze({ duplicate: true, invoice: clone(currentFolio.data.invoiceIssued), folioVersion: currentFolio.version });
    const payload = eventPayload("folio.invoice_issued", {
      folioId: targetFolioId, bookingId, invoiceNumber, financialYear, invoiceHash
    }, issuedAt);
    const changes = [
      {
        entityType: "folio_sequence", entityId: sequenceId, expectedVersion: existingVersion(sequenceRow),
        eventType: "folio.invoice_sequence_advanced", eventPayload: payload,
        mutate: entity => Object.assign(entity, {
          id: sequenceId, financialYear, nextNumber: nextNumber + 1,
          lastIssuedNumber: nextNumber, updatedAt: issuedAt
        })
      },
      {
        entityType: "folio", entityId: targetFolioId, expectedVersion: existingVersion(currentFolio),
        eventType: "folio.invoice_issued", eventPayload: payload,
        mutate: entity => Object.assign(entity, {
          id: targetFolioId, bookingId,
          invoiceIssued: clone(issuedInvoice),
          invoiceHash,
          invoiceNumbers: [...(Array.isArray(entity.invoiceNumbers) ? entity.invoiceNumbers : []), invoiceNumber],
          updatedAt: issuedAt
        })
      },
      {
        entityType: "ledger", entityId: ledgerId, expectedVersion: 0,
        eventType: "ledger.invoice_issued", eventPayload: payload,
        mutate: entity => Object.assign(entity, {
          id: ledgerId, kind: "invoice_issued", folioId: targetFolioId, bookingId,
          invoiceNumber, financialYear, invoiceHash, issuedAt,
          totalPaise: paise(issuedInvoice.totals.grossMinor, "Invoice total")
        })
      },
      {
        entityType: "audit", entityId: auditId, expectedVersion: 0,
        eventType: "audit.invoice_issued", eventPayload: payload,
        mutate: entity => Object.assign(entity, {
          id: auditId, action: "invoice_issued", actor: "local_staff",
          folioId: targetFolioId, bookingId, invoiceNumber, financialYear,
          invoiceHash, issuedAt, paymentReconciliation
        })
      }
    ];
    try {
      await batchCommit(bridge, changes);
      const saved = await bridge.fetchEntity("folio", targetFolioId);
      if (!saved?.data?.invoiceIssued || saved.data.invoiceHash !== invoiceHash ||
          saved.data.invoiceIssued.invoiceNumber !== invoiceNumber) {
        throw fail("INVOICE_COMMIT_READBACK_FAILED", "Invoice issuance could not be verified after commit.");
      }
      return Object.freeze({ duplicate: false, invoice: clone(saved.data.invoiceIssued), folioVersion: saved.version, invoiceHash });
    } catch (error) {
      if (error?.code === "ENTITY_VERSION_CONFLICT" && attempt + 1 < maxRetries) continue;
      throw error;
    }
  }
  throw fail("INVOICE_SEQUENCE_CONTENTION", "Invoice sequence remained contended; no invoice was issued.");
}

/**
 * Creates a child folio without rewriting the master charge/payment ledger.
 * Allocations are immutable source references and may not exceed the amount
 * available on the master folio. A master version check serializes competing splits.
 */
export async function createSplitFolio({
  bridge, masterFolioId, childFolioId, bookingId, guest, masterChargeLines = null, allocations,
  reason = "corporate_reimbursement", now = () => new Date().toISOString(),
  maxRetries = 6
} = {}) {
  if (!bridge || typeof bridge.fetchEntity !== "function" || typeof bridge.mutateEntities !== "function" ||
      typeof bridge.listEntities !== "function") {
    throw new TypeError("A bound transactional repository bridge is required");
  }
  await assertCompatibilityUiAllowed(bridge);
  const masterId = safeId(masterFolioId, "master folio ID");
  const childId = safeId(childFolioId, "split folio ID");
  const bookingKey = safeId(bookingId, "booking ID");
  if (masterId === childId) throw new TypeError("A split folio must have a different ID from its master");
  if (!Array.isArray(allocations) || !allocations.length) throw new TypeError("At least one split allocation is required");
  const normalized = allocations.map(allocation => Object.freeze({
    chargeId: safeId(allocation?.chargeId, "charge ID"),
    amountPaise: paise(allocation.amountPaise, "Allocation amount")
  }));
  if (new Set(normalized.map(x => x.chargeId)).size !== normalized.length) {
    throw new TypeError("Duplicate charge allocations are not allowed");
  }
  const issuedAt = new Date(now()).toISOString();
  for (let attempt = 0; attempt < maxRetries; attempt += 1) {
    const [masterRow, childRow, allFolios] = await Promise.all([
      bridge.fetchEntity("folio", masterId), bridge.fetchEntity("folio", childId), bridge.listEntities("folio")
    ]);
    if (!masterRow) throw fail("MASTER_FOLIO_MISSING", "The canonical master folio does not exist.");
    if (childRow) throw fail("SPLIT_FOLIO_ALREADY_EXISTS", "The split folio ID already exists.");
    if (masterRow.data?.invoiceIssued) throw fail("MASTER_INVOICE_ALREADY_ISSUED", "A split cannot be created after the master tax invoice has been issued.");
    if (masterRow.data?.bookingId && String(masterRow.data.bookingId) !== bookingKey) {
      throw fail("FOLIO_BOOKING_MISMATCH", "The master folio belongs to another booking.");
    }
    const canonicalCharges = Array.isArray(masterRow?.data?.chargeLines) ? masterRow.data.chargeLines :\n      (!masterRow && Array.isArray(masterChargeLines) ? masterChargeLines : null);
    if (!canonicalCharges) throw fail("SPLIT_CANONICAL_CHARGES_MISSING", "Split folios require canonical charge lines on the master folio; caller-supplied charges are not trusted.");
    const sourceMap = new Map(canonicalCharges.map((charge, index) => {
      const id = text(charge?.id) || "legacy-charge-" + index;
      return [id, { ...clone(charge), id }];
    }));
    const used = new Map();
    for (const row of allFolios) {
      const entries = [
        ...(Array.isArray(row.data?.splitAllocations) ? row.data.splitAllocations : []),
        ...(Array.isArray(row.data?.allocations) ? [{ allocations: row.data.allocations }] : [])
      ];
      for (const entry of entries) {
        for (const item of entry.allocations || []) {
          used.set(item.chargeId, (used.get(item.chargeId) || 0) + paise(item.amountPaise, "Existing split allocation"));
        }
      }
    }
    const allocated = normalized.map(item => {
      const source = sourceMap.get(item.chargeId);
      if (!source) throw fail("SPLIT_SOURCE_CHARGE_MISSING", "A split allocation references a charge absent from the canonical master folio.");
      const sourceAmount = source.amountPaise != null ? paise(source.amountPaise, "Source charge amount") :
        source.grossMinor != null ? paise(source.grossMinor, "Source charge amount") :
        Math.round(Number(source.amount ?? source.a ?? 0) * 100);
      if (!Number.isSafeInteger(sourceAmount) || sourceAmount < 0 ||
          (used.get(item.chargeId) || 0) + item.amountPaise > sourceAmount) {
        throw fail("SPLIT_ALLOCATION_ALREADY_USED", "The requested allocation exceeds the unallocated source charge amount.");
      }
      return {
        chargeId: item.chargeId, amountPaise: item.amountPaise,
        sourceDescription: text(source.description || source.label || source[0]),
        chargeSnapshot: clone(source)
      };
    });
    const allocationTotalPaise = allocated.reduce((sum, row) => sum + row.amountPaise, 0);
    const ledgerId = "folio-split-" + childId, auditId = "folio-split-audit-" + childId;
    const payload = eventPayload("folio.split_created", {
      masterFolioId: masterId, splitFolioId: childId, bookingId: bookingKey,
      allocationTotalPaise, allocations: allocated, reason: text(reason).slice(0, 120)
    }, issuedAt);
    const changes = [
      {
        entityType: "folio", entityId: masterId, expectedVersion: existingVersion(masterRow),
        eventType: "folio.split_allocated", eventPayload: payload,
        mutate: entity => Object.assign(entity, {
          id: masterId, bookingId: bookingKey,
          splitAllocations: [...(Array.isArray(entity.splitAllocations) ? entity.splitAllocations : []),
            { splitFolioId: childId, allocations: clone(allocated), allocationTotalPaise, createdAt: issuedAt }],
          updatedAt: issuedAt
        })
      },
      {
        entityType: "folio", entityId: childId, expectedVersion: 0,
        eventType: "folio.split_created", eventPayload: payload,
        mutate: entity => Object.assign(entity, {
          id: childId, bookingId: bookingKey, masterFolioId: masterId,
          billingGuest: clone(guest || {}), allocations: clone(allocated),
          allocationTotalPaise, paidPaise: 0, balanceDuePaise: allocationTotalPaise,
          paymentRows: [], invoiceIssued: null, createdAt: issuedAt, updatedAt: issuedAt, status: "OPEN"
        })
      },
      {
        entityType: "ledger", entityId: ledgerId, expectedVersion: 0,
        eventType: "ledger.folio_split_created", eventPayload: payload,
        mutate: entity => Object.assign(entity, {
          id: ledgerId, kind: "folio_split_created", masterFolioId: masterId,
          splitFolioId: childId, bookingId: bookingKey, allocations: clone(allocated),
          allocationTotalPaise, createdAt: issuedAt
        })
      },
      {
        entityType: "audit", entityId: auditId, expectedVersion: 0,
        eventType: "audit.folio_split_created", eventPayload: payload,
        mutate: entity => Object.assign(entity, {
          id: auditId, action: "folio_split_created", masterFolioId: masterId,
          splitFolioId: childId, bookingId: bookingKey, reason: text(reason).slice(0, 120),
          allocations: clone(allocated), createdAt: issuedAt
        })
      }
    ];
    try {
      await batchCommit(bridge, changes);
      const saved = await bridge.fetchEntity("folio", childId);
      if (!saved || saved.data.masterFolioId !== masterId || saved.data.allocationTotalPaise !== allocationTotalPaise) {
        throw fail("SPLIT_FOLIO_READBACK_FAILED", "Split folio could not be verified after commit.");
      }
      return Object.freeze({ duplicate: false, folio: clone(saved.data), version: saved.version });
    } catch (error) {
      if (error?.code === "ENTITY_VERSION_CONFLICT" && attempt + 1 < maxRetries) continue;
      throw error;
    }
  }
  throw fail("SPLIT_FOLIO_CONTENTION", "The master folio changed repeatedly; no split was created.");
}

/** Build a split invoice from the immutable source invoice line snapshots. */
export function buildSplitFolioInvoice({ masterInvoice, splitFolio, invoiceDate = new Date().toISOString() } = {}) {
  if (!masterInvoice || !splitFolio || !Array.isArray(splitFolio.allocations) || !splitFolio.allocations.length) {
    throw new TypeError("Master invoice and persisted split-folio allocations are required");
  }
  const lineItems = splitFolio.allocations.map(allocation => {
    const source = allocation.chargeSnapshot;
    if (!source || !Number.isSafeInteger(source.grossMinor) || source.grossMinor <= 0) {
      throw fail("SPLIT_SOURCE_SNAPSHOT_INVALID", "A split allocation has no valid immutable source invoice line.");
    }
    const grossMinor = paise(allocation.amountPaise, "Split allocation");
    if (grossMinor > source.grossMinor) throw fail("SPLIT_ALLOCATION_EXCEEDS_CHARGE", "Split amount exceeds the original invoice line.");
    const taxMinor = Math.round(grossMinor * (source.taxMinor || 0) / source.grossMinor);
    const taxableMinor = grossMinor - taxMinor;
    const cgstMinor = source.taxMinor ? Math.round(taxMinor * (source.cgstMinor || 0) / source.taxMinor) : 0;
    const sgstMinor = source.taxMinor ? Math.round(taxMinor * (source.sgstMinor || 0) / source.taxMinor) : 0;
    const igstMinor = taxMinor - cgstMinor - sgstMinor;
    return Object.freeze({
      ...clone(source), id: "split-" + splitFolio.id + "-" + allocation.chargeId,
      sourceChargeId: allocation.chargeId, grossMinor, amountMinor: grossMinor,
      taxableMinor, taxMinor, cgstMinor, sgstMinor, igstMinor,
      lineDiscountMinor: 0, netAmountMinor: grossMinor,
      description: allocation.sourceDescription || source.description
    });
  });
  const sum = key => lineItems.reduce((total, line) => total + line[key], 0);
  const grossMinor = sum("grossMinor"), taxMinor = sum("taxMinor");
  return Object.freeze({
    ...clone(masterInvoice),
    invoiceNumber: "",
    folioNumber: splitFolio.id,
    masterFolioNumber: masterInvoice.folioNumber,
    invoiceDate: new Date(invoiceDate).toISOString(),
    billedTo: Object.freeze({
      ...clone(masterInvoice.billedTo),
      name: text(splitFolio.billingGuest?.name || splitFolio.billingGuest?.n || masterInvoice.billedTo.name),
      address: text(splitFolio.billingGuest?.address || splitFolio.billingGuest?.addr),
      phone: text(splitFolio.billingGuest?.phone || splitFolio.billingGuest?.ph),
      companyName: text(splitFolio.billingGuest?.companyName),
      companyGstin: text(splitFolio.billingGuest?.companyGstin),
      occupants: Object.freeze([])
    }),
    lineItems: Object.freeze(lineItems),
    totals: Object.freeze({
      subtotalMinor: sum("taxableMinor"), taxMinor, grossMinor,
      discountMinor: 0, paidMinor: 0, dueMinor: grossMinor,
      cgstMinor: sum("cgstMinor"), sgstMinor: sum("sgstMinor"), igstMinor: sum("igstMinor")
    }),
    split: Object.freeze({ masterFolioId: splitFolio.masterFolioId, allocations: clone(splitFolio.allocations) })
  });
}

/** Exclude charges already assigned to child folios without rewriting source rows. */
export function buildRemainingFolioInvoice({ masterInvoice, masterFolio, invoiceDate = new Date().toISOString() } = {}) {
  if (!masterInvoice || !masterFolio) throw new TypeError("Master invoice and master folio are required");
  const allocated = new Map();
  for (const split of masterFolio.splitAllocations || []) {
    for (const row of split.allocations || []) allocated.set(row.chargeId, (allocated.get(row.chargeId) || 0) + row.amountPaise);
  }
  const lines = masterInvoice.lineItems.map(source => {
    const used = allocated.get(source.id) || 0;
    const grossMinor = Math.max(0, source.grossMinor - used);
    if (!grossMinor) return null;
    const taxMinor = source.grossMinor ? Math.round(grossMinor * (source.taxMinor || 0) / source.grossMinor) : 0;
    const taxableMinor = grossMinor - taxMinor;
    const cgstMinor = source.taxMinor ? Math.round(taxMinor * (source.cgstMinor || 0) / source.taxMinor) : 0;
    const sgstMinor = source.taxMinor ? Math.round(taxMinor * (source.sgstMinor || 0) / source.taxMinor) : 0;
    const igstMinor = taxMinor - cgstMinor - sgstMinor;
    return Object.freeze({ ...clone(source), grossMinor, amountMinor: grossMinor, taxableMinor,
      taxMinor, cgstMinor, sgstMinor, igstMinor, netAmountMinor: grossMinor,
      splitAllocatedMinor: used });
  }).filter(Boolean);
  const sum = key => lines.reduce((total, line) => total + line[key], 0);
  const grossMinor = sum("grossMinor"), taxMinor = sum("taxMinor");
  return Object.freeze({
    ...clone(masterInvoice), invoiceNumber: "", invoiceDate: new Date(invoiceDate).toISOString(),
    lineItems: Object.freeze(lines),
    totals: Object.freeze({
      subtotalMinor: sum("taxableMinor"), taxMinor, grossMinor,
      discountMinor: 0, paidMinor: masterInvoice.totals.paidMinor || 0,
      dueMinor: Math.max(0, grossMinor - (masterInvoice.totals.paidMinor || 0)),
      cgstMinor: sum("cgstMinor"), sgstMinor: sum("sgstMinor"), igstMinor: sum("igstMinor")
    })
  });
}

/** Staff-confirmed payment posting for a child folio; issued invoice snapshots stay immutable. */
export async function recordSplitFolioPayment({
  bridge, folioId, amountPaise, method, reference = "", idempotencyKey,
  verificationConfirmed = false, now = () => new Date().toISOString()
} = {}) {
  if (!bridge || typeof bridge.fetchEntity !== "function" || typeof bridge.mutateEntities !== "function") throw new TypeError("A bound transactional repository bridge is required");
  await assertCompatibilityUiAllowed(bridge);
  const id = safeId(folioId, "split folio ID"), amount = paise(amountPaise, "Payment amount");
  if (!amount) throw new TypeError("Payment amount must be greater than zero");
  const paymentMethod = text(method);
  if (!["Cash", "UPI", "Card", "Bank transfer"].includes(paymentMethod)) throw new TypeError("Unsupported split-folio payment method");
  const key = safeId(idempotencyKey, "payment idempotency key");
  if (verificationConfirmed !== true) throw fail("PAYMENT_CONFIRMATION_REQUIRED", "Confirm receipt of funds before posting.");
  const at = new Date(now()).toISOString(), ref = text(reference).slice(0, 120);
  const row = await bridge.fetchEntity("folio", id);
  if (!row?.data?.masterFolioId) throw fail("SPLIT_FOLIO_NOT_FOUND", "The requested split folio does not exist.");
  const existing = Array.isArray(row.data.paymentRows) ? row.data.paymentRows : [];
  const duplicate = existing.find(payment => payment.idempotencyKey === key || (ref && payment.reference === ref));
  if (duplicate) return Object.freeze({ duplicate: true, payment: clone(duplicate), folioVersion: row.version });
  const paid = Number(row.data.paidPaise || 0), due = Number(row.data.balanceDuePaise ?? row.data.allocationTotalPaise ?? 0);
  if (!Number.isSafeInteger(paid) || !Number.isSafeInteger(due) || amount > due) throw fail("SPLIT_FOLIO_OVERPAYMENT", "Payment exceeds the split folio outstanding balance.");
  const nextPaid = paid + amount, nextDue = due - amount;
  const payment = Object.freeze({ id: "split-payment-" + key, idempotencyKey: key, amountPaise: amount, method: paymentMethod, reference: ref, at });
  const ledgerId = "split-payment-ledger-" + key, auditId = "split-payment-audit-" + key;
  const payload = eventPayload("folio.split_payment_posted", { folioId: id, masterFolioId: row.data.masterFolioId, amountPaise: amount, method: paymentMethod, reference: ref, idempotencyKey: key }, at);
  await bridge.mutateEntities([
    { entityType: "folio", entityId: id, expectedVersion: row.version, eventType: "folio.split_payment_posted", eventPayload: payload,
      mutate: entity => Object.assign(entity, { paymentRows: [...existing, clone(payment)], paidPaise: nextPaid, balanceDuePaise: nextDue, updatedAt: at, status: nextDue === 0 ? "PAID" : "PARTIALLY_PAID" }) },
    { entityType: "ledger", entityId: ledgerId, expectedVersion: 0, eventType: "ledger.split_payment_posted", eventPayload: payload,
      mutate: entity => Object.assign(entity, { id: ledgerId, kind: "split_folio_payment", folioId: id, masterFolioId: row.data.masterFolioId, ...clone(payment) }) },
    { entityType: "audit", entityId: auditId, expectedVersion: 0, eventType: "audit.split_payment_posted", eventPayload: payload,
      mutate: entity => Object.assign(entity, { id: auditId, action: "split_folio_payment_posted", folioId: id, masterFolioId: row.data.masterFolioId, ...clone(payment) }) }
  ]);
  const saved = await bridge.fetchEntity("folio", id);
  const stored = saved?.data?.paymentRows?.find(item => item.idempotencyKey === key);
  if (!stored || saved.data.balanceDuePaise !== nextDue) throw fail("SPLIT_PAYMENT_READBACK_FAILED", "Split-folio payment could not be verified.");
  return Object.freeze({ duplicate: false, payment: clone(stored), folioVersion: saved.version, paidPaise: nextPaid, balanceDuePaise: nextDue });
}
