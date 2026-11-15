# Aurelia feature registry

**Baseline:** `3fc72fd6b6f69e59c8cbc7441c04624acc455723` on `feature/multi-provider-payment-backend`  
**Inventory branch:** `work/phase-0-feature-registry`  
**Tracked repository files inventoried:** 292  
**Implementation entries:** 125  
**Associated test files:** 92  
**VERIFIED:** 0 · **LOCKED:** 0 · **UNVERIFIED:** 125

## Evidence policy

An entry may become VERIFIED only when a completed green GitHub Actions run targets the exact feature SHA and reports a non-zero test count, zero failures and zero skips. Record the run URL, SHA and counts. A partially completed job, source inspection, static assertion, skipped test, unrelated SHA or suite that does not exercise the entry is not evidence. LOCKED additionally requires an immutable `lock/<id>-v1` tag and per-file hashes in `locked-hashes.json`.

No entries are marked VERIFIED or LOCKED in this initial inventory. Historical evidence from other branches is deliberately not carried over until its exact SHA, workflow result, tests and source correspondence are reconciled. No lock tags are created for unverified behavior.

## Inventory

One row per implementation module/file. This is a module-level inventory, not a claim that every exported function has been independently acceptance-tested. Test associations are candidate paths based on naming/domain and must be validated before being used as evidence.

| ID | Feature area | Implementation file | Candidate tests | Status |
|---|---|---|---|---|
| android-native-integrations-001 | android-native-integrations | `android/templates/CapacitorPmsStoragePlugin.java` | Not mapped | UNVERIFIED |
| android-native-integrations-002 | android-native-integrations | `android/templates/FirebasePhoneIdentity.kt` | Not mapped | UNVERIFIED |
| android-native-integrations-003 | android-native-integrations | `android/templates/LocalGatewayVault.java` | Not mapped | UNVERIFIED |
| android-native-integrations-004 | android-native-integrations | `android/templates/LocalPaymentLedger.java` | Not mapped | UNVERIFIED |
| android-native-integrations-005 | android-native-integrations | `android/templates/LocalPmsRepository.java` | Not mapped | UNVERIFIED |
| android-native-integrations-006 | android-native-integrations | `android/templates/NotificationQueueDb.java` | Not mapped | UNVERIFIED |
| android-native-integrations-007 | android-native-integrations | `android/templates/PAY_BRIDGE_IPC_CONTRACT.md` | Not mapped | UNVERIFIED |
| android-native-integrations-008 | android-native-integrations | `android/templates/PAY_BRIDGE_MANIFEST_TEMPLATE.xml` | Not mapped | UNVERIFIED |
| android-native-integrations-009 | android-native-integrations | `android/templates/PayBridgeClient.java` | Not mapped | UNVERIFIED |
| android-native-integrations-010 | android-native-integrations | `android/templates/PayBridgeProtocol.java` | Not mapped | UNVERIFIED |
| android-native-integrations-011 | android-native-integrations | `android/templates/RecoveryFirebaseAuthFactory.kt` | Not mapped | UNVERIFIED |
| android-native-integrations-012 | android-native-integrations | `android/templates/UPINotificationListener.java` | Not mapped | UNVERIFIED |
| android-device-security-013 | android-device-security | `android/templates/security/AppLockManager.kt` | `payment-backend/test/security-contract.test.mjs`<br>`tests/native-security-generation.test.mjs`<br>`tests/native-security-template.test.mjs` | UNVERIFIED |
| android-device-security-014 | android-device-security | `android/templates/security/AureliaAppManager.kt` | `payment-backend/test/security-contract.test.mjs`<br>`tests/native-security-generation.test.mjs`<br>`tests/native-security-template.test.mjs` | UNVERIFIED |
| android-device-security-015 | android-device-security | `android/templates/security/AureliaCryptoEngine.kt` | `payment-backend/test/security-contract.test.mjs`<br>`tests/native-security-generation.test.mjs`<br>`tests/native-security-template.test.mjs` | UNVERIFIED |
| android-device-security-016 | android-device-security | `android/templates/security/AureliaEnvelopeStore.kt` | `payment-backend/test/security-contract.test.mjs`<br>`tests/native-security-generation.test.mjs`<br>`tests/native-security-template.test.mjs` | UNVERIFIED |
| android-device-security-017 | android-device-security | `android/templates/security/AureliaSecurityRuntime.kt` | `payment-backend/test/security-contract.test.mjs`<br>`tests/native-security-generation.test.mjs`<br>`tests/native-security-template.test.mjs` | UNVERIFIED |
| android-device-security-018 | android-device-security | `android/templates/security/BiometricVaultManager.kt` | `payment-backend/test/security-contract.test.mjs`<br>`tests/native-security-generation.test.mjs`<br>`tests/native-security-template.test.mjs` | UNVERIFIED |
| android-device-security-019 | android-device-security | `android/templates/security/LockGateActivity.kt` | `payment-backend/test/security-contract.test.mjs`<br>`tests/native-security-generation.test.mjs`<br>`tests/native-security-template.test.mjs` | UNVERIFIED |
| android-device-security-020 | android-device-security | `android/templates/security/PaymentDeviceClient.kt` | `payment-backend/test/security-contract.test.mjs`<br>`tests/native-security-generation.test.mjs`<br>`tests/native-security-template.test.mjs` | UNVERIFIED |
| android-device-security-021 | android-device-security | `android/templates/security/PaymentDeviceKeyStore.kt` | `payment-backend/test/security-contract.test.mjs`<br>`tests/native-security-generation.test.mjs`<br>`tests/native-security-template.test.mjs` | UNVERIFIED |
| android-device-security-022 | android-device-security | `android/templates/security/SettlementEnvelopeVerifier.kt` | `payment-backend/test/security-contract.test.mjs`<br>`tests/native-security-generation.test.mjs`<br>`tests/native-security-template.test.mjs` | UNVERIFIED |
| legacy-ui-and-pms-entrypoint-023 | legacy-ui-and-pms-entrypoint | `index.html` | `tests/index-startup.test.mjs`<br>`tests/indexeddb-payment-intent-store.test.mjs`<br>`tests/indexeddb-pms-repository.test.mjs`<br>`tests/storage/indexeddb-pms-repository.test.mjs` | UNVERIFIED |
| device-attestation-024 | device-attestation | `payment-backend/attestation-verifier/src/main/kotlin/com/aurelia/attestation/Main.kt` | `tests/pms-domain-cutover.test.mjs` | UNVERIFIED |
| optional-payment-backend-025 | optional-payment-backend | `payment-backend/src/devices/firestore-device-service.mjs` | Not mapped | UNVERIFIED |
| optional-payment-backend-026 | optional-payment-backend | `payment-backend/src/http/async-route-errors.mjs` | `payment-backend/test/async-route-errors.test.mjs` | UNVERIFIED |
| optional-payment-backend-027 | optional-payment-backend | `payment-backend/src/http/graceful-shutdown.mjs` | `payment-backend/test/graceful-shutdown.test.mjs` | UNVERIFIED |
| optional-payment-backend-028 | optional-payment-backend | `payment-backend/src/http/payment-route-errors.mjs` | `payment-backend/test/payment-route-errors.test.mjs` | UNVERIFIED |
| optional-payment-backend-029 | optional-payment-backend | `payment-backend/src/http/public-http-error.mjs` | `payment-backend/test/public-http-error.test.mjs` | UNVERIFIED |
| optional-payment-backend-030 | optional-payment-backend | `payment-backend/src/http/readiness-probe.mjs` | `payment-backend/test/readiness-probe.test.mjs` | UNVERIFIED |
| optional-payment-backend-031 | optional-payment-backend | `payment-backend/src/http/server-timeouts.mjs` | `payment-backend/test/server-timeouts.test.mjs` | UNVERIFIED |
| optional-payment-backend-032 | optional-payment-backend | `payment-backend/src/intents/firestore-repository.mjs` | `payment-backend/test/firestore-repository.test.mjs` | UNVERIFIED |
| optional-payment-backend-033 | optional-payment-backend | `payment-backend/src/intents/folio-settlement.mjs` | Not mapped | UNVERIFIED |
| optional-payment-backend-034 | optional-payment-backend | `payment-backend/src/intents/intent-state-machine.mjs` | `payment-backend/test/intent-state-machine.test.mjs` | UNVERIFIED |
| optional-payment-backend-035 | optional-payment-backend | `payment-backend/src/local-server.mjs` | `payment-backend/test/local-server-contract.test.mjs` | UNVERIFIED |
| optional-payment-backend-036 | optional-payment-backend | `payment-backend/src/payment-controls/active-provider-selection.mjs` | `payment-backend/test/active-provider-selection.test.mjs` | UNVERIFIED |
| optional-payment-backend-037 | optional-payment-backend | `payment-backend/src/payment-controls/firestore-controls.mjs` | `payment-backend/test/payment-controls.test.mjs` | UNVERIFIED |
| optional-payment-backend-038 | optional-payment-backend | `payment-backend/src/payment-domain.mjs` | Not mapped | UNVERIFIED |
| optional-payment-backend-039 | optional-payment-backend | `payment-backend/src/providers/adapter-contract.mjs` | Not mapped | UNVERIFIED |
| optional-payment-backend-040 | optional-payment-backend | `payment-backend/src/providers/cashfree.mjs` | Not mapped | UNVERIFIED |
| optional-payment-backend-041 | optional-payment-backend | `payment-backend/src/providers/ccavenue.mjs` | Not mapped | UNVERIFIED |
| optional-payment-backend-042 | optional-payment-backend | `payment-backend/src/providers/checkout-contract.mjs` | Not mapped | UNVERIFIED |
| optional-payment-backend-043 | optional-payment-backend | `payment-backend/src/providers/factory.mjs` | Not mapped | UNVERIFIED |
| optional-payment-backend-044 | optional-payment-backend | `payment-backend/src/providers/jiopay-adapter.mjs` | `payment-backend/test/jiopay-adapter.test.mjs` | UNVERIFIED |
| optional-payment-backend-045 | optional-payment-backend | `payment-backend/src/providers/merchant-scaffolds.mjs` | Not mapped | UNVERIFIED |
| optional-payment-backend-046 | optional-payment-backend | `payment-backend/src/providers/paytm-adapter.mjs` | `payment-backend/test/paytm-adapter.test.mjs` | UNVERIFIED |
| optional-payment-backend-047 | optional-payment-backend | `payment-backend/src/providers/payu-adapter.mjs` | `payment-backend/test/payu-adapter.test.mjs` | UNVERIFIED |
| optional-payment-backend-048 | optional-payment-backend | `payment-backend/src/providers/payu-crypto.mjs` | Not mapped | UNVERIFIED |
| optional-payment-backend-049 | optional-payment-backend | `payment-backend/src/providers/phonepe-adapter.mjs` | `payment-backend/test/phonepe-adapter.test.mjs` | UNVERIFIED |
| optional-payment-backend-050 | optional-payment-backend | `payment-backend/src/providers/phonepe-crypto.mjs` | Not mapped | UNVERIFIED |
| optional-payment-backend-051 | optional-payment-backend | `payment-backend/src/providers/razorpay.mjs` | Not mapped | UNVERIFIED |
| optional-payment-backend-052 | optional-payment-backend | `payment-backend/src/providers/registry.mjs` | `payment-backend/test/provider-registry.test.mjs` | UNVERIFIED |
| optional-payment-backend-053 | optional-payment-backend | `payment-backend/src/providers/unimplemented-merchant-error.mjs` | Not mapped | UNVERIFIED |
| optional-payment-backend-054 | optional-payment-backend | `payment-backend/src/qualification/provider-acceptance.mjs` | `payment-backend/test/provider-acceptance.test.mjs` | UNVERIFIED |
| optional-payment-backend-055 | optional-payment-backend | `payment-backend/src/secrets/secret-version-management.mjs` | `payment-backend/test/secret-version-management.test.mjs` | UNVERIFIED |
| optional-payment-backend-056 | optional-payment-backend | `payment-backend/src/server.mjs` | `payment-backend/test/local-server-contract.test.mjs`<br>`payment-backend/test/server-timeouts.test.mjs` | UNVERIFIED |
| optional-payment-backend-057 | optional-payment-backend | `payment-backend/src/settlement/authorization-signer.mjs` | `payment-backend/test/settlement-authorization-signer.test.mjs` | UNVERIFIED |
| optional-payment-backend-058 | optional-payment-backend | `payment-backend/src/shared/canonical.mjs` | Not mapped | UNVERIFIED |
| optional-payment-backend-059 | optional-payment-backend | `payment-backend/src/webhooks/provider-webhook-router.mjs` | Not mapped | UNVERIFIED |
| optional-payment-backend-060 | optional-payment-backend | `payment-backend/src/webhooks/provider-webhook-state.mjs` | `payment-backend/test/provider-webhook-state.test.mjs` | UNVERIFIED |
| optional-payment-backend-061 | optional-payment-backend | `payment-backend/src/workers/reconciliation-engine.mjs` | `payment-backend/test/reconciliation-engine.test.mjs` | UNVERIFIED |
| build-and-maintenance-tools-062 | build-and-maintenance-tools | `scripts/check-release-boundaries.mjs` | Not mapped | UNVERIFIED |
| build-and-maintenance-tools-063 | build-and-maintenance-tools | `scripts/check-storage-boundaries.mjs` | Not mapped | UNVERIFIED |
| build-and-maintenance-tools-064 | build-and-maintenance-tools | `scripts/diagnose-accounting.mjs` | Not mapped | UNVERIFIED |
| build-and-maintenance-tools-065 | build-and-maintenance-tools | `scripts/generate-status.mjs` | Not mapped | UNVERIFIED |
| build-and-maintenance-tools-066 | build-and-maintenance-tools | `scripts/patch-android.js` | Not mapped | UNVERIFIED |
| build-and-maintenance-tools-067 | build-and-maintenance-tools | `scripts/patch-upi-reconciliation.js` | Not mapped | UNVERIFIED |
| build-and-maintenance-tools-068 | build-and-maintenance-tools | `scripts/prepare-web.js` | Not mapped | UNVERIFIED |
| build-and-maintenance-tools-069 | build-and-maintenance-tools | `scripts/regenerate-android-safe.sh` | Not mapped | UNVERIFIED |
| booking-lifecycle-070 | booking-lifecycle | `src/bookings/cancellation-policy.mjs` | `tests/cancellation-policy.test.mjs` | UNVERIFIED |
| local-payment-and-settlement-071 | local-payment-and-settlement | `src/features/payments/reconciliation-bridge.js` | `tests/reconciliation-bridge.test.mjs` | UNVERIFIED |
| local-payment-and-settlement-072 | local-payment-and-settlement | `src/features/payments/reconciliation-panel.js` | `tests/payments.test.mjs` | UNVERIFIED |
| local-payment-and-settlement-073 | local-payment-and-settlement | `src/payments/accounting-consistency-diagnostic.mjs` | `tests/accounting-consistency-diagnostic.test.mjs` | UNVERIFIED |
| local-payment-and-settlement-074 | local-payment-and-settlement | `src/payments/backend-router.mjs` | `tests/backend-router.test.mjs` | UNVERIFIED |
| local-payment-and-settlement-075 | local-payment-and-settlement | `src/payments/canonical.mjs` | `tests/payments.test.mjs` | UNVERIFIED |
| local-payment-and-settlement-076 | local-payment-and-settlement | `src/payments/evidence-store.mjs` | `tests/evidence-store.test.mjs` | UNVERIFIED |
| local-payment-and-settlement-077 | local-payment-and-settlement | `src/payments/indexeddb-payment-intent-store.mjs` | `tests/indexeddb-payment-intent-store.test.mjs` | UNVERIFIED |
| local-payment-and-settlement-078 | local-payment-and-settlement | `src/payments/parsers/axis.mjs` | `tests/payments.test.mjs` | UNVERIFIED |
| local-payment-and-settlement-079 | local-payment-and-settlement | `src/payments/parsers/bob.mjs` | `tests/payments.test.mjs` | UNVERIFIED |
| local-payment-and-settlement-080 | local-payment-and-settlement | `src/payments/parsers/common.mjs` | `tests/payments.test.mjs` | UNVERIFIED |
| local-payment-and-settlement-081 | local-payment-and-settlement | `src/payments/parsers/hdfc.mjs` | `tests/payments.test.mjs` | UNVERIFIED |
| local-payment-and-settlement-082 | local-payment-and-settlement | `src/payments/parsers/icici.mjs` | `tests/payments.test.mjs` | UNVERIFIED |
| local-payment-and-settlement-083 | local-payment-and-settlement | `src/payments/parsers/kotak.mjs` | `tests/payments.test.mjs` | UNVERIFIED |
| local-payment-and-settlement-084 | local-payment-and-settlement | `src/payments/parsers/sbi.mjs` | `tests/payments.test.mjs` | UNVERIFIED |
| local-payment-and-settlement-085 | local-payment-and-settlement | `src/payments/parsers/uco.mjs` | `tests/payments.test.mjs` | UNVERIFIED |
| local-payment-and-settlement-086 | local-payment-and-settlement | `src/payments/pay-bridge-orchestrator.mjs` | `tests/pay-bridge-orchestrator.test.mjs` | UNVERIFIED |
| local-payment-and-settlement-087 | local-payment-and-settlement | `src/payments/payment-device-bridge.mjs` | `tests/payments.test.mjs` | UNVERIFIED |
| local-payment-and-settlement-088 | local-payment-and-settlement | `src/payments/payment-engine.mjs` | `tests/payments.test.mjs` | UNVERIFIED |
| local-payment-and-settlement-089 | local-payment-and-settlement | `src/payments/payment-safety-gate.mjs` | `tests/payment-safety-gate.test.mjs` | UNVERIFIED |
| local-payment-and-settlement-090 | local-payment-and-settlement | `src/payments/provider-platform.mjs` | `tests/provider-platform.test.mjs` | UNVERIFIED |
| local-payment-and-settlement-091 | local-payment-and-settlement | `src/payments/reconciliation-service.mjs` | `tests/reconciliation-service.test.mjs` | UNVERIFIED |
| local-payment-and-settlement-092 | local-payment-and-settlement | `src/payments/repository-settlement-service.mjs` | `tests/repository-settlement-service.test.mjs` | UNVERIFIED |
| local-payment-and-settlement-093 | local-payment-and-settlement | `src/payments/settlement-apply.mjs` | `tests/settlement-apply.test.mjs` | UNVERIFIED |
| local-payment-and-settlement-094 | local-payment-and-settlement | `src/payments/settlement-authorization.mjs` | `payment-backend/test/settlement-authorization-signer.test.mjs` | UNVERIFIED |
| local-payment-and-settlement-095 | local-payment-and-settlement | `src/payments/settlement-gate.mjs` | `tests/payments.test.mjs` | UNVERIFIED |
| local-payment-and-settlement-096 | local-payment-and-settlement | `src/payments/settlement-journal.mjs` | `tests/settlement-journal.test.mjs` | UNVERIFIED |
| local-payment-and-settlement-097 | local-payment-and-settlement | `src/payments/settlement-projector.mjs` | `tests/settlement-projector.test.mjs` | UNVERIFIED |
| local-payment-and-settlement-098 | local-payment-and-settlement | `src/payments/settlement-service.mjs` | `tests/repository-settlement-service.test.mjs`<br>`tests/settlement-service.test.mjs` | UNVERIFIED |
| local-payment-and-settlement-099 | local-payment-and-settlement | `src/payments/settlement-trust.mjs` | `tests/payments.test.mjs` | UNVERIFIED |
| local-payment-and-settlement-100 | local-payment-and-settlement | `src/payments/smart-checkpoint.mjs` | `tests/smart-checkpoint.test.mjs` | UNVERIFIED |
| application-services-101 | application-services | `src/services/payment-api.mjs` | `tests/services/payment-api.test.mjs` | UNVERIFIED |
| local-first-storage-102 | local-first-storage | `src/storage/capacitor-pms-storage.mjs` | `tests/capacitor-pms-storage.test.mjs` | UNVERIFIED |
| local-first-storage-103 | local-first-storage | `src/storage/indexeddb-evidence-store.mjs` | `tests/capacitor-pms-storage.test.mjs`<br>`tests/storage-boundaries.test.mjs`<br>`tests/storage-errors.test.mjs`<br>`tests/storage-write-failure.test.mjs`<br>`tests/storage/indexeddb-pms-repository.test.mjs` | UNVERIFIED |
| local-first-storage-104 | local-first-storage | `src/storage/indexeddb-payment-intent-store.mjs` | `tests/indexeddb-payment-intent-store.test.mjs` | UNVERIFIED |
| local-first-storage-105 | local-first-storage | `src/storage/indexeddb-pms-repository.mjs` | `tests/indexeddb-pms-repository.test.mjs`<br>`tests/storage/indexeddb-pms-repository.test.mjs` | UNVERIFIED |
| local-first-storage-106 | local-first-storage | `src/storage/indexeddb-settlement-journal.mjs` | `tests/capacitor-pms-storage.test.mjs`<br>`tests/storage-boundaries.test.mjs`<br>`tests/storage-errors.test.mjs`<br>`tests/storage-write-failure.test.mjs`<br>`tests/storage/indexeddb-pms-repository.test.mjs` | UNVERIFIED |
| local-first-storage-107 | local-first-storage | `src/storage/pms-bootstrap-coordinator.mjs` | `tests/pms-bootstrap-coordinator.test.mjs` | UNVERIFIED |
| local-first-storage-108 | local-first-storage | `src/storage/pms-domain-cutover.mjs` | `tests/pms-domain-cutover.test.mjs` | UNVERIFIED |
| local-first-storage-109 | local-first-storage | `src/storage/pms-expense-repository.mjs` | `tests/pms-expense-repository.test.mjs` | UNVERIFIED |
| local-first-storage-110 | local-first-storage | `src/storage/pms-inventory-repository.mjs` | `tests/pms-inventory-repository.test.mjs` | UNVERIFIED |
| local-first-storage-111 | local-first-storage | `src/storage/pms-legacy-compatibility-cache.mjs` | `tests/capacitor-pms-storage.test.mjs`<br>`tests/storage-boundaries.test.mjs`<br>`tests/storage-errors.test.mjs`<br>`tests/storage-write-failure.test.mjs`<br>`tests/storage/indexeddb-pms-repository.test.mjs` | UNVERIFIED |
| local-first-storage-112 | local-first-storage | `src/storage/pms-local-first-write-coordinator.mjs` | `tests/pms-local-first-write-coordinator.test.mjs` | UNVERIFIED |
| local-first-storage-113 | local-first-storage | `src/storage/pms-local-identity.mjs` | `tests/pms-local-identity.test.mjs` | UNVERIFIED |
| local-first-storage-114 | local-first-storage | `src/storage/pms-operational-feedback.mjs` | `tests/pms-operational-feedback.test.mjs` | UNVERIFIED |
| local-first-storage-115 | local-first-storage | `src/storage/pms-repository-bridge.mjs` | `tests/pms-repository-bridge.test.mjs` | UNVERIFIED |
| local-first-storage-116 | local-first-storage | `src/storage/pms-repository-contract.mjs` | `tests/capacitor-pms-storage.test.mjs`<br>`tests/storage-boundaries.test.mjs`<br>`tests/storage-errors.test.mjs`<br>`tests/storage-write-failure.test.mjs`<br>`tests/storage/indexeddb-pms-repository.test.mjs` | UNVERIFIED |
| local-first-storage-117 | local-first-storage | `src/storage/pms-restaurant-sale-repository.mjs` | `tests/pms-restaurant-sale-repository.test.mjs` | UNVERIFIED |
| local-first-storage-118 | local-first-storage | `src/storage/pms-restaurant-table-repository.mjs` | `tests/pms-restaurant-table-repository.test.mjs` | UNVERIFIED |
| local-first-storage-119 | local-first-storage | `src/storage/pms-room-read-cutover.mjs` | `tests/pms-room-read-cutover.test.mjs` | UNVERIFIED |
| local-first-storage-120 | local-first-storage | `src/storage/pms-settings-repository.mjs` | `tests/pms-settings-repository.test.mjs` | UNVERIFIED |
| local-first-storage-121 | local-first-storage | `src/storage/repository-operational-mutation-service.mjs` | `tests/repository-operational-mutation-service.test.mjs` | UNVERIFIED |
| local-first-storage-122 | local-first-storage | `src/storage/repository-reservation-service.mjs` | `tests/repository-reservation-service.test.mjs` | UNVERIFIED |
| local-first-storage-123 | local-first-storage | `src/storage/room-inventory-service.mjs` | `tests/room-inventory-service.test.mjs` | UNVERIFIED |
| local-first-storage-124 | local-first-storage | `src/storage/storage-errors.mjs` | `tests/storage-errors.test.mjs` | UNVERIFIED |
| optional-cloud-sync-125 | optional-cloud-sync | `src/sync/local-sync-coordinator.mjs` | `tests/sync/local-sync-coordinator.test.mjs` | UNVERIFIED |

## Full repository file manifest

The complete path-to-Git-blob-SHA inventory (including tests, workflows, documentation, configuration and assets) is in [`feature-registry.json`](../feature-registry.json). It is the baseline for later lock/hash reconciliation.

## Protected controls

No production file was modified to create this registry. Release and operational flags remain unchanged and must remain disabled as specified above. Before any future shared storage, build, dependency or UI change, enumerate all verified/locked consumers and run their suites. A failure attributable to a locked file is a stop condition pending owner approval.
