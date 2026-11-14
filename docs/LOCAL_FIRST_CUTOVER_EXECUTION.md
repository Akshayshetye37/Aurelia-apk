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

`src/storage/pms-domain-cutover.mjs` adds a resumable, non-destructive projection from the verified legacy snapshot into versioned domain entities. It covers property settings and menu, rooms, guests, bookings, restaurant table rows/open orders, preserved folio-source evidence, inventory, expenses/ledger rows and audit rows. The `restaurant_table` entity uses the existing numeric table ID contract shared by settlement transactions; table creation, edits, open-order changes and retirement synchronize in the same versioned entity-plus-outbox transaction as the complete recovery snapshot, and startup hydrates canonical table rows. Removed tables are tombstoned and tables with open orders cannot be retired. Projection-manifest upgrades are additive: existing canonical domains are never replayed from a legacy snapshot, missing entities from a previously verified domain fail closed, and newly introduced domains are added without overwriting live records. Historical restaurant sales are backfilled into immutable `restaurant_sale` entities; startup merges canonical sale rows over stale snapshots, while new sales are written through existing settlement transactions or the versioned sale repository. Existing sale IDs cannot be rewritten and outbox payloads omit customer contact details. The `settings:property-settings` record preserves the legacy `set` and `menu` objects; bootstrap hydrates them from canonical storage, and every compatibility snapshot save first synchronizes changed settings through a versioned entity-plus-outbox transaction with exact read-back. Inventory now has a dedicated repository with canonical startup hydration, stable IDs for legacy rows, version-checked writes, POS/restaurant stock deduction synchronization, and tombstone retirement. Inventory entity changes and the complete recovery snapshot commit together with outbox records; stale cross-tab writes fail closed rather than overwriting a newer stock quantity. All UI inventory commands use this repository path. Bootstrap runs this projection after migration verification and before UI release on both IndexedDB and Android SQLite. The manifest is stable across ordinary saves because it is tied to the immutable migration ID; replays verify the existing projection without overwriting operational entities.

Each batch uses the repository's atomic entity-plus-outbox transaction and is read back before the next batch. A final manifest is committed only after all projected records have been verified. Replays are idempotent; divergent existing entities fail closed. The original legacy snapshot is not deleted or rewritten.

## Additional hardening — 2026-11-08

- Cancellation refund/accounting updates now await the canonical snapshot coordinator, validate the returned committed snapshot, and no longer treat an immediately-read Web Storage cache as proof of persistence.
- Strict asynchronous snapshot commits now enter the same operational serialization lock as other PMS writes, so the state snapshot is captured after earlier queued operations complete.
- The legacy synchronous accounting persistence adapter now fails closed. It cannot write the Web Storage key and claim durability while IndexedDB/SQLite persistence is still pending. The journaled gateway projector remains disabled until it is converted to an awaited canonical transaction.

## Ordered architecture work — 2026-11-08

The implementation sequence follows the requested dependency order: repository/migration → durable transactions → recovery qualification → optional outbox sync → payment authorization. No later layer is allowed to become a prerequisite for local operation.

### Implemented in this increment

- Browser IndexedDB schema advances from version 1 to version 2.
- Before the v1→v2 upgrade completes, all existing rows in `meta`, `entities`, `outbox`, and `migration_snapshots` are copied into the new `migration_backups` object store in the same version-change transaction. The original stores remain intact.
- A `schema-version` metadata row is written as part of the upgrade transaction.
- A regression test seeds a real v1 database and verifies all four stores are backed up and the original entity/outbox/snapshot data remains readable after upgrade.
- Browser/PWA bootstrap now requests persistent storage through `navigator.storage.persist()`. The result is exposed as `persistentStorage.requested/granted`; denial is reported as a capability limitation, not misrepresented as a guarantee and not used to fall back to Web Storage.

### Still required before the next gates

- Complete all screen and command migrations to repository-only reads and writes. Existing compatibility UI and legacy snapshot cache remain, so localStorage keys must not yet be deleted.
- Finish atomic business transactions for every multi-entity workflow, including order + stock + ledger.
- Add full crash, quota/full-disk, migration interruption, corruption/integrity, backup restore and multi-device conflict qualification.
- Implement/qualify the sync worker and server idempotency only after recovery gates pass.
- Keep payment provider confirmation, refund authorization and reconciliation separate from local transaction acceptance.

## Explicit limitations

This is a migration primitive, not a completed application cutover:
- It does not yet route every screen's reads/writes through domain entities.
- It does not enable `uiCutover`.
- It does not yet migrate feature flags, audit history, inventory movement rows into a dedicated append-only ledger, or every auxiliary collection into dedicated domain schemas. Property settings/menu, restaurant table rows/open orders, immutable restaurant sales and inventory balances now have canonical startup/read/write paths, but the global UI cutover remains disabled.
- It deliberately preserves `booking.p`, `booking.pays` and `booking.payments` as source evidence; it does not reconcile financial history or infer balances.
- The full projection is resumable across atomic batches, not one giant transaction. The legacy snapshot remains the recovery source until a separate verified activation step.
- Android/native adapter parity and physical-device persistence qualification remain required.

## Next mandatory implementation stages

1. Verify room-domain reload, stale-version conflicts, retirement and recovery on browser/PWA and Android SQLite.
2. Convert each remaining application command to async repository reads and transactional writes; remove direct mutation of the legacy state object from that command.
3. Cut over in bounded domains: rooms/housekeeping; guests/reservations; folio/accounting; inventory/expenses; restaurant reporting/inventory linkage; feature flags and remaining audit/auxiliary collections.
4. For each domain, add tests for reload, duplicate commands, stale versions, transaction rollback, migration replay and read-back.
5. Remove localStorage as a write authority only after every read and write path is migrated and recovery/rollback is qualified.

**Release controls:** cloud sync OFF; live gateway collection OFF; automatic settlement OFF; automatic refund posting OFF; APK/release authorization NOT GRANTED.
