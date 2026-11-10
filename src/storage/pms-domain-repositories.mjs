import { BaseRepo } from "./pms-base-repository.mjs";

function optionsFor(options, entityType) {
  if (!options || typeof options !== "object" || Array.isArray(options)) {
    throw new TypeError(entityType + " repository options are required.");
  }
  if (options.entityType !== undefined && options.entityType !== entityType) {
    throw new TypeError(entityType + " repository cannot be rebound to " + options.entityType + ".");
  }
  return { ...options, entityType };
}

/** Canonical guest profile repository. */
export class GuestRepo extends BaseRepo {
  constructor(options) { super(optionsFor(options, "guest")); }
}

/** Canonical room inventory and room-state repository. */
export class RoomRepo extends BaseRepo {
  constructor(options) { super(optionsFor(options, "room")); }
}

/** Reservation lifecycle repository (legacy entity type: booking). */
export class ReservationRepo extends BaseRepo {
  constructor(options) { super(optionsFor(options, "booking")); }
}

/** Folio repository. Payment and ledger evidence remains append-only. */
export class FolioRepo extends BaseRepo {
  constructor(options) { super(optionsFor(options, "folio")); }
}


/** Versioned provider payment lifecycle repository. */
export class PaymentRepo extends BaseRepo {
  constructor(options) { super(optionsFor(options, "payment")); }

  transition(id, expectedVersion, status, { eventPayload } = {}) {
    return this.update(id, expectedVersion, current => ({
      ...current,
      status,
      updatedAt: this.now()
    }), {
      eventType: "payment." + status,
      eventPayload: eventPayload || { operation: "verified_payment_transition", status }
    });
  }
}
