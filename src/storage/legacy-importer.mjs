/**
 * The only module allowed to read or write the legacy PMS snapshot and its
 * migration marker in Web Storage. Operational code must use repositories.
 */
export const LEGACY_STATE_KEY = "aurelia_lodge_v2";
export const LEGACY_MIGRATION_STATUS_KEY = "aurelia_canonical_migration_status";

export class LegacyImporter {
  constructor(storage = globalThis.window?.__aureliaStorage || globalThis.localStorage) {
    if (!storage || storage.memoryOnly === true ||
        typeof storage.getItem !== "function" ||
        typeof storage.setItem !== "function") {
      throw new TypeError("A durable Storage-compatible legacy store is required");
    }
    this.storage = storage;
  }

  readLegacyState() {
    return this.storage.getItem(LEGACY_STATE_KEY);
  }

  writeLegacyState(raw) {
    if (typeof raw !== "string" || raw.length === 0) {
      throw new TypeError("Legacy state must be a non-empty raw JSON string");
    }
    this.storage.setItem(LEGACY_STATE_KEY, raw);
    if (this.readLegacyState() !== raw) {
      throw new Error("Legacy state failed exact read-back verification");
    }
  }

  readMigrationStatus() {
    return this.storage.getItem(LEGACY_MIGRATION_STATUS_KEY);
  }

  writeMigrationStatus(value) {
    if (typeof value !== "string" || !value) {
      throw new TypeError("Migration status must be a non-empty string");
    }
    this.storage.setItem(LEGACY_MIGRATION_STATUS_KEY, value);
    if (this.readMigrationStatus() !== value) {
      throw new Error("Migration status failed exact read-back verification");
    }
  }
}
