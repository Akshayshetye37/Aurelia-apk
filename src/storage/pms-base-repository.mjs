import { PMS_ENTITY_TYPES, assertPmsIdentity, assertPmsVersion } from "./pms-repository-contract.mjs";
import { PMS_IMMUTABLE_ENTITY_TYPES, validatePmsDomainEntity } from "./pms-domain-schemas.mjs";

const clone = value => value == null ? value :
  (typeof structuredClone === "function" ? structuredClone(value) : JSON.parse(JSON.stringify(value)));

export class BaseRepo {
  constructor({ bridge, entityType, authorize, now = () => new Date().toISOString() } = {}) {
    if (!bridge || typeof bridge.fetchEntity !== "function" ||
        typeof bridge.listEntities !== "function" || typeof bridge.mutateEntity !== "function") {
      throw new TypeError("BaseRepo requires a bound transactional PMS repository bridge.");
    }
    assertPmsIdentity(entityType, "entity type");
    if (!PMS_ENTITY_TYPES.includes(entityType)) throw new TypeError("Unsupported PMS entity type: " + entityType);
    if (typeof authorize !== "function") {
      throw new TypeError("BaseRepo requires an explicit repository permission evaluator.");
    }
    this.bridge = bridge;
    this.entityType = entityType;
    this.authorize = authorize;
    this.now = now;
  }

  async #assertPermission(action, entityId, context = {}) {
    const allowed = await this.authorize(Object.freeze({
      action,
      entityType: this.entityType,
      entityId: entityId ?? null,
      ...context
    }));
    if (allowed !== true) {
      throw Object.assign(new Error("Repository permission denied for " + action + " on " + this.entityType + "."), {
        code: "PMS_REPOSITORY_PERMISSION_DENIED",
        action,
        entityType: this.entityType,
        entityId: entityId ?? null
      });
    }
  }

  #validate(id, value) {
    const entityId = assertPmsIdentity(String(id), "entity ID");
    const data = validatePmsDomainEntity(this.entityType, { ...clone(value), id: entityId });
    return { entityId, data };
  }

  async get(id) {
    const entityId = assertPmsIdentity(String(id), "entity ID");
    await this.#assertPermission("read", entityId);
    const row = await this.bridge.fetchEntity(this.entityType, entityId);
    if (!row) return null;
    if (row.type !== this.entityType || row.id !== entityId ||
        !Number.isSafeInteger(row.version) || row.version < 1) {
      throw new Error("Canonical " + this.entityType + " repository returned an invalid entity envelope.");
    }
    return Object.freeze({ id: row.id, version: row.version, data: validatePmsDomainEntity(this.entityType, row.data) });
  }

  async list() {
    await this.#assertPermission("list", null);
    const rows = await this.bridge.listEntities(this.entityType);
    if (!Array.isArray(rows)) throw new Error("Canonical " + this.entityType + " repository returned an invalid list.");
    const seen = new Set();
    return rows.map(row => {
      if (!row || row.type !== this.entityType || typeof row.id !== "string" ||
          !Number.isSafeInteger(row.version) || row.version < 1 || seen.has(row.id)) {
        throw new Error("Canonical " + this.entityType + " repository contains an invalid or duplicate entity.");
      }
      seen.add(row.id);
      return Object.freeze({ id: row.id, version: row.version, data: validatePmsDomainEntity(this.entityType, row.data) });
    });
  }

  async create(id, value, { eventType = this.entityType + ".created", eventPayload } = {}) {
    const { entityId, data } = this.#validate(id, value);
    await this.#assertPermission("create", entityId);
    const result = await this.bridge.mutateEntity({
      entityType: this.entityType, entityId, expectedVersion: 0, eventType, eventPayload,
      mutate: current => Object.assign(current, data)
    });
    return Object.freeze({ id: result.entity.id, version: result.entity.version, data: validatePmsDomainEntity(this.entityType, result.entity.data) });
  }

  async update(id, expectedVersion, mutate, { eventType = this.entityType + ".updated", eventPayload, permissionAction = "update" } = {}) {
    if (PMS_IMMUTABLE_ENTITY_TYPES.has(this.entityType)) {
      throw Object.assign(new Error(this.entityType + " entities are append-only and cannot be updated."), { code: "PMS_ENTITY_IMMUTABLE" });
    }
    assertPmsVersion(expectedVersion, "expected version");
    if (typeof mutate !== "function") throw new TypeError("A synchronous update callback is required.");
    const { entityId } = this.#validate(id, { id });
    await this.#assertPermission(permissionAction, entityId, { expectedVersion });
    const result = await this.bridge.mutateEntity({
      entityType: this.entityType, entityId, expectedVersion, eventType, eventPayload,
      mutate: current => {
        const draft = clone(current);
        const returned = mutate(draft);
        if (returned && typeof returned.then === "function") throw new TypeError("Repository update callbacks must be synchronous.");
        const next = this.#validate(entityId, returned && typeof returned === "object" ? returned : draft).data;
        if (next.id !== entityId) throw new TypeError("Entity identity cannot be changed.");
        Object.keys(current).forEach(key => delete current[key]);
        Object.assign(current, next);
        return current;
      }
    });
    return Object.freeze({ id: result.entity.id, version: result.entity.version, data: validatePmsDomainEntity(this.entityType, result.entity.data) });
  }

  async upsert(id, value, { expectedVersion, eventType } = {}) {
    const current = await this.get(id);
    if (!current) {
      if (expectedVersion !== undefined && expectedVersion !== 0) {
        throw Object.assign(new Error("Entity version conflict"), { code: "ENTITY_VERSION_CONFLICT", actualVersion: 0 });
      }
      return this.create(id, value, { eventType: eventType || this.entityType + ".created" });
    }
    if (expectedVersion === undefined) throw new TypeError("Expected version is required for an update.");
    if (current.version !== expectedVersion) {
      throw Object.assign(new Error("Entity version conflict"), { code: "ENTITY_VERSION_CONFLICT", actualVersion: current.version });
    }
    return this.update(id, expectedVersion, () => value, { eventType: eventType || this.entityType + ".updated" });
  }

  async retire(id, expectedVersion, { eventType = this.entityType + ".retired" } = {}) {
    if (PMS_IMMUTABLE_ENTITY_TYPES.has(this.entityType)) {
      throw Object.assign(new Error(this.entityType + " entities are append-only and cannot be retired."), { code: "PMS_ENTITY_IMMUTABLE" });
    }
    return this.update(id, expectedVersion, current => ({ ...current, retired: true, retiredAt: this.now() }), { eventType, permissionAction: "retire" });
  }
}
