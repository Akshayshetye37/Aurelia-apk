import test from "node:test";
import assert from "node:assert/strict";
import { indexedDB } from "fake-indexeddb";
import { webcrypto } from "node:crypto";
import { settlePayment } from "../src/payments/settlement-service.mjs";
import {
  applyVerifiedSettlementCommand,
  recoverPendingSettlements
} from "../src/payments/settlement-apply.mjs";
import { IndexedDbSettlementJournal } from "../src/payments/settlement-journal.mjs";

function makeJournal() {
  return new IndexedDbSettlementJournal({
    indexedDBImpl: indexedDB,
    cryptoImpl: webcrypto,
    databaseName: "settlement-apply-test-" + Math.random()
  });
}

function fixture() {
  const booking = { id: "B-100", st: "res", room: "4", p: 0, pays: [], payments: [] };
  const state = { b: [booking], today: 0, aud: [] };
  let writes = 0;
  const project = payload => {
    const target = state.b.find(item => item.id === payload.bookingId);
    if (!target) throw new Error("Booking not found during settlement recovery");
    return settlePayment({
      state, booking: target, amount: payload.amount, method: payload.method,
      reference: payload.reference, source: payload.source,
      idempotencyKey: payload.idempotencyKey, balanceDue: 500,
      verificationConfirmed: payload.verificationConfirmed,
      persist: () => { writes += 1; },
      audit: (kind, detail) => state.aud.push({ kind, detail })
    });
  };
  return { state, booking, project, get writes() { return writes; } };
}

const command = {
  provider: "razorpay",
  providerTransactionId: "pay_abc123",
  bookingId: "B-100",
  amount: 125,
  method: "UPI",
  reference: "UTR-100",
  source: "staff_review",
  verificationConfirmed: true
};

test("verified command is journaled before projection and applied after persistence", async () => {
  const journal = makeJournal();
  const app = fixture();
  const result = await applyVerifiedSettlementCommand({ journal, command, project: app.project });
  assert.equal(result.ok, true);
  assert.equal(result.record.status, "APPLIED");
  assert.equal((await journal.get(result.record.key)).status, "APPLIED");
  assert.equal(app.booking.p, 125);
  assert.equal(app.booking.pays.length, 1);
  assert.equal(app.booking.payments.length, 1);
  assert.equal(app.state.today, 125);
  assert.equal(app.writes, 1);
});

test("crash after projection but before APPLIED is repaired without a second folio credit", async () => {
  const base = makeJournal();
  let failMarkApplied = true;
  const journal = {
    append: input => base.append(input),
    listPending: () => base.listPending(),
    get: key => base.get(key),
    markApplied: async (...args) => {
      if (failMarkApplied) {
        failMarkApplied = false;
        throw new Error("simulated process loss before APPLIED");
      }
      return base.markApplied(...args);
    }
  };
  const app = fixture();
  await assert.rejects(
    applyVerifiedSettlementCommand({ journal, command, project: app.project }),
    /simulated process loss/
  );
  assert.equal((await base.listPending()).length, 1);
  assert.equal(app.booking.p, 125);
  assert.equal(app.booking.pays.length, 1);
  assert.equal(app.state.today, 125);

  const recovery = await recoverPendingSettlements({ journal: base, project: app.project });
  assert.equal(recovery.scanned, 1);
  assert.equal((await base.listPending()).length, 0);
  assert.equal(app.booking.p, 125);
  assert.equal(app.booking.pays.length, 1);
  assert.equal(app.booking.payments.length, 1);
  assert.equal(app.state.today, 125);
  // The recovery projection is an idempotent duplicate and does not persist again.
  assert.equal(app.writes, 1);
});

test("duplicate command is idempotent and changed command payload conflicts before projection", async () => {
  const journal = makeJournal();
  const app = fixture();
  await applyVerifiedSettlementCommand({ journal, command, project: app.project });
  const duplicate = await applyVerifiedSettlementCommand({ journal, command, project: app.project });
  assert.equal(duplicate.duplicate, true);
  await assert.rejects(
    applyVerifiedSettlementCommand({
      journal,
      command: { ...command, amount: 126 },
      project: app.project
    }),
    error => error.code === "SETTLEMENT_IDEMPOTENCY_CONFLICT"
  );
  assert.equal(app.booking.pays.length, 1);
  assert.equal(app.booking.p, 125);
});

test("manual, reservation advance, and automatic sources cannot enter journaled path", async () => {
  const journal = makeJournal();
  const app = fixture();
  for (const source of ["manual", "reservation_advance", "auto"]) {
    await assert.rejects(
      applyVerifiedSettlementCommand({
        journal,
        command: { ...command, source },
        project: app.project
      }),
      error => error.code === "JOURNALED_SETTLEMENT_NOT_VERIFIED"
    );
  }
  assert.equal((await journal.listPending()).length, 0);
  assert.equal(app.booking.pays.length, 0);
});
