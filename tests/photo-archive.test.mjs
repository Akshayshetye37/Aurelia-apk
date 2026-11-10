import test from "node:test";
import assert from "node:assert/strict";
import { indexedDB } from "fake-indexeddb";
import { createPhotoArchive } from "../src/storage/photo-archive.mjs";

test("photo archive stores, reads, exports and restores originals through IndexedDB", async () => {
  const archive = createPhotoArchive({ indexedDBImpl: indexedDB, nativeWindow: null, sandboxed: () => false });
  const image = "data:image/png;base64,AA==";
  await archive.put("photo-a", image);
  assert.equal(await archive.get("photo-a"), image);
  assert.deepEqual(await archive.archive(), { "photo-a": image });
  assert.equal(await archive.restore({ "photo-b": image }), 1);
  assert.equal(await archive.get("photo-a"), null);
  assert.equal(await archive.get("photo-b"), image);
});

test("legacy photo sources are deleted only after exact IndexedDB migration read-back", async () => {
  let deleted = false;
  const entries = [["legacy-photo", "data:image/jpeg;base64,BB=="]];
  const archive = createPhotoArchive({
    indexedDBImpl: indexedDB,
    nativeWindow: null,
    sandboxed: () => false,
    readLegacyPhotoFallbackEntries: () => entries,
    deleteLegacyPhotoFallbackEntries: actual => {
      assert.deepEqual(actual, entries);
      deleted = true;
    }
  });
  assert.equal(await archive.get("legacy-photo"), entries[0][1]);
  assert.equal(deleted, true);
});

test("invalid photo restore archives are rejected without mutating the database", async () => {
  const archive = createPhotoArchive({ indexedDBImpl: indexedDB, nativeWindow: null, sandboxed: () => false });
  await archive.put("stable", "data:image/png;base64,CC==");
  await assert.rejects(archive.restore({ invalid: "not-an-image" }), /invalid original image/i);
  assert.equal(await archive.get("stable"), "data:image/png;base64,CC==");
});
