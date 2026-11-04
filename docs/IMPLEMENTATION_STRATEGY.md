# Aurelia PMS — Engineering strategy and implementation order

## Selected architecture: Option A — local-first ledger with cloud payment authority

The checked-in PMS source audit is documented in [PMS_ACCOUNTING_SCHEMA.md](./PMS_ACCOUNTING_SCHEMA.md). It confirms that the current UI owns its folios inside local booking objects (`S.b[]`), using `booking.p` for the main due calculation and `booking.pays[]` for payment detail. The separate Firestore `paymentFolios` prototype is not wired to that local ledger.

Do not migrate the current product to a new server-side folio schema as part of payment integration. Preserve the local PMS accounting path and bridge verified cloud payment evidence into it through a narrowly authorized, idempotent command. This avoids a premature accounting migration and preserves local operation when the backend is unavailable.

## Target structure

```text
Android / Capacitor PMS
  ├─ Local booking/folio ledger: S.b[].p + S.b[].pays[]
  ├─ Existing settlePayment() mutation boundary
  ├─ IndexedDB pending-command journal
  └─ Trusted native authorization + projection bridge (NOT INSTALLED)
          │
          ▼
Cloud payment API
  ├─ Authentication / tenant authorization
  ├─ Payment intent + stable idempotency
  ├─ Provider registry (qualified adapters only)
  ├─ Webhook ingress + durable inbox
  ├─ Authoritative provider status verification
  ├─ Refund orchestration
  └─ Reconciliation worker
          │
          ├─ Secret Manager: provider credentials
          └─ Firestore: intents, inbox/outbox, verification evidence
                    │
                    ▼
          Short-lived, one-time accounting authorization
                    │
                    ▼
          Trusted native bridge validates binding
                    │
                    ▼
          Local settlePayment() → durable state write/read-back
                    │
                    ▼
          Device acknowledgement → backend marks posted
```

## Authoritative ten-workstream remediation plan

The complete dependency graph, implementation details, acceptance evidence and hard stop conditions are maintained in [END_TO_END_REMEDIATION_PLAN.md](./END_TO_END_REMEDIATION_PLAN.md). That document supersedes any shorter checklist below where details differ. The ten workstreams are: (1) canonical booking/folio accounting, (2) intent/idempotency, (3) provider checkout/capture/webhooks, (4) durable reconciliation/recovery, (5) trusted Pay Bridge IPC, (6) canonical local settlement/receipts, (7) refunds/reversals, (8) authenticated Android API/session UX, (9) security/infrastructure/operations, and (10) end-to-end qualification/release control.

## Execution sequence (strict dependencies)

### Gate 0 — Keep the existing local ledger intact
Preserve the existing local booking/folio data model; do not replace `booking.p`, `booking.pays[]` or the existing booking data format with a new Firestore folio schema during this integration. **At the current source checkpoint, the global accounting kill switch blocks manual as well as automated balance mutations. Manual payment posting is therefore NOT currently operational.** Restore it only after the authorized real-data audit and an owner-approved, narrowly scoped policy change; do not claim it remains available.

### Gate 1 — Resolve local ledger consistency
The audit found that main due calculation reads `booking.p`, while the invoice paid helper sums `booking.pays[].a`. Legacy/imported records may differ. Build a read-only diagnostic and report mismatches; do not auto-correct historical financial data. Decide an explicit reconciliation policy and test it against backup/restore fixtures.

### Gate 2 — Stabilize payment intent and idempotency
Define the server-side state machine for created, pending, captured, authorization-issued, device-posted, unknown, failed and refunded states. Bind every intent to tenant, booking ID, device identity, amount minor units, ISO currency, provider order/payment IDs and one stable idempotency key. Ambiguous create-order outcomes must be reconciled before retry.

### Gate 3 — Harden webhook and provider verification
Verify raw webhook signatures, persist provider/environment-scoped events, fetch authoritative provider status and validate order/payment/amount/currency/tenant bindings. Webhooks and polling must converge on the same verified capture record. A callback or UI boolean must never authorize a local credit.

### Gate 4 — Build the trusted accounting bridge
The cloud service issues a short-lived, one-time authorization bound to intent ID, provider transaction ID, booking ID, amount minor units, currency, device identity, expiry and nonce. A trusted Capacitor/native component—not arbitrary WebView JavaScript—validates it and invokes the existing local settlement boundary with a deterministic key. The device acknowledges only after local persistence and read-back verification. The backend must retain a recoverable UNKNOWN state if the device or network fails between local commit and acknowledgement.

The existing IndexedDB settlement journal is a useful local pending-command foundation, but the current issuer, authorization callback and projection function are intentionally absent. Do not enable this gate until all three are implemented and tested.

### Gate 5 — Refunds and reconciliation
Model refunds as separate provider events and local folio debits/adjustments; never rewrite the original payment credit. Add partial-refund support, deterministic refund identity, provider refund-status lookup, device delivery/acknowledgement and crash recovery. Worker claims must be atomic and bounded. Reconciliation must handle backend capture with device offline, device post with acknowledgement lost, and duplicate delivery.

### Gate 6 — Android authenticated API and local credential UX
Connect PaymentApiClient to the actual Firebase/native session. Keep merchant secrets in backend Secret Manager. Test credentials can be entered only into an authenticated owner flow and submitted directly to the backend over HTTPS; never persist secret values in the WebView, APK or backup. Local PMS operations must remain fully usable offline.

### Gate 7 — Provider expansion
Complete Razorpay and Cashfree end-to-end first. Keep PayU and PhonePe prototypes outside the production registry until their exact merchant API/refund/callback contracts are tested. Add Paytm, JioPay and CCAvenue one at a time. UI capability comes from backend qualification evidence, not provider labels.

### Gate 8 — Release qualification
Test duplicate webhook, forged callback, replay, provider timeout, ambiguous order creation, device process death, IndexedDB failure, local persistence failure, backup restore, device offline/online recovery, partial refund, and two-device duplicate attempts. Complete security review, provider sandbox/UAT, monitoring and runbooks. Live collection and automatic settlement remain disabled until explicit release approval.

## Non-negotiable invariants

- Live payment collection remains OFF.
- Automatic folio settlement remains OFF.
- Current manual folio payment posting is blocked by the global accounting kill switch; restore only after the real-data accounting review and explicit owner approval.
- Local PMS remains fully usable when the cloud backend is unavailable.
- Merchant secrets never enter HTML, JavaScript, WebView storage, backups or APK assets.
- Only authoritative provider verification can produce an accounting authorization.
- A WebView callback or `verificationConfirmed` boolean is not cryptographic proof.
- The same provider transaction/intent can produce at most one local folio credit.
- Backend status becomes device-posted only after durable local write/read-back acknowledgement.
- Unknown outcomes remain recoverable and are never treated as success or failure by guesswork.


## Build prohibition and immediate release freeze — global kill switch active

Do not run Android debug/release APK workflows, signing, publishing or production deployment until all ten workstreams in [END_TO_END_REMEDIATION_PLAN.md](./END_TO_END_REMEDIATION_PLAN.md) pass their acceptance evidence. Source-only checks and non-build tests may be used where they do not trigger a build/deployment workflow. The historical successful APK workflow is not authorization for another build.



Until an authorized PMS backup has been diagnosed and reviewed with the owner, the application and backend are in accounting read-only mode. No code path may mutate folio paid totals or payment rows. This freeze intentionally includes manual payment posting; ordinary booking, stay and non-payment operations remain available. Existing recorded balances are preserved.

The four independent release controls are locked:
1. `blockAllBalanceMutations`: rejects every call to the local `settlePayment()` mutation boundary.
2. `automaticSettlement`: remains disabled independently of provider state.
3. `liveCollection`: remains disabled; payment intent/order creation is locked.
4. `nativeSettlementBridge`: journaled apply and recovery are rejected.

Cloud webhooks may record provider verification evidence, but must leave the capture pending with `PAYMENT_SAFETY_KILL_SWITCH`; they must never invoke a folio writer. The cloud reconciliation endpoint must also remain unavailable while this freeze is active.

### Unlock prerequisites

Do not remove the interlock until all of the following are evidenced: authorized real-data diagnostic report; owner-approved classification of discrepancies; tested and reversible reconciliation policy (if needed); local persistence/read-back qualification; payment intent and webhook state-machine tests; provider sandbox/refund/reconciliation acceptance; and, for the native bridge, a native trust-boundary/security review. Any unlock is a separate, explicit release decision—not an automatic consequence of tests passing.
