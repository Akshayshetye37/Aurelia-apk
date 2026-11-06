import test from "node:test";
import assert from "node:assert/strict";
import { SmartCheckpoint, calculateFolioCheckpoint } from "../src/payments/smart-checkpoint.mjs";

function fixture() {
  const folio = {
    folioId: "folio-1", version: 4, currency: "INR", status: "OPEN",
    chargeLines: [{ kind: "CHARGE", amountPaise: 23000 }],
    adjustmentLines: [],
    paymentEntries: [{ paymentId: "gateway-1", kind: "PAYMENT", status: "VERIFIED", amountPaise: 20000, method: "Razorpay" }],
    auditTrail: []
  };
  const repository = {
    current: folio,
    async readFolio(id) { return id === this.current.folioId ? structuredClone(this.current) : null; },
    async transactFolio(id, callback) {
      if (id !== this.current.folioId) throw new Error("not found");
      // Simulates a single local database readwrite transaction.
      const working = structuredClone(this.current);
      const result = await callback(working);
      this.current = working;
      return result;
    }
  };
  return { folio, repository, checkpoint: new SmartCheckpoint({ repository, now: () => "2026-11-07T00:00:00.000Z" }) };
}
const staff = { userId: "frontdesk-1", role: "staff" };
const manager = { userId: "manager-1", role: "manager" };

test("computes due from net charges, verified payments and refunds in paise", () => {
  const { folio } = fixture();
  folio.adjustmentLines.push({ kind: "DISCOUNT", amountPaise: 1000 });
  folio.paymentEntries.push({ paymentId: "cash-refund", kind: "REFUND", status: "POSTED", amountPaise: 500 });
  const result = calculateFolioCheckpoint(folio);
  assert.equal(result.netChargesPaise, 22000);
  assert.equal(result.verifiedPaymentsPaise, 20000);
  assert.equal(result.refundsPaise, 500);
  assert.equal(result.remainingDuePaise, 2500);
  assert.equal(result.state, "PARTIALLY_PAID");
});

test("unverified gateway evidence is excluded from received funds and forces review", () => {
  const { folio } = fixture();
  folio.paymentEntries.push({ paymentId: "gateway-2", kind: "PAYMENT", status: "PENDING", amountPaise: 3000 });
  const result = calculateFolioCheckpoint(folio);
  assert.equal(result.verifiedPaymentsPaise, 20000);
  assert.equal(result.unverifiedCount, 1);
  assert.equal(result.state, "PENDING_REVIEW");
});

test("stale folio version rejects approval without changing the ledger", async () => {
  const { repository, checkpoint } = fixture();
  await assert.rejects(checkpoint.recordPayment({
    folioId: "folio-1", expectedVersion: 3, amountPaise: 3000,
    method: "Cash", paymentId: "cash-1", staff
  }), error => error.code === "FOLIO_VERSION_CONFLICT");
  assert.equal(repository.current.paymentEntries.length, 1);
  assert.equal(repository.current.version, 4);
});

test("staff can post cash as a distinct idempotent payment and the folio remains due", async () => {
  const { repository, checkpoint } = fixture();
  const input = { folioId: "folio-1", expectedVersion: 4, amountPaise: 3000, method: "Cash", reference: "", paymentId: "cash-1", staff };
  const first = await checkpoint.recordPayment(input);
  assert.equal(first.checkpoint.remainingDuePaise, 0);
  assert.equal(first.checkpoint.state, "SETTLEMENT_READY");
  assert.equal(repository.current.version, 5);
  const replay = await checkpoint.recordPayment(input);
  assert.equal(replay.duplicate, true);
  assert.equal(repository.current.paymentEntries.length, 2);
  assert.equal(repository.current.version, 5);
});

test("staff cannot write off; manager write-off is reasoned and audited", async () => {
  const { repository, checkpoint } = fixture();
  const input = { folioId: "folio-1", expectedVersion: 4, amountPaise: 3000, reason: "Minibar charge waived", adjustmentId: "adj-1", staff };
  await assert.rejects(checkpoint.approveWriteOff(input), error => error.code === "MANAGER_APPROVAL_REQUIRED");
  const result = await checkpoint.approveWriteOff({ ...input, staff: manager });
  assert.equal(result.checkpoint.remainingDuePaise, 0);
  assert.equal(repository.current.auditTrail.at(-1).action, "WRITE_OFF_APPROVED");
  assert.equal(repository.current.auditTrail.at(-1).actorId, "manager-1");
});

test("settlement requires zero balance and is explicitly approved and audited", async () => {
  const { repository, checkpoint } = fixture();
  await assert.rejects(checkpoint.approveSettlement({ folioId: "folio-1", expectedVersion: 4, staff }),
    error => error.code === "FOLIO_NOT_SETTLEABLE");
  await checkpoint.recordPayment({ folioId: "folio-1", expectedVersion: 4, amountPaise: 3000, method: "Cash", paymentId: "cash-1", staff });
  const settled = await checkpoint.approveSettlement({ folioId: "folio-1", expectedVersion: 5, staff });
  assert.equal(settled.checkpoint.remainingDuePaise, 0);
  assert.equal(repository.current.status, "SETTLED");
  assert.equal(repository.current.settledBy, "frontdesk-1");
  assert.equal(repository.current.auditTrail.at(-1).reconciliationMethod, "LOCAL_SMART_CHECKPOINT");
});

test("overpayment is explicitly classified and cannot be silently settled", () => {
  const { folio } = fixture();
  folio.paymentEntries[0].amountPaise = 24000;
  const result = calculateFolioCheckpoint(folio);
  assert.equal(result.remainingDuePaise, -1000);
  assert.equal(result.state, "OVERPAID");
});

test("invalid monetary precision, malformed rows and credits above charges fail closed", () => {
  const { folio } = fixture();
  folio.chargeLines[0].amountPaise = 1.2;
  assert.throws(() => calculateFolioCheckpoint(folio), /integer number of paise/);
  folio.chargeLines[0].amountPaise = 23000;
  folio.adjustmentLines = [{ kind: "CREDIT", amountPaise: 24000 }];
  assert.throws(() => calculateFolioCheckpoint(folio), error => error.code === "CREDITS_EXCEED_CHARGES");
});
