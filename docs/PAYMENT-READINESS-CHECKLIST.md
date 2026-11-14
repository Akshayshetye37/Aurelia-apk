# Aurelia PMS payment readiness checklist

> **SUPERSEDED for execution order and status (2026-11-14).** Use [REMAINING_WORK_AUDIT_2026-11-09.md](./REMAINING_WORK_AUDIT_2026-11-09.md) as the sole canonical plan. This document is retained only as historical/technical reference; do not use its phase ordering or status snapshot to authorize work or release.

Release-gate ledger for `feature/multi-provider-payment-backend`. Source implementation, unit tests and APK builds do not establish deployment or physical-device acceptance.

## P0 — Required before payment execution

- [x] Native challenge-bound Android Key Attestation primitive added.
- [x] StrongBox requested first; TEE fallback only on StrongBox-unavailable signal.
- [x] Software-backed keys rejected locally; staged key preserves the legacy identity.
- [ ] Appliance verifies chain, challenge, package/signing digest, boot state, device lock and patch policy.
- [x] Owner-session attestation-challenge issuance, single-use storage, pending enrollment and device revocation exist on the LAN appliance.
- [x] Official `android/keyattestation` v0.4 verifier sidecar integrated with Google trust anchors, six-hour fail-closed revocation cache, challenge validation, expected app identity, TEE/StrongBox-only security, locked VERIFIED boot and leaf-key binding.
- [x] Owner/property/device-bound single-use challenge and atomic attestation metadata persistence added; owner activation requires verified attestation.
- [ ] Docker build/CI, actual configured signer digest, valid chain tests, physical StrongBox + TEE acceptance and OS/patch/rollback policy review remain pending.
- [~] Native HTTPS device transport, attested-key requirement, signed lease/ack, lease-token retention, canonical payload hash and immutable command-binding checks are implemented; command consumption, safe key rotation and end-to-end revocation lifecycle remain incomplete.
- [ ] StrongBox and TEE physical-device instrumentation tests.
- [ ] LAN appliance TLS, owner authentication, durable storage, backup and restore.
- [ ] Matching release-signed PMS/Bridge APKs tested on physical hardware.
- [ ] Versioned executable IPC with per-call caller validation and replay protection.
- [x] LAN provider backend independently verifies raw-body webhooks and provider status before enqueueing a device command; production provider activation remains blocked.
- [ ] Durable idempotency, unknown-outcome reconciliation and crash/restart tests.
- [ ] Atomic PMS folio projection with exact tenant/property/booking/folio/amount/currency/provider binding, durable receipt and read-back before device acknowledgement.
- [ ] Provider sandbox E2E acceptance for duplicate, timeout, replay, app-death and backend-outage cases, including the physical device lease-to-ack path.

## P1 — Required before broad operational rollout

- [x] Third-party QR endpoint removed; a CI release-bundle scan now rejects known remote QR services. Local UPI intent works; QR rendering remains intentionally disabled until a local encoder is integrated.
- [ ] Static CI guard for unauthorized folio/payment-field writes.
- [ ] Orchestrator wired to the actual UI only after enrollment and IPC gates exist.
- [ ] INR minor-unit Money value object used consistently.
- [ ] Evidence synchronization is cache/mirror only; local evidence never authorizes settlement.
- [ ] Refund workflow has separate idempotency, verification and atomic folio reversal.
- [ ] Monitoring, backup retention, restore drills and incident/revocation procedures.

## Safety invariants

- `LIVE_PAYMENTS=false`.
- Automatic folio settlement remains disabled.
- Provider and webhook secrets never enter either APK.
- Handshake-only IPC remains the only executable Pay Bridge capability until the complete contract is accepted.
- No local evidence, Bridge callback, client signature or attestation result independently authorizes folio credit.
- Ambiguous dispatched requests are reconciled before retry.
- Core PMS hotel operations remain usable when Pay Bridge or the payment backend is unavailable.

See [Native Device Delivery Boundary](NATIVE-DEVICE-DELIVERY-BOUNDARY.md) for the exact implemented transport contract and the remaining projector/attestation-verifier boundary. Update this checklist with evidence and commit references as each gate is completed. Never mark deployment, physical-device testing or production acceptance complete based only on source inspection.


## Attestation activation hardening — 2026-11-03

- Android enrollment refuses to overwrite an existing attested Keystore alias. Explicit revoke/reset is required before reenrollment.
- Proof-of-possession alone cannot activate a device. The new activation API requires persisted verifier success, hardware security level, locked VERIFIED boot and owner/property binding.
- The integration test isolates transport coverage by manually promoting a test-only database fixture after verifying that HTTP activation leaves it PENDING.

This implements the appliance verifier path using the official v0.4 library. CI Docker build, runtime signer/property configuration, physical StrongBox/TEE acceptance and policy review are still required. Do not enable payment execution, automatic settlement or live collection.


## Appliance Key Attestation verifier implementation — 2026-11-03

- [x] Official upstream verifier v0.4 integrated as a loopback-only JVM sidecar; upstream source tag is pinned in the Docker build.
- [x] Google trust anchors and revocation status validation; six-hour cache with fail-closed refresh behavior.
- [x] Exact challenge, expected app package/signing digest, hardware security level, locked VERIFIED boot and leaf SPKI checks.
- [x] Owner/property/device challenge binding and atomic persistence of verified metadata.
- [ ] Confirm CI Docker build and tests pass on the latest commit.
- [ ] Run valid enrollment on physical StrongBox and TEE-only devices.
- [ ] Complete owner-console enrollment/status UI, native enrollment orchestration, staged rotation and OS/patch/rollback policy.
- [ ] LAN deployment, backup/restore, accounting projector, recovery, refund and end-to-end acceptance remain separate release gates.

Activation is now possible only after verifier success and explicit owner-session action. This does not authorise payment execution or live collection.
