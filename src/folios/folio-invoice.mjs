/**
 * Folio invoice projection.
 *
 * Keeps tax classification explicit per charge. No GST rate or SAC code is
 * inferred from a description: the property's configured tax profile is the
 * only source of tax treatment.
 */
const text = value => String(value ?? "").trim();
const money = (value, label = "Amount") => {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0 || !Number.isSafeInteger(Math.round(n * 100)) ||
      Math.abs(n * 100 - Math.round(n * 100)) > 1e-7) {
    throw new TypeError(label + " must be a non-negative amount with at most two decimal places");
  }
  return Math.round(n * 100);
};
const fromMinor = value => value / 100;
const safeDate = value => {
  if (!value) return null;
  const d = new Date(value);
  return Number.isFinite(d.getTime()) ? d.toISOString() : null;
};
const taxProfile = (profiles, key) => {
  const row = Array.isArray(profiles) ? profiles.find(x => x && String(x.id) === String(key)) : null;
  if (!row) return null;
  const rate = Number(row.rate);
  if (!Number.isFinite(rate) || rate < 0 || rate > 100) {
    throw new TypeError("Configured tax rate must be between 0 and 100");
  }
  const supply = row.supply === "interstate" ? "interstate" : "intrastate";
  const inclusive = row.inclusive === true;
  const sac = text(row.sac);
  return Object.freeze({ id: text(row.id), rate, supply, inclusive, sac });
};

function normalizeCharge(row, index, profiles) {
  const source = Array.isArray(row)
    ? { description: row[0], amount: row[1], category: row[2] || "other" }
    : (row && typeof row === "object" ? row : null);
  if (!source) throw new TypeError("Folio charge " + index + " is malformed");
  const amountMinor = money(source.amount ?? source.a, "Folio charge");
  const profile = taxProfile(profiles, source.taxProfileId);
  return Object.freeze({
    id: text(source.id) || "charge-" + index,
    date: safeDate(source.date || source.at),
    description: text(source.description || source.label || source.name) || "Charge",
    category: text(source.category) || "other",
    outlet: text(source.outlet),
    reference: text(source.reference || source.checkNumber),
    sac: profile?.sac || text(source.sac),
    amountMinor,
    taxProfile: profile
  });
}

function taxForLine(amountMinor, profile) {
  if (!profile || profile.rate === 0) {
    return Object.freeze({ taxableMinor: amountMinor, taxMinor: 0, cgstMinor: 0, sgstMinor: 0, igstMinor: 0 });
  }
  const taxableMinor = profile.inclusive
    ? Math.round(amountMinor / (1 + profile.rate / 100))
    : amountMinor;
  const taxMinor = profile.inclusive ? amountMinor - taxableMinor : Math.round(taxableMinor * profile.rate / 100);
  const cgstMinor = profile.supply === "intrastate" ? Math.floor(taxMinor / 2) : 0;
  const sgstMinor = profile.supply === "intrastate" ? taxMinor - cgstMinor : 0;
  const igstMinor = profile.supply === "interstate" ? taxMinor : 0;
  return Object.freeze({ taxableMinor, taxMinor, cgstMinor, sgstMinor, igstMinor });
}

export function buildFolioInvoice({
  booking, guest = null, room = null, settings = {}, roomCharge = 0,
  paidAmount = 0, balanceDue = 0, invoiceDate = new Date().toISOString()
} = {}) {
  if (!booking || typeof booking !== "object" || booking.id == null) {
    throw new TypeError("A persisted booking with a stable ID is required");
  }
  const profiles = Array.isArray(settings.folioTaxProfiles) ? settings.folioTaxProfiles : [];
  const nights = Math.max(1, Math.trunc(Number(booking.out) - Number(booking.in)) || 1);
  const charges = [
    normalizeCharge({
      id: "room-" + booking.id,
      description: "Room accommodation · " + text(booking.room),
      amount: roomCharge,
      category: "room",
      taxProfileId: booking.roomTaxProfileId || settings.roomTaxProfileId
    }, 0, profiles),
    ...(Array.isArray(booking.ch) ? booking.ch : []).map((row, i) => normalizeCharge(row, i + 1, profiles))
  ];
  const rawLines = charges.map(line => ({ ...line, ...taxForLine(line.amountMinor, line.taxProfile) }));
  const rawSubtotalMinor = rawLines.reduce((sum, line) => sum + line.taxableMinor, 0);
  const discountMinor = money(booking.dc || 0, "Discount");
  if (discountMinor > rawSubtotalMinor) throw new RangeError("Discount cannot exceed the taxable subtotal");
  const allocations = rawLines.map(line => {
    const exact = rawSubtotalMinor ? discountMinor * line.taxableMinor / rawSubtotalMinor : 0;
    return { base: Math.floor(exact), remainder: exact - Math.floor(exact) };
  });
  let undistributed = discountMinor - allocations.reduce((sum, x) => sum + x.base, 0);
  allocations.map((x, index) => ({ ...x, index })).sort((a, b) => b.remainder - a.remainder || a.index - b.index)
    .slice(0, undistributed).forEach(x => { allocations[x.index].base += 1; });
  const lineItems = rawLines.map((line, index) => {
    const lineDiscountMinor = allocations[index].base;
    const taxableMinor = line.taxableMinor - lineDiscountMinor;
    const taxMinor = line.taxProfile ? Math.round(taxableMinor * line.taxProfile.rate / 100) : 0;
    const cgstMinor = line.taxProfile?.supply === "intrastate" ? Math.floor(taxMinor / 2) : 0;
    const sgstMinor = line.taxProfile?.supply === "intrastate" ? taxMinor - cgstMinor : 0;
    const igstMinor = line.taxProfile?.supply === "interstate" ? taxMinor : 0;
    return Object.freeze({ ...line, lineDiscountMinor, taxableMinor, taxMinor, cgstMinor, sgstMinor, igstMinor,
      netAmountMinor: taxableMinor + taxMinor });
  });
  const subtotalMinor = lineItems.reduce((sum, line) => sum + line.taxableMinor, 0);
  const taxMinor = lineItems.reduce((sum, line) => sum + line.taxMinor, 0);
  const grossMinor = subtotalMinor + taxMinor;
  const paidMinor = money(paidAmount, "Paid amount");
  const dueMinor = money(balanceDue, "Balance due");
  const occupants = Array.isArray(guest?.occ)
    ? guest.occ.map(x => text(x?.n)).filter(Boolean)
    : [];
  const primaryGuest = text(guest?.n || booking.g);
  const guestCount = 1 + occupants.length;
  return Object.freeze({
    invoiceNumber: text(booking.iv),
    folioNumber: text(booking.folioId || "booking-" + booking.id),
    invoiceDate: safeDate(invoiceDate),
    property: Object.freeze({
      legalName: text(settings.legalName || settings.name),
      address: text(settings.addr),
      phone: text(settings.phone),
      gstin: text(settings.gstin || settings.tax)
    }),
    billedTo: Object.freeze({
      name: primaryGuest,
      address: text(guest?.address || guest?.addr),
      phone: text(guest?.ph),
      companyName: text(guest?.companyName),
      companyGstin: text(guest?.companyGstin),
      occupants: Object.freeze(occupants),
      adults: Number.isSafeInteger(Number(booking.adults)) ? Number(booking.adults) : guestCount,
      children: Number.isSafeInteger(Number(booking.children)) ? Number(booking.children) : 0
    }),
    stay: Object.freeze({
      roomNumber: text(booking.room),
      roomType: text(room?.t),
      arrival: text(booking.scheduledCheckIn) || text(booking.in),
      departure: text(booking.scheduledCheckOut) || text(booking.out),
      checkInTime: text(booking.checkInTime),
      checkOutTime: text(booking.checkOutTime),
      nights
    }),
    lineItems: Object.freeze(lineItems),
    totals: Object.freeze({
      subtotalMinor, taxMinor, grossMinor, discountMinor, paidMinor, dueMinor,
      cgstMinor: lineItems.reduce((n, x) => n + x.cgstMinor, 0),
      sgstMinor: lineItems.reduce((n, x) => n + x.sgstMinor, 0),
      igstMinor: lineItems.reduce((n, x) => n + x.igstMinor, 0)
    }),
    payments: Object.freeze((Array.isArray(booking.pays) ? booking.pays : []).map(p => Object.freeze({
      method: text(p?.m || p?.method),
      reference: text(p?.r || p?.reference),
      at: safeDate(p?.at || p?.date),
      amountMinor: money(p?.amountPaise != null ? Number(p.amountPaise) / 100 : (p?.a ?? p?.amount ?? 0), "Payment")
    })))
  });
}

export function formatFolioMinor(minor) {
  if (!Number.isSafeInteger(minor)) throw new TypeError("Minor-unit amount must be a safe integer");
  return (minor / 100).toFixed(2);
}
