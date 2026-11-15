/**
 * Canonical folio invoice projection. Tax treatment is explicit per charge;
 * rates and SAC codes are never inferred from free-form descriptions.
 */
const text = value => String(value ?? "").trim();
const money = (value, label = "Amount") => {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0 || !Number.isSafeInteger(Math.round(n * 100)) ||
      Math.abs(n * 100 - Math.round(n * 100)) > 1e-7) {
    throw new TypeError(label + " must be non-negative with at most two decimal places");
  }
  return Math.round(n * 100);
};
const safeDate = value => {
  if (!value) return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
};
const dateFromOffset = value => {
  const offset = Number(value);
  if (!Number.isFinite(offset)) return null;
  const date = new Date();
  date.setHours(12, 0, 0, 0);
  date.setDate(date.getDate() + offset);
  return date.toISOString();
};
const ageAt = dob => {
  if (!dob) return null;
  const birth = new Date(dob);
  if (!Number.isFinite(birth.getTime())) return null;
  const today = new Date();
  let age = today.getFullYear() - birth.getFullYear();
  if (today.getMonth() < birth.getMonth() ||
      (today.getMonth() === birth.getMonth() && today.getDate() < birth.getDate())) age -= 1;
  return age;
};
function getTaxProfile(profiles, key) {
  const row = Array.isArray(profiles) ? profiles.find(item => item && String(item.id) === String(key)) : null;
  if (!row) return null;
  const rate = Number(row.rate);
  if (!Number.isFinite(rate) || rate < 0 || rate > 100) throw new TypeError("Configured tax rate must be between 0 and 100");
  return Object.freeze({
    id: text(row.id), rate,
    supply: row.supply === "interstate" ? "interstate" : "intrastate",
    inclusive: row.inclusive === true,
    sac: text(row.sac)
  });
}
function normalizeCharge(row, index, profiles) {
  const source = Array.isArray(row)
    ? { description: row[0], amount: row[1], category: row[2] || "other" }
    : (row && typeof row === "object" ? row : null);
  if (!source) throw new TypeError("Folio charge " + index + " is malformed");
  const amountMinor = money(source.amount ?? source.a, "Folio charge");
  const profile = getTaxProfile(profiles, source.taxProfileId);
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
  if (!profile || profile.rate === 0) return { taxableMinor: amountMinor, taxMinor: 0 };
  const taxableMinor = profile.inclusive
    ? Math.round(amountMinor / (1 + profile.rate / 100))
    : amountMinor;
  return { taxableMinor, taxMinor: profile.inclusive
    ? amountMinor - taxableMinor
    : Math.round(taxableMinor * profile.rate / 100) };
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
    ...(Array.isArray(booking.ch) ? booking.ch : []).map((row, index) => normalizeCharge(row, index + 1, profiles))
  ];
  const rawLines = charges.map(line => {
    const tax = taxForLine(line.amountMinor, line.taxProfile);
    const grossMinor = line.taxProfile && !line.taxProfile.inclusive
      ? line.amountMinor + tax.taxMinor : line.amountMinor;
    const discountBasisMinor = line.taxProfile?.inclusive ? grossMinor : line.amountMinor;
    return { ...line, ...tax, grossMinor, discountBasisMinor };
  });
  const discountBasisTotal = rawLines.reduce((sum, line) => sum + line.discountBasisMinor, 0);
  const discountMinor = money(booking.dc || 0, "Discount");
  if (discountMinor > discountBasisTotal) throw new RangeError("Discount cannot exceed the folio discount basis");
  const allocations = rawLines.map(line => {
    const exact = discountBasisTotal ? discountMinor * line.discountBasisMinor / discountBasisTotal : 0;
    return { amount: Math.floor(exact), remainder: exact - Math.floor(exact) };
  });
  let remainder = discountMinor - allocations.reduce((sum, row) => sum + row.amount, 0);
  allocations.map((row, index) => ({ ...row, index }))
    .sort((a, b) => b.remainder - a.remainder || a.index - b.index)
    .slice(0, remainder)
    .forEach(row => { allocations[row.index].amount += 1; });
  const lineItems = rawLines.map((line, index) => {
    const lineDiscountMinor = allocations[index].amount;
    const grossAfterDiscount = line.taxProfile?.inclusive
      ? line.grossMinor - lineDiscountMinor : null;
    const taxableMinor = line.taxProfile?.inclusive
      ? Math.round(grossAfterDiscount / (1 + line.taxProfile.rate / 100))
      : line.amountMinor - lineDiscountMinor;
    const taxMinor = line.taxProfile
      ? (line.taxProfile.inclusive ? grossAfterDiscount - taxableMinor : Math.round(taxableMinor * line.taxProfile.rate / 100))
      : 0;
    const cgstMinor = line.taxProfile?.supply === "intrastate" ? Math.floor(taxMinor / 2) : 0;
    const sgstMinor = line.taxProfile?.supply === "intrastate" ? taxMinor - cgstMinor : 0;
    const igstMinor = line.taxProfile?.supply === "interstate" ? taxMinor : 0;
    return Object.freeze({
      ...line, lineDiscountMinor, taxableMinor, taxMinor, cgstMinor, sgstMinor, igstMinor,
      netAmountMinor: taxableMinor + taxMinor
    });
  });
  const subtotalMinor = lineItems.reduce((sum, line) => sum + line.taxableMinor, 0);
  const taxMinor = lineItems.reduce((sum, line) => sum + line.taxMinor, 0);
  const grossMinor = lineItems.reduce((sum, line) => sum + line.netAmountMinor, 0);
  const paidMinor = money(paidAmount, "Paid amount");
  const dueMinor = money(balanceDue, "Balance due");
  const occupants = Array.isArray(guest?.occ) ? guest.occ.filter(row => text(row?.n)) : [];
  const childCount = occupants.filter(row =>
    /child|minor/i.test(text(row?.rel)) || (ageAt(row?.dob) != null && ageAt(row?.dob) < 18)
  ).length;
  const adultCount = 1 + occupants.length - childCount;
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
      name: text(guest?.n || booking.g),
      address: text(guest?.address || guest?.addr),
      phone: text(guest?.ph),
      companyName: text(guest?.companyName),
      companyGstin: text(guest?.companyGstin),
      occupants: Object.freeze(occupants.map(row => text(row.n))),
      adults: Number.isSafeInteger(Number(booking.adults)) ? Number(booking.adults) : adultCount,
      children: Number.isSafeInteger(Number(booking.children)) ? Number(booking.children) : childCount
    }),
    stay: Object.freeze({
      roomNumber: text(booking.room),
      roomType: text(room?.t),
      arrival: safeDate(booking.scheduledCheckIn) || dateFromOffset(booking.in),
      departure: safeDate(booking.scheduledCheckOut) || dateFromOffset(booking.out),
      checkInTime: text(booking.checkInTime),
      checkOutTime: text(booking.checkOutTime),
      nights
    }),
    lineItems: Object.freeze(lineItems),
    totals: Object.freeze({
      subtotalMinor, taxMinor, grossMinor, discountMinor, paidMinor, dueMinor,
      cgstMinor: lineItems.reduce((sum, line) => sum + line.cgstMinor, 0),
      sgstMinor: lineItems.reduce((sum, line) => sum + line.sgstMinor, 0),
      igstMinor: lineItems.reduce((sum, line) => sum + line.igstMinor, 0)
    }),
    payments: Object.freeze((Array.isArray(booking.pays) ? booking.pays : []).map(row => Object.freeze({
      method: text(row?.m || row?.method),
      reference: text(row?.r || row?.reference),
      at: safeDate(row?.at || row?.date),
      amountMinor: money(row?.amountPaise != null ? Number(row.amountPaise) / 100 : (row?.a ?? row?.amount ?? 0), "Payment")
    })))
  });
}
export function formatFolioMinor(minor) {
  if (!Number.isSafeInteger(minor)) throw new TypeError("Minor-unit amount must be a safe integer");
  return (minor / 100).toFixed(2);
}
