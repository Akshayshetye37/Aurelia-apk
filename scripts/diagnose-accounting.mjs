#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { diagnoseAccountingConsistency } from "../src/payments/accounting-consistency-diagnostic.mjs";

const input = process.argv[2];
if (!input || input.startsWith("-")) {
  console.error("Usage: node scripts/diagnose-accounting.mjs <pms-backup.json> [--strict]");
  process.exitCode = 64;
} else {
  try {
    const raw = await readFile(resolve(input), "utf8");
    const state = JSON.parse(raw);
    // A truncated/wrong-format export must never look like a clean empty PMS.
    if (!state || typeof state !== "object" || Array.isArray(state) || !Array.isArray(state.b)) {
      throw new TypeError("Backup root must be an object containing the active bookings array 'b'");
    }
    if (state.cancelled !== undefined && !Array.isArray(state.cancelled)) {
      throw new TypeError("Backup 'cancelled' collection must be an array when present");
    }

    const report = diagnoseAccountingConsistency(state);
    console.log(JSON.stringify({
      mode: "READ_ONLY",
      input: resolve(input),
      generatedAt: new Date().toISOString(),
      ...report
    }, null, 2));

    const findingCounts = [
      "affectedBookingCount",
      "malformedBookingCount",
      "duplicatePaymentCount",
      "orphanAdvanceCount",
      "refundOverpaymentCount",
      "historyMismatchCount",
      "missingBookingIdCount",
      "duplicateBookingIdCount",
      "malformedJournalCount",
      "unbalancedJournalCount",
      "duplicateJournalIdCount",
      "duplicateCancellationPostingCount",
      "cancellationFlagMismatchCount"
    ];
    const hasFindings = findingCounts.some(key => report[key] > 0);
    if (hasFindings) process.exitCode = 2;
  } catch (error) {
    console.error("Accounting diagnostic failed:", error.message);
    process.exitCode = 1;
  }
}
