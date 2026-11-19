# Aurelia PMS backup and data ownership architecture

## Ownership boundary

- Aurelia PMS owns hotel operations: rooms, guests, bookings, folios, invoices, hotel expenses and PMS settings.
- The future Aurelia Pay Bridge owns payment execution records, provider records, refunds and reconciliation.
- Each app has its own private database/storage and independently versioned backup format.
- A SAF folder is a user-authorized file exchange and backup destination. It is never a shared live database and does not grant access to another app's private storage.

## PMS backup destinations

### 1. Private local device backup — primary

The PMS Android native bridge writes verified snapshots to the PMS app-private files/backups/pms directory. It needs no storage permission. Snapshots are written to a staging file, flushed, SHA-256 read-back verified and atomically renamed. The latest seven managed snapshots are retained. Only filenames matching the Aurelia PMS backup naming contract are eligible for retention cleanup.

The web UI creates a PMS snapshot when data changes and on app launch/periodic foreground maintenance. Every new snapshot is encrypted in the WebView using AES-256-GCM before native storage receives it. The 256-bit data key is non-extractable in Web Crypto and persisted in IndexedDB; a recovery-password-wrapped copy is embedded in each backup envelope so the owner can recover on a replacement device. The password is processed with PBKDF2-HMAC-SHA-256 (600,000 iterations) and is never stored. Android may defer work while the app is stopped or force-stopped; because the live PMS source of truth remains WebView/IndexedDB, a native worker cannot safely create a fresh snapshot after the WebView process is gone. The app catches up on next launch. A guaranteed unattended snapshot requires migrating the PMS data source to a native background-accessible database; WorkManager alone cannot solve that data-ownership problem.

Private app data is removed when the app is uninstalled or its data is cleared. Owners must configure an optional off-device destination or export backups if they need protection from device loss/uninstall.

### 2. Google Drive OAuth — optional, owner-controlled

The new direct Drive adapter authorizes the owner's Google account separately from Aurelia Google Sign-In. It requests only the non-sensitive `drive.appdata` scope and stores backup files in the hidden `appDataFolder`; the user does not select a folder. The adapter is implemented in `src/backup/google-drive-backup.mjs` and packaged by `scripts/prepare-web.js`. Android authorization is exposed through the native bridge using Google Identity Services AuthorizationClient.

- Connect is explicit and independent from login.
- After the first successful connection, Aurelia immediately asks the user to choose Daily, Weekly, Monthly or Never.
- No recurring backup begins until the schedule is saved. Never disables scheduling but preserves manual Back Up Now.
- Daily/Weekly/Monthly selection starts the first backup after consent; subsequent backups are due according to the stored schedule.
- New files are encrypted backup envelopes only. The adapter rejects plaintext and malformed backup payloads.
- Seven remote recovery points are retained; cleanup failure is reported separately from upload success.
- Disconnect disables scheduled/manual Drive operations in Aurelia and leaves local business data unchanged. Google authorization may remain granted in the Google Account until revoked there.
- Drive OAuth tokens are passed transiently to the adapter and are not stored in PMS state, Web Storage, logs or backup payloads.

Production configuration:

1. Enable Google Drive API in the Google Cloud project used by Aurelia's Android OAuth identity.
2. Configure the OAuth consent screen with the Aurelia app name, support contact and privacy policy.
3. Register Android OAuth credentials for package `com.aurelia.pms` with the debug/release signing certificate SHA-1 fingerprints used by the corresponding APK.
4. Verify the Android identity configuration on a physical device with Google Play Services before release.
5. Do not ship OAuth client secrets or service-account private keys in the APK.

The Drive `appDataFolder` is hidden and accessible only to Aurelia. It is not a user-selected folder, is separate from visible Drive backup folders, and can be deleted by the user or when the app is removed from their Drive. Owners should retain independent recovery/export options.

Android background scheduling is best-effort. WorkManager/OS scheduling cannot safely snapshot the current PMS state because the authoritative snapshot and recovery-key wrapper are owned by the running WebView. A due scheduled backup is therefore caught up when Aurelia is running/foregrounded and the local snapshot is available. A guaranteed unattended snapshot requires moving snapshot creation and encryption/key access into a native background-capable storage architecture.

The old `backup_tree_uri` SAF grant remains migration/restore compatibility only. New Drive OAuth backups do not require or replace any payment SAF/UPI/Pay Bridge integration. Shared-folder SAF remains a separate export/import capability.

### 3. Owner-configured server/cloud — optional

The owner supplies an HTTPS endpoint and bearer upload token. The endpoint is provider-neutral and follows the backup server contract document. The token is encrypted with an AES-GCM key held in Android Keystore; the plaintext token is not stored in WebView localStorage, PMS state, or backup payloads. Redirects are rejected. Remote upload/restore requires HTTPS.

The PMS uploads the encrypted backup envelope after a successful local snapshot while the PMS app is running. The browser database is owned by the WebView and cannot be snapshotted by a stopped-process worker without a separate native data migration. Therefore this implementation performs automatic snapshots on launch/data-change/foreground maintenance, not a guaranteed unattended daily snapshot after force-stop.

### 4. Shared folder — separate SAF grant

The shared folder has its own URI preference and its own persisted SAF grant, separate from the optional Drive backup folder. It is for owner-authorized backup import/export and permitted file exchange. When selected, PMS writes the same encrypted backup envelope there; it never shares the PMS database file or grants access to Pay Bridge private data.

## Backup file identity and restore

PMS files use aurelia-backup-<date>-<content-hash>.json. New files contain an `AURELIA-PMS-ENCRYPTED-BACKUP` v1 envelope: AES-256-GCM ciphertext, random 96-bit nonce, 128-bit authentication tag, PBKDF2-HMAC-SHA-256 key-wrapping metadata (600,000 iterations), per-vault salt and a password-wrapped random 256-bit data key. The encrypted plaintext remains the PMS schema v4 snapshot with SHA-256 integrity metadata. AES-GCM authenticates the ciphertext; SHA-256 remains useful for transport/read-back verification. The PMS restore path checks schema, integrity when present, record structure and photo archive completeness before committing. Restore remains transactional with rollback attempts for the PMS state and photo archive.

A future Pay Bridge backup must use a distinct application identifier and its own schema, retention and restore validation. PMS must reject Pay Bridge backup files as PMS snapshots and vice versa.

## Android permissions

- INTERNET is retained for HTTPS server/cloud backup.
- SAF uses explicit owner selection and persistable URI grants; it requires no broad storage permission.
- Google Drive account authentication is handled by the Drive document provider.
- No SMS, contacts, location, camera, microphone, notification listener, accessibility, overlay, broad storage or package inventory permissions are required for this backup architecture.


## Recovery password operations

- The owner sets a recovery password once in Backup & Restore (minimum 14 characters). It is not stored by Aurelia.
- Keep the password in an independent password manager or secure offline recovery record. If it is lost, backups cannot be decrypted; there is no vendor reset.
- The current installation caches a non-extractable Web Crypto data key in IndexedDB so automatic snapshots do not require repeated password prompts. Each backup includes a password-wrapped copy of that data key.
- A replacement installation imports the encrypted file and prompts for the recovery password. Successful decryption imports the non-extractable key into its local vault.
- Existing plaintext v4 backups remain readable for migration; all newly generated backups are encrypted. Do not treat legacy files as meeting the new encryption policy.
- Password rotation is deliberately not exposed until a rewrapping/re-encryption migration can update every retained recovery point safely.


## Google Drive automatic-backup lifecycle (WhatsApp-inspired)

- Connection is explicit and owner-controlled. The app verifies the authorized account and displays its email before recurring backup is enabled.
- OAuth requests only Drive app-data access plus OpenID/email identity. Access tokens are transient and are never persisted in PMS state, Web Storage, logs or backup envelopes.
- Backup files are written to the hidden Drive `appDataFolder`; the owner does not need to select a folder. Each file contains only an already-encrypted Aurelia backup envelope.
- The owner chooses Daily, Weekly, Monthly or Never. Connecting alone does not enable a schedule. Manual Back Up Now and restore history remain available for Never.
- The UI shows account, last successful backup, size, next scheduled date and last error/warning.
- Drive history is paginated and newest-first. Restore lets the owner select a recovery point; download/validation precedes the existing explicit restore confirmation and transactional restore path.
- Retention defaults to seven recovery points. Cleanup runs only after upload succeeds, protects the new file, and reports cleanup failures separately from upload success.
- Disconnect disables scheduling and clears the account identity in Aurelia. It preserves local PMS data; Google permission revocation remains available in the owner's Google Account.
- Authorization expiry, permission denial and rate limiting are surfaced as distinct retryable states.

### Scheduling limitation (important)
The PMS snapshot and encryption/key wrapper are currently owned by the running WebView. Android WorkManager cannot independently produce an authoritative encrypted PMS snapshot, and a Drive access token is not stored for background use. Therefore scheduled backups are **best-effort catch-up when Aurelia is running/foregrounded**, not guaranteed unattended backups. A true WhatsApp-style background guarantee requires migrating snapshot/export, key wrapping, and refreshable owner authorization into a native background-capable architecture. Do not advertise guaranteed background execution until that architecture and device qualification are complete.
