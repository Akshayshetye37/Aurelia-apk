# Gate 4 — Physical-device account-recovery qualification

**Status: PREPARATION IN PROGRESS — NOT EXECUTED.** Emulator CI, source-contract tests, and simulated Activity/process recreation do not pass this gate. Gate 4 requires a real supported Android handset and a staging APK built from the exact candidate commit.

## Entry criteria

- A dedicated Linux self-hosted runner labeled `aurelia-android-device` is online with Android platform-tools, build-tools (`apksigner`), `jq`, `curl` and USB access to one authorized physical test handset. The runner must be isolated from production credentials and must not log/store device serials.
- Gate 1 same-DEK SQLCipher instrumentation is PASS for the candidate SHA.
- Gate 2 Firebase Emulator grant issue/consume/replay and negative-claim tests are PASS.
- Gate 3 staging APK workflow completed successfully for the same candidate SHA; artifact SHA-256 and APK signing SHA-1/SHA-256 are recorded.
- The APK uses the staging Firebase project only. Phone Auth, SMS quota, deployed staging Functions, App Check and required staging secrets are verified without printing secret values.
- A dedicated test handset, non-production test number and synthetic PMS fixture are approved.
- The device owner and independent reviewer are assigned.

A changed source SHA, rebuilt APK, Firebase configuration change, signing-key change, or relevant backend deployment invalidates the corresponding evidence and requires affected cases to be rerun.

## Safety and data handling

- Use synthetic property, guest, booking and payment records only. Never copy production/customer data to a qualification handset.
- Use a Firebase staging project, test phone number and non-production credentials. Never send test OTPs to an unapproved number.
- Do not place PINs, OTPs, recovery keys, ID tokens, JWT grants, DEKs, raw phone numbers, device serials or secret values in this repository, CI logs, screenshots or evidence summaries.
- Keep raw device serial and sensitive diagnostic bundles only in the access-controlled evidence store. Use a redacted device label here.
- Do not enable production recovery or payment controls as part of this gate.
- Do not uninstall/clear app data unless the case explicitly requires it; doing so can destroy recovery material and invalidate the run.

## Required physical-device matrix

At minimum, qualify one supported current Android handset and one supported lower-end handset. Include a StrongBox-capable handset where supported by the approved device matrix. Each device/API combination gets a separate immutable result record.

| Field | Required value |
|---|---|
| Device label | Redacted label, e.g. DEVICE-01 |
| Manufacturer/model | Exact model |
| Android version/API | Exact version and API level |
| Build fingerprint | Exact OS build fingerprint |
| SoC / security level | Hardware-backed Keystore details |
| StrongBox | Available / unavailable / not supported |
| App candidate SHA | Exact source commit |
| APK SHA-256 | Exact installed artifact |
| APK signer SHA-1/SHA-256 | Exact values from Gate 3 |
| Firebase project | Staging project ID only |
| Test number | Redacted identifier |
| Test run ID | Unique run identifier |
| Tester / reviewer | Names and signed dates |
| Evidence reference | Access-controlled evidence-store reference |

## Gate 4 execution cases

All cases below must be run on the physical handset. Capture timestamped, redacted evidence and exact build/device identity for every result.

| ID | Procedure | Required pass condition |
|---|---|---|
| G4-01 | Fresh install, enroll PIN A, securely retain offline recovery key, register recovery phone and restart app. | Phone destination remains encrypted and registered; Forgot PIN exposes no phone-number input; no secret is logged. |
| G4-02 | Request real staging SMS to registered test number; submit incorrect code, expired code, then fresh valid code. | Wrong/expired codes rejected; valid code verifies only registered phone identity; failed verification never opens recovery gate. |
| G4-03 | Exercise wrong tenant, wrong device binding, wrong nonce, malformed/invalid signature, expired grant and already-consumed grant using supported staging test path. | Every invalid grant rejected; server one-time consumption authoritative; failed case never arms local gate. |
| G4-04 | After successful OTP and grant consumption, force-stop app before entering recovery key; relaunch. | Process-local recovery gate is closed after process death. Fresh authorized OTP/grant required; stale authorization does not survive. |
| G4-05 | With fresh valid grant, submit malformed recovery-key text, valid-format wrong key, then correct offline recovery key. | Malformed input does not spend attempt; wrong valid-format key spends exactly one; maximum three attempts; fourth rejected; expiry/clear fail-closed. |
| G4-06 | Kill process after successful recovery-key unwrap but before new PIN envelope is durably committed; relaunch and inspect existing envelope. | No partial PIN rotation accepted; pre-existing PIN/recovery route remains usable; database remains unopened until authenticated. |
| G4-07 | Complete recovery with PIN B after successful authorization; revoke biometric wrapper/key as part of commit; relaunch. | PIN A rejected; PIN B accepted; biometric wrapper and alias invalidated; recovery wrapper remains associated with original DEK. |
| G4-08 | Open existing SQLCipher database with PIN B and verify pre-seeded synthetic records and versions. | Same database opens with original data intact; no database recreation, data loss, or new DEK generation. |
| G4-09 | Force-stop and reboot after successful recovery; unlock with PIN B and inspect database integrity and foreign keys. | PIN B works after reboot; SQLCipher integrity and foreign-key checks pass; synthetic data and entity/outbox parity remain intact. |
| G4-10 | Inspect app-private files, preferences, crash/logcat output and approved diagnostic artifacts. | No plaintext PIN, OTP, phone number, ID token, grant, recovery key or DEK; no secret in CI artifacts or uploaded logs. |
| G4-11 | Enroll the PIN/biometric Keystore wrappers, then change/remove the secure lock-screen credential through Android Settings and attempt unlock/recovery. | Invalidated Keystore wrappers are detected; app fails closed, never silently regenerates the DEK or wrapper; the separately provisioned offline recovery key can still unwrap the same DEK where its own wrapper remains valid. |
| G4-12 | Register two independently attested owner devices, then simulate a recovery attempt from the registered recovery handset while the second owner device is online; repeat with the second device offline and with notification permission disabled. | Every enrolled owner device receives the alert; at least one device must post and acknowledge it before the 24-hour hold starts. No acknowledgement means no cooldown eligibility and no grant. Owner cancellation revokes an unconsumed grant. |
| G4-13 | Simulate SIM swap/port-out by moving the staging test number to a second SIM/handset while retaining the original attested owner devices. Attempt recovery from the unregistered handset and from the registered recovery device. | Phone possession alone on the unregistered handset cannot satisfy device binding. Owner devices receive and acknowledge the alert; the 24-hour hold begins only after acknowledgement; a fresh SMS after the hold is still bound to the enrolled device and grant. Any missing owner alert/ack blocks grant issue. |

## Execution notes

- Use the exact approved release APK and companion release-signed androidTest APK from the same Gate 3 artifact. The artifact must contain `app-release.apk`, `app-release-androidTest.apk`, their SHA-256 values and both certificate reports. The app and instrumentation APK signer SHA-256 values must match. Do not build or install a different candidate during the run.
- Dispatch the physical workflow with the candidate SHA, successful staging run ID and a redacted device label. It rejects emulators, API levels below 24, unlocked bootloaders and non-green verified boot.
- Run the automated physical-device subset using `.github/workflows/recovery-physical-device-qualification.yml` on the dedicated self-hosted Android device runner. The workflow verifies the staging artifact's originating SHA, physical/locked boot state, signer match and runs the local SQLCipher, grant-preflight and force-stop recovery instrumentation suites. Real SMS, independent owner-device alert/cancellation, lock-screen changes and reboot qualification remain separate Gate 4 cases.
- Capture device build fingerprint, Android API, model and package version before testing. Store serial privately; record only redacted device label here.
- For force-stop cases, record command and timestamp. Force-stop/relaunch is not a substitute for the separate reboot case.
- Run database integrity and foreign-key checks using the approved diagnostic build path; do not add a production-accessible debug endpoint.
- Preserve failed runs as immutable evidence. A rerun is a new run ID; do not overwrite or silently convert a failure to PASS.
- Any crash, unexpected gate opening, old-PIN acceptance, biometric survival, data mismatch, plaintext secret, or unexpected DEK regeneration is a FAIL and blocks Gate 4.

## Result record

| Case | Device label | Run ID | Result | Evidence reference | Tester/date | Reviewer/date |
|---|---|---|---|---|---|---|
| G4-01 to G4-13 | — | NOT RUN | NOT QUALIFIED | — | — | — |

## Exit criteria

Gate 4 is PASS only when all required cases pass on every approved device/API combination, evidence is attached to the access-controlled evidence store, exact source/APK/Firebase staging identities are recorded, and an independent reviewer signs the results.

**Current state:** Gate 4 execution has not started. Gate 3 staging APK and signing evidence are prerequisites. Production account recovery remains DISABLED until all release gates and owner sign-off pass.

## Independent owner-alert requirement

The device requesting recovery must never count as its own owner-notification destination and must never acknowledge its own recovery event. At least one separately enrolled, hardware-attested owner device must accept the FCM event and acknowledge the posted notification. If no independent device exists, or all independent endpoints reject delivery, recovery remains in `ALERT_PENDING` with no cooldown start and no grant. Physical qualification must verify successful acknowledgement from the independent device, rejection of self-acknowledgement, partial FCM failure, and the no-independent-device fail-closed case.


Owner acknowledgement proof is per-device and one-time. The FCM payload contains a random 256-bit token; only the token hash is persisted server-side. The acknowledgement callable requires the matching device token and atomically consumes the pending alert state. Verify a wrong-device token, random token, replayed token and an acknowledgement arriving before the FCM send operation returns are all rejected or safely handled as designed.
