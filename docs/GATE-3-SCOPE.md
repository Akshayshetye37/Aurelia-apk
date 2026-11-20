# Gate 3 — Authentication and Staging Security Qualification Scope

**Status:** Scope established; implementation and qualification are NOT complete.
**Candidate branch:** `work/gate-3-google-email-link`
**Base:** `integration/ledger-patch`

## In-scope authentication methods

1. **Google Sign-In** — primary identity authentication.
2. **Firebase Email Link (passwordless)** — fallback identity authentication.

Email Link is selected over numeric email OTP for this Gate 3 scope. Numeric email OTP is a separate feature and is not part of this qualification.

## Explicit exclusions

- SMS OTP, phone-number authentication, SIM-based identity, SMS recovery, and phone binding.
- Recovery-phone callables and phone-change callables.
- Any authentication flow that unlocks, derives, replaces, rotates, or recovers the local encryption DEK.
- Production recovery activation. Production `RECOVERY_ENABLED=false` remains mandatory.
- Production credentials or deployment. Gate 3 uses a distinct staging project and staging identities only.

## Security boundary

Authentication establishes the signed-in account identity. It does **not** authorize access to or recover the local PMS encryption key. Local PIN, biometric, and recovery-key mechanisms remain independent. Google Sign-In or Email Link alone must never unlock encrypted PMS data.

## Required qualification

### Google Sign-In
- Successful sign-in and token/session validation.
- Account selection and account switching.
- Sign-out and reauthentication.
- Wrong-account and unauthorized-owner/business isolation.
- App restart and session lifecycle behavior.
- Missing/invalid App Check rejection for protected staging endpoints.

### Firebase Email Link
- Link delivery and Android deep-link handling.
- Correct account binding and wrong-account rejection.
- Expiry rejection.
- Single-use consumption and replay rejection.
- Rate limiting/abuse controls and bounded verification attempts.
- Link handling after app restart and on a different signed-in account.
- Missing/invalid App Check rejection for protected staging endpoints.

### Staging and evidence
- Staging and production Firebase/GCP project identities are distinct and explicitly verified.
- WIF trust is restricted to the repository and intended branch/workflow; unauthorized branch/fork negative tests must fail.
- Deployment and runtime IAM are least privilege.
- Candidate SHA, APK signer, APK hashes, workflow runs, test logs and evidence are bound to the exact qualified commit.
- Physical-device qualification records device model, Android version/build, app version, candidate SHA and test outcomes.

## Qualification status

Gate 3 remains **NOT QUALIFIED** until implementation, staging deployment, automated security tests, exact-SHA evidence and physical-device matrix all pass. Owner-controlled cloud configuration and physical-device testing are external prerequisites and must not be represented as completed by repository changes.

## Workflow/documentation consistency

Every Gate 3 workflow, callable inventory, evidence schema, test, runbook and README status must follow this scope. Legacy SMS/phone qualification artifacts must be retired or clearly marked obsolete and must not be runnable as current Gate 3.
