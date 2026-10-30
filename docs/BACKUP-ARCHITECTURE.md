# Aurelia PMS backup and data ownership architecture

## Ownership boundary

- Aurelia PMS owns hotel operations: rooms, guests, bookings, folios, invoices, hotel expenses and PMS settings.
- The future Aurelia Pay Bridge owns payment execution records, provider records, refunds and reconciliation.
- Each app has its own private database/storage and independently versioned backup format.
- A SAF folder is a user-authorized file exchange and backup destination. It is never a shared live database and does not grant access to another app's private storage.

## PMS backup destinations

### 1. Private local device backup — primary

The PMS Android native bridge writes verified snapshots to the PMS app-private files/backups/pms directory. It needs no storage permission. Snapshots are written to a staging file, flushed, SHA-256 read-back verified and atomically renamed. The latest seven managed snapshots are retained. Only filenames matching the Aurelia PMS backup naming contract are eligible for retention cleanup.

The web UI creates a PMS snapshot when data changes and on app launch/periodic foreground maintenance. Android may defer work while the app is stopped or force-stopped; the app creates or catches up on the next launch. This is not a claim of guaranteed background execution while the process is stopped.

Private app data is removed when the app is uninstalled or its data is cleared. Owners must configure an optional off-device destination or export backups if they need protection from device loss/uninstall.

### 2. Google Drive — optional

The owner selects a Drive folder using Android Storage Access Framework (SAF). If Google Drive is available as a document provider, its own UI handles account sign-in and authorization. Aurelia does not request Google account, contacts, broad storage or all-files permissions and does not embed a Google OAuth client.

The selected Drive URI is persisted with Android's persistable URI grant. The PMS writes an additional verified copy there after the private local copy. Drive/provider failures do not invalidate a successful private local backup; they are reported as a secondary-destination warning.

### 3. Owner-configured server/cloud — optional

The owner supplies an HTTPS endpoint and bearer upload token. The endpoint is provider-neutral and follows the backup server contract document. The token is encrypted with an AES-GCM key held in Android Keystore; the plaintext token is not stored in WebView localStorage, PMS state, or backup payloads. Redirects are rejected. Remote upload/restore requires HTTPS.

The PMS uploads a copy after a successful local snapshot while the PMS app is running. The browser database is owned by the WebView and cannot be snapshotted by a stopped-process worker without a separate native data migration. Therefore this implementation performs automatic snapshots on launch/data-change/foreground maintenance, not a guaranteed unattended daily snapshot after force-stop.

### 4. Shared folder — separate SAF grant

The shared folder has its own URI preference and its own persisted SAF grant, separate from the optional Drive backup folder. It is for owner-authorized backup import/export and permitted file exchange. When selected, PMS writes its own backup copy there; it never shares the PMS database file or grants access to Pay Bridge private data.

## Backup file identity and restore

PMS files use aurelia-backup-<date>-<content-hash>.json and the current PMS schema (v: 4) with SHA-256 integrity metadata. The PMS restore path checks schema, integrity when present, record structure and photo archive completeness before committing. Restore remains transactional with rollback attempts for the PMS state and photo archive.

A future Pay Bridge backup must use a distinct application identifier and its own schema, retention and restore validation. PMS must reject Pay Bridge backup files as PMS snapshots and vice versa.

## Android permissions

- INTERNET is retained for HTTPS server/cloud backup.
- SAF uses explicit owner selection and persistable URI grants; it requires no broad storage permission.
- Google Drive account authentication is handled by the Drive document provider.
- No SMS, contacts, location, camera, microphone, notification listener, accessibility, overlay, broad storage or package inventory permissions are required for this backup architecture.
