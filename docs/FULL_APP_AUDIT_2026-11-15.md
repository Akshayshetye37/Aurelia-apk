# Aurelia APK — full repository audit (2026-11-15)

## Audit identity and scope

- Repository: `Akshayshetye37/Aurelia-apk`
- Audited ref: `work/phase-0-feature-registry`
- Exact audited SHA: `403900581b62e3b94c5a714bb1fe2400d9c8afc3`
- PR: [#35 — feature registry and immutable lock guard](https://github.com/Akshayshetye37/Aurelia-apk/pull/35)
- Base feature branch SHA: `3fc72fd6b6f69e59c8cbc7441c04624acc455723`
- Audit type: repository-wide static architecture, source/API, test-layout, CI/release and documentation consistency review.
- No production source, release flag, workflow or runtime behaviour was changed during this audit.

This is a source audit, not a production qualification. It does not prove Android device behaviour, merchant UAT, accounting correctness on live PMS data, or production deployment.

## Repository inventory

The recursive Git tree is complete (not truncated) and contains 298 tracked blobs on the audited SHA:

| Area | Files |
|---|---:|
| Main app UI/runtime (`index.html`) | 1 |
| Client modules (`src/`) | 56 |
| Payment backend source/config/docs/tests | 87 |
| Android native templates | 22 |
| Root PMS tests | 61 |
| Nested PMS tests | 3 |
| Payment backend tests | 29 |
| Project docs | 39 |
| GitHub workflows | 8 |
| Scripts | 9 |
| Other config/assets | remaining files |

There are 93 test files in the audited tree: 61 root PMS tests, 3 nested PMS tests, and 29 payment-backend tests.

### Test execution boundary

- Root `npm test` is `node --test tests/*.test.mjs`; this glob selects the 61 root-level test files, not the 3 nested files and not the 29 payment-backend tests.
- Payment backend tests run only through `npm --prefix payment-backend test` in the separate payment-backend workflow.
- The current candidate SHA has four successful PR-associated runs: Feature lock integrity, PMS source/web packaging, R1 local-first checks, and settlement foundation.
- The current candidate has **no payment-backend CI run** in its PR-associated run set. Backend source, adapter, webhook, Firestore, Terraform and container checks are therefore not qualified by those four runs.
- Root and backend package manifests do not have checked-in lockfiles. Workflows use `npm install`, so dependency resolution is not locked to a committed npm dependency graph.

## Executive verdict

**The application is a substantial, partially implemented local-first PMS with a separate optional payment-backend foundation. It is not release-ready.** The source tree contains broad booking, room, guest, folio, restaurant/POS, inventory, expense, reporting, import/export, backup, identity, payment, reconciliation, security and sync code. The remaining blockers are not merely missing screens: they include canonical data authority, accounting invariants, complete transaction boundaries, native Android integration/qualification, recovery, trusted Pay Bridge, provider UAT, and release governance.

The existing feature registry is deliberately conservative: 125 implementation entries, 0 VERIFIED, 0 LOCKED, 125 UNVERIFIED. Of those 125 entries, 90 have candidate test-path associations and 35 have no candidate test mapped. The associations are heuristic, not evidence of coverage. The registry references 92 baseline test files; the audited candidate tree has 93 after the new feature-lock test was added.

## Feature-by-feature audit

| Feature / subsystem | Source present | Current classification | Main remaining acceptance gap |
|---|---|---|---|
| App shell, navigation, dashboards and settings | `index.html` | PARTIAL | Large monolithic UI/runtime still owns an in-memory state model; canonical UI cutover remains OFF. |
| Reservations and booking lifecycle | UI + `src/bookings`, repository services | PARTIAL | Full create/edit/modify/cancel/check-in/check-out transaction coverage, concurrency and restart recovery are not proven for every path. |
| Rooms, room status and maintenance blocks | UI + room repository/services | PARTIAL | Full canonical read/write cutover, stable identifiers, overlap/maintenance rules and physical-device persistence are not complete. |
| Guest profiles, identity documents and guest links | UI + repository helpers + OCR/ID helpers | PARTIAL | Complete canonical guest/booking relationships, privacy/security review, and all mutation/read paths are not qualified. |
| Folios, charges, payments, invoices and receipts | UI + payment/settlement modules | BLOCKED | Multiple legacy paid representations remain; no owner-approved canonical append-only local journal or real-data reconciliation sign-off. |
| Manual cash/card/UPI recording | Client UI and local settlement foundations | PARTIAL | Local manual path exists, but financial source-of-truth and every write/read-back invariant are not accepted. |
| Restaurant, tables, POS and room charges | UI + restaurant repositories/services | PARTIAL | Atomic foundations exist; complete sale/stock/folio/report projection and reversal/reconciliation coverage remain open. |
| Inventory and stock movements | UI + inventory repository | PARTIAL | Transaction foundations exist; all stock/report projections, movement reconciliation and fault-injection acceptance remain open. |
| Expenses | UI + expense repository | PARTIAL | Canonical create/update foundation exists; void policy, report projections and full mutation coverage remain open. |
| Accounting reports, balance sheet and exports | UI/report functions + diagnostic | BLOCKED | Reports still consume mixed projections; diagnostic has not been run on an owner-authorized redacted backup; mapping not signed off. |
| Import/export (JSON/XLSX/guest/invoice) | UI helpers and tests | PARTIAL | Complete rollback, duplicate handling, all-domain import validation and export/restore checksums need qualification. |
| Backup and restore | UI backup vault, encryption/checksum helpers, docs | PARTIAL | Real Android native database + attachment backup/restore, interrupted restore, clean-profile checksums and physical-device drills are not qualified. |
| Photos and attachments | Native/IndexedDB helpers | PARTIAL | Durable attachment-store path and removal of success-reporting memory fallback are not fully accepted. |
| Local identity, PIN and app lock | Kotlin templates + UI/runtime | PARTIAL | Native templates exist; generated APK compilation, launch-gate integration and hardware-backed behaviour are not qualified. |
| Biometric unlock and DEK wrapping | Kotlin biometric/crypto templates | PARTIAL / BLOCKED | Biometric key wrapper exists, but biometric DEK wrapping is not integrated into the launch gate; complete one-DEK envelope lifecycle is not proven. |
| Forgotten-PIN/recovery-key/Firebase OTP recovery | Kotlin templates/docs | MISSING / BLOCKED | Recovery UI explicitly has an unavailable path; recovery-key provisioning and full owner-authorized recovery workflow are not implemented/qualified. OTP must remain separate from DEK access. |
| Bank SMS/UPI evidence parsing | Seven bank parser modules + notification template | PARTIAL | Parser presence does not prove a complete supported ingestion, authentication, deduplication and reconciliation lifecycle. |
| Local payment reconciliation | Client parser, matching and reconciliation modules | PARTIAL | End-to-end real statement import, owner review, exact accounting mapping and ledger reconciliation are not accepted. |
| Optional payment backend | Express/Firestore services, intents, controls, webhook and reconciliation modules | PARTIAL | Current candidate has no backend CI run; production deployment, tenant isolation, durable worker recovery and local-ledger binding are not proven. |
| Provider adapters | Razorpay, Cashfree, PayU, PhonePe, Paytm, JioPay and CCAvenue source | PARTIAL | Adapter source is not merchant acceptance. No provider has independently signed merchant sandbox UAT/live eligibility. CCAvenue has limited refund/status capability. |
| Refunds and reversals | Adapter and settlement foundations | BLOCKED | Full/partial refund domain, cumulative limits, provider-confirmed status, exactly-once local reversal and recovery are not accepted. |
| Pay Bridge | PMS-side Java client/protocol templates and docs | MISSING as a complete product | Companion app source is not in this repository; current client is primarily connection/handshake, not a complete payment/refund IPC product. |
| Optional cloud sync | One local sync coordinator + docs | DEFERRED / OFF | Not required for local PMS; remains OFF and must not become a dependency for ordinary operations. |
| Cloud payment infrastructure | Cloud Run, Firestore, Secret Manager, Terraform source | PARTIAL | Source/config foundations exist; deployed project, IAM/rules/indexes, webhook ingress, scheduled recovery, monitoring and DR evidence are absent. |
| Android build and release | Capacitor config, 22 native templates, patch script and workflow | BLOCKED | No generated Android project/Gradle wrapper is tracked; APK workflow job is explicitly disabled with `if: ${{ false }}`; no current APK build/sign/device qualification. |
| Feature protection and governance | Registry, hash checker, workflow | PARTIAL | Empty lock manifest; no feature is verified/locked; checker does not yet prove immutable tag targets; CODEOWNERS and branch protection are absent/admin-blocked. |

## Function and entry-point inventory

### Main UI/runtime

Static extraction from `index.html` (5,785 lines; approximately 582 KB) found:

- 345 function-definition candidates.
- 311 distinct function names.
- 28 names are defined more than once (including `folio`, `settle`, `pay`, `completeCheckIn`, `completeCheckOut`, `inv`, `shr`, `chg`, `resv`, `cin`, `dishNew`, `sv`, and `commit`).

The duplicate names may represent layered/legacy implementations or overrides; they are not automatically defects. They are a material collision and maintainability risk until script-scope, definition order, active call sites and runtime behaviour are reconciled.

The distinct UI function names extracted are:

```text
guestContactActions, canLS, $, fmtStayTimes, defCheckInTime, defCheckOutTime,
defCheckInHour, defCheckOutHour, syncRoomTypes, inh, nav, go, render, kpi, chart,
motes, avail, resv, mk, cin, completeCheckIn, folio, out, addI, toRoom,
selectDiningGuest, saveDiningGuestPhone, confirmDiningRoomCharge, chg, settle,
wrap, cal, pay, addC, outB, completeCheckOut, inv, shr, rs, tg, pv, sv, gopen,
gread, gadd, gsheet, gsave, invOp, invGo, invNew, invSaveNew, expNew, expAdd,
expVoid, cp, hc, demoRm, day0, photoStorageSandboxed, photoNative, photoDb,
photoPut, photoGet, photoArchive, photoRestore, openOriginalPhoto, shrink, ask,
syncT, free, brand, settlePayment, persistSettlement, payForm, dcApply, waS,
addSig, sigM, sigReject, sigReopen, sigA, band, flow, newDraft, dopen, rdD,
dsheet, f, ty, im, dsave, cxl, rform, roomNew, roomSave, roomS, rdel, dishNew,
dishAdd, mdel, settleGo, gdel, invDel, expDel, br, sw, saveRazorpaySettings,
testRazorpayConnection, disableRazorpay, setImg, demoGo, confirmResetAll,
resetAll, curHash, photoKeysIn, validatePhotoArchive, sha256Hex, cloneSnapshot,
cloneLiveSnapshot, backupB64, backupUnB64, backupVaultDb, readBackupVaultFallback,
readBackupVault, writeBackupVault, backupPasswordKey, setupBackupRecoveryPassword,
rotateBackupRecoveryPassword, decryptBackupEnvelope, decryptBackupPayload,
encryptBackupPayload, hasBackupVault, createBackupSnapshot, pruneBrowserBackups,
runBackup, bkDone, toggleLocalAutoBackup, clearBackupFolder, saveBackupServer,
restoreFromBackupServer, testBackupServer, clearBackupServer, autoBackup, pickDir,
requestNextAutomaticRecovery, restoreF, normaliseImportedBooking, restoreGo,
persist, save, persistStrict, persistCanonicalStrict, commit, cloneRuntimeState,
withLocalOperationalLock, execute, commitStayMutation, commitRoomStatusMutation,
commitRoomCatalogState, createStableGuestId, commitGuestCatalogState,
commitInventoryCatalogState, commitExpenseCatalogState, commitRestaurantFolioState,
commitRestaurantSettlementState, loadAll, openGlobalSearch, renderGuestHits, auto,
restCur, tableMeta, saveTableMeta, tableRoomBooking, tableRoomGuestDetails,
fillTableGuestFromRoom, cleanTableOrders, sellStockItem, openRestaurantReceipt,
downloadBillPng, shareInvoiceImage, setRestaurantLogo, saveRestaurantSettings,
setRestaurantImage, resizeForOcr, fileBase64, loadScript, dsaveProfileOnly,
resvForGuest, guestBookingExport, exportGuestBundleJson, safeFile, downloadBlob,
exportGuestBooking, printGuestPreview, detectIndianIdType, aadhaarVerhoeffValid,
passportMrzCheckDigitValid, parseIdOcrText, ocrUploadedId, upiIntentUri,
dynamicUpiQr, importXlsxFile, run, get, timeVal, commitXlsxImport, book, ensure,
bookingApiCfg, bookingPublicView, listBookingsForApi, getBookingForApi,
pushBookingsToRemote, openBookingApiPreview, copyBookingApiJson, fallbackCopy,
enhanceBookingApiSettings, patchSv, boot, uploadedQrWithDynamicBalance, occLabel,
exportBalanceSheet, fixDiningNumbers, cleanDiningModel, diningAddCategory,
saveDiningCategory, diningRenameCategory, saveDiningRename, diningRemoveCategory,
diningAddTable, saveDiningTable, diningEditTable, saveDiningTableEdit,
removeDiningTable, exportInvoicePng, waInvoicePng, saveMenuState,
uploadedHotelQrHtml, finVal, finField, financialStatementsPanel,
saveFinancialInputs, exportHotelFinancialStatements, selectFolioPaymentMethod,
renameSelectedDiningCategory, pmsFinanceMoney, pmsFinanceControlHtml,
normalizeDiningCategoriesFinal, selectPaymentMethod, hotelQrBlock,
normalizeDiningBeforeRender, removePaymentQrMarkup, renderSinglePaymentQr,
selectDiningCategory, diningCategoryChips, diningQuantityControls, changeDiningQty,
removeDiningOrderItem, repairMenu, getValidCategories, repairDiningMenuState,
renderCategoryChips, renderCategoryOptions, cleanGuestName, restaurantUPI,
exactUPIBox, guestPhoneFor, guestCallAction, guestWhatsAppAction, selectRestPay,
recordRestPay, loadAureliaCheckoutScript, restaurantFolioPanels,
cancellationPaidAmount, cancellationJournal, caDateValue, caInPeriod, caReportRows,
docs, providerNames, bridgeStatus, bridgeConnected, liveCollectionControlHtml,
platformHtml, providerConfigPanelHtml, localPaymentLedgerCall, emit, setState,
loadSdk, validConfig, configure, finish, initFromWindow, waitForReady,
getIdTokenAsync, solveMfa, signIn, reauthenticate, signOut, fail, persistAdapter,
cloudPaymentApi, mapCloudPaymentStatus, nextFrame, copyComputedStyles,
inlineSafeImages, renderInvoicePng, nativePrintFallback, exportInvoicePngV2,
openWhatsAppExternally, replayApplicationScripts
```

This is a lexical inventory of named function declarations and selected arrow-function assignments, not a complete call graph. Class methods in Java/Kotlin/JavaScript modules, anonymous callbacks, inline HTML handlers, and dynamically loaded scripts need a separate AST/call-site inventory. The 125-file registry remains the source-level module inventory.

### Client and backend module entry points

The audited module tree includes these major API families:

- **Storage/repository:** `PmsRepository`, `IndexedDbPmsRepository`, `CapacitorPmsStorageClient`, `PmsBootstrapCoordinator`, `PmsRepositoryBridge`, `PmsLocalFirstWriteCoordinator`, domain repositories for expenses/inventory/settings/restaurant tables/sales, reservation and operational mutation services, room/guest/booking hydration and storage error normalization.
- **Client payments:** payment intent engine and candidate scoring, bank SMS parsers, reconciliation service, payment provider platform/config validation, Pay Bridge orchestrator/client, payment safety gates, settlement authorization/verifier, settlement apply/recovery, journal/projector/service and smart checkpoint.
- **Backend domain and persistence:** payment domain/state transitions, Firestore payment repository, payment intent state machine, folio settlement helper, device enrollment/attestation/lease/acknowledgement, payment control defaults and provider activation.
- **Backend providers:** adapter contract/factory/registry; Razorpay, Cashfree, PayU, PhonePe, Paytm, JioPay and CCAvenue adapters; provider-specific cryptographic helpers and acceptance evaluator.
- **Backend trust/operations:** webhook router/replay-integrity helpers, durable reconciliation worker, settlement signer, secret-version management, HTTP error/readiness/timeout/shutdown utilities, Terraform and container deployment configuration.
- **Android templates:** native SQLite repository and outbox transactions, local payment ledger, notification evidence queue, Firebase phone identity, Pay Bridge client/protocol, app lock, PIN envelope/crypto engine, biometric vault, device key attestation, payment device client and signed settlement-envelope verifier.

## High-priority findings

1. **Canonical database cutover is not complete.** `uiCutover=false`; the legacy `aurelia_lodge_v2` snapshot and large in-memory UI state remain in `index.html`. Repository foundations are not equivalent to all-screen canonical authority.
2. **Accounting is not a single source of truth.** Legacy `booking.p`, `booking.pays[]`, `booking.payments[]`, cancellation journals and daily totals coexist. The real-data diagnostic and accounting-owner mapping/sign-off are outstanding.
3. **Atomicity is incomplete across all business operations.** Several repository transactions exist, but every checkout/POS/stock/payment/refund path, outbox write and post-commit invariant has not been proven under failure injection.
4. **Android is not build-qualified.** The repository tracks 22 native templates, not a generated Android project. The APK workflow's job is disabled. Source tests cannot substitute for Kotlin/Java compile, instrumentation or physical-device qualification.
5. **Recovery and DEK lifecycle are incomplete.** PIN and envelope primitives exist, but biometric wrapping is not integrated into the launch gate; forgotten-PIN/recovery-key provisioning is not complete. OTP must never access or replace the DEK.
6. **Pay Bridge is not a complete companion product here.** PMS-side client/protocol templates exist; the separate companion source repository is absent. Handshake code is not payment/refund IPC.
7. **Provider code is not provider acceptance.** Adapter classes and synthetic contract tests do not prove merchant sandbox transactions. No provider has merchant UAT or live authorization. CCAvenue ordinary refund/status capability remains limited.
8. **Backend qualification is absent on this candidate.** The current candidate's four successful PR-associated workflows do not include payment-backend CI. The backend workflow must run separately on an exact candidate SHA before backend status can be promoted.
9. **Test command coverage is incomplete by default.** Root `npm test` omits three nested test files and all 29 backend tests; the latter require the separate workflow.
10. **Dependency reproducibility is weak.** No root or backend npm lockfile is tracked; CI uses `npm install`.
11. **Documentation is inconsistent/stale.** `STATUS.md` names old candidate SHA `6540efb109d62c74ccdf85f361569335fb30ea63`, not the audited SHA. `PAYMENT_PROVIDER_ONBOARDING.md` says several adapters are not implemented, while `PROVIDER_INTEGRATION_STATUS.md` and source show adapters exist; the correct distinction is code present versus merchant-accepted/production-eligible.
12. **Function ownership/collision risk exists in the monolithic UI.** There are 28 repeated function names in `index.html`; active definitions and call sites need to be mapped before refactoring or locking behaviour.
13. **Feature lock governance is incomplete.** The lock manifest is empty; no feature is VERIFIED/LOCKED; the current checker validates file hashes but does not yet prove immutable tag target identity. CODEOWNERS and enforced branch protection are not present.
14. **External dependencies remain real blockers.** Redacted owner backup and accounting sign-off, Pay Bridge repo, provider sandbox credentials, deployed staging hostname/certificate, physical devices/test SIM, release signing owner and GitHub admin controls cannot be invented from source.

## CI evidence on the audited SHA

The following four PR-associated workflows completed successfully on exact SHA `403900581b62e3b94c5a714bb1fe2400d9c8afc3`:

- [Feature lock integrity run 43627835834](https://github.com/Akshayshetye37/Aurelia-apk/actions/runs/43627835834) — 5 tests passed, 0 failed, 0 skipped.
- [PMS source tests and production web packaging run 43627835845](https://github.com/Akshayshetye37/Aurelia-apk/actions/runs/43627835845) — 516 tests passed, 0 failed, 0 skipped; storage and production-asset privacy checks passed; web bundle packaged.
- [R1 local-first checks run 43627835887](https://github.com/Akshayshetye37/Aurelia-apk/actions/runs/43627835887) — completed success.
- [Settlement foundation run 43627835855](https://github.com/Akshayshetye37/Aurelia-apk/actions/runs/43627835855) — completed success.

These runs do not qualify payment-backend tests, Android APK compilation/signing, physical devices, accounting migration, provider UAT, cloud deployment or production release.

## Release controls observed

Keep all of the following OFF:
- `RECOVERY_ENABLED=false`
- live payment collection
- automatic settlement and automatic refund posting
- cloud sync
- `uiCutover=false`
- release publishing

The repository's Android build workflow has a job-level `if: ${{ false }}` guard. Do not remove that guard or trigger release builds until the acceptance gates and owner approvals are complete.

## Audit conclusion and next implementation order

This audit found no basis to declare the full application complete. The correct sequence remains:

1. Finish function/call-site and data-path inventory; resolve duplicate UI definitions without changing behaviour.
2. Complete canonical local database authority and all-domain read/write cutover.
3. Reconcile accounting using an owner-authorized redacted backup; obtain written mapping approval before changing financial data.
4. Complete transaction/idempotency/ledger invariants and fault-injection coverage.
5. Qualify Android native SQLite, backup/restore, PIN/DEK/recovery and biometric flows on generated builds and physical devices.
6. Obtain and audit Pay Bridge source; finish trusted IPC and local settlement.
7. Run backend CI on the exact candidate SHA; complete provider sandbox UAT and refund/reconciliation evidence.
8. Deploy optional cloud payment infrastructure only when required and with real staging hostname, IAM, secrets and security probes.
9. Add tag-target verification, CODEOWNERS and admin-enforced branch protection; then freeze one candidate SHA for full release qualification.

**Acceptance rule:** a feature is not complete because a screen, source file, mock, template or unit test exists. It is complete only when its defined behaviour is implemented, its negative and failure paths are tested, its consumers are regression-tested, and exact-SHA evidence plus required real-world sign-off exists.
