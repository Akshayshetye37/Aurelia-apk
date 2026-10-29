# Payment / folio settlement write-path audit

**Branch:** `feature/direct-upi-reconciliation`  
**Phase A hotfix:** `0dcf0e319f0c6c0fa3bc16383482dcb479110b88`  
**Phase B implementation commits:** `5433111`, `9a684ca`, `b0d9f28`, `233df47`, `bdaf590`, `d3a2948`, `418beb0`, `c8afa7f`, `fde1fd0`  
**Status:** Runtime settlement writes are centralized in the new service. Full repository test/build execution and APK/device verification are still pending. Automatic settlement must remain disabled.

## Settlement invariants

The folio has three related representations: `booking.pays` (canonical payment rows), `booking.p` (paid total used by balance calculations), and `booking.payments` (legacy/history rows). Runtime changes to these fields must be made only by `src/payments/settlement-service.mjs` through `settlePayment()`. `addPay()` is now a compatibility adapter, not a writer.

The settlement service validates booking membership, amount, method, balance limit and source; deduplicates by idempotency key and non-empty reference; updates payment rows, paid total, history, daily total and audit once; and attempts in-memory rollback if persistence throws. This is not a true transaction across app storage and IndexedDB evidence.

## Frozen write-path table

| Site / route | Classification | Current disposition |
|---|---|---|
| `src/payments/settlement-service.mjs` — `settlePayment()` | **Canonical settlement writer** | Sole runtime writer of `booking.pays`, `booking.p`, `booking.payments`, `state.today`, and payment audit entry. Automatic source calls the canonical `assertAutoFolioSettlementEnabled()` before mutation. |
| `index.html` — `addPay(b,a,m,r,auto)` | Compatibility alias | Thin adapter to `settlePayment()`. `auto=true` routes to source `auto`, which fails closed while the gate is false. Current search found no remaining call sites beyond the adapter definition. |
| Manual folio payment handlers, including the final `pay(i)` assignment | Manual settlement | Call `settlePayment({source:'manual'})`; UI validates selected method, amount and receipt confirmation. Duplicate history writes were removed from superseded wrappers. |
| `sigA(id,i)` | Staff-reviewed settlement | Calls `settlePayment({source:'staff_review'})`; signal is marked matched only after the service returns successfully. Uses UTR/reference or signal ID as an idempotency key. |
| Reservation creation / booking advance | Settlement at booking creation | Calls `settlePayment({source:'reservation_advance'})` with `booking-advance:<booking id>` idempotency key. |
| `addSig(o)` and `window.aureliaNativePaymentSignal` | Evidence / suggestion only | Creates a signal, deduplicates repeated notifications, and may set `pending_review` plus `suggestedBookingId`. Does not call `addPay()` or `settlePayment()`. |
| `src/payments/reconciliation-service.mjs`, `payment-engine.mjs`, `evidence-store.mjs` | Evidence ingestion, matching and persistence | No folio writes. Reconciliation service returns match suggestions and rejects staff decisions marked posted/settled. |
| Demo/bootstrap initialization (`index.html`, around original lines 493 and 625–626) | Seed data, not runtime settlement | Seeds demo paid totals/payment rows. Keep these values consistent; they are the remaining direct field assignments outside the runtime settlement service. |
| State import/restore paths (prior audit: around `index.html:1000–1077`) | Privileged state replacement / migration | May replace booking/payment state as a whole; not a normal payment path. Imported legacy totals/rows still need validation and normalization policy. |
| `addC()`, `dcApply()`, restaurant-to-room posting | Charge / discount operations | Separate folio mutations; must not change payment rows or paid totals. |
| Restaurant sales (`recordRestPay()`) | Independent restaurant ledger | Does not settle a hotel folio. |
| Cancellation/refund journal (`commitCancellationRefund()`) | Separate accounting workflow | Writes cancellation/refund journals and refund statuses, not a hotel payment settlement. |
| Export / invoice / reports | Read-only consumers | Read paid totals and payment rows; no payment mutation. |

## Build integration

`index.html` loads `./src/payments/settlement-service.mjs`. `scripts/prepare-web.js` now copies both `settlement-service.mjs` and `settlement-gate.mjs` into `www/src/payments/` so the module import remains available in the Capacitor APK.

## Tests added

`tests/settlement-service.test.mjs` covers manual success, staff-review success, idempotency/UTR dedupe, automatic-source rejection with the gate disabled, overpayment rejection, rollback after a thrown persistence error, evidence-only `addSig`, and manual/staff route wiring.

**Not yet verified:** complete `npm test`, `npm run build`, Android sync/build, and device/APK smoke tests. Do not claim production readiness until those run against the actual branch.

## Gate and product stance

- `AUTO_FOLIO_SETTLEMENT_ENABLED` remains `false`.
- UI label is **“Suggest matches”**, not “Auto settle.”
- Phase A blocks silent notification-to-folio posting.
- Phase B centralizes runtime payment writes, but cross-store atomicity, reconciliation quality, evidence fixtures, APK/device verification, and production approval remain outstanding.
