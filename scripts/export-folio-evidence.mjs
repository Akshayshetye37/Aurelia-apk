#!/usr/bin/env node
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

function paise(value, label) {
  const amount = typeof value === "number" ? value
    : typeof value === "string" && /^\d+(?:\.\d{1,2})?$/.test(value.trim()) ? Number(value)
    : Number.NaN;
  const scaled = amount * 100;
  const result = Math.round(scaled);
  if (!Number.isFinite(amount) || amount < 0 || !Number.isSafeInteger(result) ||
      Math.abs(scaled - result) > 1e-7) {
    throw new TypeError(label + " is not a valid non-negative INR amount");
  }
  return result;
}

function maskReference(value) {
  const normalized = String(value ?? "").replace(/\s+/g, "");
  if (!normalized) return null;
  return { last4: normalized.slice(-4), length: normalized.length };
}

function paymentEvidence(row) {
  if (!row || typeof row !== "object" || Array.isArray(row)) throw new TypeError("Payment evidence row is malformed");
  const amountPaise = Number.isSafeInteger(row.amountPaise) ? row.amountPaise : paise(row.a ?? row.amount, "Payment amount");
  if (!Number.isSafeInteger(amountPaise) || amountPaise <= 0) throw new RangeError("Payment amount must be positive safe integer paise");
  return {
    amountPaise,
    method: String(row.m ?? row.method ?? ""),
    source: String(row.source ?? "legacy_unspecified"),
    timestamp: row.at ?? row.date ?? null,
    reference: maskReference(row.r ?? row.reference),
    verificationConfirmed: row.verificationConfirmed === true,
    automatic: row.auto === true,
    bookingId: row.bookingId == null ? null : String(row.bookingId)
  };
}

function summarizeBooking(booking, rooms) {
  const room = rooms.find(item => String(item?.n) === String(booking.room));
  const suppliedRate = Number(booking.rate);
  const hasValidRateSnapshot = booking.rate != null && Number.isFinite(suppliedRate) &&
    suppliedRate >= 0 && Number.isSafeInteger(Math.round(suppliedRate * 100));
  const rateValue = hasValidRateSnapshot ? Math.round(suppliedRate * 100) / 100 : (room || { r: 0 }).r;
  const ratePaise = paise(rateValue, "Room rate");
  const nights = Number(booking.out) - Number(booking.in);
  if (!Number.isSafeInteger(nights) || nights < 0) throw new TypeError("Booking has invalid in/out day offsets");
  const stayNights = Math.max(1, nights);
  if (!Array.isArray(booking.ch)) throw new TypeError("Booking charge collection is missing or malformed");
  const charges = booking.ch;
  const chargeLines = charges.map((line, index) => {
    if (!Array.isArray(line) || line.length < 2) throw new TypeError("Booking charge line " + index + " is malformed");
    return { description: String(line[0] ?? ""), amountPaise: paise(line[1], "Charge line amount") };
  });
  const discountPaise = paise(booking.dc ?? 0, "Booking discount");
  const paidPaise = paise(booking.p ?? 0, "Booking paid total");
  const roomChargePaise = ratePaise * stayNights;
  if (!Number.isSafeInteger(roomChargePaise)) throw new RangeError("Room charge exceeds safe paise range");
  const chargesPaise = chargeLines.reduce((sum, line) => sum + line.amountPaise, 0);
  const totalPaise = roomChargePaise + chargesPaise - discountPaise;
  if (!Number.isSafeInteger(totalPaise) || totalPaise < 0) throw new RangeError("Calculated booking total is invalid");
  const paymentRows = Array.isArray(booking.pays) ? booking.pays : [];
  const historyRows = Array.isArray(booking.payments) ? booking.payments : [];
  return {
    bookingId: String(booking.id),
    folioId: booking.folioId == null ? null : String(booking.folioId),
    room: String(booking.room ?? ""),
    status: String(booking.st ?? ""),
    checkInDayOffset: booking.in,
    checkOutDayOffset: booking.out,
    nights: stayNights,
    ratePaise,
    roomChargePaise,
    chargeLines,
    discountPaise,
    totalPaise,
    paidPaise,
    balanceDuePaise: totalPaise - paidPaise,
    pays: paymentRows.map(paymentEvidence),
    paymentsCompatibilityHistory: historyRows.map(paymentEvidence)
  };
}

/** Build a PII-minimized report from a real owner-exported PMS JSON snapshot. */
export function buildFolioEvidenceExport(state, sourceSha256) {
  if (typeof sourceSha256 !== "string" || !/^[a-f0-9]{64}$/.test(sourceSha256)) throw new TypeError("A source SHA-256 digest is required");
  if (!state || typeof state !== "object" || Array.isArray(state) ||
      !Array.isArray(state.b) || !Array.isArray(state.rooms)) {
    throw new TypeError("PMS snapshot must contain bookings 'b' and rooms arrays");
  }
  const summaries = state.b.map(booking => {
    if (!booking || typeof booking !== "object" || Array.isArray(booking) ||
        booking.id == null || String(booking.id).trim() === "") {
      throw new TypeError("Every exported booking must have a stable booking ID");
    }
    return { booking, summary: summarizeBooking(booking, state.rooms) };
  });
  const manualCash = [];
  const staffReviewedUpi = [];
  const unpaidBalance = [];
  for (const { booking, summary } of summaries) {
    const payments = summary.pays;
    if (payments.some(payment => payment.method.toLowerCase() === "cash" &&
        payment.automatic !== true && ["manual", "legacy_unspecified"].includes(payment.source))) {
      manualCash.push(summary);
    }
    if (payments.some(payment => payment.method.toLowerCase() === "upi" &&
        payment.source === "staff_review" && payment.verificationConfirmed)) {
      const evidence = (Array.isArray(state.sig) ? state.sig : [])
        .filter(row => String(row?.b ?? row?.bookingId ?? "") === String(booking.id));
      summary.staffReviewEvidence = evidence.map(row => ({
        evidenceId: row.id == null ? null : String(row.id),
        status: String(row.st ?? ""),
        amountPaise: row.amt == null ? null : paise(row.amt, "Evidence amount"),
        reference: maskReference(row.ref),
        approvedAt: row.approvedAt ?? null
      }));
      staffReviewedUpi.push(summary);
    }
    if (summary.balanceDuePaise > 0) unpaidBalance.push(summary);
  }
  return {
    reportType: "AURELIA_FOLIO_EVIDENCE_READ_ONLY",
    schemaVersion: 1,
    sourceSha256,
    generatedAt: new Date().toISOString(),
    piiPolicy: "Guest name, phone, email, identity numbers, images, secrets and full payment references are excluded.",
    groups: { manualCash, staffReviewedUpi, unpaidBalance },
    counts: {
      activeBookings: state.b.length,
      manualCashBookings: manualCash.length,
      staffReviewedUpiBookings: staffReviewedUpi.length,
      unpaidBalanceBookings: unpaidBalance.length,
      legacyPaymentFoliosPresent: Array.isArray(state.paymentFolios) ? state.paymentFolios.length : null
    },
    interpretation: {
      runningBalance: "The UI calculates due from room charge + booking.ch charge lines - booking.dc - booking.p.",
      canonicalPaymentRows: "booking.pays",
      paidTotalUsedByRunningBalance: "booking.p",
      compatibilityPaymentHistory: "booking.payments",
      paymentFolios: "Not used by the running-balance expression in index.html; presence is reported only.",
      settlementJournal: "A separate provider-command journal; it is not read by the UI running-balance calculation."
    }
  };
}

async function main() {
  const input = process.argv[2], output = process.argv[3];
  if (!input || !output || input.startsWith("-") || output.startsWith("-")) {
    console.error("Usage: node scripts/export-folio-evidence.mjs <owner-backup.json> <new-report.json>");
    process.exitCode = 64;
    return;
  }
  try {
    const inputPath = resolve(input), outputPath = resolve(output);
    const raw = await readFile(inputPath, "utf8");
    const state = JSON.parse(raw);
    const digest = createHash("sha256").update(raw, "utf8").digest("hex");
    const report = buildFolioEvidenceExport(state, digest);
    // Exclusive create avoids silently overwriting a prior evidence export.
    await writeFile(outputPath, JSON.stringify(report, null, 2) + "\n", { flag: "wx", mode: 0o600 });
    console.log(JSON.stringify({ mode: "READ_ONLY", output: outputPath, sourceSha256: digest, counts: report.counts }, null, 2));
  } catch (error) {
    console.error("Folio evidence export failed:", error.message);
    process.exitCode = 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  await main();
}
