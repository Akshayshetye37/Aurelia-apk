# Phase 7 — Canonical PMS persistence cutover

**Branch:** `feature/phase-7-pms-persistence`  
**Base:** `feature/multi-provider-payment-backend`  
**Status:** In progress — safe read-path foundation only; no UI cutover authorized.

## Objective

Move operational PMS reads and writes from the legacy synchronous `S` state to the versioned asynchronous repository without losing legacy data, weakening accounting controls, or claiming unqualified domains are canonical.

## Architectural guardrails confirmed from the checked-in source

- The durable repository currently contains the verified legacy snapshot under the `legacy` entity type. That is migration evidence, not a completed domain migration.
- The operational UI still treats the legacy synchronous state as authoritative. `uiCutover` remains false.
- Booking records are dynamically shaped. Existing booking IDs are numeric and payment fields include `p`, `pays[]`, and `payments[]`; historical balances may disagree.
- The accounting kill switch and gateway controls must remain unchanged. No folio, payment, refund, or balance mutation is part of this phase until an authorized data audit and accounting-owner decision exist.
- Room occupancy is derived from bookings. Room deletion/reassignment must not be enabled until stable room references and cross-entity transactions are proven.
- Browser IndexedDB and Android SQLite must satisfy the same repository contract before any operational UI path is switched.

## Implemented in this phase branch

### Read-path prerequisite

Added `PmsRepositoryBridge.listEntities(entityType)`:
- accepts only declared canonical PMS entity types;
- requires a bound repository and valid tenant/property scope;
- validates every returned row shape and version;
- excludes records belonging to another tenant/property;
- returns cloned rows in deterministic ID order;
- never exposes the untyped legacy migration snapshot as an operational domain collection.

Regression tests cover tenant/property isolation, deterministic ordering, unsupported entity types, and malformed adapter results.

## Remaining implementation sequence

1. **Read-only inventory and schema mapping:** enumerate every operational collection and field, including booking aliases, guest linkage, room references, cancellation/restore flows, and derived reports. Do not normalize financial fields automatically.
2. **Stable identity mapping:** define immutable IDs for bookings, guests, and rooms. Preserve legacy numeric IDs and original references as source identifiers; resolve room-number references only with a collision-checked mapping.
3. **Shadow import:** add deterministic, replay-safe domain projection from the exact verified legacy snapshot. Import in bounded atomic batches; preserve source hashes and reject ambiguous records rather than guessing.
4. **Read parity:** compare every imported domain entity against the source snapshot, including unknown fields and financial arrays. Produce a read-only discrepancy report.
5. **Command migration:** migrate non-financial booking, guest, and room commands first, with optimistic version checks, scope enforcement, outbox events, durable read-back, and rollback/recovery tests.
6. **UI read migration:** switch one screen at a time behind a disabled-by-default feature gate; compare repository results with legacy projections before rendering canonical reads.
7. **Financial domain separately gated:** folio/payment writes remain frozen. Only after authorized backup review and accounting approval may a separate change migrate ledger commands and reconcile `booking.p`, `booking.pays[]`, and `booking.payments[]`.
8. **Adapter parity:** run the same contract suite against IndexedDB and Android SQLite, including process interruption, transaction rollback, schema upgrade, and restore.
9. **Cutover acceptance:** require zero unexplained discrepancies, verified backup/rollback, all critical tests passing on the exact commit, Android instrumentation and device evidence, and owner approval. Only then consider setting `uiCutover=true`.

## Stop conditions

- Missing or ambiguous booking/guest/room identity.
- Any unexplained source-to-repository mismatch.
- Cross-tenant/property record visibility.
- Lost unknown booking fields or changed financial history.
- Repository write/read-back failure, stale-version conflict, or outbox inconsistency.
- Accounting kill switch changes or attempted gateway activation.
- Native SQLite contract or device qualification failure.

**Current release decision:** no operational UI cutover, no ledger mutation, no gateway collection, no automatic settlement, and no APK build or production deployment.


## 2026-11-07 — deterministic booking shadow-plan foundation

Added `src/storage/legacy-booking-shadow-plan.mjs` as a pure, read-only planner. It creates deterministic canonical booking keys from legacy booking IDs, scopes each planned envelope to an explicitly supplied tenant/property, and retains the complete original booking object under `legacyRecord`. This preserves unknown fields and the original `p`, `pays[]`, and `payments[]` values without selecting a financial source of truth.

The planner scans both active `b[]` and cancelled `cancelled[]` collections. Missing/invalid IDs, malformed rows, and duplicate IDs across either collection are reported as blocking issues; ambiguous records are not assigned guessed identities. Planning does not write to the repository, alter the input snapshot, resolve guest identities from names, or infer canonical room IDs from room numbers. Re-running the planner against the same snapshot and scope yields the same plan.

**Boundary:** this is a deterministic shadow-plan generator, not an executed migration. No real PMS snapshot was available, no canonical entity was written, and no operational screen was switched. The next gate is collision-checked guest/room linkage and an explicit source snapshot digest + migration-run journal before bounded transactional import can be considered.
