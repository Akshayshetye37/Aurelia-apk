# Payment / folio settlement write-path audit

**Source implementation history:** `feature/direct-upi-reconciliation`  
**Inspected integration branch:** `feature/multi-provider-payment-backend`  
**Phase A hotfix:** `0dcf0e319f0c6c0fa3bc16383482dcb479110b88`  
**Phase B implementation commits:** `5433111`, `9a684ca`, `b0d9f28`, `233df47`, `bdaf590`, `d3a2948`, `418beb0`, `c8afa7f`, `fde1fd0`  
**Status (2026-11-08):** Manual folio payments and staff-reviewed UPI approvals now use an asynchronous repository transaction that commits the booking entity, folio projection and full recovery snapshot in one IndexedDB/SQLite batch, followed by exact read-back. The source-only CI suite and production web bundle passed on commit `773d98443a361f9c26d736d977afa17a5b991f97` (354 tests). Android APK/device qualification and provider UAT remain outstanding. Automatic gateway settlement remains disabled.

## Deployment and connectivity policy

The current PMS settlement implementation is local-first. A server, cloud account or Firebase deployment is not required for manual PMS operations or manual/cash payment recording. Remote payment processing is optional and must remain unavailable until an owner explicitly configures a trusted payment backend through a future Settings workflow. Do not reuse backup endpoint settings as payment API configuration. No automatic cloud provisioning or guest/payment data upload is permitted. The payment-backend Settings workflow is not implemented; this audit does not claim otherwise.

## Settlement invariants

The folio has three related representations: `booking.pays` (canonical payment rows), `booking.p` (paid total used by balance calculations), and `booking.payments` (legacy/history rows). Runtime changes to these fields must be made only by `src/payments/settlement-service.mjs` through `settlePayment()`. `addPay()` is now a compatibility adapter, not a writer.

The settlement policy service validates booking membership, amount, method, balance limit and source; deduplicates by idempotency key and non-empty reference; and updates payment rows, paid total, history, daily total and audit. Manual payments and staff-reviewed UPI approvals now run through `src/payments/repository-settlement-service.mjs`, which commits the booking, folio projection and recovery snapshot in one version-checked repository batch and verifies exact read-back before reporting success. This transaction does not authorize gateway settlement and does not yet make all non-payment PMS mutations repository-first.

## Frozen write-path table

| Site / route | Classification | Current disposition |
|---|---|---|
| `src/payments/settlement-service.mjs` — `settlePayment()` | **Canonical settlement writer** | Sole runtime writer of `booking.pays`, `booking.p`, `booking.payments`, `state.today`, and payment audit entry. Automatic source calls the canonical `assertAutoFolioSettlementEnabled()` before mutation. |
| `index.html` — `addPay(b,a,m,r,auto)` | Compatibility alias | Thin adapter to `settlePayment()`. `auto=true` routes to source `auto`, which fails closed while the gate is false. Current search found no remaining call sites beyond the adapter definition. |
| Manual folio payment handlers, including the final `pay(i)` assignment | Canonical local settlement | Await `settlePaymentToRepository` through the UI adapter. Booking, folio projection and full recovery snapshot commit atomically; exact read-back precedes success. Duplicate requests are idempotent. |
| `sigA(id,i)` | Canonical staff-reviewed settlement | Validates evidence ID, review state, UPI amount, reference and evidence-bound idempotency key; atomically commits evidence approval, booking payment, folio projection and recovery snapshot. Replay is idempotent. |
| Primary guest/reservation creation / booking advance | Canonical snapshot commit; domain transaction incomplete | `dsave()` now awaits `persistCanonicalStrict()` and exact full-state snapshot read-back after preparing guest, booking and any advance; rollback is attempted through the same canonical path. The advance is still applied in memory before the snapshot commit and guest/booking/folio are not yet separate entities in the same batch. Other reservation entry points remain to be migrated. |
| `addSig(o)` and `window.aureliaNativePaymentSignal` | Evidence / suggestion only | Creates a signal, deduplicates repeated notifications, and may set `pending_review` plus `suggestedBookingId`. Does not call `addPay()` or `settlePayment()`. |
| `src/payments/reconciliation-service.mjs`, `payment-engine.mjs`, `evidence-store.mjs` | Evidence ingestion, matching and persistence | No folio writes. Reconciliation service returns match suggestions and rejects staff decisions marked posted/settled. |
| Demo/bootstrap initialization (`index.html`, around original lines 493 and 625–626) | Seed data, not runtime settlement | Seeds demo paid totals/payment rows. Keep these values consistent; they are the remaining direct field assignments outside the runtime settlement service. |
| State import/restore paths (prior audit: around `index.html:1000–1077`) | Privileged state replacement / migration | May replace booking/payment state as a whole; not a normal payment path. Imported legacy totals/rows still need validation and normalization policy. |
| `addC()`, `dcApply()`, restaurant-to-room posting | Charge / discount operations | Separate folio mutations; must not change payment rows or paid totals. |
| Restaurant sales (`recordRestPay()`) | Independent restaurant ledger | Does not settle a hotel folio. |
| Cancellation/refund journal (`commitCancellationRefund()`) | Separate accounting workflow | Writes cancellation/refund journals and refund statuses, not a hotel payment settlement. |
| Export / invoice / reports | Read-only consumers | Read paid totals and payment rows; no payment mutation. |


## Canonical local settlement transaction — 2026-11-08

`settlePaymentToRepository()` is now the storage adapter for manual folio payments and staff-reviewed UPI approvals. It:

1. Flushes previously queued compatibility snapshots before reading repository versions.
2. Loads the canonical recovery snapshot and rejects divergence between that snapshot and an existing booking entity.
3. Runs the existing paise-safe settlement policy against a detached booking/state copy.
4. For staff review, binds the approval to an existing evidence ID, open review state, exact UPI amount/reference and deterministic evidence idempotency key.
5. Commits the booking entity, folio payment projection and complete recovery snapshot with one version-checked multi-entity SQLite/IndexedDB transaction.
6. Reads all three entities back and compares the committed payment rows, paid/balance paise totals and full snapshot before updating the live UI state.
7. Refreshes the legacy synchronous UI cache only after canonical commit. A cache-refresh failure is surfaced separately and does not cause a second credit on retry.

The provider/automatic sources remain rejected by this adapter. They still require the separately trusted backend authorization and gateway projector. Reservation-advance creation remains on the old synchronous path because its guest/booking creation needs a wider atomic transaction.

Tests: `tests/repository-settlement-service.test.mjs` covers atomic commit, exact read-back, idempotent retry, staff UPI evidence approval/replay, evidence-state mismatch, canonical booking divergence, provider-source rejection, failed storage and cache refresh.

## Build integration

`index.html` loads `./src/payments/settlement-service.mjs`. `scripts/prepare-web.js` now copies both `settlement-service.mjs` and `settlement-gate.mjs` into `www/src/payments/` so the module import remains available in the Capacitor APK.

## Tests added

`tests/settlement-service.test.mjs` covers manual success, staff-review success, idempotency/UTR dedupe, automatic-source rejection with the gate disabled, overpayment rejection, rollback after a thrown persistence error, evidence-only `addSig`, and manual/staff route wiring.

**Verification:** GitHub Actions run [42486548554](https://github.com/Akshayshetye37/Aurelia-apk/actions/runs/42486548554) passed 354/354 tests, production web bundle build and asset privacy checks on the exact commit shown above. This was a web/source workflow, not an APK build or physical-device test. Android release and device qualification remain open.

## Gate and product stance

- `AUTO_FOLIO_SETTLEMENT_ENABLED` remains `false`.
- UI label is **“Suggest matches”**, not “Auto settle.”
- Phase A blocks silent notification-to-folio posting.
- Phase B centralizes runtime payment writes, but cross-store atomicity, reconciliation quality, evidence fixtures, APK/device verification, and production approval remain outstanding.

## Follow-up hardening — 2026-11-01

The PMS-side local settlement boundary was further hardened on this branch:

- INR amounts, balance due, legacy paid totals and daily totals are validated as safe paise values. Invalid numeric encodings, more-than-two-decimal values, control characters and unsafe aggregate totals are rejected.
- An idempotent replay is resolved before checking the now-reduced balance, so a retry after a full payment returns the original posting instead of a false overpayment error.
- Idempotency-key reuse with changed details and reuse across bookings is rejected. A UTR already present on another folio is a conflict, not a successful duplicate acknowledgement.
- Duplicate-reference lookup includes both canonical `booking.pays` and legacy `booking.payments` rows.
- Existing paid totals without matching payment rows are preserved; no fabricated receipt date or payment method is introduced.
- Manual folio submissions now carry a per-sheet request key when no bank reference is supplied.
- Reservation advances are validated against stay charges before guest/booking mutation. Reservation creation snapshots and restores guest, booking, audit, daily total and ID state if persistence verification fails.
- Folio totals, room rates, extra charges and discounts are rounded/validated to two decimal places. Each new reservation/imported booking snapshots its nightly room rate, and later room-rate edits preserve the old rate on existing bookings so historical folios do not change.
- The IndexedDB intent journal now requires backend-verified `SUCCESS` before settlement authorization, keeps failed/cancelled provider intents available for late-capture reconciliation, and protects recovered session identifiers.
- Bridge terminal observations cannot finalize payment. Backend verification/reconciliation must echo exact request, session, provider, booking, folio, amount and currency bindings.
- The web build now packages the PMS payment orchestrator and IndexedDB intent journal, and a Node test/build GitHub Actions workflow was added.

**Verification status:** Source changes and test cases were committed and re-fetched for inspection. The complete Node test suite, web build and Android APK/device verification have not been executed in this session. The new workflow is intended to run these Node tests and web bundle checks on pushes to this branch. Live gateway use remains disabled.

- Reconciliation evidence now rejects invalid parse states, quarantines non-INR or unparsed evidence, derives normalized payer/UPI identity from raw fields rather than caller-supplied normalized values, and prevents a bank-statement credit from matching itself as a candidate.
- Evidence payloads and identifiers are bounded; staff decisions are limited to review-only outcomes and must reference an existing evidence record. IndexedDB listing is cursor-based and bounded.
- Historical room-rate snapshots are used in folio totals, preventing future room-rate edits from silently changing existing booking balances.

- The settlement boundary now requires an explicit receipt-confirmation flag for manual payments, staff-reviewed UPI evidence and reservation advances; that confirmation is retained in both canonical payment and history rows. UPI evidence also requires a separate staff confirmation dialog, and synthetic “test payment” signals were removed from the production PMS UI.
- Settlement rejects bookings outside the active reservation, in-house and departed states. Cancelled bookings cannot be settled through the local folio writer.
