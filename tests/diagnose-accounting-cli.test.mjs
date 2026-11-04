import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const script = fileURLToPath(new URL("../scripts/diagnose-accounting.mjs", import.meta.url));

function runDiagnostic(state, strict = true) {
  const directory = mkdtempSync(join(tmpdir(), "aurelia-accounting-"));
  const backup = join(directory, "backup.json");
  try {
    writeFileSync(backup, JSON.stringify(state), "utf8");
    return spawnSync(process.execPath, [script, backup, ...(strict ? ["--strict"] : [])], {
      encoding: "utf8"
    });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test("strict accounting diagnostic exits non-zero for history mirror drift", () => {
  const result = runDiagnostic({ b: [{
    id: 51, p: 10,
    pays: [{ a: 10, m: "UPI", r: "UTR-51", source: "manual", bookingId: 51 }],
    payments: [{ amount: 9, method: "UPI", reference: "UTR-51", source: "manual", bookingId: 51 }]
  }] });
  assert.equal(result.status, 2, result.stderr);
  assert.match(result.stdout, /"historyMismatchCount": 1/);
});

test("strict accounting diagnostic exits non-zero for duplicate booking identifiers", () => {
  const result = runDiagnostic({ b: [
    { id: "duplicate-52", p: 0, pays: [] },
    { id: "duplicate-52", p: 0, pays: [] }
  ] });
  assert.equal(result.status, 2, result.stderr);
  assert.match(result.stdout, /"duplicateBookingIdCount": 1/);
});

test("strict accounting diagnostic succeeds for a clean backup", () => {
  const result = runDiagnostic({ b: [{ id: 53, p: 10, pays: [{ a: 10 }] }] });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /"mode": "READ_ONLY"/);
});
