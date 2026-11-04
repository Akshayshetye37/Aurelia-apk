# PMS Accounting Schema — Source Audit

**Branch:** `feature/multi-provider-payment-backend`  
**Audit date:** 2026-11-04  
**Auditor:** OpenAI code audit  
**Status:** Source review complete for the checked-in web application and settlement modules; runtime/device persistence behaviour is not independently instrumented.

## 1. Purpose and scope

This document records the accounting structures and payment mutation paths found in the repository source. It distinguishes the local PMS ledger from the separate cloud payment-backend prototype. Statements below are based on the checked-in files and line locations, not on assumed production Firestore data.

Primary files inspected:

- `index.html` — application state, folio calculations, UI settlement, persistence and backup/restore.
- `src/payments/settlement-service.mjs` — canonical local settlement mutation boundary.
- `src/payments/settlement-gate.mjs` — automatic settlement feature gate.
- `src/payments/settlement-journal.mjs` — IndexedDB command journal.
- `src/payments/settlement-apply.mjs` — authorization-gated projection boundary.
- `payment-backend/src/intents/folio-settlement.mjs` — separate cloud prototype settlement.

## 2. Core objects

### 2.1 Reservation / booking object

**Authoritative in-app collection:** `S.b`, an array in the application state object declared in `index.html`.

The demo booking constructor creates objects with these fields:

| Field | Observed type | Meaning |
|---|---|---|
| `id` | number | In-memory booking identifier, incremented by the app |
| `g` | string | Guest name |
| `room` | string | Room identifier |
| `in`, `out` | number | Stay-day offsets used by date helpers |
| `st` | string | Booking status |
| `ch` | array | Additional charge rows, represented as label/amount pairs |
| `rate` | number | Room rate |

The imported-booking normalizer additionally ensures/creates `id`, `g`, `room`, `in`, `out`, `st`, `ch`, `p`, `pays`, `oc`, `veh`, `checkInTime` and `checkOutTime`. Other fields are added by operational flows (for example `dc`, `iv`, actual check-in/out timestamps, guest/contact details and cancellation metadata). There is no single enforced schema validator that enumerates every allowed booking property.

**Booking statuses observed:**

- `res`: reserved / arriving.
- `in`: checked in / in-house.
- `done`: departed / checked out.
- Other values may exist in imported or cancelled records.

**Payment posting rule:** `settlePayment()` permits blank status or `res`, `in`, `done`; a non-empty status outside that set is rejected. It also requires the booking object to be the same object instance contained in `state.b`. Cancelled bookings are included in the global duplicate scan, but are not eligible for a new posting through this check because they are not in `state.b`.

### 2.2 Folio / payment collection

**Canonical local payment rows:** `booking.pays` (array).  
**Legacy/history mirror:** `booking.payments` (array).  
**Stored paid-total field:** `booking.p` (number in major currency units).

One payment row written by `src/payments/settlement-service.mjs` has this shape:

| Field | Type | Meaning |
|---|---|---|
| `a` | number | Amount in major currency units (the configured UI defaults to ₹) |
| `amountPaise` | integer | Same amount in integer paise |
| `m` | string | Payment method |
| `r` | string | Normalized reference / UTR when supplied |
| `at` | ISO date-time string | Posting timestamp |
| `auto` | boolean | Whether source is automatic |
| `source` | string | `manual`, `staff_review`, `reservation_advance` or `auto` |
| `bookingId` | number/string-compatible booking identifier | Booking association |
| `verificationConfirmed` | boolean | UI/business confirmation flag; not cryptographic provider proof |
| `idempotencyKey` | string or undefined | Supplied key or derived `ref:<reference>` |

The parallel `booking.payments` history row uses descriptive keys: `date`, `amount`, `amountPaise`, `method`, `reference`, `source`, `bookingId`, `verificationConfirmed`, `idempotencyKey`.

**Important qualification:** `booking.pays` is the payment-row source used by invoice rendering and the `paid()` helper. The stored `booking.p` is used by the main due calculation and several reports. These are not guaranteed to agree for legacy or imported records.

### 2.3 Balance calculation

The main PMS calculations in `index.html` are:

- `tt(b)`: room charge + additional charges − discount, rounded to two decimals.
- `dueB(b)`: `tt(b) - (b.p || 0)`, rounded to two decimals.
- `paid(b)`: sum of `b.pays[].a`.

Therefore, the current main due calculation trusts `booking.p`, not the sum of `booking.pays`. Invoice display also uses the sum of payment rows for its displayed paid amount. A legacy mismatch can therefore produce different paid figures in different UI locations.

**Precision:** The UI stores/display-calculates major units (default currency symbol ₹) to two decimal places. The settlement service converts entered major units to integer paise for validation and arithmetic, then stores both `a` (major units) and `amountPaise` (integer paise). Its accepted tolerance after scaling is `1e-7`; more than two decimal places are rejected.

**Overpayment:** `settlePayment()` rejects a new payment greater than the caller-supplied `balanceDue`. Idempotent retries are checked before due validation.

**Legacy paid-total behaviour:** When adding a payment, the service sets the new paid total to `max(sum(prior booking.pays), prior booking.p) + new payment`. This preserves a legacy paid total that has no matching payment rows, but does not repair or explain the difference. The `paid()` display helper still sums only `pays`.

**Currency limitation:** The app has a configurable currency symbol (`S.set.cur`, default ₹), but the inspected local booking/payment schema does not store a per-booking ISO currency code. The settlement service names its integer minor-unit field `amountPaise` and applies INR-style 100-paise conversion without a currency parameter. It is not currently a multi-currency ledger contract.

## 3. Settlement writer

**File:** `src/payments/settlement-service.mjs`  
**Function:** `settlePayment()`

### 3.1 Inputs and validation

Inputs: `state`, `booking`, `amount`, `method`, optional `reference`, `source`, `idempotencyKey`, required `balanceDue` for a new post, `verificationConfirmed`, automatic-settlement gate inputs, `persist`, `audit`, and `now`.

Validation includes:

- Allowed source enum.
- `verificationConfirmed === true`.
- Booking must be present by object identity in `state.b`.
- Status must be blank, `res`, `in` or `done`.
- Positive amount with no more than two decimal places and safe integer paise.
- Non-empty bounded payment method; bounded/control-character-free reference and key.
- Duplicate idempotency key and payment reference checks across active and cancelled booking arrays.
- New amount must not exceed supplied balance due.

The confirmation flag is a local staff confirmation, not a trusted gateway authorization. The separate journaled staff-review path requires an authorization callback and opaque token, but no trusted issuer/projector is installed in the current HTML module.

### 3.2 Fields mutated

For a successful local post, `settlePayment()` updates:

- `booking.pays`: appends the canonical payment row.
- `booking.p`: increments stored paid total.
- `booking.payments`: appends the compatibility/history row.
- `state.today`: increments daily takings.
- `state.aud`: updated through the supplied audit callback.

It does not directly write Firestore or a remote payment document.

### 3.3 Idempotency and deduplication

- An explicit `idempotencyKey` is used when supplied.
- If no explicit key exists and a reference is present (except `reservation_advance`), the service derives `ref:<normalized reference>`.
- The service scans `state.b` and `state.cancelled`, checking both `pays` and `payments`.
- Exact same-booking replay with matching amount, method and normalized reference returns `duplicate: true` without mutation.
- Reusing a key for another booking or different payment details is rejected.
- For UPI/bank/NEFT/RTGS/IMPS/card/wallet-like methods, reference whitespace is removed and the reference uppercased.
- Legacy reference deduplication is global across the local booking set. `reservation_advance` is exempt from reference-based deduplication.

This is a local in-memory scan. It is not a cross-device uniqueness constraint and cannot prevent two separate devices from independently recording the same UTR.

### 3.4 Failure and rollback behaviour

The service snapshots the affected booking arrays/paid total, `state.today`, and (when it is an array) the audit list. On a synchronous exception during mutation/audit/persist it restores those in-memory values and attempts to persist the restored state.

The application wrapper used by the UI calls `persist()`, reads the saved JSON back, and verifies the booking paid total, payment rows/history, daily total and audit list. A failed read-back throws, allowing the settlement service to roll back in-memory state.

This is **not a database transaction**. The booking state is persisted as one JSON value under local storage key `aurelia_lodge_v2`; there is no compare-and-swap or multi-device transaction. The rollback write is best-effort. A process termination/power loss between storage mutation and verified read-back can leave an uncertain result until the next load/backup inspection. The journaled settlement module is a separate IndexedDB journal, but its configured projector currently always throws and its trusted authorization callback is not installed; it does not currently bridge verified gateway capture into the local folio.

## 4. Persistence, backup and restore

- Main app state is serialized from the `DK` allow-list into JSON and saved under `aurelia_lodge_v2` using `localStorage` (or the Android-provided `window.__aureliaStorage` wrapper).
- The storage wrapper falls back to an in-memory map when browser local storage is unavailable. In that mode data is session-only and the UI warns that persistence is unavailable.
- The app loads and validates required top-level arrays/objects, restores the state keys, and quarantines invalid saved JSON under a recovery key.
- Full backup/restore uses a versioned encrypted backup payload and checksum validation in the backup flow. Restore normalizes booking aliases and fills missing arrays/defaults. The inspected import/restore path does not recompute `booking.p` from `booking.pays`; it preserves the imported paid total and rows.
- Restore snapshots current in-memory state and attempts rollback if restore/persist/read-back validation fails. This is a recovery procedure, not a transactional storage engine.
- No booking-level optimistic-lock version field or compare-and-swap mechanism was found in the inspected local settlement path. `updatedAt` is not used as a folio concurrency token here.

## 5. Multi-device / server-side presence

**Does the checked-in live PMS UI use `pms_reservations/{reservationId}/folios/{folioId}`?** No such local UI read/write path was found in the inspected application entry point and settlement modules.

**Does local `settlePayment()` write remotely?** No. It mutates the supplied local state and invokes the supplied persistence callback.

**Is payment-backend `paymentFolios/{hash}/journalEntries/{intentId}` the live PMS ledger?** No evidence of that connection was found. It is a separate Firestore prototype in `payment-backend/src/intents/folio-settlement.mjs`. It expects a separately provisioned `paymentFolios` document with `tenantId`, `folioId`, `currency`, `balanceMinor`, `revision` and `status`; it does not project into `S.b`, `booking.pays` or `booking.p`.

The current repository therefore has a local-first PMS ledger and a separate cloud payment prototype, not a unified multi-device folio ledger.

## 6. Currency and amount handling

- UI currency symbol defaults to ₹ but can be changed in hotel settings.
- Local booking totals and payment `a` values are major units represented as JavaScript numbers with two-decimal rounding.
- Payment rows also include integer `amountPaise`.
- Payment-backend intents use integer `amountMinor` and an explicit `currency` field; the current cloud settlement prototype requires `INR`.
- The local UI's configurable currency symbol is not a currency code and is not bound to the backend intent currency. This mismatch must be resolved before gateway integration.

## 7. Known inconsistencies and technical debt

1. `booking.p` and `sum(booking.pays[].a)` can disagree. The settlement service deliberately preserves legacy `p`, while the invoice paid helper sums `pays`; main due calculation uses `p`.
2. `booking.payments` is written as a history mirror in addition to canonical `booking.pays`. Duplicate scans inspect both arrays.
3. Booking fields are dynamically added by app workflows; there is no single strict booking schema.
4. UI standalone fallback settlement code duplicates part of the local settlement implementation. The module adapter is the normal local path, but the fallback remains embedded in `index.html`.
5. Imported bookings normalize `p` and `pays` independently; restore does not reconcile them.
6. Local idempotency is only device-local. It is not a globally enforced constraint across devices.
7. The IndexedDB journal can durably append pending settlement commands, but the current HTML has no trusted authorization issuer or actual projection function; the projector explicitly fails closed.
8. Local currency symbol configuration can diverge from the INR paise assumption in the settlement service and the cloud payment backend.
9. The main `persist()` helper catches storage errors rather than propagating them. The payment-specific wrapper compensates with read-back verification, but the general state persistence API is not uniformly fail-fast.
10. The local ledger and cloud `paymentFolios` prototype are separate data models with no verified mapping.

## 8. Conclusions and integration implications

- **Authoritative ledger for the currently shipped local PMS UI:** `S.b[]` booking objects, with `booking.p` used by the main due calculation and `booking.pays[]` used as payment detail rows. These fields are not perfectly normalized; they must be reconciled before an automated bridge is enabled.
- **Recommended integration:** Option A — local-first with a backend-authorized, idempotent settlement command and local projection through the existing `settlePayment()` boundary. The cloud backend verifies provider capture and issues a narrowly bound, short-lived authorization; the trusted Android/native layer validates it and invokes local settlement. The backend must receive a durable device acknowledgement only after local persistence/read-back succeeds.
- **Automatic gateway settlement status:** OFF. `AUTO_FOLIO_SETTLEMENT_ENABLED` is hard-coded false. The HTML journal path reports no trusted issuer, no native projector and no command acknowledgement.
- **Schema migration:** No move to `pms_reservations/{id}/folios/{id}` is justified by the current source. A server-side multi-device ledger would be a separate future architecture project requiring migration and offline conflict handling.
- **Important security qualification:** Do not expose an authorization token to arbitrary WebView JavaScript and treat its presence as sufficient. The trusted native/backend channel must bind tenant, booking ID, amount in minor units, currency, provider transaction ID, intent ID, expiry and one-time nonce; local projection must independently enforce idempotency.

## 9. Open questions

1. Confirm on a physical Android installation whether `window.__aureliaStorage` is backed by native durable storage and what its write/flush guarantees are.
2. Determine whether the product requires multiple devices to mutate one booking concurrently. If yes, define a conflict/reconciliation protocol before enabling provider auto-posting.
3. Confirm whether the configurable currency setting is intentionally INR-only in production. If not, replace the paise-specific contract with currency-aware minor-unit metadata.
4. Decide how to reconcile historical bookings where `booking.p` differs from the sum of `booking.pays`; do not silently rewrite financial history.
5. Confirm whether the trusted native settlement issuer/projector is planned as a Capacitor plugin or an authenticated device API.

## Source evidence (branch snapshot)

- `index.html`: state declaration and booking constructor; lines 423–424.
- `index.html`: booking lookups, audit helper, total and due formula; line 530.
- `index.html`: payment-row sum helper; line 668.
- `index.html`: UI settlement wrapper and storage read-back verification; lines 670–681.
- `index.html`: manual payment form and confirmation; lines 684–694.
- `index.html`: backup allow-list and persistence/load logic; lines 969–1002 and 1443–1455.
- `index.html`: imported booking normalization; lines 1329–1350.
- `index.html`: standalone fallback settlement; lines 4470–4518.
- `index.html`: local module adapter and journaled settlement adapter/status; lines 4520–4565.
- `src/payments/settlement-service.mjs`: complete validation, dedupe, mutation and rollback implementation.
- `src/payments/settlement-gate.mjs`: automatic settlement hard-off.
- `src/payments/settlement-journal.mjs`: IndexedDB journal transaction and pending/applied states.
- `src/payments/settlement-apply.mjs`: token/callback authorization requirement and pending recovery.
- `payment-backend/src/intents/folio-settlement.mjs`: separate Firestore paymentFolios settlement prototype.
