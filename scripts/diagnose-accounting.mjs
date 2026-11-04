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
    const report = diagnoseAccountingConsistency(state);
    console.log(JSON.stringify({
      mode: "READ_ONLY",
      input: resolve(input),
      generatedAt: new Date().toISOString(),
      ...report
    }, null, 2));
    const hasFindings = report.affectedBookingCount ||
      report.malformedBookingCount ||
      report.duplicatePaymentCount ||
      report.orphanAdvanceCount ||
      report.refundOverpaymentCount ||\n      report.historyMismatchCount ||\n      report.missingBookingIdCount ||\n      report.duplicateBookingIdCount;
    if (process.argv.includes("--strict") && hasFindings) process.exitCode = 2;
  } catch (error) {
    console.error("Accounting diagnostic failed:", error.message);
    process.exitCode = 1;
  }
}
