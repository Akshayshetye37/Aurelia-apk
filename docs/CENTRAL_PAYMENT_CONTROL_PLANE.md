# Central payment control plane

## Status

The control-plane foundation is committed, but it is **not yet wired into payment routes or the PMS local settlement path**. All existing hard-coded locks remain in force. No financial capability has been enabled. Do not deploy this as a completed control system.

## Canonical control document

Firestore document: `paymentControls/{tenantId}`.

Schema version 1:

```json
{
  "schemaVersion": 1,
  "emergency_stop": true,
  "manual_posting": false,
  "test_collection": false,
  "live_collection": false,
  "automatic_settlement": false,
  "native_settlement_bridge": false,
  "refund_processing": false,
  "updatedAt": "Firestore Timestamp",
  "updatedBy": "Firebase UID"
}
```

A missing document resolves to the safe defaults. An unreadable document resolves to `emergency_stop=true` and all capabilities false. A malformed or incomplete document is invalid and fails closed. A positive capability flag never overrides emergency stop.

## Audit record

Each update creates a durable record in `paymentControlAudit/{autoId}`. A record contains tenant ID, one or more per-control entries, actor UID and verified email, reason, and server timestamp. Each entry records `control`, `from`, `to`, and ISO timestamp. The control document update and audit append occur in one Firestore transaction. Audit collection write/delete permissions must be denied to clients by Firestore Security Rules; only the backend service identity may write it.

## Current implementation

- `payment-backend/src/payment-controls/firestore-controls.mjs` defines defaults, validation, fail-closed reads, authorization predicates and transactional updates with audit records.
- `payment-backend/test/payment-controls.test.mjs` covers default-deny, emergency-stop precedence, explicit capability checks, read failure, audit fields and invalid updates.
- The cloud server does not yet expose authenticated control administration routes or apply the reader to every intent, provider activation, reconciliation, webhook authorization, refund and settlement path.
- The client-side settlement function is synchronous and can operate offline. It cannot safely consume a mutable cloud flag directly. A future local reader must accept only a signed, short-lived policy lease delivered through the trusted native boundary, enforce expiry/version/replay protection, and fail closed when missing or stale. A JavaScript/localStorage boolean is never authority.
- The existing local hard lock and backend hard lock remain active until complete route coverage and local trust-boundary enforcement are implemented and tested.

## Required enforcement sequence

1. Add owner/admin authenticated GET and PATCH endpoints. PATCH must validate tenant membership, recent MFA, explicit boolean changes and mandatory reason. Use the transactional writer above.
2. Add server middleware that reads the tenant control document for every financial operation. Do not cache allow decisions. Firestore errors, malformed data and missing state reject the operation.
3. Keep provider webhook signature/status verification available as evidence collection only. Never issue accounting authorization while emergency stop is on or native settlement is disabled.
4. Integrate signed, expiring control leases with the native device boundary. The local settlement path must validate the lease and relevant control before its first mutation. Offline/stale state means reject.
5. Add an owner-only control panel with confirmation for emergency-stop changes and a read-only recent audit feed. The UI is advisory; server/native enforcement is authoritative.
6. Add route-level integration tests for each financial endpoint, including Firestore unavailable, missing document, malformed document, emergency stop, capability OFF/ON, unauthorized actor, audit failure and concurrent updates.
7. Audit every local balance mutation, restore/import path and refund/reversal path. Tests must prove the relevant gate runs before any mutation.

## Unlock evidence gates

| Control | Minimum evidence before enabling |
|---|---|
| `manual_posting` | Real PMS-data diagnostic plus owner classification of every discrepancy; local trusted policy enforcement |
| `test_collection` | Local credential vault, order creation, provider status verification and staff confirmation acceptance |
| `native_settlement_bridge` | Challenge-bound trusted authorization, signature verification, replay prevention, durable acknowledgement and recovery |
| `automatic_settlement` | Full crash, duplicate, offline, restore, persistence-failure and two-device acceptance matrix |
| `live_collection` | Explicit production readiness review and separate owner approval; all lifecycle and reconciliation gates complete |
| `refund_processing` | Refund state machine, cumulative limits, provider status verification, reversal journal and recovery tests |

Emergency stop must remain available as a permanent immediate interlock. Passing tests alone does not authorize an unlock.
