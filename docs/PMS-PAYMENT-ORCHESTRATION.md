# PMS payment orchestration contract

Status: **PMS-side orchestration foundation added; not production payment processing.**
The module at `src/payments/pay-bridge-orchestrator.mjs` is a fail-closed domain layer. It does not provide a durable storage adapter, Android IPC payment methods, a deployed backend, provider adapters, webhooks or folio ledger transaction.

## Trust boundaries

- PMS owns hotel booking/folio records and the UI.
- Pay Bridge is an execution client. Its callbacks are untrusted observations and never authorize settlement.
- The trusted backend owns provider credentials, payment sessions, provider API calls, webhook signature verification, provider status polling, refunds and the authoritative payment ledger.
- PMS authorizes folio posting only after backend verification binds request ID, session, transaction, booking, folio, amount and currency.
- PMS remains usable for reservations, rooms, guests, cash and manual records when Pay Bridge is absent. Gateway checkout is unavailable, not queued for execution while disconnected.

## Implemented in this branch

- Explicit payment states and validated transitions.
- Durable-store dependency is mandatory; no silent in-memory fallback.
- Request IDs and idempotency conflict detection.
- Payment intent is persisted before any bridge call.
- Bridge events are correlated to the original request, amount, currency, booking and folio.
- A bridge-reported success is never trusted; it remains non-settleable until backend verification.
- Backend adapter requires HTTPS and sends bearer authorization without persisting provider credentials.
- Reconciliation, cancellation and backend-authorized refund orchestration interfaces.
- Automated tests for disconnected operation, event mismatch, duplicate request IDs and backend verification.

## Still required before production

1. Implement and security-review the durable payment store using a transactional database with unique constraints on request/idempotency IDs. Do not use a JS Map or IndexedDB as the cross-device accounting ledger.
2. Implement the native Messenger payment operations in both PMS and the separate Pay Bridge APK. Protocol v1 currently negotiates handshake only; reserved message IDs are not implemented operations.
3. Deploy the trusted backend and implement authenticated sessions, provider-specific server adapters, webhook signature validation, immutable event ingestion, idempotent transaction verification, refunds and reconciliation.
4. Add staff authorization, property/tenant scoping, audit logs, rate limits, key rotation and replay protection to backend endpoints.
5. Connect the verified result to the single folio posting mutation boundary with durable unique settlement constraints and atomic ledger writes. Do not enable automatic settlement until this exists.
6. Implement a durable outbox and startup/foreground reconciliation. A network or app crash must leave the payment pending/unknown rather than infer failure.
7. Implement a payment history and refund/reconciliation UI with explicit pending/unknown states.
8. Test two installed APKs signed with the same controlled signing identity, provider sandbox flows, webhook replay, duplicate callbacks, process death, network loss and database failure.

## Backend endpoint contract (to be implemented server-side)

- `POST /v1/payment-sessions`: idempotently create a provider session for a server-authorized booking/folio amount. Return `requestId` and opaque `sessionId`; never return provider secrets.
- `POST /v1/payments/verify`: independently query provider status and return a signed/authenticated result bound to request, session, transaction, booking, folio, amount and currency.
- `POST /v1/payments/status`: retrieve authoritative status.
- `POST /v1/payments/reconcile`: reconcile unknown/in-flight transactions from provider status and webhook ledger.
- `POST /v1/refunds`: authorize and idempotently create a refund against a backend-verified captured transaction.

The client adapter is only an HTTP contract. It does not mean these endpoints exist. Webhook processing must be implemented server-side; a mobile app must never receive webhook signing secrets.

## State machine

```text
CREATED -> REQUESTED -> PROCESSING -> SUCCESS (backend verification only)
                    |              |-> FAILED / CANCELLED / UNKNOWN
                    |-> UNKNOWN    UNKNOWN -> RECONCILIATION
UNKNOWN -> RECONCILIATION -> PROCESSING / FAILED / CANCELLED / SUCCESS
```

A raw Pay Bridge `success` event is treated as an observation, not a state transition to settleable SUCCESS. Only `verifyPayment()` can set `backendVerified` and `settlementAuthorized`.
