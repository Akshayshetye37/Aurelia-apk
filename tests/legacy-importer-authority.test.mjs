import test from "node:test";
import assert from "node:assert/strict";
import { indexedDB } from "fake-indexeddb";
import { IndexedDbPmsRepository } from "../src/storage/indexeddb-pms-repository.mjs";
import { LegacyImporter, LEGACY_STATE_KEY } from "../src/storage/legacy-importer.mjs";

const snapshot = JSON.stringify({
  rooms: [], b: [], g: [], t: [], exp: [], inv: [], led: [], aud: [],
  set: {}, menu: {}
});

test("legacy importer is the narrow read/write boundary for the legacy snapshot", () => {
  const values = new Map([[LEGACY_STATE_KEY, snapshot]]);
  const storage = {
    getItem: key => values.has(key) ? values.get(key) : null,
    setItem: (key, value) => values.set(key, String(value))
  };
  const importer = new LegacyImporter(storage);
  assert.equal(importer.readLegacyState(), snapshot);
  importer.writeMigrationStatus("VERIFIED:mig_legacy_test");
  assert.equal(importer.readMigrationStatus(), "VERIFIED:mig_legacy_test");
  const updated = snapshot + " ";
  importer.writeLegacyState(updated);
  assert.equal(importer.readLegacyState(), updated);
  assert.throws(() => importer.writeLegacyState(""), /non-empty/);
});

test("database authority advances legacy -> migrating -> canonical only after a committed migration", async () => {
  const repository = new IndexedDbPmsRepository({
    indexedDBImpl: indexedDB,
    databaseName: "pms-authority-transition-test"
  });
  assert.equal(await repository.getAuthority(), "legacy");
  assert.equal(await repository.beginMigrationAuthority(), "migrating");
  await assert.rejects(
    repository.completeMigrationAuthority("mig_authority_test"),
    /matching committed legacy backup/
  );
  await repository.migrateLegacySnapshot({
    raw: snapshot,
    parsed: JSON.parse(snapshot)
  }, {
    migrationId: "mig_authority_test",
    sourceKey: LEGACY_STATE_KEY
  });
  assert.equal(
    await repository.completeMigrationAuthority("mig_authority_test"),
    "canonical"
  );
  assert.equal(await repository.getAuthority(), "canonical");
  await assert.rejects(repository.revertMigrationAuthority(), /cannot be downgraded/);
});

test("an interrupted migration can safely return authority to legacy", async () => {
  const repository = new IndexedDbPmsRepository({
    indexedDBImpl: indexedDB,
    databaseName: "pms-authority-revert-test"
  });
  await repository.beginMigrationAuthority();
  assert.equal(await repository.revertMigrationAuthority(), "legacy");
  assert.equal(await repository.getAuthority(), "legacy");
});
