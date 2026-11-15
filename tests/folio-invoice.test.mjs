import test from "node:test";
import assert from "node:assert/strict";
import { buildFolioInvoice, formatFolioMinor } from "../src/folios/folio-invoice.mjs";

const booking = {
  id: "B-1", g: "Primary Guest", room: "12", in: 0, out: 2, dc: 0,
  ch: [
    { id: "food-1", description: "Dinner", amount: 1180, category: "dining",
      outlet: "Restaurant", reference: "POS-108", taxProfileId: "food" },
    { id: "laundry-1", description: "Laundry", amount: 100, category: "other" }
  ],
  pays: [{ a: 500, m: "UPI", r: "UTR123", at: "2026-11-16T10:00:00Z" }]
};
const settings = {
  name: "Aurelia PMS", addr: "Property address", gstin: "PROPERTY-GSTIN",
  folioTaxProfiles: [
    { id: "food", rate: 18, supply: "intrastate", inclusive: true, sac: "996331" }
  ]
};

test("invoice includes primary guest, occupants, dated nightly room rows and POS reference", () => {
  const invoice = buildFolioInvoice({
    booking, guest: { n: "Primary Guest", ph: "9999999999", occ: [{ n: "Second Guest" }, { n: "Child" }] },
    room: { t: "Deluxe" }, settings, roomCharge: 2000, paidAmount: 500, balanceDue: 2680
  });
  assert.equal(invoice.billedTo.name, "Primary Guest");
  assert.deepEqual(invoice.billedTo.occupants, ["Second Guest", "Child"]);
  assert.equal(invoice.billedTo.adults, 3);
  assert.equal(invoice.stay.nights, 2);
  assert.equal(invoice.lineItems.filter(line => line.category === "room").length, 2);
  const food = invoice.lineItems.find(line => line.id === "food-1");
  assert.equal(food.outlet, "Restaurant");
  assert.equal(food.reference, "POS-108");
  assert.equal(food.sac, "996331");
});

test("tax is calculated per configured profile and split by place of supply", () => {
  const invoice = buildFolioInvoice({
    booking, guest: { n: "Primary Guest" }, settings, roomCharge: 2000,
    paidAmount: 500, balanceDue: 2680
  });
  const food = invoice.lineItems.find(line => line.id === "food-1");
  assert.equal(food.amountMinor, 118000);
  assert.equal(food.taxableMinor, 100000);
  assert.equal(food.taxMinor, 18000);
  assert.equal(food.cgstMinor, 9000);
  assert.equal(food.sgstMinor, 9000);
  assert.equal(food.igstMinor, 0);
  assert.equal(invoice.totals.taxMinor, 18000);
});

test("interstate tax profile produces IGST without CGST or SGST", () => {
  const invoice = buildFolioInvoice({
    booking, guest: { n: "Primary Guest" },
    settings: { folioTaxProfiles: [{ id: "food", rate: 5, supply: "interstate", inclusive: false }] },
    roomCharge: 0, paidAmount: 0, balanceDue: 0
  });
  const food = invoice.lineItems.find(line => line.id === "food-1");
  assert.equal(food.igstMinor, 5900);
  assert.equal(food.cgstMinor, 0);
  assert.equal(food.sgstMinor, 0);
});

test("discount is allocated and tax is recomputed", () => {
  const invoice = buildFolioInvoice({
    booking: { ...booking, dc: 100 },
    guest: { n: "Primary Guest" }, settings, roomCharge: 0,
    paidAmount: 0, balanceDue: 0
  });
  assert.equal(invoice.totals.discountMinor, 10000);
  assert.ok(invoice.totals.grossMinor < 128000);
});

test("invalid money and invalid configured tax rates fail closed", () => {
  assert.throws(() => buildFolioInvoice({ booking, roomCharge: -1 }), /non-negative/);
  assert.throws(() => buildFolioInvoice({
    booking, roomCharge: 0,
    settings: { folioTaxProfiles: [{ id: "food", rate: 101 }] }
  }), /between 0 and 100/);
});

test("minor-unit formatting is deterministic", () => {
  assert.equal(formatFolioMinor(12345), "123.45");
});
