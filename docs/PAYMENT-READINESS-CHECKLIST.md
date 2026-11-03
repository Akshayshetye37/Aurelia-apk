# Aurelia PMS payment readiness checklist

Release-gate ledger for `feature/multi-provider-payment-backend`. Source implementation, unit tests and APK builds do not establish deployment or physical-device acceptance.

## P0 — Required before payment execution

- [x] Native challenge-bound Android Key Attestation primitive added.
- [x] StrongBox requested first; TEE fallback only on StrongBox-unavailable signal.
- [x] Software-backed keys rejected locally; staged key preserves the legacy identity.
- [ ] Appliance verifies chain, challenge, package/signing digest, boot state, device lock and patch policy.
- [x] Owner-session challenge issuance, single-use storage, pending enrollment, proof-of-possession activation and revocation exist on the LAN appliance; this does not yet verify Android hardware attestation.
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

- [~] Third-party QR endpoint removed; local UPI intent works, but QR rendering remains intentionally disabled until a local encoder is integrated.
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
- Appliance activation is fail-closed and returns device_attestation_verifier_unavailable; proof-of-possession alone cannot activate a device.
- The integration test isolates transport coverage by manually promoting a test-only database fixture after verifying that HTTP activation leaves it PENDING.

This closes the proof-of-possession activation bypass but does not implement the Google Android Key Attestation verifier. Certificate-chain trust/revocation, attestation extension parsing, challenge and app-signer binding, verified-boot/device-lock policy, and physical StrongBox/TEE acceptance remain P0 blockers. Do not activate devices, payment execution, automatic settlement or live collection.
