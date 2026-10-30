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

### 2. Google Drive — optional

The owner selects a Drive folder using Android Storage Access Framework (SAF). If Google Drive is available as a document provider, its own UI handles account sign-in and authorization. Aurelia does not request Google account, contacts, broad storage or all-files permissions and does not embed a Google OAuth client.

The selected Drive URI is persisted with Android's persistable URI grant. The PMS writes the same authenticated encrypted envelope there after the private local copy. Plaintext PMS records and guest photos never leave the app through a backup destination. Drive/provider failures do not invalidate a successful private local backup; they are reported as a secondary-destination warning.

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
