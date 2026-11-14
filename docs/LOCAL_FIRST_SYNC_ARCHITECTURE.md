# Local-first PMS data and optional cloud sync

**Status:** Contract/foundation implemented; no transport or canonical transaction adapter enabled. **Default:** local-only; cloud sync OFF. Payment gateway processing is separate.

## Topology

```text
PMS UI -> domain services -> canonical local transactional repository
                            |-- PMS entities / folio ledger
                            |-- append-only business events
                            |-- durable sync outbox (same transaction)
                            |-- recovery / backup
                            |
                       optional authenticated sync transport (OFF)
                            v
                       customer-controlled future sync service

Separate: device checkout -> official payment provider / approved SDK.
```

## Atomicity rule

A business mutation and its outbox event MUST commit in one database transaction. Android uses SQLite; browser/PWA uses one IndexedDB readwrite transaction spanning entity and outbox stores. The adapter exposes one `transactBusinessChange` boundary with version check, mutation, version increment and event append.

The current app's canonical PMS record remains localStorage-backed; the existing native/IndexedDB payment journals are separate. A localStorage snapshot plus a separate journal is not atomic. Therefore this branch does not claim every PMS write is safely queued. Do not enable transport until the canonical repository migration and atomic adapter exist.

## Event envelope and delivery

Events carry immutable `eventId`, tenant/property/device identity, entity type/id, aggregate sequence, schema version, allow-listed event type, timestamp and minimal payload. Delivery metadata may move through PENDING, IN_FLIGHT, ACKNOWLEDGED, RETRY and CONFLICT; business events remain immutable. Corrections are compensating events.

Use stable event IDs, aggregate sequence/version, idempotent cloud ingestion, exact acknowledgements, bounded batches, retry/backoff and conflict quarantine. A gap or concurrent folio edit is a conflict, never silent last-write-wins. Snapshot bootstrap must atomically capture a local snapshot and high-water mark, then replay events after it. Legacy changes without captured events can only be represented as a labelled opening snapshot, not reconstructed as authentic history.

Do not enqueue UI keystrokes or arbitrary staff notes. Minimize guest PII. Never include credentials, tokens, card data, CVV or identity-document contents in generic events.

## Configuration and trust

Endpoint URL is routing metadata, not authentication. Sync defaults disabled and endpoint blank. Client validation requires public HTTPS and rejects private/local targets, userinfo, query, fragment and nonstandard ports. This is input hygiene only: the future service must independently enforce device enrollment, tenant authorization, TLS, replay protection, schema validation, rate limits and audit. Never place bearer tokens, passwords, private keys or service-account material in admin value boxes or local app storage.

Payment-provider order creation, capture verification, refunds and webhooks are not PMS sync operations. Merchant secrets must remain outside the device and generic sync outbox.

## Implemented

- `src/sync/local-sync-coordinator.mjs`: endpoint/config validation, versioned event validation, sensitive-field rejection, strict atomic repository contract, bounded batch/ack/retry/conflict orchestration.
- `tests/sync/local-sync-coordinator.test.mjs`: config, endpoint, event, atomic-boundary delegation and disabled-sync tests.

## Not implemented / not claimed

Canonical SQLite/IndexedDB PMS repository, migration from localStorage, atomic outbox schema/adapter, device enrollment, HTTP transport, server authentication, snapshot bootstrap, conflict UI, retention/restore drills and physical crash/power-loss tests.

**Release rule:** this foundation does not enable sync or change live-payment status. Complete the local database migration and atomic adapter before enabling any network worker.


## Concrete browser/PWA repository implementation

Added `src/storage/indexeddb-pms-repository.mjs`. Canonical entity state and the corresponding outbox event share one IndexedDB readwrite transaction. The adapter includes optimistic version checks, leased batches, device-bound acknowledgements, retry/conflict transitions, and guarded legacy JSON ingestion.

Migration validates the existing PMS state shape, stores the exact raw source snapshot alongside imported structured legacy records in one transaction, refuses to overwrite a non-empty canonical database, and records a one-time migration marker. Replaying the same migration ID/source is idempotent.

This is the browser/PWA adapter only. Android still requires a native SQLite implementation of the same contract. The current `index.html` app has not yet been switched to this asynchronous repository; do not delete or overwrite its localStorage state until UI/domain commands and on-device recovery have been migrated and tested.
