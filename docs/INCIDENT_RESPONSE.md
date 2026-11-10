# Aurelia PMS Incident Response Runbook

**Status:** Operational template; named owners and contact channels must be assigned before production activation.

## 1. Operating rules

- Preserve evidence. Do not clear app data, uninstall, wipe, reinitialize or regenerate an encryption key during an incident.
- Keep `uiCutover`, cloud sync, provider activation, live gateway collection, auto-settlement and auto-refunds OFF unless the incident commander explicitly authorizes a controlled recovery.
- Use synthetic data in engineering reproductions. Real PMS snapshots require written owner authorization and encrypted, access-controlled handling.
- Never put guest names, phone numbers, email addresses, room numbers, folio contents, payment-card data, access tokens, PINs, recovery keys, DEKs, KEKs, webhook secrets or raw webhook bodies in logs or tickets.
- Record event IDs, timestamps, build SHA, device model/API and non-sensitive error codes instead of payloads or credentials.

## 2. Key loss, missing envelope or database corruption

**Trigger:** PIN/biometric unlock fails unexpectedly; Keystore key is invalidated; the DEK envelope is missing/corrupt; SQLCipher authentication or integrity checks fail.

1. Stop writes and lock the app. Do not retry setup or create a new DEK.
2. Disable any affected cutover or sync path. Keep the source database and WAL/SHM files untouched.
3. Record the exact app build SHA, device model, Android API, timestamp and non-sensitive error code.
4. Preserve a read-only forensic copy of the database, WAL/SHM files and envelope in access-controlled storage. Do not export plaintext.
5. If the database file is corrupt, quarantine it without deleting or replacing the original. Restrict write access to the quarantine copy.
6. Attempt recovery only through an approved PIN, biometric reauthorization, recovery-key procedure or verified encrypted backup.
7. Restore into a temporary database, run SQLCipher authentication, `PRAGMA integrity_check`, `PRAGMA foreign_key_check`, repository contract checks and accounting reconciliation before an atomic swap.
8. Require a second reviewer before releasing the recovered database to the app.
9. If no valid key or backup exists, preserve the encrypted database and escalate to the data owner. Never claim data recovery without verification.

## 3. Suspected credential, key or personal-data leak

**Trigger:** A secret appears in source control, CI output, crash logs, monitoring, a support ticket or an unauthorized device/account.

1. Contain first: disable the affected integration/provider credential, revoke sessions/tokens and block affected webhook ingress as appropriate.
2. Do not paste the leaked value into the incident record. Record only the secret type, location, exposure window and identifier/version.
3. Preserve relevant CI run IDs, commit SHAs, artifact hashes and sanitized logs. Restrict access to raw evidence.
4. Rotate the affected credential in the managed secret store. During a planned dual-secret rotation window, accept both versions only for the minimum approved period.
5. If DEK/KEK exposure is suspected, keep the database locked and invoke the owner-approved key compromise procedure. Do not silently re-encrypt or regenerate keys.
6. Assess affected tenants, devices, records and time window without exporting unnecessary PII.
7. Remove the secret from active source/history using the repository owner's approved remediation procedure; confirm push protection and secret scanning are enabled.
8. Notify the security owner and data owner. Follow applicable contractual and legal notification requirements.
9. Close only after rotation, containment, impact assessment, evidence preservation and independent review.

## 4. Payment dispute, duplicate charge or webhook anomaly

**Trigger:** Guest dispute, provider settlement mismatch, duplicate/out-of-order webhook, signature failure, unexplained folio posting or refund mismatch.

1. Disable the affected provider or automation path. Keep cash/manual folio operations independent.
2. Do not delete payment events, webhook inbox records, folio entries or audit history.
3. Identify the transaction using provider, environment, provider transaction ID, event ID, order ID and internal folio reference. Do not record card PAN/CVV or raw payment credentials.
4. Verify the authoritative payment/refund status directly with the provider API or merchant dashboard.
5. Check raw-body signature validation, timestamp window, replay record, idempotency key and payment state transition.
6. Compare provider amount/currency/order against the persisted intent and folio entry using integer minor units.
7. If a correction is needed, use an idempotent, append-only adjustment/refund workflow with an explicit reason and independent approval. Never edit or delete a posted ledger entry.
8. Reconcile the affected provider settlement batch against folio and journal totals.
9. Obtain accounting approval and provider evidence before re-enabling the affected provider or automation.

## 5. Required incident record

Record the following non-sensitive evidence:

- Incident ID, severity, opened/closed timestamps and detection source.
- Incident commander, technical owner, data owner and independent reviewer.
- App/build SHA, backend deployment SHA, artifact digest and workflow run IDs.
- Affected device model/API or provider/environment.
- Non-sensitive event/transaction identifiers and error codes.
- Containment actions, key/secret version rotations and timestamps.
- Integrity-check, restore, reconciliation and regression-test results.
- User/data-owner notification decision and approval.
- Rollback decision, owner and completion evidence.

## 6. Recovery and release authority

A recovery or security incident does not authorize production release. Re-enable a feature only after the affected release gate is re-tested on the exact candidate SHA, the data/security owner approves the evidence, and a different reviewer signs the result.

## 7. Ownership — must be completed before production

| Responsibility | Assigned person/team | Contact / escalation |
|---|---|---|
| Incident commander | **UNASSIGNED** | **UNASSIGNED** |
| Security/key custodian | **UNASSIGNED** | **UNASSIGNED** |
| PMS data owner | **UNASSIGNED** | **UNASSIGNED** |
| Accounting approver | **UNASSIGNED** | **UNASSIGNED** |
| Payment/provider owner | **UNASSIGNED** | **UNASSIGNED** |
| Release owner | **UNASSIGNED** | **UNASSIGNED** |
| Rollback owner | **UNASSIGNED** | **UNASSIGNED** |
| Independent reviewer | **UNASSIGNED** | **UNASSIGNED** |
