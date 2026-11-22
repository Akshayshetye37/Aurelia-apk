# Aurelia PMS — Google-only identity and device-credential recovery snapshot

**Status: implementation candidate — NOT production-qualified.** This README describes the source ZIP generated on 2026-11-22. The ZIP has no Git metadata and is not yet proven to match a GitHub commit. The README update is documentation, not release approval.

## Repository and project location

- Repository: https://github.com/Akshayshetye37/Aurelia-apk
- Intended integration branch: `integration/ledger-patch`
- Project root in a repository clone: `/` (repository root)
- Source ZIP: `Aurelia-apk-google-device-credential-implementation.zip`
- Snapshot project directory inside ZIP: `Aurelia-apk-integration-ledger-patch/`
- Local extracted workspace used for this update: `/mnt/data/Aurelia-apk-google-device-credential-implementation/Aurelia-apk-integration-ledger-patch`
- Local ZIP path: `/mnt/data/Aurelia-apk-google-device-credential-implementation.zip`
- ZIP SHA-256: `fdae2308edaacf5ab534a956ae2e6d0b08deb51e8c9df91e558332485e528fca` (checksum sidecar: `Aurelia-apk-google-device-credential-implementation.zip.sha256`)

The local ZIP is available in the ChatGPT workspace. **It has not been uploaded as a binary to this GitHub branch.** This documentation branch therefore does not represent a source-code merge. The extracted project is at `/mnt/data/Aurelia-apk-google-device-credential-implementation/Aurelia-apk-integration-ledger-patch`.

## Product/security decisions

- Google Sign-In is the sole account identity mechanism. Google UID—not email—binds the local profile.
- SMS/phone OTP, email OTP, email/password, email-link login, recovery codes/screenshots, recovery-key/escrow/grant infrastructure and recovery-only Functions/workflows are removed from this snapshot.
- PMS is local-first; cloud/server services are optional and cannot block local operations.
- App PIN and biometric unlock are optional.
- Android device screen lock is the forgotten-PIN recovery authorization.
- PIN reset must unwrap and rewrap the **same DEK**, never silently create a new DEK/database.
- One local profile is supported. Account switching requires an explicit destructive reset; multi-business/profile selection is not implemented.
- Background lock: immediate, 5 minutes, 15 minutes, or never while the process remains alive. Process death/reboot clears the in-memory DEK. `FLAG_SECURE` remains.
- Live payment collection remains disabled.
- Cross-device backup discovery/restore is not implemented or qualified.

## Implemented source changes

### Authentication and identity
- Google-only auth in app and payment-admin UI.
- Local UID binding and account-isolation boundaries.
- Google Sign-In alone does not unlock the DEK.

### Android native recovery
- Android Keystore device-credential DEK wrapper, UID/database-bound metadata.
- Device-credential envelope stored in no-backup storage with atomic file handling.
- Forgotten PIN: fresh Google Sign-In → UID match → native Android screen-lock prompt → unwrap existing DEK → verify new PIN wrapper → atomic envelope replacement → reopen original database.
- Optional PIN enrollment and biometric slot.
- Missing/invalidated key material fails closed; no silent replacement database.

### Settings and lifecycle
- Native Security Settings activity and UI bridge.
- Background-lock options: immediate / 5m / 15m / never while process alive.
- Process death/reboot clears in-memory DEK.

### Generator and qualification
- Android patcher copies native security templates, settings activity, manifest entries and bridge.
- Synthetic patcher smoke test added.
- Gate 1–6 framework retained, with OTP-specific gates replaced by device-credential/Google-only/optional-cloud qualification.
- Source-contract/security tests and workflow checks updated.

## Verification performed

| Check | Result | Scope/limitation |
|---|---|---|
| `npm run build` | PASS | Web build |
| Repair-focused tests | PASS — 22 | Android regeneration safety, generator smoke, gate tests |
| Full root suite | BLOCKED — 404 passed, 25 failed | Missing `fake-indexeddb`/`zod`; npm install timed out |
| Android generator synthetic smoke | PASS | Synthetic project only |
| Workflow lint | PASS | Workflow structure |
| Immutable action pin check | PASS | Action refs |
| Workflow YAML parse | PASS | YAML syntax |
| Source/auth flag tripwire | PASS | Source scan |
| Source-only production audit | PASS | No production credentials/project |
| Inline JS syntax | PASS | Syntax checks |
| JSON/Node syntax | PASS | Syntax checks |
| ZIP integrity | PASS | Archive integrity |
| Full `npm test` | BLOCKED | Current run: 404 passed, 25 failed to load `fake-indexeddb` or `zod`; install timed out |
| Android Gradle/Kotlin compile | NOT RUN | SDK/Gradle unavailable |
| Android instrumentation | NOT RUN | No emulator/SDK |
| Firebase Functions build/emulator | NOT RUN | Dependencies/emulators unavailable |
| Physical device/Keystore | NOT RUN | No device qualification |
| Production cloud audit | NOT RUN | No authorized production project |
| Cross-device backup/restore | NOT IMPLEMENTED/QUALIFIED | Google Sign-In cannot be assumed to decrypt backup |

See `docs/IMPLEMENTATION-REPORT-2026-11-22.md`. Do not claim a verified APK or production readiness.

## Remaining work — exact blockers and required technology

### P0 — Synchronize snapshot with GitHub source
**Blocker:** ZIP is not Git-backed and has not been reconciled file-by-file with the current GitHub branch head `bd4b987c7c4cfa105c4f627ec8cbeea220dd571c`.
**Required:** compare files against current branch head, integrate source changes without overwriting newer commits, commit source and README, record exact SHA, rebuild ZIP from that commit.
**Technology:** Git, diff/merge, GitHub Actions, PR review.

### P0 — Complete the dependency-backed test suite
**Blocker:** dependencies unavailable; registry installation timed out. Direct dependencies are exact-version pins, but no lockfile was generated.
**Required:** clean dependency install, full `npm test`, `npm run build`, fix all failures and rerun.
**Technology:** Node.js 22, npm, `node:test`, Zod, fake-indexeddb.

### P0 — Android generated-project compilation
**Blocker:** no Android SDK/Gradle toolchain in the implementation environment; native Kotlin/Java is not compile-qualified.
**Required:** generate project, patch templates, Capacitor sync, compile Kotlin/Java, unit tests, assemble debug APK, inspect package/manifest/permissions/signature.
**Technology:** Node 22, Capacitor 7, Android SDK/build-tools 35, Java 21, Gradle, Kotlin, AndroidX, Keystore, Credential Manager.

### P0 — Android instrumentation and device-credential recovery
**Blocker:** no emulator or physical-device evidence.
**Required:** AndroidJUnitRunner nonzero test count; pass SQLCipher repository and security tests; retain XML/logcat/diagnostics. Physical device matrix must cover screen-lock authentication, key invalidation, biometric changes, process death/reboot, lockout/cancel, Google UID mismatch and same-DEK recovery.
**Technology:** Android emulator API 35 Google APIs x86_64, ADB, Android JUnit instrumentation, SQLCipher/SQLite, Android Keystore, device credential/BiometricPrompt.

### P0 — Firebase/Google configuration and emulator qualification
**Blocker:** provider/client/signing configuration and emulator tests are not qualified for this exact SHA.
**Required:** enable Firebase Google provider, OAuth Web client ID, debug/release fingerprints and correct `google-services.json`; Functions build; Firestore/Storage emulator authorization tests; verify App Check. Do not commit credentials.
**Technology:** Firebase Auth, Credential Manager, Firebase Functions TypeScript, Firestore/Storage rules, Firebase Emulator Suite, App Check.

### P1 — Physical-device/release identity qualification
**Required:** supported Android/API matrix; signed internal build; Google auth; local UID isolation; PIN/biometric/device-credential flows; background lock; process death/reboot; database integrity and data preservation.
**Technology:** Android devices, Java/Kotlin, Keystore, SQLCipher, ADB, protected release signing.

### P1 — Encrypted backup and second-device restore
**Status:** not implemented/qualified for this architecture.
**Required:** versioned authenticated-encrypted backup of DB+attachments; key authorization on second device; integrity/checksum/reference/financial-total validation; interrupted/tampered/wrong-key restore tests.
**Technology:** SQLCipher checkpointing, Android Keystore/envelope crypto, attachment storage, backup format, integrity checks, Android/Node tests, physical second-device acceptance.

### P1 — Canonical PMS data authority and UI cutover
**Required:** screen/mutation inventory; repository-backed reads/writes for all domains; transactional booking/folio/payment/inventory/audit/outbox changes; restart hydration; remove stale legacy authority; rollback/replay tests. Cutover remains gated.
**Technology:** JS ES modules, domain schemas, repository/command services, IndexedDB, Capacitor SQLite/SQLCipher, Node tests, Android instrumentation.

### P1 — Security and release review
**Required:** exact-SHA evidence; independent security review; secret/dependency/permission review; signing identity verification; gates and explicit owner approval. Production audit needs authorized project evidence.
**Technology:** GitHub Actions, source/dependency scanners, Firebase/IAM/App Check, signing verification, Gate 1–6 evidence.

### Conditional — Live payment provider qualification
Live collection is OFF. If online collection is required: merchant sandbox/UAT; raw webhook signatures; replay/idempotency; authoritative capture/refund reconciliation; atomic folio/journal posting; secrets/IAM/monitoring; accounting-owner approval. Otherwise keep gateway flags disabled and preserve offline/manual operations.

## Repository structure

```
.
├── index.html                         # PMS UI/entry
├── package.json                      # Node/Capacitor scripts/dependencies
├── capacitor.config.json             # Capacitor config
├── firebase.json                     # Firebase config
├── firestore.rules                   # Firestore auth rules
├── storage.rules                     # Storage auth rules
├── functions/                         # Firebase Functions
│   ├── src/
│   └── test/
├── android/templates/                 # Authoritative native templates
│   ├── security/                      # crypto, envelopes, PIN/biometric/device credential
│   ├── instrumentation/                # Android test templates
│   └── *.java / *.kt                  # storage, identity, payment bridges
├── src/
│   ├── bookings/                      # booking domain helpers
│   ├── features/payments/              # payment UI
│   ├── payments/                      # orchestration, ledger, evidence, settlement
│   ├── services/                      # service boundaries
│   ├── storage/                       # schemas, adapters, repositories, authority,
│   │                                   # bootstrap, backup/attachment foundations
│   └── sync/                           # sync/cloud connection foundations
├── payment-backend/                    # payment service/providers/infra/tests
├── scripts/
│   ├── patch-android.js                # native template integration
│   ├── regenerate-android-safe.sh       # safe generation + backup/restore
│   └── gates/                          # candidate/evidence/audit/workflow utilities
├── gates/                               # qualification config
├── tests/                               # source/storage/security/generator tests
├── docs/                                # architecture, security, Android, payment,
│                                         # backup, qualification and release docs
└── .github/workflows/                   # CI/build/qualification workflows
```

## Android generation/build workflow

Android native code is maintained under `android/templates`; generated project files are not the authoritative template source.

### Recommended safe regeneration
From project root:
```bash
bash scripts/regenerate-android-safe.sh
```
The script refuses to run if `android/templates` is missing/empty, runs `npm test` and `npm run build`, backs up the existing `android/` tree, preserves templates and `google-services.json`, regenerates via `npx cap add android`, restores templates/config, applies `scripts/patch-android.js`, then runs `npx cap sync android`. On failure it restores the previous Android directory, or removes partial output when no prior Android project existed.

### Manual debug build
Prerequisites: Node 22, npm, Java 21, Android SDK/build-tools 35 and a compatible Gradle environment.
```bash
npm install
npm test
npm run build
# Preserve android/templates and app/google-services.json before generating.
npx cap add android
node scripts/patch-android.js
npx cap sync android
cd android
./gradlew --no-daemon assembleDebug
```
Do not run `npx cap add android` over an existing Android project without backing it up and preserving templates/config. `assembleDebug` is not a signed production release.

### Workflow inventory
| Workflow | Purpose | Qualification boundary |
|---|---|---|
| `pms-quality.yml` | PMS source tests/web build | Source quality only |
| `r1-local-first.yml` | Exact-SHA local-first tests/build/privacy boundaries | Not Android/device/accounting/release |
| `primary-auth-ci.yml` | Google auth contracts, Functions build, emulator rules, Android debug compile | Exact SHA; CI config/dependencies required |
| `native-sqlite-contract.yml` | Android SQLite/SQLCipher contract/instrumentation | Nonzero tests and retained evidence required |
| `payment-backend-ci.yml` | Payment backend checks | No live provider qualification |
| `settlement-foundation-ci.yml` | Settlement contracts | No live collection approval |
| `gate-lint.yml` | Gate workflow/config lint | Structure only |
| `gate-1-encrypted-storage.yml` | Gate 1 encrypted storage | Candidate evidence |
| `gate-2-device-credential-runtime.yml` | Gate 2 device-credential runtime | Candidate evidence |
| `gate-3-google-cloud-qualification.yml` | Gate 3 optional Google/cloud | Configuration/credentials required |
| `gate-4-physical-device.yml` | Physical-device qualification | Real device evidence |
| `gate-5-production-security.yml` | Production audit | Authorized production config required |
| `gate-6-release-signoff.yml` | Exact candidate sign-off | All prior gates and approval |
| `gate-manual-attestation.yml` | Manual evidence | Human attestation |
| `build-pms-debug-apk.yml` | Manual debug build + emulator instrumentation | QA only; not Pay Bridge-compatible |
| `build-apk.yml` | Release APK | Job disabled with `if: false`; release not authorized |

Evidence is SHA-specific. A passing workflow on an older commit does not qualify the current source.

## Commands
```bash
npm install
npm test
npm run build
npm run android:sync
npm run diagnose:accounting
```

## Documentation index
- `docs/IMPLEMENTATION-REPORT-2026-11-22.md` — implementation and verification evidence/limits.
- `docs/IMPLEMENTATION_STRATEGY.md` — strategy.
- `docs/ANDROID_REBUILD.md` — safe Android regeneration.
- `docs/ANDROID_DEVICE_QUALIFICATION.md` — device acceptance.
- `docs/ANDROID-PMS-ENCRYPTION-KEY-LIFECYCLE.md` — key lifecycle.
- `docs/NATIVE-SECURITY-AND-RECOVERY.md` — security/recovery.
- `docs/RECOVERY-GATE-PIPELINE.md`, Gate 4/5/6 docs — qualification.
- `docs/SECURITY.md` and `docs/RELEASE_CHECKLIST.md` — security/release.

## Production release rule
All required tests, Android compile/instrumentation, Firebase emulator qualification, physical-device lifecycle/security, backup/restore acceptance, migration/accounting parity, independent review, exact-SHA Gate 1–6 evidence and explicit release authorization must pass on the same release-candidate SHA. Until then: **implementation candidate only; no production APK is verified by this report.**
