import test from "node:test";
import assert from "node:assert/strict";
import { StorageFullError, isStorageFull, mapStorageError, guardNativePlugin } from "../src/storage/storage-errors.mjs";

test("maps browser quota exhaustion to a typed non-success storage error", () => {
  const quota = Object.assign(new Error("quota exceeded"), { name: "QuotaExceededError" });
  const mapped = mapStorageError(quota);
  assert.ok(mapped instanceof StorageFullError);
  assert.equal(mapped.code, "STORAGE_FULL");
  assert.equal(mapped.cause, quota);
  assert.match(mapped.message, /NOT saved/);
});

test("maps native PMS storage-full rejection to the same typed error", () => {
  const native = Object.assign(new Error("Native write failed"), { code: "PMS_STORAGE_FULL" });
  assert.equal(isStorageFull(native), true);
  assert.ok(mapStorageError(native) instanceof StorageFullError);
});

test("does not reclassify ordinary storage failures", () => {
  const failure = new Error("database locked");
  assert.equal(mapStorageError(failure), failure);
  assert.equal(isStorageFull(failure), false);
});

test("native plugin guard maps asynchronous storage-full rejections", async () => {
  const guarded = guardNativePlugin({ write: async () => { throw Object.assign(new Error("disk full"), { code: "PMS_STORAGE_FULL" }); } });
  await assert.rejects(guarded.write(), StorageFullError);
});
