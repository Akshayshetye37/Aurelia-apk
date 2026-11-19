import test from "node:test";
import assert from "node:assert/strict";
import {
  StorageError,
  StorageFullError,
  DatabaseUnavailableError,
  PermissionDeniedError,
  DatabaseCorruptionError,
  TransactionAbortedError,
  VersionConflictError,
  AttachmentWriteError,
  MigrationFailedError,
  normalizeStorageError
} from "../src/storage/storage-errors.mjs";
import { PmsLocalFirstWriteCoordinator } from "../src/storage/pms-local-first-write-coordinator.mjs";

test("all concrete storage errors expose stable codes and inherit StorageError", () => {
  const cases = [
    [StorageFullError, "STORAGE_FULL"],
    [DatabaseUnavailableError, "DATABASE_UNAVAILABLE"],
    [PermissionDeniedError, "PERMISSION_DENIED"],
    [DatabaseCorruptionError, "DATABASE_CORRUPTION"],
    [TransactionAbortedError, "TRANSACTION_ABORTED"],
    [VersionConflictError, "VERSION_CONFLICT"],
    [AttachmentWriteError, "ATTACHMENT_WRITE_FAILED"],
    [MigrationFailedError, "MIGRATION_FAILED"]
  ];

  for (const [ErrorType, code] of cases) {
    const error = new ErrorType();
    assert.ok(error instanceof StorageError);
    assert.ok(error instanceof ErrorType);
    assert.equal(error.code, code);
    assert.equal(typeof error.retryable, "boolean");
    assert.equal(error.toJSON().code, code);
  }
});

test("storage error normalization maps common browser and native failure messages", () => {
  const cases = [
    ["QuotaExceededError: quota exceeded", StorageFullError],
    ["Device storage full", StorageFullError],
    ["Permission denied while opening database", PermissionDeniedError],
    ["Database is corrupt", DatabaseCorruptionError],
    ["Malformed database header", DatabaseCorruptionError],
    ["Entity version conflict", VersionConflictError],
    ["Transaction aborted", TransactionAbortedError],
    ["Migration failed while upgrading", MigrationFailedError]
  ];

  for (const [message, ErrorType] of cases) {
    const normalized = normalizeStorageError(new Error(message));
    assert.ok(normalized instanceof ErrorType, message);
    assert.ok(normalized instanceof StorageError, message);
  }
});

test("normalization preserves typed errors and retains the original cause", () => {
  const original = new Error("quota exceeded");
  const typed = normalizeStorageError(original);
  assert.equal(normalizeStorageError(typed), typed);
  assert.equal(typed.cause, original);
});

test("unknown storage failures normalize to retryable database-unavailable errors", () => {
  const normalized = normalizeStorageError(new Error("native bridge failed"));
  assert.ok(normalized instanceof DatabaseUnavailableError);
  assert.equal(normalized.retryable, true);
});

test("coordinator propagates a typed storage failure and never refreshes compatibility cache", async () => {
  const original = new Error("quota exceeded");
  let cacheWrites = 0;
  let callbackError = null;
  const coordinator = new PmsLocalFirstWriteCoordinator({
    persist: async () => { throw original; },
    readBack: async () => { throw new Error("read-back must not run"); },
    cache: { setItem() { cacheWrites++; }, getItem() { return null; } },
    onFailure(error) { callbackError = error; }
  });

  await assert.rejects(coordinator.save({ rooms: [] }), error => {
    assert.ok(error instanceof StorageFullError);
    assert.ok(error instanceof StorageError);
    assert.equal(error.code, "STORAGE_FULL");
    assert.equal(error.cause, original);
    return true;
  });
  assert.ok(callbackError instanceof StorageFullError);
  assert.equal(cacheWrites, 0);
  assert.equal(coordinator.status.failed, true);
});

test("coordinator wraps read-back verification failures as typed storage errors", async () => {
  const coordinator = new PmsLocalFirstWriteCoordinator({
    persist: async () => {},
    readBack: async () => ({ snapshot: { rooms: [{ id: "different" }] } })
  });

  await assert.rejects(coordinator.save({ rooms: [] }), error => {
    assert.ok(error instanceof StorageError);
    assert.equal(error.code, "DATABASE_UNAVAILABLE");
    return true;
  });
});

test("coordinator commits and reads back before refreshing compatibility cache on success", async () => {
  const snapshot = { rooms: [{ id: "101" }] };
  const calls = [];
  let stored = null;
  const cache = {
    setItem(key, value) { calls.push("cache-write"); this.value = value; },
    getItem() { calls.push("cache-read"); return this.value; }
  };
  const coordinator = new PmsLocalFirstWriteCoordinator({
    persist: async value => { calls.push("commit"); stored = structuredClone(value); },
    readBack: async () => { calls.push("read-back"); return { snapshot: structuredClone(stored) }; },
    cache
  });

  const result = await coordinator.save(snapshot);
  assert.equal(result.committed, true);
  assert.deepEqual(result.snapshot, snapshot);
  assert.deepEqual(calls, ["commit", "read-back", "cache-write", "cache-read"]);
  assert.equal(coordinator.status.failed, false);
});
