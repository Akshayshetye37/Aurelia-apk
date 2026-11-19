# Cloud storage architecture

## Decision

Aurelia is local-first. Local encrypted storage is the default and remains available without any cloud account, network, provider credentials, or cloud configuration. Cloud storage is an optional user-selected capability.

## Provider catalog

The provider catalog is intentionally a roadmap, not a claim that every adapter is implemented:

- Available boundary: local device adapter (requires a durable adapter supplied by the platform).
- Existing backup workflow: Android Storage Access Framework (SAF) cloud-folder selection. The system picker can expose installed document providers, including Google Drive, Dropbox, OneDrive, Box, Nextcloud, and others when those apps/providers are installed and expose folders. Provider capabilities vary; Aurelia does not embed their OAuth SDKs or collect their passwords in this folder flow.
- Planned direct adapters: Dropbox, Google Drive, OneDrive, iCloud, WebDAV, Nextcloud, S3, Azure Blob, and custom storage endpoints. These direct adapters are not implemented by this abstraction.

Provider availability must be marked accurately in the UI. SAF is an existing backup-folder path but is not wired to this generic manager. A listed direct provider cannot be connected until its adapter is implemented, tested, and registered.

## Existing backup integration

The current Backup & Restore screen already supports a user-selected SAF cloud folder, private local backup, and an owner-configured HTTPS server/cloud destination. The SAF picker is provider-neutral: users can choose an installed document provider if it is exposed by Android. The UI should not label the destination as Google Drive only. Local backup remains primary and cloud folders are secondary destinations.

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
