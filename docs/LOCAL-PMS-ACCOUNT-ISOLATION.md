# Local PMS Account Isolation

## Security boundary

The native SQLCipher repository is the protected data boundary. Every plugin-facing repository operation is guarded by:

1. A non-empty current Firebase UID.
2. An authenticated, Keystore-encrypted local binding containing the full UID and owner ID.
3. Exact UID and owner-ID match (no UID-only authorization).
4. An unlocked session whose DEK can still be copied; the copied key is zeroed immediately.
5. A final identity/binding recheck before a native plugin result is returned.

The repository guard is also called at every public repository operation, not only when the database is opened. Identity transitions lock the session and synchronously close the SQLCipher repository, zeroing its in-memory key copy. Queued plugin work fails closed after the transition.

## Binding states

- **UNBOUND**: both binding preference fields are absent. First binding is allowed only for a genuinely new profile with no encrypted database, envelope, enrollment marker, or existing binding Keystore alias.
- **BOUND**: authenticated binding decrypts and the full UID/owner ID match. Access is permitted only while the matching Firebase UID and unlocked DEK session are present.
- **MISMATCH**: a different UID or owner ID is supplied, or a rebinding attempt is made.
- **CORRUPT**: partial preferences, malformed ciphertext, failed GCM authentication, or invalid binding contents. Access is denied; state is never silently treated as UNBOUND.

Bindings are immutable through normal application flows. Clearing preferences does not permit rebinding because an existing Keystore alias, encrypted database, envelope, or enrollment marker causes the binding operation to fail closed.

## Initial binding

The Google primary-auth activity calls the App-Check-protected `ensureOwnerMembership` callable and validates that the response contains a server-created membership before launching the non-exported native PIN gate. The owner ID passed to the gate comes from that server response. The gate binds only during fresh enrollment, before an encrypted profile exists.

Existing profiles with missing or corrupt owner-binding material are intentionally not auto-rebound. A PIN proves possession of the DEK, but by itself does not prove that the currently signed-in cloud owner is the original owner. Such profiles require a separately designed, server-verified recovery/migration procedure.

## Offline behavior

Local PMS reads and writes remain offline-first. The native guard checks the local binding and unlocked session; it does not make a network request on every operation. Cloud membership must be independently revalidated by any future transport before sending or applying remote data.

The current PMS sync coordinator reports that transport is not installed. The native outbox remains in the owner-bound encrypted database; it is not currently uploaded by a background worker.

## Qualification boundaries

The automated repository-guard instrumentation test simulates UID A to UID B and confirms reads and writes are rejected, then confirms A can return. This tests the repository guard, not a live Firebase/Firestore/App-Check integration.

Not yet qualified:
- physical-device A→B→A account switching and process-death behavior;
- release-signed Google authentication and server callable/App Check enforcement;
- production Firestore membership revocation behavior;
- background worker cancellation, because no native PMS sync worker/transport is currently installed;
- cross-account Firestore cache/pending-write isolation, because PMS data is not currently written through Firestore;
- release build and device-specific SQLCipher/key-revocation behavior.

These are qualification gaps, not claims of completed testing.
