# PMS core consolidation — 26 November 2026

## Consolidated implementation

The PMS core candidate is assembled from the audited local-first storage branch and the mainline Android/UPI implementation. The integration preserves the mainline SQLCipher plugin, native repository, PIN/biometric/recovery unlock lifecycle, UPI UI and existing security hardening.

Included PMS foundations:
- IndexedDB browser repository and Capacitor SQLCipher repository adapter.
- Local device identity, migration snapshots, authority state, resumable domain projection, transactional outbox, repository bridge and serialized canonical writes.
- Versioned repositories/services for rooms, guests, bookings, settings, dining tables/sales, inventory and expenses.
- Folio invoice/accounting and booking cancellation services.
- Local payment authorization/safety gates and repository settlement components. All automatic settlement controls remain OFF.
- Backup vault, photo archive, evidence storage, storage fault injection and migration/recovery tests.
- Build packaging copies the canonical PMS module graph without gateway/provider code.

## Data and security invariants

- The native SQLCipher and unlock templates in mainline are authoritative; older branch versions are not copied over them.
- PIN, biometric and recovery independently unwrap one random 256-bit DEK. OTP never generates or replaces that DEK.
- Legacy `booking.p` remains rupees. New financial-domain values use integer paise. Migration preserves old payment rows as evidence and does not infer balances.
- A QR scan, customer-paid claim, notification, SMS, UTR text or observer payload is not proof of bank credit.
- Gateway providers, Pay Bridge, provider SDKs/webhooks, cloud sync, automatic settlement, automatic refunds and production release are excluded or disabled.

## Remaining qualification

The runtime uses the verified canonical repository and compatibility snapshot for durable local writes. The normalized domain repositories are not yet the read/write authority for every UI command; global `uiCutover` remains OFF. Physical Android device lifecycle, low-storage, process-death, backup/restore and complete IndexedDB/SQLCipher parity qualification are still required.

A passing Node suite and web build are necessary but not sufficient for production approval. No APK release, deployment, live payment activation or production cutover is authorized by this consolidation.
