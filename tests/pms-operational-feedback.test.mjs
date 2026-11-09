import test from "node:test";
import assert from "node:assert/strict";
import { PmsOperationalFeedback } from "../src/storage/pms-operational-feedback.mjs";

test("save lifecycle moves through saving to saved only after verified commit", () => {
  const feedback = new PmsOperationalFeedback();
  const operation = feedback.beginSave();
  assert.equal(feedback.status.state, "saving");
  assert.equal(feedback.completeSave(operation), true);
  assert.equal(feedback.status.state, "saved");
});

test("failed writes never become saved and retain typed error information", () => {
  const feedback = new PmsOperationalFeedback();
  const operation = feedback.beginSave();
  feedback.failSave(operation, { code: "STORAGE_FULL", message: "Device storage is full" });
  assert.equal(feedback.status.state, "save_failed");
  assert.equal(feedback.status.errorCode, "STORAGE_FULL");
  assert.equal(feedback.status.message, "Device storage is full");
});

test("database unavailable is distinguished from other write failures", () => {
  const feedback = new PmsOperationalFeedback();
  const operation = feedback.beginSave();
  feedback.failSave(operation, { code: "DATABASE_UNAVAILABLE", message: "Database unavailable" });
  assert.equal(feedback.status.state, "database_unavailable");
});

test("ambiguous or recovery-pending writes enter recovery_required and block new saves", () => {
  const feedback = new PmsOperationalFeedback();
  const operation = feedback.beginSave();
  feedback.failSave(operation, { code: "TRANSACTION_ABORTED", message: "Commit outcome uncertain" }, { recoveryRequired: true });
  assert.equal(feedback.status.state, "recovery_required");
  assert.throws(() => feedback.beginSave(), /recovery/i);
});

test("only explicit verified recovery clears a recovery-required state", () => {
  const feedback = new PmsOperationalFeedback();
  const operation = feedback.beginSave();
  feedback.failSave(operation, new Error("read-back mismatch"), { recoveryRequired: true });
  assert.throws(() => feedback.beginSave());
  feedback.completeRecovery({ verified: false });
  assert.equal(feedback.status.state, "recovery_required");
  feedback.completeRecovery({ verified: true });
  assert.equal(feedback.status.state, "saved");
});

test("stale async completions cannot overwrite a newer operation state", () => {
  const feedback = new PmsOperationalFeedback();
  const first = feedback.beginSave();
  const second = feedback.beginSave();
  assert.equal(feedback.completeSave(first), false);
  assert.equal(feedback.completeSave(second), true);
  assert.equal(feedback.status.state, "saved");
});

test("status snapshots are immutable and listeners receive transitions", () => {
  const feedback = new PmsOperationalFeedback();
  const states = [];
  feedback.subscribe(status => states.push(status.state));
  const operation = feedback.beginSave();
  feedback.completeSave(operation);
  assert.deepEqual(states, ["idle", "saving", "saved"]);
  assert.equal(Object.isFrozen(feedback.status), true);
});
