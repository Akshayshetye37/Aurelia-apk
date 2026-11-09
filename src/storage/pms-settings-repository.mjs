/**
 * Canonical, versioned property settings repository.
 *
 * Property configuration and menu data are business records. This service
 * deliberately writes only through the local repository bridge so each
 * settings update and its immutable outbox event share one database commit.
 */
const clone = value => typeof structuredClone === "function"
  ? structuredClone(value)
  : JSON.parse(JSON.stringify(value));

const isPlainObject = value => value !== null && typeof value === "object" &&
  !Array.isArray(value) &&
  (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);

function jsonClone(value, label) {
  let encoded;
  try { encoded = JSON.stringify(value); }
  catch { throw new TypeError(label + " must contain JSON-safe data"); }
  if (typeof encoded !== "string") throw new TypeError(label + " must contain JSON-safe data");
  return JSON.parse(encoded);
}

function assertSettingsData(data) {
  if (!isPlainObject(data) || !isPlainObject(data.set) || !isPlainObject(data.menu)) {
    throw new Error("Canonical property settings record is malformed; refusing to overwrite it.");
  }
  return data;
}

export class PmsSettingsRepository {
  constructor({ bridge } = {}) {
    if (!bridge || typeof bridge.fetchEntity !== "function" || typeof bridge.mutateEntity !== "function") {
      throw new TypeError("A bound canonical PMS repository bridge is required.");
    }
    this.bridge = bridge;
  }

  async get() {
    const row = await this.bridge.fetchEntity("settings", "property-settings");
    if (!row) return Object.freeze({
      version: 0,
      data: Object.freeze({ id: "property-settings", set: {}, menu: {} })
    });
    const data = assertSettingsData(clone(row.data));
    return Object.freeze({ version: row.version, data: Object.freeze(data) });
  }

  async update(patch, { expectedVersion } = {}) {
    if (!isPlainObject(patch)) throw new TypeError("Settings patch must be a plain object.");
    const keys = Object.keys(patch);
    if (!keys.length || keys.some(key => key !== "set" && key !== "menu")) {
      throw new TypeError("Settings patch may update only set or menu.");
    }
    for (const key of keys) {
      if (!isPlainObject(patch[key])) throw new TypeError(key + " settings must be a plain object.");
    }

    const current = await this.bridge.fetchEntity("settings", "property-settings");
    const actualVersion = current?.version ?? 0;
    if (expectedVersion !== undefined && expectedVersion !== actualVersion) {
      throw Object.assign(new Error("Property settings version conflict"), {
        code: "ENTITY_VERSION_CONFLICT", actualVersion
      });
    }
    const base = current
      ? assertSettingsData(clone(current.data))
      : { id: "property-settings", set: {}, menu: {} };
    const next = {
      id: "property-settings",
      set: { ...base.set },
      menu: { ...base.menu }
    };
    for (const key of keys) next[key] = jsonClone(patch[key], key + " settings");

    await this.bridge.mutateEntity({
      entityType: "settings",
      entityId: "property-settings",
      expectedVersion: actualVersion,
      eventType: "settings.updated",
      eventPayload: { changedFields: keys },
      mutate: entity => {
        entity.id = "property-settings";
        entity.set = next.set;
        entity.menu = next.menu;
        return entity;
      }
    });

    const committed = await this.bridge.fetchEntity("settings", "property-settings");
    if (!committed || committed.version !== actualVersion + 1 ||
        JSON.stringify(committed.data) !== JSON.stringify(next)) {
      throw Object.assign(new Error("Property settings commit failed exact repository read-back."), {
        code: "SETTINGS_READBACK_FAILED"
      });
    }
    return Object.freeze({ version: committed.version, data: Object.freeze(clone(committed.data)) });
  }
}
