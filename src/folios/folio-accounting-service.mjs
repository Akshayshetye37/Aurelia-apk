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
  if (invoice.lineItems.some(line => !line.taxProfile || !line.taxProfile.id)) {\n    throw fail("TAX_PROFILE_MISSING", "Every invoice charge requires an explicit configured tax profile, including an explicit zero-rate/exempt profile.");\n  }\n  const paymentReconciliation = reconcileLegacyPaymentTotals(booking);
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
  bridge, masterFolioId, childFolioId, bookingId, guest, sourceCharges,
  allocations, reason = "corporate_reimbursement", now = () => new Date().toISOString(),
  maxRetries = 6
} = {}) {
  if (!bridge || typeof bridge.fetchEntity !== "function" || typeof bridge.mutateEntities !== "function") {
    throw new TypeError("A bound transactional repository bridge is required");
  }
  await assertCompatibilityUiAllowed(bridge);
  const masterId = safeId(masterFolioId, "master folio ID");
  const childId = safeId(childFolioId, "split folio ID");
  const bookingKey = safeId(bookingId, "booking ID");
  if (masterId === childId) throw new TypeError("A split folio must have a different ID from its master");
  if (!Array.isArray(sourceCharges) || !Array.isArray(allocations) || !allocations.length) {
    throw new TypeError("Source charges and at least one split allocation are required");
  }
  const normalized = allocations.map((allocation, index) => {
    const chargeId = safeId(allocation?.chargeId, "charge ID");
    return Object.freeze({ chargeId, amountPaise: paise(allocation.amountPaise, "Allocation amount"), index });
  });
  if (new Set(normalized.map(x => x.chargeId)).size !== normalized.length) {
    throw new TypeError("Duplicate charge allocations are not allowed");
  }
  const sourceMap = new Map(sourceCharges.map((charge, index) => [
    text(charge?.id) || "legacy-charge-" + index,
    { ...clone(charge), id: text(charge?.id) || "legacy-charge-" + index }
  ]));
  for (const allocation of normalized) {
    const source = sourceMap.get(allocation.chargeId);
    if (!source) throw fail("SPLIT_SOURCE_CHARGE_MISSING", "A split allocation references a missing source charge.");
    const amount = source.amountPaise != null ? paise(source.amountPaise, "Source charge amount") :
      Math.round(Number(source.amount || source.a || 0) * 100);
    if (!Number.isSafeInteger(amount) || amount < 0 || allocation.amountPaise > amount) {
      throw fail("SPLIT_ALLOCATION_EXCEEDS_CHARGE", "A split allocation exceeds its source charge.");
    }
  }
  const issuedAt = new Date(now()).toISOString();
  for (let attempt = 0; attempt < maxRetries; attempt += 1) {
    const [masterRow, childRow, allFolios, ledgerRows] = await Promise.all([
      bridge.fetchEntity("folio", masterId),
      bridge.fetchEntity("folio", childId),
      bridge.listEntities("folio"),
      bridge.listEntities("ledger")
    ]);
    if (childRow) throw fail("SPLIT_FOLIO_ALREADY_EXISTS", "The split folio ID already exists.");
    if (masterRow?.data?.bookingId && String(masterRow.data.bookingId) !== bookingKey) {
      throw fail("FOLIO_BOOKING_MISMATCH", "The master folio belongs to another booking.");
    }
    const used = new Map();
    for (const row of allFolios) {
      for (const entry of row.data?.splitAllocations || []) {
        for (const item of entry.allocations || []) used.set(item.chargeId, (used.get(item.chargeId) || 0) + item.amountPaise);
      }
    }
    const allocated = normalized.map(item => {
      const source = sourceMap.get(item.chargeId);
      const sourceAmount = source.amountPaise != null ? paise(source.amountPaise, "Source charge amount") : Math.round(Number(source.amount || source.a || 0) * 100);
      if ((used.get(item.chargeId) || 0) + item.amountPaise > sourceAmount) {
        throw fail("SPLIT_ALLOCATION_ALREADY_USED", "The requested amount has already been allocated to another split folio.");
      }
      return { chargeId: item.chargeId, amountPaise: item.amountPaise, sourceDescription: text(source.description || source.label || source[0]), chargeSnapshot: clone(source) };
    });
    const allocationTotalPaise = allocated.reduce((sum, row) => sum + row.amountPaise, 0);
    const ledgerId = "folio-split-" + childId;
    const auditId = "folio-split-audit-" + childId;
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
          allocationTotalPaise, paymentRows: [], invoiceIssued: null,
          createdAt: issuedAt, updatedAt: issuedAt, status: "OPEN"
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
      if (!saved || saved.data.masterFolioId !== masterId ||
          saved.data.allocationTotalPaise !== allocationTotalPaise) {
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
