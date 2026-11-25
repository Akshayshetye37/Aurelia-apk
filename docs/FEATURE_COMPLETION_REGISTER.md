# Aurelia APK — branch and feature consolidation register

**Audit snapshot:** 26 November 2026  
**Base branch:** `main` at `0f967b48323cd1f9ed967b24d083b9ae694cda1b`  
**Development branch:** `work/feature-completion`  
**APK policy:** No APK build, signing, or release until the owner explicitly approves it.

## Repository state observed

- 84 branches were returned by the GitHub branch API, including `main`.
- Prefix counts: `work/*` 18, `fix/*` 15, `feature/*` 12, `backup/*` 8, `dependabot/*` 8, `docs/*` 5, `security/*` 3, `integration/*` 3, `test/*` 3, `hardening/*` 2, `review/*` 2, and 5 root/release/verify branches.
- 63 pull requests were returned in the repository's pull-request listing.
- GitHub reports `protected: false` for `main`; the rulesets endpoint returned an empty list. The connected GitHub integration cannot read the branch-protection endpoint (403), so the branch object's protection flag is the available evidence.
- `main` explicitly documents the production payment boundary as Aurelia UPI only. Historical provider/gateway branches are not candidates for automatic adoption.

## Adoption rules

1. Never merge a whole branch solely because its name, commit count, or PR description says "complete".
2. Compare each branch against its actual merge base and inspect its changed files, dependencies, workflow changes, and tests.
3. Classify a feature as **complete** only when its UI, domain logic, persistence, authorization/privacy controls, failure handling, and automated tests are all integrated. Physical-device features additionally require device evidence before production qualification.
4. Port only the minimal feature-specific commits/files into the consolidation branch. Do not import unrelated branch history or feature flags.
5. Keep incomplete work on this branch. Keep production-affecting features disabled until their acceptance gates pass.
6. Merge to `main` only after source tests and review. Because the current Android APK workflow is triggered by qualifying PR changes to `index.html` and build inputs, do not open a PR to `main` until its APK workflow is made explicitly manual or the owner separately approves the build.
7. Delete a source branch only after its complete diff is represented in the destination, the destination commit is verified, the source branch has no remaining open PR/dependent branch, and the owner can recover the merged source from Git history.

## Feature findings

| Branch / workstream | Evidence observed | Classification | Adoption decision |
|---|---|---|---|
| `feature/bt-printing` | Printer catalog, ESC/POS/ZPL encoders, print queue/service, Bluetooth plugin and Node tests exist. Printing is disabled by default; the branch's app UI does not expose a complete integrated printer workflow. The branch is deeply diverged and contains unrelated payment/security work. | Partial foundation | Port printing files selectively only after UI integration, transport tests and permission review. Do not merge the branch wholesale. |
| `feature/direct-upi-reconciliation` | Its own `docs/PAYMENT-MATCHING.md` says it does not yet integrate with Android notification/SMS listener or post to the production folio ledger. | Partial | Keep disabled; integrate only with explicit staff review and ledger idempotency tests. |
| `feature/phase-7-pms-persistence` | Persistence/canonical-accounting code and tests exist, but the branch documentation identifies further stable identity mapping, repository/UI cutover and acceptance work. | Partial | Do not enable `uiCutover`; selectively reconcile with the current main storage architecture. |
| `feature/multi-provider-payment-backend` | Extensive provider/backend code and tests exist, but main's README explicitly excludes gateway providers from the active PMS payment interface. Merchant acceptance, production credentials, webhook-to-ledger lifecycle and device qualification are separate gates. | Deliberately excluded from main | Do not merge or activate provider rails. Preserve as historical development material. |
| `feature/owner-drive-backup-hardening` and `feature/owner-google-drive-backup-v2` | Overlapping Drive backup branches modify the same backup/UI/Android files. Real OAuth/account isolation, revocation, upload/download and second-device restore require external qualification. | Partial / overlapping | Consolidate one reviewed implementation only after backup crypto and restore tests. |
| `security/native-lock-lifecycle-hardening` (PR #74) | Draft PR. Durable browser-state fallback and stay-extension code/tests exist. Native SQLCipher is not the live canonical PMS store; no complete pre-WebView lock gate or physical-device qualification is evidenced. | Partial | Keep draft. Do not merge into main yet. |
| `security/audit-followup-2026-11-25` (PR #73) | Draft PR adds security status corrections, Gitleaks workflow and XSS regression inventory; its own description leaves CI/device gates pending. | Partial | Keep separate until exact-head checks and security remediation are complete. |
| `work/phase-0-feature-registry` | Contains a detailed evidence-based implementation register: several repository/outbox foundations are present; full domain/UI cutover, shared adapter contract, financial invariants, Android qualification and other gates remain incomplete. | Audit reference | Use as a source of work items; revalidate every statement against current main and branch heads. |
| `work/folio-booking-lifecycle` | Identified by main's branch audit as containing cancellation-policy and folio/accounting work, requiring domain integration and regression verification against the current UI. | Candidate / partial | Inspect and port individual domain functions only after current folio/accounting invariants are verified. |

**No non-main branch has been marked fully adopted by this snapshot.** A feature may have working source and tests while still lacking full UI integration, authorization, durable persistence, or device qualification. More branch-specific reviews remain before the inventory can be called exhaustive.

## Main-branch functionality already present

The current main UI includes Home, Stays, Rooms, Dining, and a More area containing Guests, Housekeeping, Inventory, Expenses, Reports, Audit, Import/Export, and Settings. Main already includes booking/guest/folio flows, ID upload and OCR parsing, local backup/photo handling, and UPI-only payment collection. The new All-sections dropdown is being implemented on this development branch without changing main.

## Work started on this branch

- Added an accessible All-sections dropdown over the existing main tabs and all More modules. Disabled modules remain visible but cannot be opened.
- Switched Android OCR to ML Kit's bundled Devanagari recognizer, which supports both Latin and Devanagari scripts.
- Added Marathi/Hindi identity-card labels, explicit holder-name detection, format-gated ID suggestions, and masking of checksum-verified Aadhaar candidates before profile persistence.
- Added source-contract tests for OCR parsing and navigation. They have **not yet been executed** in this environment.

## Not done

- No branch was merged into `main`.
- No source branch was deleted.
- No APK was built.
- No production payment, settlement, backup, or SQLCipher cutover flag was enabled.
- No physical Android OCR accuracy matrix has been run.
