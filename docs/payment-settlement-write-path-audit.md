# Payment / folio settlement write-path audit

**Branch:** `feature/direct-upi-reconciliation`  
**Baseline:** Phase A hotfix commit `0dcf0e319f0c6c0fa3bc16383482dcb479110b88`  
**Status:** Audit snapshot; Phase B centralization is not yet implemented. Do not enable automatic settlement.

## Scope and invariants

The folio's current paid amount is represented redundantly by `booking.pays` (payment rows), `booking.p` (paid total), and in some UI/history paths `booking.payments` (legacy history rows). `paid(booking)` sums `booking.pays`; `dueB(booking)` computes `tt(booking) - booking.p`. Any write that updates only one of these fields can create inconsistent balances, receipts, or reports.

Target invariant: **one `settlePayment()` API owns every runtime mutation of `booking.pays`, `booking.p`, and payment-history rows.** It must validate amount and booking, apply source-specific authorization, deduplicate idempotency keys, update accounting totals once, and persist through the app's existing persistence mechanism. Automatic settlement remains disabled.

## Current payment write-path table

| Site | Current behavior | Risk / Phase B action |
|---|---|---|
| `index.html:635` `addPay(b,a,m,r,auto)` | Appends `b.pays`, recalculates `b.p`, increments `S.today`, writes audit entry. | Current central mutation function, but accepts an `auto` flag and has no source authorization or idempotency. Replace internals with the single `settlePayment()` implementation; keep only a compatibility adapter if required. |
| `index.html:658` `sigA(id,i)` | Staff taps Apply; directly calls `addPay()`, then marks signal matched. | Route through `settlePayment({source:'staff_review', idempotencyKey: signal.id})`. Mark matched only after settlement succeeds. Validate signal and booking before mutation. |
| `index.html:2488` final `pay(i)` assignment | Current manual-payment UI validates amount/method/confirmation and calls `addPay()`; persists and refreshes UI. | Route through `settlePayment({source:'manual'})`; preserve existing validation and confirmation. |
| `index.html:2890–2896` final `pay(i)` wrapper | Wraps the preceding `pay`; after observing a changed `b.p`, appends to `b.payments`, persists, and opens invoice. This is the active history wrapper at end of file. | Remove duplicate accounting/history mutation from wrapper. History rows must be emitted by `settlePayment()` exactly once; UI wrapper may only render/persist after success. |
| `index.html:2157–2163` earlier `pay(i)` wrapper | Wraps an earlier `pay` and appends `b.payments` after observing a changed total. It is later superseded by the assignment at line 2488, but remains confusing dead wrapper code. | Remove during cleanup; do not treat this superseded wrapper as an independent active route. |
| `index.html:729` reservation creation | Creates a booking with `pays:[]`; if a booking advance is entered, calls `addPay(booking, amount, 'Cash', 'Booking advance', false)`. | Route the advance through the same settlement API with `source:'manual'` and a deterministic booking-advance idempotency key. Ensure reservation initialization does not double-count the advance. |
| `index.html:493` demo initialization | Sets `S.b[1].p=1000` directly. | Demo/bootstrap data only, but violates runtime single-writer rule. Initialize consistent demo payment rows and totals in one seed helper, clearly separated from runtime settlement. |
| `index.html:625–626` demo initialization | Resets each booking's `pays=[]`, then seeds a payment row on `S.b[1]`. | Demo/bootstrap only; keep seed data internally consistent with `b.p`. Do not use this pattern for live bookings. |
| `index.html:1224` guest/booking export | Reads paid/balance values and exports a snapshot; no settlement mutation. | Read-only; no change needed. |
| `index.html:635` audit write | `aud()` records a payment audit row after the payment write. | Audit must occur only after successful settlement and exactly once. |
| State import/restore paths around `index.html:1000–1077` (prior audit) | Can replace imported application state, including bookings and payment fields. | Treat as a privileged state-replacement boundary, not a normal payment path. Validate imported booking totals/rows and document whether legacy snapshots are normalized before being accepted. |

## Related financial writes that are not payment settlement

| Site | Behavior | Boundary |
|---|---|---|
| `index.html:509` `addC()` | Adds a folio charge to `booking.ch`. | Charge API; must not change paid totals. |
| `index.html:643` `dcApply()` | Changes `booking.dc` discount. | Discount API; must not change payment rows or paid totals. |
| `index.html:1191–1193` (prior audit) | Posts restaurant charges to a hotel room folio. | Charge-posting API; must not create a payment. |
| `index.html:2834–2857` (prior audit) | Records independent restaurant sales. | Restaurant sales ledger; must not mutate hotel folio payments. |
| `index.html:3093–3118` | Creates cancellation/refund journal entries and updates refund-status fields. | Separate cancellation accounting workflow; do not route through `settlePayment()`. |
| Import/restore | May replace the whole state object. | State migration/restore boundary, not a normal payment API. |

## Required Phase B acceptance checks

1. Search the complete source for every assignment/push to `pays`, `p`, and `payments`; classify each as settlement, seed/migration, or restore.
2. Runtime mutation of those payment fields occurs only inside `settlePayment()`.
3. Manual UI and staff review call `settlePayment()` with `source:'manual'` and `source:'staff_review'` respectively.
4. Notification ingestion (`addSig`) only creates evidence/review candidates and never posts a folio.
5. Automatic source is rejected while `AUTO_FOLIO_SETTLEMENT_ENABLED === false`; do not flip the flag as part of Phase B.
6. Tests cover manual success, invalid amount, overpayment, idempotency, staff-review idempotency, evidence-only notification, and automatic-source rejection.
7. Run `npm test` and `npm run build`; report actual results before any production approval.
