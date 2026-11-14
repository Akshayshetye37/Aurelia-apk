# Central payment control plane

## Status

The **cloud backend control plane is implemented and wired to the cloud payment routes** on `feature/multi-provider-payment-backend`. The local PMS settlement gate and native apply/recovery gate remain independently hard-locked. The cloud control document does not authorize local WebView or offline settlement. No capability has been enabled and no deployment has been performed. The control plane is not a completed production payment system.

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

Each update creates a durable record in `paymentControls/{tenantId}/audit/{auditId}`. A record contains tenant ID, one or more per-control entries, actor UID and verified email, reason, and server timestamp. Each entry records `control`, `from`, `to`, and ISO timestamp. The control document update and audit append occur in one Firestore transaction. Client SDK access to the control document, nested audit records and release approvals is denied in `payment-backend/firestore.rules`. The cloud backend uses Firebase Admin SDK and is governed by server authentication and IAM. This rules file has **not been deployed**. Before deployment, merge it with any existing application Firestore rules (unmentioned paths are denied by default) and verify the complete ruleset in the Firebase emulator.

## Implemented backend control plane

- `payment-backend/src/payment-controls/firestore-controls.mjs` defines the canonical flags, strict schema validation, fail-closed reads, authorization predicates and transactional updates.
- Canonical tenant document: `paymentControls/{tenantId}`.
- Immutable append-only audit subcollection: `paymentControls/{tenantId}/audit/{auditId}`. Each update writes the control document and audit entry in one Firestore transaction.
- Owner/admin authenticated endpoints:
  - `GET /v1/admin/payment-controls` — current tenant flags and latest 50 audit entries.
  - `PATCH /v1/admin/payment-controls` — changes plus mandatory reason.
- Authentication uses verified Firebase identity, active tenant membership, verified email, recent MFA and owner/admin role. Tenant ID is derived from membership, never from request input.
- Financial routes read the current tenant control document for each request; no allow-decision cache is used. Missing, malformed, stale-schema or unreadable control state fails closed.
- Test intents, test order creation and test provider activation require `test_collection`. Live intents and provider activation require `live_collection` and retain a separate unconditional production-readiness rejection. The reconciliation endpoint checks `automatic_settlement` and `native_settlement_bridge` but remains unconditionally blocked because the current worker writes a separate Firestore folio journal that is not proven to be the authoritative local PMS ledger.
- A capability cannot be enabled merely by changing its boolean. A separate owner release approval document must exist at `paymentControlApprovals/{tenantId}/controls/{control}`, be current, identify an independent approver, and contain the required evidence codes. The live control additionally requires explicit production-readiness and separate-owner-approval fields. The API cannot turn `emergency_stop` OFF; engaging it remains immediately available.
- Webhooks can store signature/provider-status evidence. They never issue accounting authorization. Their pending record identifies whether collection, settlement controls or the still-missing trusted bridge is blocking posting.
- `payment-backend/test/payment-controls.test.mjs` and `payment-backend/test/security-contract.test.mjs` cover control defaults, precedence, read failure, audit contract, release approval checks and enforcement wiring. The GitHub Actions checks on commit `52f763b` completed successfully before the additional core emergency-stop guard and its test were added. The newest commit must pass CI before this change set is considered verified.

## Local PMS enforcement boundary

- The local `settlePayment()` function and native journal apply/recovery paths remain hard-locked by `src/payments/payment-safety-gate.mjs`. The cloud control document is **not** trusted by the WebView and cannot authorize offline local posting.
- No mutable JavaScript/localStorage control value is accepted. A signed, short-lived policy lease must be delivered and verified through the trusted native device boundary before local manual posting or bridge settlement can be considered.
- The local gate intentionally remains closed until that mechanism exists. Do not interpret the cloud control API as enabling local manual posting.
- The Settings → Payment Gateway screen now provides an advisory tenant live-collection switch backed by the authenticated cloud control endpoints. The server independently enforces verified email, active owner/admin membership, recent MFA, the internal release gate, provider qualification and the emergency stop. The UI cannot enable the internal gate. The retired device-local merchant credential vault is not an unlock prerequisite. Provider secrets remain backend-only in Secret Manager. Do not assume the cloud flags directly gate LAN appliance operations.

## Remaining integration and release work

1. Complete signed, expiring native policy lease delivery, device binding, expiry, version/rollback protection and offline fail-closed behaviour.
2. Add native enforcement for manual posting, verified settlement, refunds and recovery before any local balance mutation.
3. Deploy the payment-control Firestore rules only after merging with the project's complete ruleset; validate in the emulator first. Add Firestore emulator/integration tests for owner/admin auth, unauthorized staff, audit write failure, missing/malformed state, simultaneous updates and each route's 423/503 behaviour. The current unit/contract tests do not replace this integration suite.
4. Complete a full write-path audit of direct booking paid-total writes, payment row writes, import/restore, reservation advances, refunds and reversals.
5. Build the owner-only control panel with emergency-stop confirmation and audit history.
6. Run the complete root and backend test suites; perform sandbox and physical Android acceptance. No deployment or unlock is implied by code commits.

## Unlock evidence gates

| Control | Minimum evidence before enabling |
|---|---|
| `manual_posting` | Real PMS-data diagnostic plus owner classification of every discrepancy; local trusted policy enforcement |
| `test_collection` | Secret Manager credential validation, provider sandbox order creation, verified webhook or independent status recovery, and staff confirmation acceptance |
| `native_settlement_bridge` | Challenge-bound trusted authorization, signature verification, replay prevention, durable acknowledgement and recovery |
| `automatic_settlement` | Full crash, duplicate, offline, restore, persistence-failure and two-device acceptance matrix |
| `live_collection` | Explicit production readiness review and separate owner approval; all lifecycle and reconciliation gates complete |
| `refund_processing` | Refund state machine, cumulative limits, provider status verification, reversal journal and recovery tests |

Emergency stop must remain available as a permanent immediate interlock. Passing tests alone does not authorize an unlock.
