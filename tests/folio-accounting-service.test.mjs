import test from "node:test";
import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import { indexedDB } from "fake-indexeddb";
import { IndexedDbPmsRepository } from "../src/storage/indexeddb-pms-repository.mjs";
import { PmsRepositoryBridge } from "../src/storage/pms-repository-bridge.mjs";
import {
  buildRemainingFolioInvoice, buildSplitFolioInvoice, createSplitFolio, financialYearFor, issueFolioInvoice, reconcileLegacyPaymentTotals
} from "../src/folios/folio-accounting-service.mjs";

let fixtureNumber = 0;
function fixture() {
  const repository = new IndexedDbPmsRepository({
    indexedDBImpl: indexedDB, databaseName: "folio-accounting-" + (++fixtureNumber)
  });
  let event = 0;
  const bridge = new PmsRepositoryBridge({
    tenantId: "tenant-local", propertyId: "property-local", deviceId: "device-local",
    now: () => "2026-11-16T12:00:00.000Z",
    eventId: () => "folio-event-" + (++event)
  }).bindActiveEngine(repository);
  return { bridge };
}
const booking = {
  id: "booking-1", folioId: "folio-1", g: "Primary Guest", p: 50,
  pays: [{ a: 50, m: "UPI", r: "UTR-1" }]
};
const invoice = {
  invoiceNumber: "", lineItems: [{ id: "room-1", grossMinor: 10000 }],
  totals: { grossMinor: 10000, taxMinor: 0, subtotalMinor: 10000 }
};

test("financial year is April through March in UTC", () => {
  assert.equal(financialYearFor("2026-03-31T23:59:59Z"), "FY2025-26");
  assert.equal(financialYearFor("2026-04-01T00:00:00Z"), "FY2026-27");
});

test("legacy paid scalar must reconcile exactly with payment rows", () => {
  assert.equal(reconcileLegacyPaymentTotals(booking).matched, true);
  assert.equal(reconcileLegacyPaymentTotals({ ...booking, p: 60 }).matched, false);
});

test("invoice number, invoice snapshot, ledger and audit commit atomically", async () => {
  const { bridge } = fixture();
  const first = await issueFolioInvoice({
    bridge, folioId: "folio-1", booking, invoice,
    now: () => "2026-11-16T12:00:00.000Z", cryptoImpl: webcrypto
  });
  assert.equal(first.invoice.invoiceNumber, "INV/FY2026-27/000001");
  assert.equal(first.duplicate, false);
  const sequence = await bridge.fetchEntity("folio_sequence", "gst-invoice-sequence-FY2026-27");
  assert.equal(sequence.data.nextNumber, 2);
  const ledger = await bridge.fetchEntity("ledger", "invoice-issued-FY2026-27-00000001");
  const audit = await bridge.fetchEntity("audit", "invoice-audit-FY2026-27-00000001");
  assert.equal(ledger.data.invoiceNumber, first.invoice.invoiceNumber);
  assert.equal(audit.data.invoiceHash, first.invoiceHash);
  const duplicate = await issueFolioInvoice({
    bridge, folioId: "folio-1", booking, invoice,
    now: () => "2026-11-16T12:00:00.000Z", cryptoImpl: webcrypto
  });
  assert.equal(duplicate.duplicate, true);
  assert.equal(duplicate.invoice.invoiceNumber, first.invoice.invoiceNumber);
  assert.equal((await bridge.fetchEntity("folio_sequence", "gst-invoice-sequence-FY2026-27")).data.nextNumber, 2);
});

test("unreconciled historical payments block invoice issuance without consuming sequence", async () => {
  const { bridge } = fixture();
  await assert.rejects(issueFolioInvoice({
    bridge, folioId: "folio-1", booking: { ...booking, p: 60 }, invoice,
    now: () => "2026-11-16T12:00:00.000Z", cryptoImpl: webcrypto
  }), error => error.code === "LEGACY_PAYMENT_RECONCILIATION_REQUIRED");
  assert.equal(await bridge.fetchEntity("folio_sequence", "gst-invoice-sequence-FY2026-27"), null);
});

test("failed invoice batch does not consume sequence or create invoice records", async () => {
  const { bridge } = fixture();
  const original = bridge.mutateEntities.bind(bridge);
  bridge.mutateEntities = async () => { throw new Error("simulated transaction failure"); };
  await assert.rejects(issueFolioInvoice({
    bridge, folioId: "folio-1", booking, invoice,
    now: () => "2026-11-16T12:00:00.000Z", cryptoImpl: webcrypto
  }), /simulated transaction failure/);
  bridge.mutateEntities = original;
  assert.equal(await bridge.fetchEntity("folio_sequence", "gst-invoice-sequence-FY2026-27"), null);
  assert.equal(await bridge.fetchEntity("folio", "folio-1"), null);
});

test("split folio preserves master ledger and creates separately billable child atomically", async () => {
  const { bridge } = fixture();
  await bridge.mutateEntity({
    entityType: "folio", entityId: "folio-1", expectedVersion: 0,
    eventType: "folio.created",
    mutate: entity => Object.assign(entity, { id: "folio-1", bookingId: "booking-1", paymentRows: [] })
  });
  const result = await createSplitFolio({
    bridge, masterFolioId: "folio-1", childFolioId: "folio-1-A",
    bookingId: "booking-1", guest: { name: "Second Guest", companyGstin: "27ABCDE1234F1Z5" },
    sourceCharges: [{ id: "room-night-1", description: "Room night", amount: 100 }],
    allocations: [{ chargeId: "room-night-1", amountPaise: 5000 }],
    now: () => "2026-11-16T12:00:00.000Z"
  });
  assert.equal(result.folio.masterFolioId, "folio-1");
  assert.equal(result.folio.allocationTotalPaise, 5000);
  assert.equal((await bridge.fetchEntity("folio", "folio-1")).data.splitAllocations.length, 1);
  assert.ok(await bridge.fetchEntity("ledger", "folio-split-folio-1-A"));
  assert.ok(await bridge.fetchEntity("audit", "folio-split-audit-folio-1-A"));
});

test("split folio rejects over-allocation and duplicate child IDs", async () => {
  const { bridge } = fixture();
  await createSplitFolio({
    bridge, masterFolioId: "folio-master", childFolioId: "folio-child-1",
    bookingId: "booking-1", sourceCharges: [{ id: "charge-1", amount: 10 }],
    allocations: [{ chargeId: "charge-1", amountPaise: 600 }],
    now: () => "2026-11-16T12:00:00.000Z"
  });
  await assert.rejects(createSplitFolio({
    bridge, masterFolioId: "folio-master", childFolioId: "folio-child-2",
    bookingId: "booking-1", sourceCharges: [{ id: "charge-1", amount: 10 }],
    allocations: [{ chargeId: "charge-1", amountPaise: 500 }],
    now: () => "2026-11-16T12:00:00.000Z"
  }), error => error.code === "SPLIT_ALLOCATION_ALREADY_USED");
  await assert.rejects(createSplitFolio({
    bridge, masterFolioId: "folio-master", childFolioId: "folio-child-1",
    bookingId: "booking-1", sourceCharges: [{ id: "charge-1", amount: 10 }],
    allocations: [{ chargeId: "charge-1", amountPaise: 100 }],
    now: () => "2026-11-16T12:00:00.000Z"
  }), error => error.code === "SPLIT_FOLIO_ALREADY_EXISTS");
});

test("split invoice preserves source line tax and uses the split billing identity", () => {
  const masterInvoice = {
    folioNumber: "folio-master", invoiceNumber: "INV/FY2026-27/000001",
    billedTo: { name: "Primary Guest", address: "Main address", phone: "123", occupants: [] },
    property: { legalName: "Aurelia" }, stay: { roomNumber: "12", nights: 1 },
    lineItems: [], totals: { grossMinor: 10000 }
  };
  const splitFolio = {
    id: "folio-split", masterFolioId: "folio-master",
    billingGuest: { name: "Second Guest", companyGstin: "27ABCDE1234F1Z5" },
    allocations: [{
      chargeId: "room-night-1", amountPaise: 5000, sourceDescription: "Room night",
      chargeSnapshot: {
        id: "room-night-1", description: "Room night", grossMinor: 10000,
        amountMinor: 10000, taxableMinor: 8475, taxMinor: 1525,
        cgstMinor: 763, sgstMinor: 762, igstMinor: 0,
        taxProfile: { id: "room", rate: 18, supply: "intrastate", inclusive: true, sac: "996311" }
      }
    }]
  };
  const split = buildSplitFolioInvoice({ masterInvoice, splitFolio, invoiceDate: "2026-11-16T12:00:00Z" });
  assert.equal(split.folioNumber, "folio-split");
  assert.equal(split.billedTo.name, "Second Guest");
  assert.equal(split.billedTo.companyGstin, "27ABCDE1234F1Z5");
  assert.equal(split.totals.grossMinor, 5000);
  assert.equal(split.totals.taxMinor, 763);
  assert.equal(split.invoiceNumber, "");
});

test("remaining master invoice excludes amounts assigned to split folios", () => {
  const masterInvoice = {
    invoiceNumber: "", lineItems: [
      { id: "room-night-1", grossMinor: 10000, taxableMinor: 8475, taxMinor: 1525,
        cgstMinor: 763, sgstMinor: 762, igstMinor: 0 },
      { id: "food-1", grossMinor: 5000, taxableMinor: 5000, taxMinor: 0,
        cgstMinor: 0, sgstMinor: 0, igstMinor: 0 }
    ],
    totals: { grossMinor: 15000, paidMinor: 0 }
  };
  const remaining = buildRemainingFolioInvoice({
    masterInvoice,
    masterFolio: { splitAllocations: [{ allocations: [{ chargeId: "room-night-1", amountPaise: 4000 }] }] }
  });
  assert.equal(remaining.totals.grossMinor, 11000);
  assert.equal(remaining.lineItems.find(x => x.id === "room-night-1").grossMinor, 6000);
  assert.equal(remaining.lineItems.find(x => x.id === "food-1").grossMinor, 5000);
});
