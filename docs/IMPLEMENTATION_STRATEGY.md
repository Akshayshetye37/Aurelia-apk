# Aurelia PMS — Engineering strategy and implementation order

## Target structure

```text
Android / Capacitor PMS
  ├─ Firebase authentication session
  ├─ Payment UI + capability-driven provider picker
  └─ HTTPS PaymentApiClient (no merchant secrets)
          │
          ▼
Cloud payment API
  ├─ Authentication / tenant authorization / rate limits
  ├─ Payment orchestration + idempotency
  ├─ Provider registry (only qualified adapters)
  ├─ Webhook ingress + durable inbox
  ├─ Provider status verification
  ├─ Refund orchestration
  ├─ Reconciliation worker + operator endpoint
  └─ Accounting application service
          │
          ├─ Secret Manager: provider credentials
          ├─ Firestore: intents, idempotency, inbox/outbox, worker claims
          └─ Canonical PMS folio/journal repository
                    │
                    ▼
             Reservation / Folio / Journal
```

## Execution sequence (strict dependencies)

### Gate 1 — Establish the real PMS accounting contract
Inspect the application data model and actual read/write paths for reservations, folios, balances, currencies, journal entries, folio closure and concurrency/version fields. Record the canonical document paths and field mapping. Add contract tests against that model. **Do not switch settlement paths until this evidence exists.**

### Gate 2 — Stabilize payment intent lifecycle
Use one explicit state machine for dispatch, pending, capture, failure, conflict and accounting. Persist provider order/payment identifiers and immutable verification evidence. Keep idempotency and folio reservation locks transactional. Unknown provider outcomes stay locked and are reconciled, never blindly retried.

### Gate 3 — Make webhook and polling converge
Verify raw webhook signatures, fetch authoritative provider status, validate tenant/order/payment/amount/currency bindings, then persist the event in a durable inbox. Duplicate deliveries must resume incomplete work and short-circuit only after terminal accounting. Add concurrency tests for webhook-versus-worker races.

### Gate 4 — Canonical accounting and refunds
Implement a single accounting application service over a repository for the confirmed PMS schema. In one database transaction, create a deterministic journal entry, update the folio balance/version, and mark the intent posted. Refunds use separate deterministic journal entries and provider refund-status reconciliation. No UI or provider adapter writes directly to a folio.

### Gate 5 — Durable worker operations
Add atomic worker claims/leases, bounded batches, retry backoff, stale-lease recovery, per-item outcomes, metrics and alerts. Manual admin invocation remains an operator tool, not a substitute for scheduled recovery. Deploy required Firestore indexes and prove query behavior under realistic volume.

### Gate 6 — Provider capability qualification
The registry exposes only providers whose complete required operations are implemented. For each provider, run adapter contract tests, webhook fixtures, status/refund identity tests and sandbox acceptance. Keep prototypes out of the production registry. Implement providers one at a time.

### Gate 7 — App integration and release qualification
Connect PaymentApiClient to the actual Firebase session lifecycle. Render providers from backend capability responses. Test process death, offline/online recovery, duplicate taps, ambiguous network failures, redirects, refunds and reconciliation. Deploy with least-privilege IAM, public HTTPS ingress and monitored webhook endpoints. Live collection requires signed release approval.

## Non-negotiable invariants

- Backend-only merchant secrets.
- Server-derived tenant identity and authorization.
- Integer minor-unit amounts and explicit currency.
- No client callback is authoritative.
- Stable idempotency across retries.
- No double posting under concurrent webhook/worker execution.
- Capture and folio settlement are distinct states.
- Refund completion is independently verified.
- Fail closed on identity, amount, currency or schema mismatch.
- Live collection remains disabled until every release gate has evidence.
