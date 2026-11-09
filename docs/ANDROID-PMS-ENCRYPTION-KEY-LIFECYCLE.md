# Android PMS database encryption and key lifecycle

**Status:** implemented in the engineering branch; Android CI/device qualification remains required. This document describes the actual implementation, not an assertion of production approval.

## Data path

1. First enrollment generates a random 256-bit DEK using `SecureRandom`.
2. A PIN-derived KEK (Argon2id, fixed approved parameters) wraps the DEK with AES-256-GCM. The envelope authenticates its version and KDF/cipher metadata.
3. `AureliaEnvelopeStore` persists that PIN envelope in an `AtomicFile` under `noBackupFilesDir`, encrypted again with an AES-GCM key held by Android Keystore. A copied app-private envelope file is therefore not a standalone offline PIN oracle.
4. Successful PIN unlock authenticates/decrypts the PIN envelope and places the DEK in the process-scoped `AureliaAppManager` session.
5. The native PMS plugin obtains a short-lived DEK byte-array copy and opens the SQLCipher database. SQLCipher encrypts database pages and WAL content; the plaintext SQLite header is not present on disk.
6. The plugin serializes database work on one executor. On app background, it records the background transition and queues database close. The repository wipes the passphrase byte array when closed. While backgrounded, the session manager refuses further DEK copies; foreground reauthorization is required before the database can be reopened.
7. Explicit lock clears the process-scoped DEK. Process termination clears process memory. A session exceeding its configured foreground/background timeout is cleared on the next foreground authorization check.

## Important cryptographic boundary

The current implementation does **not** claim that the SQLCipher DEK is a non-exportable Android Keystore key. SQLCipher's Android API requires key/passphrase bytes to be supplied to its native database connection; therefore the DEK is available in process memory for the authenticated session. Android Keystore protects the persisted envelope at rest, while the PIN-derived KEK protects the DEK envelope. The SQLCipher helper receives a temporary byte-array copy that is wiped when the repository closes.

It would be inaccurate to say that the DEK never leaves hardware-backed Keystore. A future design that requires a non-exportable Keystore key to remain the sole database key would need a database encryption/VFS integration that can invoke Keystore cryptography for page operations; a normal SQLCipher passphrase interface cannot directly consume a non-exportable `SecretKey`.

## Migration safety

The former plaintext SQLite database is opened read-only. The importer requires the expected schema version, passes `PRAGMA quick_check`, verifies all required tables, and copies rows inside one encrypted-database transaction. It compares deterministic SHA-256 digests for each table before and after commit. The plaintext source is deleted only after successful post-commit parity verification. Any schema mismatch, digest mismatch, integrity failure or source-cleanup failure blocks repository initialization.

The native instrumentation suite covers encrypted file/header checks, correct-key reopen, wrong-key rejection, helper byte-array zeroization, plaintext migration parity/cleanup, entity-plus-outbox atomicity, multi-entity rollback, atomic acknowledgement and lease-bound retry/conflict handling.

## Qualification boundary

GitHub emulator instrumentation is necessary but is not physical-device qualification. The release gate remains closed until physical Android devices pass the process-death, low-storage, lock/unlock and backup/restore matrix, including a real-device encrypted database inspection. No gateway collection, automatic settlement/refund posting or UI cutover is enabled by this work.
