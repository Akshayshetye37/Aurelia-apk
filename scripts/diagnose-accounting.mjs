#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { diagnoseAccountingConsistency } from "../src/payments/accounting-consistency-diagnostic.mjs";

const args = process.argv.slice(2);
const input = args.find(arg => !arg.startsWith("--"));
const strict = args.includes("--strict");
const privateReport = args.includes("--private-report");

if (!input || args.some(arg => !arg.startsWith("--") && arg !== input) ||
    args.some(arg => !["--strict", "--private-report"].includes(arg) && arg.startsWith("--"))) {
  console.error("Usage: node scripts/diagnose-accounting.mjs <pms-backup.json> [--strict] [--private-report]");
  process.exitCode = 64;
} else {
  try {
    const raw = await readFile(resolve(input), "utf8");
    const state = JSON.parse(raw);
    const report = diagnoseAccountingConsistency(state);
    const hasFindings = report.affectedBookingCount ||
      report.malformedBookingCount ||
      report.duplicatePaymentCount ||
      report.orphanAdvanceCount ||
      report.refundOverpaymentCount ||
      report.historyMismatchCount ||
      report.missingBookingIdCount ||
      report.duplicateBookingIdCount ||
      report.malformedJournalCount ||
      report.unbalancedJournalCount ||
      report.duplicateJournalIdCount ||
      report.duplicateCancellationPostingCount ||
      report.cancellationFlagMismatchCount;

    // Default output is safe for CI/log capture: no booking IDs, guest/room
    // details, payment references, idempotency keys or row-level payloads.
    const summary = {
      mode: "READ_ONLY",
      privacy: privateReport ? "PRIVATE_ROW_LEVEL_REPORT" : "REDACTED_SUMMARY",
      generatedAt: new Date().toISOString(),
      scannedBookingCount: report.scannedBookingCount,
      affectedBookingCount: report.affectedBookingCount,
      malformedBookingCount: report.malformedBookingCount,
      duplicatePaymentCount: report.duplicatePaymentCount,
      orphanAdvanceCount: report.orphanAdvanceCount,
      refundOverpaymentCount: report.refundOverpaymentCount,
      historyMismatchCount: report.historyMismatchCount,
      missingBookingIdCount: report.missingBookingIdCount,
      duplicateBookingIdCount: report.duplicateBookingIdCount,
      malformedJournalCount: report.malformedJournalCount,
      unbalancedJournalCount: report.unbalancedJournalCount,
      duplicateJournalIdCount: report.duplicateJournalIdCount,
      duplicateCancellationPostingCount: report.duplicateCancellationPostingCount,
      cancellationFlagMismatchCount: report.cancellationFlagMismatchCount,
      totalAbsoluteDiscrepancyPaise: report.totalAbsoluteDiscrepancyPaise,
      hasFindings: Boolean(hasFindings)
    };
    console.log(JSON.stringify(privateReport ? { ...summary, report } : summary, null, 2));
    if (strict && hasFindings) process.exitCode = 2;
  } catch (error) {
    // Avoid printing input paths or raw record values in shared logs.
    console.error("Accounting diagnostic failed:", error.message);
    process.exitCode = 1;
  }
}
