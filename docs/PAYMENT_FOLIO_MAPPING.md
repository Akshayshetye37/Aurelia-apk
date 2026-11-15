# Payment folio mapping — draft for accounting-owner approval

**Status:** DRAFT — NOT APPROVED. No production payment activation is authorized by this document.  
**Canonical plan:** [REMAINING_WORK_AUDIT_2026-11-09.md](./REMAINING_WORK_AUDIT_2026-11-09.md)  
**Decision required:** Accounting owner must approve this mapping in writing before any live collection or automated settlement is enabled.

## Authority boundary

The local PMS journal (SQLite on Android; IndexedDB in browser/PWA) is the sole financial ledger. The backend Firestore payment collections are operational caches and evidence stores. Receipt acceptance verifies a device-signed statement that the local journal commit and read-back already succeeded; it must not create a second financial journal or decrement a backend folio balance.

## Proposed field mapping

| Backend field | Local PMS field / record | Mapping rule | Authority |
|---|---|---|---|
| `paymentMemberships.tenantId` / `paymentIntents.tenantId` | Repository bridge `tenantId` | Must resolve to the same owner-approved PMS tenant scope. | Local repository identity is authoritative; backend membership is authorization evidence. |
| `paymentIntents.folioId` | `booking.folioId`; legacy fallback `booking-${booking.id}` | Exact string match; never fuzzy-match or infer by guest name/room. | Local booking/folio identity is authoritative. |
| `paymentIntents.bookingId` (from cached folio snapshot) | Local booking entity ID | Exact stable booking ID; must resolve to exactly one active/cancelled booking as permitted by policy. | Local booking repository is authoritative. |
| `paymentIntents.amountMinor` | Local payment `amountPaise` | INR only; integer paise; 1 backend minor unit = 1 local paise. | Local journal validates the actual due and accepted amount. |
| `paymentIntents.currency` | Local folio currency | Exact `INR` match. No implicit conversion. | Local folio contract. |
| Provider, environment, merchant account, order ID and payment ID | Immutable local payment metadata and receipt evidence | Preserve exact provider identity and sandbox/live environment. | Server-side provider verification plus device receipt; client callback is not evidence. |
| `paymentIntents.intentId` / command ID | Local settlement command and signed receipt | Bind command, intent, payment ID and receipt one-to-one; replay must be idempotent. | Local journal idempotency and server receipt registry. |
| `paymentIntents.deviceId` | Enrolled attested device ID | Exact match to the device that performed the local posting/read-back. | Attestation registry. |
| Signed receipt `ledgerEntryHash` | Hash of canonical local payment entry after read-back | Device signs the hash only after local transaction commit and read-back verification. | Local journal evidence. |
| `paymentFolios` snapshot fields | Cache/preflight only | May reject obviously stale/closed requests, but never acts as a ledger, is never decremented on receipt acceptance, and never proves a local credit. | Non-authoritative cache. |
| `paymentFolioLocks` | No local financial row | Concurrency/idempotency lock for one backend tenant+folio intent at a time. | Operational coordination only. |
| `paymentAccountingReceipts` | No local financial row | Store signed receipt and provider-verification evidence only. | Evidence registry, not ledger. |

## Required controls

- Receipt acceptance does not create `paymentFolios/{id}/journalEntries` and does not update a folio balance.
- Local settlement rechecks the current balance inside the local repository transaction and refuses overpayment.
- A captured payment rejected by the local device remains captured-but-unposted and enters reconciliation; it is never silently credited.
- Any correction to the local financial journal is a reversing entry, not an update/delete.
- Tenant/folio mapping is deterministic and tested for mismatch, cross-tenant access, duplicate booking IDs and stale cache snapshots.
- The accounting owner must approve the exact mapping and the historic/imported balance reconciliation policy in writing.

## Approval record

- Accounting owner: **PENDING**
- Written approval reference: **PENDING**
- Approved mapping version: **PENDING**
- Approval date: **PENDING**

Until all approval fields are completed and the evidence is linked, this mapping is not approved and live collection remains OFF.

## Current implementation evidence (provisional; not accounting approval)

- Canonical manual and staff-reviewed payment postings now append an `AURELIA_FINANCIAL_LEDGER_ENTRY_V1` record with integer `amountPaise`, `transactionType: PAYMENT_RECEIVED`, tenant/property/device, booking/folio, method, reference, source, idempotency key and timestamp.
- The payment ledger entity, booking projection, folio projection and recovery snapshot are committed in one repository batch and verified by exact read-back.
- Ledger entities are append-only in both the IndexedDB and Android SQLite repository adapters. Stable payment IDs are derived from a SHA-256 digest of tenant identity plus idempotency key.
- The same canonical entry is included in the recovery snapshot and retains its stable entity ID during domain projection/restart.
- A payment without a stable idempotency key is rejected before persistence. A duplicate retry must match the existing ledger row and recovery projection; otherwise it fails closed.
- Reservation advances, expenses and restaurant sales are not yet routed through this journal. This is an operational payment journal only: it does **not** assign debit/credit accounts, migrate historical `p` / `pays[]` / `payments[]` values, or authorize accounting reports. Those mappings remain pending the accounting owner's written approval and redacted-backup reconciliation.

The mapping above remains **PENDING**. Live collection, automatic settlement and automatic refunds remain OFF.
