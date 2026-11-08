# Aurelia device-primary architecture contract

**Normative rule:** Aurelia is a device-primary application. Every feature must operate on and persist its working state on the primary device first. No PMS feature may require cloud connectivity, a remote database, account login, analytics, or a sync service to start, read local data, or commit a local business change.

## 1. Data ownership

The primary device is the operational source of truth for the property's active Aurelia installation.

- Android: native SQLite through the Capacitor storage bridge.
- Browser/PWA: IndexedDB.
- localStorage is retained only for the legacy compatibility/migration boundary until each old screen and command has been safely moved; it is not a second canonical database.
- The app must not silently substitute volatile JavaScript memory, session-only state, a remote database, or a different platform's storage engine when durable local storage is unavailable.
- App restart, WebView recreation and device reboot must not erase committed business data.

## 2. Applies to every feature

The rule applies without feature exceptions to:

- reservations, booking changes, cancellations and guest records;
- rooms, room status, occupancy, housekeeping and maintenance;
- folios, charges, receipts, manual payments, refunds/reversals and accounting history;
- inventory, expenses, menu, taxes, rates and property settings;
- staff workflows, local authorization state, payment-review evidence and decision history;
- dashboards, reports, invoices, exports, notifications and audit/recovery records;
- payment-provider selection, checkout intents, provider references and reconciliation evidence.

Each feature must load from the local repository and persist its local changes before any optional remote work begins. Derived screens and reports must be computable from local records.

## 3. Offline behavior

- Startup and normal PMS reads/writes do not require a network request.
- Local business changes are committed durably before being shown as saved.
- A local commit failure is visible and must not be reported as success.
- When synchronization is later enabled, immutable outbox events are delivered with idempotency, retry and conflict handling. Sync is OFF by default and is not part of the local commit's success condition.
- Backup/export may be offered as a user-controlled operation. Remote backup is not a runtime dependency.

## 4. External services are effects, not the PMS database

Some actions inherently require an external party. For example, a gateway cannot authorize or capture a real charge while offline. The feature still works locally: Aurelia saves the payment intent, amount/currency binding, idempotency key, pending/unknown state, provider reference when available, evidence and recovery state on the device. The external authorization is attempted only when connectivity exists. Until authoritative provider verification is received, the UI must not label the payment captured or credit the folio as settled.

The same rule applies to WhatsApp delivery, SMS, email, online tax/identity checks and other third-party effects: preserve the local draft/request/status first; clearly represent queued, pending, failed or externally confirmed states. Do not fabricate external completion.

Merchant credentials, private keys, webhook secrets and signing material remain in the trusted provider/backend boundary. This security boundary does not make the backend the PMS data source of truth.

## 5. Transaction and recovery requirements

- Each business mutation and its local audit/outbox event must commit atomically in the device database.
- Use stable entity IDs, optimistic version checks and idempotent command IDs.
- Multi-entity operations (for example, room reassignment or folio settlement) require one local transaction.
- Read back the committed row before returning a successful save result.
- Preserve legacy source snapshots and unknown fields during migration. Never guess ambiguous identities or overwrite a non-empty canonical database.
- Conflicts and unknown external outcomes remain explicit; never use silent last-write-wins for financial or inventory records.

## 6. Runtime enforcement added

The local-first runtime policy module defines the device-primary policy and rejects a platform/storage-engine mismatch or an incomplete local repository contract. The PMS bootstrap coordinator establishes this policy after durable local storage and guarded migration verification, before releasing the application scripts. The runtime reports cloud sync disabled and network not required for startup.

The bootstrap validates a declared inventory of 26 product feature areas (reservations, guests, rooms, housekeeping, maintenance, folios, manual payments, gateway intents, refunds, inventory, expenses, settings, staff workflows, payment review, reports, invoices, notifications, audit/recovery and provider selection) against the no-network/no-cloud-prerequisite contract. Regression coverage is provided by the local-first runtime policy test and bootstrap assertions.

## 7. Honest implementation boundary

This policy is now explicit and enforced at bootstrap, but it does **not** falsely certify that every legacy UI screen has already been migrated. The existing application bootstrap still reports uiCutover false; legacy screens continue to use compatibility state until their individual reads and writes have been migrated and verified against the canonical local repository.

Therefore:
- device-primary is the mandatory architecture for all new and migrated feature work;
- no cloud-first feature may be added;
- the remaining implementation work is the complete operational UI/domain-command cutover, including every feature listed above, followed by migration parity and device-level restart/offline/rollback qualification;
- cloud sync remains disabled and optional throughout that work.

**Acceptance condition:** do not declare the application fully device-primary in implementation until every feature read and write is repository-backed on the device, network-disabled tests pass for all local workflows, and Android SQLite/browser IndexedDB persistence and recovery are qualified.
