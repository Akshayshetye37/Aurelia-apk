# Gate 6 — Recovery release qualification and owner sign-off

**Status: NOT QUALIFIED — PRODUCTION RECOVERY MUST REMAIN OFF.**

This gate is a release-control record, not an implementation test. No CI result, emulator pass, staging deployment, APK build or developer approval substitutes for the owner's explicit sign-off.

## Candidate freeze

The release candidate must be one immutable 40-character Git commit SHA on `work/p0-storage-hardening`. Record the branch, commit URL, source-tree SHA, build timestamp and exact Firebase staging project. No cherry-picks, rebases, amendments or configuration changes after the candidate is frozen. Any relevant change creates a new candidate and invalidates affected gate evidence.

## Required gate evidence

| Gate | Required immutable evidence | Pass criteria | Current result |
|---|---|---|---|
| 1 — Local encryption | Android instrumentation workflow URL, run ID, candidate SHA, JUnit XML and force-stop phase-one/phase-two logs | Same-DEK recovery, old PIN rejected/new PIN accepted, SQLCipher data intact; genuine app force-stop between phases; zero failures/skips; no plaintext secrets | NOT QUALIFIED on current candidate until latest run completes and same-DEK cases are confirmed |
| 2 — Firebase grant runtime | Recovery Functions CI URL, emulator runtime artifact, candidate SHA | OTP proof, owner alert/ack, 24-hour hold, fresh OTP, local verifier, consume-once, replay/negative claims, cancellation and race tests pass | Awaiting latest candidate CI |
| 3 — Real SMS | Staging workflow URL, APK SHA-256, signer SHA-1/SHA-256, approved test-device run record | Real SMS wrong/expired/replayed/valid OTP and complete grant path on staging handset; no production SMS | NOT RUN |
| 4 — Physical device | Signed device matrix, raw evidence-store reference, exact APK/source fingerprints | All required cases on every approved handset/API; process death, reboot, PIN rotation, data integrity, biometric revocation, cancellation and offline unlock pass | NOT RUN |
| 5 — Deployment/security | Verifier deploy run, IAM policy probe, App Check probes, Secret Manager versions, key-rotation evidence, production flag audit | Private verifier; least-privilege invoker; missing/invalid App Check and attestation fail closed; fresh revocation; no secret leakage; production flag false/unset | NOT RUN |
| 6 — Owner sign-off | This completed section with signed owner and independent reviewer acknowledgement | Owner explicitly accepts exact frozen candidate and all preceding gates; production enablement is a separate authorized action | NOT SIGNED |

## Artifact and certificate record

| Field | Value |
|---|---|
| Candidate SHA | NOT FROZEN |
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
