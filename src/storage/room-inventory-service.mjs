import { assertPmsIdentity } from "./pms-repository-contract.mjs";

const HOUSEKEEPING = new Set(["DIRTY", "CLEAN", "INSPECTED"]);
const MAINTENANCE = new Set(["NORMAL", "MAINTENANCE", "OUT_OF_ORDER"]);
const clone = value => structuredClone(value);

function roomText(value, label) {
  if (typeof value !== "string" || !value.trim() || value.trim().length > 80 || /[\u0000-\u001f]/.test(value)) {
    throw new TypeError("Invalid " + label);
  }
  return value.trim();
}
function rate(value) {
  if (!Number.isSafeInteger(value) || value < 0) throw new TypeError("ratePaise must be a non-negative safe integer");
  return value;
}
function enumValue(value, allowed, label) {
  if (!allowed.has(value)) throw new TypeError("Invalid " + label);
  return value;
}

/**
 * Durable room-inventory commands. Occupancy is deliberately not stored here:
 * it is derived from booking records until booking commands are migrated.
 * Destructive operations are intentionally absent until a cross-entity
 * transaction can prove that booking references remain valid.
 */
export class RoomInventoryService {
  constructor({ bridge } = {}) {
    if (!bridge || typeof bridge.fetchEntity !== "function" || typeof bridge.saveRoom !== "function") {
      throw new TypeError("A bound PMS repository bridge is required");
    }
    this.bridge = bridge;
  }

  #scope() {
    const { tenantId, propertyId } = this.bridge.context || {};
    assertPmsIdentity(tenantId, "tenant ID");
    assertPmsIdentity(propertyId, "property ID");
    return { tenantId, propertyId };
  }

  async #read(roomId) {
    assertPmsIdentity(roomId, "room ID");
    const row = await this.bridge.fetchEntity("room", roomId);
    if (!row) return null;
    const scope = this.#scope();
    if (row.data?.tenantId !== scope.tenantId || row.data?.propertyId !== scope.propertyId) {
      const error = new Error("Room belongs to a different tenant or property");
      error.code = "ROOM_SCOPE_MISMATCH";
      throw error;
    }
    return row;
  }

  async createRoom({ roomId, roomNumber, roomType, ratePaise }) {
    this.#scope();
    assertPmsIdentity(roomId, "room ID");
    if (await this.bridge.fetchEntity("room", roomId)) {
      const error = new Error("Room ID already exists");
      error.code = "ROOM_ALREADY_EXISTS";
      throw error;
    }
    const scope = this.#scope();
    const saved = await this.bridge.saveRoom({
      entityId: roomId,
      expectedVersion: 0,
      eventType: "room.created",
      eventPayload: { operation: "create" },
      mutate: room => Object.assign(room, {
        id: roomId, ...scope,
        roomNumber: roomText(roomNumber, "room number"),
        roomType: roomText(roomType, "room type"),
        ratePaise: rate(ratePaise),
        housekeepingStatus: "DIRTY",
        maintenanceStatus: "NORMAL"
      })
    });
    const verified = await this.#read(roomId);
    if (!verified || verified.version !== saved.entity.version || JSON.stringify(verified.data) !== JSON.stringify(saved.entity.data)) {
      throw new Error("Room creation durable read-back verification failed");
    }
    return clone(verified);
  }

  async updateRoom({ roomId, expectedVersion, roomNumber, roomType, ratePaise }) {
    const current = await this.#read(roomId);
    if (!current) throw new Error("Room does not exist");
    if (current.version !== expectedVersion) {
      const error = new Error("Room version conflict");
      error.code = "ENTITY_VERSION_CONFLICT";
      error.actualVersion = current.version;
      throw error;
    }
    const saved = await this.bridge.saveRoom({
      entityId: roomId, expectedVersion, eventType: "room.updated",
      eventPayload: { operation: "update" },
      mutate: room => {
        if (room.id !== roomId || room.tenantId !== current.data.tenantId || room.propertyId !== current.data.propertyId) {
          throw new Error("Room identity and scope are immutable");
        }
        room.roomNumber = roomText(roomNumber, "room number");
        room.roomType = roomText(roomType, "room type");
        room.ratePaise = rate(ratePaise);
      }
    });
    const verified = await this.#read(roomId);
    if (!verified || verified.version !== saved.entity.version || JSON.stringify(verified.data) !== JSON.stringify(saved.entity.data)) {
      throw new Error("Room update durable read-back verification failed");
    }
    return clone(verified);
  }

  async setHousekeepingStatus({ roomId, expectedVersion, status }) {
    enumValue(status, HOUSEKEEPING, "housekeeping status");
    return this.#updateStatus({ roomId, expectedVersion, field: "housekeepingStatus", status, eventType: "room.housekeeping_updated" });
  }

  async setMaintenanceStatus({ roomId, expectedVersion, status }) {
    enumValue(status, MAINTENANCE, "maintenance status");
    return this.#updateStatus({ roomId, expectedVersion, field: "maintenanceStatus", status, eventType: "room.maintenance_updated" });
  }

  async #updateStatus({ roomId, expectedVersion, field, status, eventType }) {
    const current = await this.#read(roomId);
    if (!current) throw new Error("Room does not exist");
    if (current.version !== expectedVersion) {
      const error = new Error("Room version conflict");
      error.code = "ENTITY_VERSION_CONFLICT";
      error.actualVersion = current.version;
      throw error;
    }
    const saved = await this.bridge.saveRoom({
      entityId: roomId, expectedVersion, eventType,
      eventPayload: { operation: field, status },
      mutate: room => { room[field] = status; }
    });
    const verified = await this.#read(roomId);
    if (!verified || verified.version !== saved.entity.version || verified.data[field] !== status) {
      throw new Error("Room status durable read-back verification failed");
    }
    return clone(verified);
  }
}
