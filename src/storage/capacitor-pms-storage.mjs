import { registerPlugin } from "@capacitor/core";

const NativePmsStorage = registerPlugin("CapacitorPmsStorage");

function requiredString(value, label) {
  if (typeof value !== "string" || !value.trim() || value.length > 180 || /[\u0000-\u001f]/.test(value)) {
    throw new TypeError("Invalid " + label);
  }
  return value;
}
function requiredVersion(value) {
  if (!Number.isSafeInteger(value) || value < 0) throw new TypeError("Invalid expected entity version");
  return value;
}

/**
 * Thin Promise-based client for the registered Android plugin.
 * This is deliberately not advertised as a complete PmsRepository adapter:
 * native list/migration/outbox lifecycle parity must land before engine binding.
 */
export class CapacitorPmsStorageClient {
  constructor(plugin = NativePmsStorage) { this.plugin = plugin; }

  async initializeStorage() {
    const result = await this.plugin.initializeStorage();
    if (!result || result.success !== true || result.engine !== "android-sqlite") {
      throw new Error("Native PMS storage did not confirm SQLite initialization");
    }
    return result;
  }

  async getEntity(entityType, entityId) {
    requiredString(entityType, "entity type");
    requiredString(entityId, "entity ID");
    const result = await this.plugin.getEntity({ entityType, entityId });
    return result?.entity ?? null;
  }

  async transactBusinessChange({ entityType, entityId, expectedVersion, event }, apply) {
    requiredString(entityType, "entity type");
    requiredString(entityId, "entity ID");
    requiredVersion(expectedVersion);
    if (typeof apply !== "function") throw new TypeError("Mutation callback required");
    const current = await this.getEntity(entityType, entityId);
    const liveVersion = current?.version ?? 0;
    if (liveVersion !== expectedVersion) {
      const error = new Error("Entity version conflict");
      error.code = "ENTITY_VERSION_CONFLICT";
      error.actualVersion = liveVersion;
      throw error;
    }
    const nextData = apply({ data: current?.data ?? null, version: liveVersion });
    if (nextData && typeof nextData.then === "function") {
      throw new TypeError("Mutation callback must be synchronous; prepare asynchronous work before opening the transaction");
    }
    if (nextData === undefined || nextData === null || typeof nextData !== "object" || Array.isArray(nextData)) {
      throw new TypeError("Mutation must return an entity object");
    }
    // The native transaction rechecks expectedVersion while holding SQLite's
    // write lock, so a concurrent writer cannot slip between this read and commit.
    const committed = await this.plugin.transactBusinessChange({
      entityType, entityId, expectedVersion, data: nextData, event
    });
    if (!committed || committed.version !== expectedVersion + 1) {
      throw new Error("Native PMS transaction returned an invalid committed version");
    }
    return {
      key: entityType + ":" + entityId,
      type: entityType,
      id: entityId,
      version: committed.version,
      data: committed.data,
      updatedAt: Date.now()
    };
  }
}

export const capacitorPmsStorage = new CapacitorPmsStorageClient();
