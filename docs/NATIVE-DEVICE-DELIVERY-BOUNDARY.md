# Native payment device delivery boundary

## Implemented in the PMS template

The maintained Android generator copies `PaymentDeviceKeyStore.kt` and
`PaymentDeviceClient.kt` into the generated app. The client is native-only
and is not exposed through a WebView JavaScript interface.

The device transport now:

- requires the challenge-attested Keystore alias; the legacy key alias alone
  cannot open the device transport;
- accepts only an HTTPS appliance origin, safe device IDs, and no redirects;
- signs each lease and acknowledgement request with the
  `AURELIA_DEVICE_REQUEST_V1` transcript, a fresh nonce, timestamp and body hash;
- bounds response bodies to 1 MiB and rejects non-JSON responses;
- retains the lease token, cursor and expiry returned by the appliance;
- checks that the lease is contiguous and not expired;
- verifies the command payload against the exact canonical bytes and SHA-256
  hash supplied by the appliance;
- checks the outer command envelope against the nested command and settlement
  bindings (device, command, sequence, transaction, folio, amount, INR and
  provider).

The LAN appliance computes the payload digest from canonical JSON and returns
those exact canonical bytes as `payloadCanonical`. This avoids depending on
JavaScript, Kotlin or JSON-library object key ordering when verifying the
command digest.

## Deliberately not implemented / not enabled

This client is a transport and validation boundary, **not** a folio consumer.
It does not:

- display or enforce owner/staff accounting approval;
- mutate PMS folio state;
- create a durable folio ledger receipt;
- prove that a caller-supplied `ledgerAckId` corresponds to a durable ledger
  write;
- recover the PMS folio and intent journal after process death;
- establish Google Android Key Attestation trust on the appliance.

The `acknowledge(lease, ledgerAckId)` method must only be called by a future
native projector after approval, idempotent durable application, and a
successful independent folio read-back. The appliance's signed receipt proves
which device key acknowledged which command; it does not independently prove
that the PMS ledger write occurred. Do not treat a transport acknowledgement
as accounting evidence.

## Required next implementation boundary

A production projector needs a single durable accounting repository with an
idempotency constraint on `commandId`, a durable receipt containing the
immutable command binding and resulting folio version, and a read-back check
before acknowledgement. If PMS folios remain in WebView-managed storage, that
storage cannot be atomically committed with a separate Android SQLite journal.
The architecture must either move the authoritative folio ledger into a native
transactional store or introduce a server-authoritative ledger and treat the
WebView folio as a projection. A best-effort dual write is not exactly-once.

The owner enrollment path must also submit the attestation certificate chain
and challenge to an appliance verifier that validates the Google trust anchor,
attestation challenge, app signing identity, security level and verified boot.
The current owner proof-of-possession enrollment is not equivalent to hardware
attestation verification.

## Release gate

Keep all of the following disabled until the full physical-device acceptance
matrix passes:

- automatic folio settlement;
- live provider activation and live payment dispatch;
- payment execution IPC;
- native device command projection and acknowledgement.

Required physical acceptance includes attestation verification on supported
Android versions, release-signed app identity, trusted appliance TLS,
lease/hash validation, explicit staff approval, durable idempotent projection,
read-back, signed acknowledgement, process-kill recovery and duplicate replay
testing.
