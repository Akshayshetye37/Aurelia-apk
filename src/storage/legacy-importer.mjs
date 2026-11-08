/**
 * The only module allowed to read or write the legacy PMS snapshot and its
 * migration marker in Web Storage. Operational code must use repositories.
 */
export const LEGACY_STATE_KEY = "aurelia_lodge_v2";
export const LEGACY_MIGRATION_STATUS_KEY = "aurelia_canonical_migration_status";

export class LegacyImporter {
  constructor(storage = globalThis.window?.__aureliaStorage || globalThis.localStorage) {
    this.storage = storage;
  }

  assertStorage() {
    if (!this.storage || this.storage.memoryOnly === true ||
        typeof this.storage.getItem !== "function" ||
        typeof this.storage.setItem !== "function") {
      throw new TypeError("A durable Storage-compatible legacy store is required");
    }
  }

  readLegacyState() {
    this.assertStorage();
    return this.storage.getItem(LEGACY_STATE_KEY);
  }

  writeLegacyState(raw) {
    this.assertStorage();
    if (typeof raw !== "string" || raw.length === 0) {
      throw new TypeError("Legacy state must be a non-empty raw JSON string");
    }
    this.storage.setItem(LEGACY_STATE_KEY, raw);
    if (this.readLegacyState() !== raw) {
      throw new Error("Legacy state failed exact read-back verification");
    }
  }

  readMigrationStatus() {
    this.assertStorage();
    return this.storage.getItem(LEGACY_MIGRATION_STATUS_KEY);
  }

  writeMigrationStatus(value) {
    this.assertStorage();
    if (typeof value !== "string" || !value) {
      throw new TypeError("Migration status must be a non-empty string");
    }
    this.storage.setItem(LEGACY_MIGRATION_STATUS_KEY, value);
    if (this.readMigrationStatus() !== value) {
      throw new Error("Migration status failed exact read-back verification");
    }
  }
}
