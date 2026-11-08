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


## Evidence-backed provider qualification and native interlock (8 November 2026)

The live-collection route now evaluates a tenant-scoped qualification record at
`paymentProviderQualifications/{tenantId}/providers/{provider}` on every live
intent request. The record is not a client setting and is not inferred from
adapter registration or a provider's catalogue presence. It must identify the
matching provider, production environment, schema version 1, APPROVED status,
owner approval, approval timestamp and expiry. Every evidence item must be
PASSED, have a durable evidence reference, identify a verifier distinct from
the owner approver, and have a valid verification and expiry interval.

Required evidence keys are:

- `merchant_uat`
- `signed_webhook_verification`
- `provider_status_reconciliation`
- `refund_lifecycle_uat`
- `android_physical_device_acceptance`
- `canonical_pms_ledger_parity`
- `incident_response_and_alerting`
- `production_readiness_review`

The server also requires the production provider configuration to be active,
configured and credential-validated. Missing, expired, malformed or unreadable
qualification evidence blocks live routing. This qualification record does
not itself enable live collection: the independent internal live control,
tenant live switch and emergency-stop interlock must also permit it.

The Android native checkout entry point now invokes
`PaymentReleaseSafeguards.assertSandboxCheckoutAllowed` before SDK handoff.
The immutable device matrix permits only test/staging/UAT environments for
the six wired providers; CCAvenue remains NOT_IMPLEMENTED. Android's matrix is
defence in depth only. It cannot authorize live collection, settlement or
refund posting and cannot override backend policy.

The refund-create route now checks the owner-approved `refund_processing`
control before reserving a refund or calling any provider refund API. The
read-only refund-status route remains available for recovery. A successful
provider refund still does not authorize a PMS ledger reversal; verified
refund evidence and the canonical accounting reversal remain separate gates.

New automated coverage is in
`payment-backend/test/provider-production-qualification.test.mjs` and
`tests/payment-release-safeguards.test.mjs`. The backend CI run must pass
before this implementation is considered CI-verified. Android Gradle
compilation, instrumentation and physical-device acceptance are separate
release requirements.


## Accounting and reconciliation hardening (8 November 2026)

The first accounting/reconciliation implementation is intentionally **proposal
and audit only**. It does not write to Firestore, alter folio balances, or
authorize settlement.

### Double-entry journal contract

- `payment-backend/src/accounting/canonical-journal.mjs` creates immutable,
  deterministic journal proposals in integer INR minor units.
- Payment initiation is a non-posting audit event. It must not move money or
  create a financial journal.
- Provider-verified capture proposes Dr 2020 Gateway Clearing / Cr 1010 Guest
  Receivable. It does not credit 4010 revenue: room/service revenue must be
  recognized by the PMS charge/invoice lifecycle, not merely because a guest
  paid.
- Actual provider fees are separate Dr 5010 Processing Fees / Cr 2020 Gateway
  Clearing entries. Estimated fees are not accepted as posted expense.
- A successful refund requires independently verified provider evidence and a
  parent capture journal. It proposes Dr 1010 / Cr 2020, carries the parent
  journal ID, and rejects cumulative refunds above the original captured
  amount. The eventual Firestore writer must enforce the cumulative cap and
  uniqueness transactionally.
- Every proposal validates safe integer amounts, tenant/folio/provider
  identity, evidence identity and debit-credit equality. Deterministic IDs
  make identical proposals stable across retries.

**Important chart-of-accounts assumption:** account 2020 is treated here as a
gateway clearing asset, not a liability. The supplied label "undistributed
gateway collections / suspense" is not enough to settle its normal balance or
reconciliation treatment. Finance/accounting owner approval of account
definitions and opening balances is required before any writer or migration.
Account 4010 is deliberately not used by payment capture/refund proposals.

### Read-only reconciliation

- `payment-backend/src/accounting/reconciliation-audit.mjs` compares
  tenant-scoped, provider-verified captures against a supplied canonical
  journal snapshot.
- It reports missing, orphaned, duplicate, malformed and field-mismatched
  records and returns a deterministic snapshot digest.
- It is pure and read-only: no repair, settlement, status mutation, or
  ledger write occurs.
- It is not yet exposed as an API or scheduled worker. A trusted server-side
  data source and confirmed canonical PMS ledger are prerequisites. An Android
  WorkManager job is not treated as an accounting authority; Android can be
  offline, untrusted, uninstalled, or delayed by OS scheduling. The eventual
  authoritative cadence should be a backend scheduler with tenant isolation,
  bounded batches, lease/idempotency controls, alert delivery and observable
  run history. The mobile app may display audit results only.

### Refund and provider acceptance

The existing refund dispatch interlock remains in force. No refund journal is
written from a client callback or from a refund-create response alone. The
provider refund must be independently status-verified, then linked to its
original capture and checked against cumulative refunded amount.

The six provider qualification checklists remain evidence requirements, not
automatic green checkmarks. Sandbox contract tests can validate adapter
behaviour, but cannot create merchant UAT, production credentials, webhook
registration, settlement statements, or physical-device acceptance evidence.
No in-repository boolean registry is allowed to qualify a gateway for live
traffic. Qualification remains tenant-scoped, owner-approved, independently
reviewed and time-bounded.

### Physical device integrity

A Kotlin check for API level, emulator build strings or a handful of `su`
paths is not hardware attestation. It is bypassable and can misclassify
custom-ROM devices. Android API level does not prove a hardware-backed key.
Production device acceptance requires a server-verified Play Integrity
verdict (where applicable), hardware-backed key attestation with certificate
chain/challenge validation, app-signing identity/version checks, root/debug/
hook risk signals, and a documented policy for unsupported devices. No
single local Boolean is accepted as proof. The current native safeguard
continues to block live checkout.

### Verification status

New tests:
- `payment-backend/test/canonical-journal.test.mjs`
- `payment-backend/test/reconciliation-audit.test.mjs`

These tests validate the pure accounting contract and read-only discrepancy
detection. They do not establish a canonical production ledger, run merchant
UAT, compile Android, or qualify any provider. Live collection, automatic
settlement and automatic refund posting remain OFF; CCAvenue remains disabled.


## Server-verified Android integrity (8 November 2026)

Device enrollment now layers Google Play Integrity over the existing Android
hardware-backed signing-key attestation. The Play token is not decoded on the
client. The backend uses a service-account OAuth token with the
`https://www.googleapis.com/auth/playintegrity` scope and calls Google's
`decodeIntegrityToken` endpoint. It validates the decoded request binding,
freshness, package name, Play-recognized app verdict, licensed app verdict,
configured signing-certificate SHA-256 digest and
`MEETS_DEVICE_INTEGRITY` device verdict. A stricter
`MEETS_STRONG_INTEGRITY` requirement can be selected by policy.

The one-time server enrollment challenge now includes a standard-request
`playIntegrityRequestHash` bound to tenant, device, challenge ID and a digest
of the random challenge nonce. The decoded verdict must match that exact
request hash and be no older than two minutes (with a bounded future clock
skew). Only then does the existing independent Android Key Attestation
verifier validate the certificate chain, verified boot state, device lock
state and attested public key. Both proof layers are persisted on the
tenant-scoped device record and required at owner activation.

Android integration:
- `android/templates/security/AureliaPlayIntegrityClient.kt` prepares the
  Standard Integrity token provider and requests a token for the server-issued
  request hash.
- `scripts/patch-android.js` copies the helper and adds
  `com.google.android.play:integrity:1.5.0`.
- The helper is a client capability, not a trust authority. The new
  `CloudPaymentDeviceEnrollmentClient.kt` coordinates the server challenge,
  Play token, Android attested key and enrollment submission. It does not
  activate the device. The native coordinator is not yet connected to a
  user-facing owner enrollment screen.

Backend deployment configuration:
- `AURELIA_ANDROID_PACKAGE_NAME`: exact Play Console package name.
- `AURELIA_ANDROID_CERT_SHA256_DIGESTS`: comma-separated expected
  Base64URL SHA-256 signing-certificate digests from the Play app signing
  configuration.
- `AURELIA_REQUIRE_STRONG_INTEGRITY=true`: optional stricter device policy.
- Enable/link Play Integrity API in Play Console and the linked Google Cloud
  project; grant the Cloud Run service identity permission to call the API.
  No service-account private key is placed in the APK or source repository.

No production verdict has been collected. Package name, signing digest,
Play Console project linkage, IAM, Android SDK build and physical-device
enrollment must be configured and verified before the feature can be treated
as operational. Standard Play Integrity is currently checked at device
enrollment; high-risk payment actions will require fresh, action-bound
integrity tokens before any future live authorization.

## PMS ledger source mapping — read-only findings

The actual PMS sources are not yet a unified, server-authoritative accounting
bookwriter:

- `booking.pays` is identified by
  `src/payments/accounting-consistency-diagnostic.mjs` as the canonical
  payment-row collection. `booking.p` and `booking.payments` are
  compatibility representations.
- `financialLedger` is a separate journal array in the local PMS snapshot.
  Existing journal writers found in `index.html` are focused on cancellation
  accounting and use named accounts such as `Guest Advances Liability`,
  `Refunds Payable Liability`, `Cancellation Revenue` and `Cash & Bank`.
- The current revenue/receivable reports derive much of their totals from
  booking and payment data. They do not establish that a complete general
  ledger already exists for every room, dining, expense, gateway collection
  and fee lifecycle.
- The newer canonical repository exposes a `ledger` entity and
  `addLedgerLine` bridge method, but that generic entity interface is not yet
  proven to be the same book as `financialLedger` or the payment rows.

Consequently, no payment writer has been connected to `financialLedger`,
`booking.pays`, or the repository `ledger` entity. Doing so before
establishing the canonical book would create a second ledger or double-post
existing cancellation entries.

| Proposed account | Current PMS evidence | Mapping decision |
|---|---|---|
| 1010 Guest Receivable | Booking balances and payment rows; no complete AR journal mapping verified | Unapproved |
| 2020 Gateway Clearing | No gateway-clearing subledger or float-cycle normal balance verified | **Finance sign-off required** |
| 4010 Operational Guest Revenue | Room/dining revenue is derived from PMS booking and sales data | No journal mapping approved |
| 5010 Merchant Processing Fees | No authoritative provider fee settlement record mapped to PMS expense ledger | Unmapped |

Account 2020 must have its legal/economic nature, normal balance, float
recognition, settlement timing, chargeback treatment and reconciliation
ownership explicitly approved by the accounting owner. The current label
"undistributed gateway collections / suspense" does not resolve whether the
account is a clearing asset or a liability throughout the settlement cycle.
No opening balance, migration, or journal writer is authorized.

## Reconciliation scheduling boundary

The pure comparator and existing bounded provider-recovery worker are not
equivalent to a deployed read-only audit scheduler. A durable scheduled audit
must load both sides from the verified canonical PMS ledger, persist run
history, use tenant-scoped leases and bounded batches, alert on discrepancies,
and remain read-only. That source adapter is not yet available. Scheduling
the current comparator against the incomplete `paymentFolios` writer would
institutionalize the wrong ledger. The scheduler is therefore intentionally
not deployed until the PMS ledger source mapping is approved.

### Verification for this update

The Play Integrity verifier has automated tests for request-hash binding,
freshness, app/package recognition, licensing, signing-certificate matching,
device-integrity labels, optional strong-integrity policy, authenticated
Google decode and fail-closed API responses. The backend CI run on commit
`a4324df34b6a14b1003b08e734100f1445e184a5` passed all backend tests, syntax,
container build, non-root image and Terraform validation. The application
workflow exposed one integration-contract assertion because the cloud
enrollment route had not yet been updated to accept the token; that route has
since been corrected and its current-head workflow must pass before acceptance.


### Follow-up verification and posting interlock (8 November 2026)

Every journal proposal now also carries explicit
`postingEligible: false`, `postingAuthorization: NOT_AUTHORIZED` and
`chartOfAccountsStatus: PROPOSAL_ONLY` fields. A downstream writer must not
treat a mathematically balanced proposal as posting permission. The new
canonical-journal regression test asserts this boundary.

The complete workflow set on commit
`cb2a53d7a348d9339f53215d6bb672a3e76ceaed` passed:
- PMS source tests and production web packaging.
- Settlement foundation CI.
- Payment backend contract/security tests, JavaScript syntax, Cloud Run
  container build, non-root runtime check, Terraform formatting, provider
  initialization and Cloud Run infrastructure validation.

The current head includes the additional non-postable proposal metadata and
its regression assertion. Its workflows are running separately; do not
transfer the previous commit's green status to the newer head until those
runs finish.


The native cloud enrollment coordinator now submits both the Standard
Integrity token and challenge-bound Android Key Attestation chain to the
backend enrollment endpoint. It preserves owner activation as a separate
server action. Android Gradle compilation, device-side API compatibility and
a real Play Console internal-test enrollment are still required.


### Enrollment replay and approval freshness controls

A device record now holds the single current `enrollmentChallengeId`.
Issuing a newer challenge supersedes the prior one; enrollment checks this
pointer both before external verification and again inside the final Firestore
transaction. Successful enrollment consumes the challenge and clears the
pointer. A stale concurrent verification therefore cannot overwrite the
newer device identity.

The owner activation transaction requires the Play Integrity proof to be no
older than ten minutes, and still requires the independently verified Android
Key Attestation state. If the owner does not activate within that window, the
device must be re-enrolled. Once an attested key has been submitted, another
challenge is not issued until the owner activates or revokes the pending
device. A failed/ambiguous client submission may leave a locally generated
attested key; do not silently delete or replace it. Recovery requires an
explicit owner-controlled device reset procedure, which remains a separate
UI/operational task.

The current source head
`8bad860a8d2fdca00595ba042f38f22b7eb065eb` passed all three GitHub workflows:
PMS tests and production web packaging, settlement foundation CI, and payment
backend CI including tests, syntax, container build, non-root verification
and Terraform validation. Android Gradle compilation and real Play Console
physical-device enrollment are still not part of those workflows.
