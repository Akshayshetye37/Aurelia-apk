# Gate 6 — Recovery release qualification and owner sign-off

**Status: NOT QUALIFIED — PRODUCTION RECOVERY MUST REMAIN OFF.**

This gate is a release-control record, not an implementation test. No CI result, emulator pass, staging deployment, APK build or developer approval substitutes for the owner's explicit sign-off.

## Candidate freeze

The release candidate must be one immutable 40-character Git commit SHA on `work/p0-storage-hardening`. Record the branch, commit URL, source-tree SHA, build timestamp and exact Firebase staging project. No cherry-picks, rebases, amendments or configuration changes after the candidate is frozen. Any relevant change creates a new candidate and invalidates affected gate evidence.

## Required gate evidence

| Gate | Required immutable evidence | Pass criteria | Current result |
|---|---|---|---|
| 1 — Local encryption | Android instrumentation workflow URL, run ID, candidate SHA, JUnit XML and force-stop phase-one/phase-two logs | Same-DEK recovery, old PIN rejected/new PIN accepted, SQLCipher data intact; genuine app force-stop between phases; zero failures/skips; no plaintext secrets | PASS — run [43835932330](https://github.com/Akshayshetye37/Aurelia-apk/actions/runs/43835932330), frozen candidate SHA |
| 2 — Firebase grant runtime | Recovery Functions CI URL, emulator runtime artifact, candidate SHA | OTP proof, owner alert/ack, 24-hour hold, fresh OTP, local verifier, consume-once, replay/negative claims, cancellation and race tests pass | PASS — run [43835932275](https://github.com/Akshayshetye37/Aurelia-apk/actions/runs/43835932275), same frozen candidate SHA |
| 3 — Real SMS | Staging workflow URL, APK SHA-256, signer SHA-1/SHA-256, approved test-device run record | Real SMS wrong/expired/replayed/valid OTP and complete grant path on staging handset; no production SMS | NOT RUN |
| 4 — Physical device | Signed device matrix, raw evidence-store reference, exact APK/source fingerprints | All required cases on every approved handset/API; process death, reboot, PIN rotation, data integrity, biometric revocation, cancellation and offline unlock pass | NOT RUN |
| 5 — Deployment/security | Verifier deploy run, IAM policy probe, App Check probes, Secret Manager versions, key-rotation evidence, production flag audit | Private verifier; least-privilege invoker; missing/invalid App Check and attestation fail closed; fresh revocation; no secret leakage; production flag false/unset | NOT RUN |
| 6 — Owner sign-off | This completed section with signed owner and independent reviewer acknowledgement | Owner explicitly accepts exact frozen candidate and all preceding gates; production enablement is a separate authorized action | NOT SIGNED |

## Artifact and certificate record

| Field | Value |
|---|---|
| Candidate SHA | `a3f483ab8672ab5dfd5dd4ccdb98ce892720663c` |
| Android APK SHA-256 | NOT BUILT |
| Android instrumentation APK SHA-256 | NOT BUILT |
| APK signer SHA-1 | NOT BUILT |
| APK signer SHA-256 | NOT BUILT |
| Staging Firebase project ID | NOT CONFIGURED |
| Production recovery flag audit run | NOT RUN |
| Gate evidence bundle | NOT ASSEMBLED |

## Explicit owner decision

Complete only after Gates 1–5 are PASS on the same candidate SHA and all evidence is reviewed.

- Owner name: ____________________
- Owner account / role (no email or credential): ____________________
- Candidate SHA reviewed: ____________________
- Decision: APPROVE / REJECT
- Scope: staging qualification only / authorize separate production release review
- Owner signature or approved audit-trail reference: ____________________
- Date and timezone: ____________________

Independent reviewer: ____________________
Reviewer signature or approved audit-trail reference: ____________________
Review date and timezone: ____________________

**No signature is present. Production recovery remains OFF.** The owner must not sign a candidate whose gates are missing, failed, stale or recorded against another SHA. Production enablement requires a separately reviewed, explicit authorization after all six gates pass.


## Canonical workflow sequence and evidence inputs

Use only these canonical workflows from the trusted control branch `integration/ledger-patch`:

1. `.github/workflows/gate-3-real-sms-staging.yml` — staging deploy, APK build, signer verification and App Check probes.
2. `.github/workflows/gate-manual-attestation.yml` with `kind=sms` — reviewer-approved real-SMS test record tied to the Gate 3 APK.
3. `.github/workflows/gate-4-physical-device.yml` — automated physical handset instrumentation using the exact Gate 3 APK.
4. `.github/workflows/gate-manual-attestation.yml` with `kind=device` — reviewer-approved record for the additional human-only device cases.
5. `.github/workflows/gate-5-production-security.yml` — read-only production security audit.
6. `.github/workflows/gate-6-release-signoff.yml` — final cross-gate evidence and approval verification.

The obsolete `recovery-physical-device-qualification.yml` and `recovery-production-flag-audit.yml` workflows have been removed. Their outputs were not accepted by Gate 6 and must not be used as qualification evidence.

### SMS attestation JSON template

Submit this JSON to the manual-attestation workflow with `kind=sms`. Replace every placeholder with evidence from the exact Gate 3 APK and physical staging test. Do not include the OTP, phone number, SMS body, Firebase `verificationId`, device serial or secrets.

```json
{
  "kind": "sms",
  "apkSha256": "<64-character Gate 3 app APK SHA-256>",
  "testedAt": "2026-11-16T12:00:00Z",
  "tester": "<independent GitHub login>",
  "results": {
    "validOtp": "VERIFIED",
    "wrongOtp": "REJECTED",
    "expiredOtp": "REJECTED",
    "replayedOtp": "REJECTED",
    "resendRateLimit": "REJECTED",
    "otpDoesNotAccessDek": "CONFIRMED",
    "passkeyAckEnrollAndAssert": "VERIFIED"
  },
  "country": "IN",
  "carrier": "<mobile carrier>",
  "stagingProjectId": "<Gate 3 staging project ID>",
  "smsDeliveredAt": "2026-11-16T11:55:00Z",
  "challengeId": "<UUID v4 from createRecoveryAttestationChallenge>",
  "deviceLabel": "Pixel 8 Android 15",
  "deviceIdentitySha256": "<64-character lowercase SHA-256 of redacted device identity>"
}
```

### Physical-device attestation JSON template

Submit this JSON to the same manual-attestation workflow with `kind=device`. The before/after checksums must be measured from the same synthetic SQLCipher fixture and must match exactly.

```json
{
  "kind": "device",
  "apkSha256": "<64-character Gate 3 app APK SHA-256>",
  "testedAt": "2026-11-16T12:00:00Z",
  "tester": "<independent GitHub login>",
  "results": {
    "pinAFailsAfterRecovery": true,
    "pinBOpensOriginalData": true,
    "forceStopSurvived": true,
    "rebootSurvived": true,
    "replayRejected": true,
    "lockScreenChangeFailsClosed": true,
    "ownerCancelDuringHold": true,
    "offlineNormalUse": true,
    "logScanClean": true
  },
  "deviceModel": "<physical handset model>",
  "androidVersion": "<Android version>",
  "verifiedBoot": "green",
  "bootloaderLocked": true,
  "dataChecksumBefore": "<64-character lowercase SHA-256>",
  "dataChecksumAfter": "<same 64-character lowercase SHA-256>"
}
```

The manual-attestation workflow requires a distinct tester, a separate workflow trigger actor, and an independent reviewer approval. Never have the tester approve their own attestation.



### Gate 3 and Gate 5 runtime identity requirements

Gate 3 probes all 19 exported recovery callables with both missing and invalid App Check tokens. The staging deployment requires distinct `RECOVERY_PHONE_SERVICE_ACCOUNT` and `RECOVERY_GRANT_SERVICE_ACCOUNT` values; the former is bound only to the phone-registration callables and `PHONE_PEPPER`, while the latter is bound to grant issuance/consumption and both `PHONE_PEPPER` and `RECOVERY_SIGNING_KEY_PKCS8`. No-secret callables must not share either secret-bearing identity. Gate 5 requires `RUNTIME_SERVICE_ACCOUNTS` to list every deployed runtime identity and checks exact secret access, project/function/service invocation policies, and production recovery OFF.

### Gate 6 run ID input

The `run_ids` input must be a JSON object with exactly these keys and successful workflow run IDs, all for the same candidate SHA and control-branch revision: All seven run IDs must be positive, distinct IDs; Gate 6 rejects duplicate IDs, stale evidence, incomplete callable probes, mismatched APK/attestation hashes, and incomplete production IAM-policy coverage.

```json
{
  "1": "<Gate 1 run ID>",
  "2": "<Gate 2 run ID>",
  "3": "<Gate 3 run ID>",
  "4": "<Gate 4 run ID>",
  "5": "<Gate 5 run ID>",
  "sms": "<SMS attestation run ID>",
  "device": "<device attestation run ID>"
}
```

Configure the GitHub variable `RELEASE_OWNER_LOGIN` with the candidate owner's GitHub login. Configure `recovery-release-owner`, `recovery-release-review-1` and `recovery-release-review-2` as protected GitHub Environments with required reviewers. Restrict `recovery-release-owner` to that same candidate owner; Gate 6 verifies the approved login against `RELEASE_OWNER_LOGIN`. Each environment must produce an approved deployment-review record; Gate 6 requires three distinct approvers (the owner and two independent reviewers), none of whom may be the workflow trigger actor or either manual attestation tester. The manual SMS and device workflows must separately be approved through the protected `recovery-attestation` environment. It also checks that the Gate 3 APK signer SHA-256 is present in the production Firebase signing inventory from Gate 5.
