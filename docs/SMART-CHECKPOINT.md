# Smart Checkpoint — local folio reconciliation

## Purpose

The Smart Checkpoint is a local-first accounting domain boundary between payment evidence and folio settlement. It does not initiate gateway payments, verify gateway signatures, or treat checkout callbacks as proof of capture. Provider-specific verification must happen before a gateway payment entry is stored with `status: "VERIFIED"`.

No Aurelia-owned cloud service is required by this domain module. Provider SDKs and official provider services remain responsible for payment processing and any provider-mandated verification mechanism.

## Reconciliation model

```
Net charges = gross charge lines - discounts - approved credits
Remaining due = net charges - verified/posted payments + posted refunds
```

All monetary values are integer minor units (paise for INR). Floating-point rupees are not accepted by the engine.

The checkpoint classifies a folio as:

- `PENDING_REVIEW`: at least one payment/refund entry is not verified or posted.
- `PARTIALLY_PAID`: verified/posted entries exist but a positive balance remains.
- `OVERPAID`: payments exceed net charges; this requires investigation/refund handling.
- `SETTLEMENT_READY`: the exact remaining balance is zero and there is no unverified evidence.
- `SETTLED`: a staff settlement approval has been committed.

A provider callback must never directly set a folio to `SETTLED`.

## Human actions and controls

- Staff may record an independently received cash or external payment as a separate `POSTED` payment entry.
- Only manager/owner/admin roles may approve a write-off. A reason is mandatory.
- Settlement approval requires zero balance, no unverified entries, an authorized staff identity and a matching folio version.
- Each action appends an audit record with actor, role, time, amount/reference and source version.
- Payment and adjustment IDs are idempotent; replays do not double-post.
- A stale version fails with `FOLIO_VERSION_CONFLICT`; the UI must reload the folio and ask the operator to review again.
- Opening a review screen does not lock the folio.

## Local persistence contract

`SmartCheckpoint` requires a repository with:

- `readFolio(folioId)`
- `transactFolio(folioId, callback)`

The second operation **must execute the callback and commit the resulting folio/version/audit changes atomically in one local database transaction** (SQLite transaction or a single IndexedDB readwrite transaction). A plain localStorage read-modify-write adapter is not sufficient for multi-tab/process concurrency and must not be advertised as atomic.

The module deliberately does not silently adapt the current application-wide localStorage model or split a folio update across two stores. That would create a false atomicity guarantee. The current PMS canonical booking/folio state must be migrated or exposed through a transaction-capable local repository before the engine is connected to live folio UI.

## Current implementation boundary

Implemented in this branch:

- Pure paise-based reconciliation calculation.
- Pending/unverified evidence exclusion.
- Payment/refund/discount/credit math and overpayment classification.
- Staff cash/external payment posting with idempotency.
- Manager-only reasoned write-off.
- Explicit staff settlement approval and audit trail.
- Optimistic folio version checks.
- Automated unit tests for these rules.

Not yet connected/released:

- The app's canonical booking store does not yet implement the required atomic `transactFolio` adapter.
- The Smart Checkpoint popup and resolution buttons are not yet wired into the existing folio screen.
- Provider SDK callback/verification adapters remain provider-specific; the Smart Checkpoint does not replace them.
- Cross-device folio coordination is not provided by a device-local database.
- Gateway live collection and automatic settlement remain disabled.

Do not enable live collection or describe this module as production-integrated until the local transaction adapter, UI workflow, provider verification paths and physical-device acceptance are complete.
