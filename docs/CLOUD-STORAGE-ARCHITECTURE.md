# Cloud storage architecture

## Decision

Aurelia is local-first. Local encrypted storage is the default and remains available without any cloud account, network, provider credentials, or cloud configuration. Cloud storage is an optional user-selected capability.

## Provider catalog

The provider catalog is intentionally a roadmap, not a claim that every adapter is implemented:

- Available boundary: local device adapter (requires a durable adapter supplied by the platform).
- Planned: Dropbox, Google Drive, OneDrive, iCloud, WebDAV, Nextcloud, S3, Azure Blob, and custom storage endpoints.

Provider availability must be marked accurately in the UI. A listed provider cannot be connected until its adapter is implemented, tested, and registered.

## Boundary and data handling

`src/storage/cloud-storage-provider.mjs` defines the provider-independent boundary. It accepts only a versioned AES-256-GCM envelope with a 12-byte nonce, key identifier, and ciphertext. Providers must store ciphertext and must not receive plaintext application records or DEKs.

OAuth tokens, provider passwords, and refresh tokens are owned by provider-specific authentication adapters. They must not be persisted by the generic provider manager or included in cloud payloads. Provider connection requires explicit user consent. Disconnect returns the active storage selection to local mode and must not delete local data.

## Non-goals of this foundation

This change does not implement provider OAuth, remote backup scheduling, bidirectional business-data synchronization, platform iCloud APIs, cloud credentials UI, or a production durable local adapter. Those require separate provider-specific work and tests. Existing local PMS persistence remains authoritative.

## Acceptance criteria

- Local-only is the default.
- Cloud provider selection requires explicit consent.
- Unimplemented providers cannot be connected.
- Provider adapters are validated against the common contract.
- Storage accepts encrypted envelopes only.
- Object keys reject traversal and unsafe separators.
- Disconnect returns to local mode.
- Provider catalog does not overstate implementation status.
