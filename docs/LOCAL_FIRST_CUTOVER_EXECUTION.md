# Local-first cutover — execution record

**Branch:** `feature/multi-provider-payment-backend`  
**Baseline:** `7262091cce720c48933d534071f8f77065efcbee`  
**Status:** Canonical-first serialized writes are active; startup verifies migration replay and restores the latest canonical snapshot; domain projection is wired; room housekeeping status, room catalogue mutations and the active room read projection are routed through canonical room entities; guest profiles now hydrate stable canonical IDs, create/update through transactions and retire through tombstones; global UI cutover remains OFF. Fresh installs now receive a durable READY_CANONICAL marker on their first committed snapshot, so they do not get misclassified as legacy migrations on the next launch.

## Objective

Make the device repository the sole canonical read/write path for all PMS domains:
- Android: native SQLite through the Capacitor repository plugin.
- Browser/PWA: IndexedDB repository.
- No successful write may depend on a localStorage or in-memory fallback.
- Cloud sync remains disabled and separate from gateway payment verification.

## Implemented in this phase

`src/storage/pms-domain-cutover.mjs` adds a resumable, non-destructive projection from the verified legacy snapshot into versioned domain entities. It covers rooms, guests, bookings, preserved folio-source evidence, inventory, expenses/ledger rows and audit rows. Bootstrap runs this projection after migration verification and before UI release on both IndexedDB and Android SQLite. The manifest is stable across ordinary saves because it is tied to the immutable migration ID; replays verify the existing projection without overwriting operational entities.

Each batch uses the repository's atomic entity-plus-outbox transaction and is read back before the next batch. A final manifest is committed only after all projected records have been verified. Replays are idempotent; divergent existing entities fail closed. The original legacy snapshot is not deleted or rewritten.

## Explicit limitations

This is a migration primitive, not a completed application cutover:
- It does not yet route every screen's reads/writes through domain entities.
- It does not enable `uiCutover`.
- It does not migrate tables, settings, feature flags, or every auxiliary collection into dedicated domain schemas.
- It deliberately preserves `booking.p`, `booking.pays` and `booking.payments` as source evidence; it does not reconcile financial history or infer balances.
- The full projection is resumable across atomic batches, not one giant transaction. The legacy snapshot remains the recovery source until a separate verified activation step.
- Android/native adapter parity and physical-device persistence qualification remain required.

## Next mandatory implementation stages

1. Verify room-domain reload, stale-version conflicts, retirement and recovery on browser/PWA and Android SQLite.
2. Convert each remaining application command to async repository reads and transactional writes; remove direct mutation of the legacy state object from that command.
3. Cut over in bounded domains: rooms/housekeeping; guests/reservations; folio/accounting; inventory/expenses; restaurant/tables; settings/audit.
4. For each domain, add tests for reload, duplicate commands, stale versions, transaction rollback, migration replay and read-back.
5. Remove localStorage as a write authority only after every read and write path is migrated and recovery/rollback is qualified.

**Release controls:** cloud sync OFF; live gateway collection OFF; automatic settlement OFF; automatic refund posting OFF; APK/release authorization NOT GRANTED.
