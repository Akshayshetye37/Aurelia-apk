import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

const source = await readFile(
  new URL("../src/features/payments/reconciliation-bridge.js", import.meta.url),
  "utf8"
);

function loadBridge(native) {
  const window = { AureliaNative: native };
  vm.runInNewContext(source, { window, JSON, Number, String, Error });
  return window.AureliaUPIReconciliation;
}

test("fetchPendingEvidence validates and converts integer paise", () => {
  const bridge = loadBridge({
    fetchUnprocessedSignals: () => JSON.stringify([{
      id: 3, sourcePackage: "com.phonepe.app", utr: "UTR12345678",
      amountPaise: 12550, notificationText: "Money received ₹125.50",
      receivedAt: 1770000000000, status: "pending"
    }]),
    markSignalProcessed: () => JSON.stringify({ ok: true })
  });
  const rows = bridge.fetchPendingEvidence();
  assert.equal(rows[0].amountRupees, 125.5);
  assert.equal(rows[0].verified, false);
});

test("fetchPendingEvidence distinguishes native queue failure from empty queue", () => {
  const bridge = loadBridge({
    fetchUnprocessedSignals: () => JSON.stringify({ error: true, message: "database unavailable" }),
    markSignalProcessed: () => JSON.stringify({ ok: true })
  });
  assert.throws(() => bridge.fetchPendingEvidence(), /database unavailable/);
});

test("updateEvidenceStatus requires native acknowledgement", () => {
  const bridge = loadBridge({
    fetchUnprocessedSignals: () => "[]",
    markSignalProcessed: () => JSON.stringify({ ok: false, error: "record missing" })
  });
  assert.throws(() => bridge.updateEvidenceStatus(1, "reviewed", ""), /record missing/);
});

test("updateEvidenceStatus rejects unsupported statuses", () => {
  const bridge = loadBridge({
    fetchUnprocessedSignals: () => "[]",
    markSignalProcessed: () => JSON.stringify({ ok: true })
  });
  assert.throws(() => bridge.updateEvidenceStatus(1, "settled", ""), /Invalid evidence status/);
});

test("possible existing folio match stays visible for staff recovery", () => {
  const state = { b: [{ id: 17, room: "A1", pays: [{ r: "UTR12345678", a: 125.5 }] }] };
  let statusUpdates = 0;
  // This test explicitly asserts advisory recovery never auto-acknowledges queue evidence.
  const window = { AureliaNative: {
    fetchUnprocessedSignals: () => JSON.stringify([{
      id: 9, sourcePackage: "com.phonepe.app", utr: "UTR12345678",
      amountPaise: 12550, notificationText: "Money received ₹125.50",
      receivedAt: 1770000000000, status: "pending"
    }]),
    markSignalProcessed: () => { statusUpdates++; return JSON.stringify({ ok: true }); }
  }, aureliaGetAppState: () => state };
  vm.runInNewContext(source, { window, JSON, Number, String, Error });
  const rows = window.AureliaUPIReconciliation.fetchPendingEvidence();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].possibleExistingFolioMatch, true);
  assert.equal(rows[0].matchedRoom, "A1");
  assert.equal(statusUpdates, 0);
});

test("conflict status can be moved to staff review", () => {
  const bridge = loadBridge({
    fetchUnprocessedSignals: () => "[]",
    markSignalProcessed: (_id, status) => JSON.stringify({ ok: true, status })
  });
  assert.equal(bridge.updateEvidenceStatus(4, "conflict", "amount mismatch").ok, true);
});
