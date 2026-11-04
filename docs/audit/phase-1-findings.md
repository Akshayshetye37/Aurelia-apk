# Phase 1 findings — accounting audit

**Branch:** `fix/phase-1-accounting-audit`  
**Base:** `feature/multi-provider-payment-backend`  
**Status:** IN PROGRESS — source inspection started; no financial data changed; no accounting migration proposed or applied.

## Executive findings

1. **Two paid representations drive different calculations.** In `index.html`, the main due calculation uses `b.p` (line 530 in this branch snapshot), while the `paid(b)` helper sums `b.pays[].a` (line 668 in this branch snapshot). Invoice/report consumers use the helper. A mismatch can therefore make the folio due, invoice paid amount and management totals disagree.
2. **Settlement logic is duplicated in the large HTML entry point.** The preview fallback at lines 4470–4516 starts with an unconditional `ACCOUNTING_READ_ONLY_KILL_SWITCH` throw; the older implementation after that throw is unreachable but still contains direct assignments to `booking.pays`, `booking.p` and `booking.payments`. The normal module adapter is later installed by an ES module. This dead duplicate code is a maintenance hazard and complicates static write-path auditing; do not remove it until tests prove fallback behaviour.
3. **Cancellation/refund accounting is a separate journal path.** `confirmCancelBooking` snapshots payment data and moves a booking from `S.b` to `S.cancelled` (lines 3642–3650). `commitCancellationRefund` writes `S.financialLedger` journal entries and mutates refund status/amount metadata (lines 3667–3702). This is not the same as a provider refund lifecycle; status labels can represent manual bookkeeping, not provider-confirmed money movement.
4. **Legacy cancellation history has multiple payment sources.** `cancellationPaidAmount` considers `paymentSnapshot`, `payments`, `pays`, `original_amount_paid` and `p` (lines 3659–3662). It chooses the maximum total among arrays rather than summing them, apparently to avoid counting mirrored rows twice. That is a heuristic; real records are needed to establish which source is reliable.
5. **Reservation advances are posted as payment rows.** `dsave()` validates an advance and invokes `settlePayment` with source `reservation_advance` and key `booking-advance:<bookingId>` (lines 820–864). Reservation creation and the advance are intended to be one local operation. Orphan detection must validate these rows against their booking and audit/backup history.
6. **The imported booking normalizer can map legacy `payments[]` into `pays[]` while separately setting `p`.** The normalizer around line 1860 (confirm exact current line before citing in a final audit) accepts aliases and coerces `p` using `Number(...)||0`. This can hide malformed source values and preserve paid-total drift.
7. **The current diagnostic is not yet sufficient for the runbook's acceptance criteria.** `src/payments/accounting-consistency-diagnostic.mjs` compares `p` to payment-row totals and flags malformed rows, but does not yet identify duplicate payment rows, orphan advances, or refunds exceeding recorded payments. Existing tests cover basic drift and malformed data, not all requested cases.

## Source paths inspected

| File / area | Observed responsibility | Classification |
|---|---|---|
| `index.html` state and helpers | `S.b`, `S.cancelled`, `S.financialLedger`; due uses `p`, paid helper uses `pays` | Read / derived |
| `index.html` reservation form, lines 820–864 | Validates and posts booking advance through `settlePayment` | Mutating workflow (delegated payment mutation) |
| `index.html` payment form / staff review, lines around 650–690 and 1080 | Manual payment and reviewed bank-signal application call `settlePayment` | Mutating workflow (delegated payment mutation) |
| `src/payments/settlement-service.mjs` | Canonical module writer for `pays`, `p`, `payments`, daily total and audit | Mutating |
| `index.html` preview fallback, lines 4470–4516 | Immediately throws read-only kill-switch; unreachable legacy mutation code remains below throw | Guarded / dead duplicate mutator |
| `index.html` cancellation, lines 3642–3650 | Archives booking and its payment snapshots; removes active booking | Mutating booking lifecycle |
| `index.html` cancellation accounting, lines 3659–3702 | Derives original paid amount, journals pending/paid refund or retained revenue, updates cancellation metadata | Mutating refund/accounting journal |
| `index.html` import normalization, around line 1860 | Maps legacy booking fields and payment aliases | Import/normalization; potential data transformation |
| `index.html` persistence and restore | Serializes state and restores allow-listed state; must be audited separately for the exact backup envelope and failure semantics | Persistence / privileged replacement |
| `payment-backend/src/intents/folio-settlement.mjs` | Writes separate Firestore `paymentFolios` journal, not verified as the local PMS ledger | Separate cloud ledger prototype |
| `src/payments/settlement-apply.mjs` and journal modules | Authorization-gated command application/recovery; current trusted projector/issuer remains unavailable | Guarded / recovery path |

## Decisions deliberately not made

- Do **not** yet declare `booking.pays[]` the historical source of truth. The code's runtime writer treats it as payment detail rows, but due calculations and legacy records rely on `booking.p`. A real backup and source-receipt review are required before choosing a canonical representation.
- Do **not** infer that `refundStatus === 'refunded'` proves an actual refund was paid. The cancellation UI permits an admin to mark completion; provider evidence is not required in this local workflow.
- Do **not** infer that the cloud `paymentFolios` collection is mapped to a real PMS folio.
- Do **not** auto-repair any discrepancy.

## Verification and human inputs

- No real PMS backup was available in this inspection. Therefore there is no real-data discrepancy count, duplicate count, orphan-advance count or refund-overpayment count.
- No production data was accessed or changed.
- The full backup export/decode envelope and all import/restore mutation paths still need a targeted pass before the Phase 1 acceptance gate can be marked complete.
- Human input required: provide a current, authorized PMS backup JSON (redacted if necessary, but preserve IDs, amounts, payment references, booking relationships, cancellation snapshots and journal records). Do not upload merchant secrets or identity-document images.

## Phase 1 gate

**Not complete.** Complete the remaining path inventory, add failing tests for duplicate rows / negative and non-integer amounts / orphan advances / refunds exceeding recorded payments, implement the read-only CLI, run the tests and build, and then analyze the supplied backup. Stop before Phase 2 until reviewed.
