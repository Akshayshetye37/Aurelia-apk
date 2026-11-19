# Aurelia PMS recovery backend API contract

This contract supplements BACKUP-ARCHITECTURE.md. It is not an implementation or a deployed endpoint. Production use requires a tenant-aware backend, shared challenge store, SMS provider and KMS/HSM integration.

## Authentication and tenant identity

All endpoints require TLS. Business identity must be established by a pre-existing authenticated session or an enrollment flow with verified ownership. Never accept an arbitrary business ID as proof of tenant identity. Apply per-tenant and per-IP rate limits. Use generic responses where account enumeration is possible.

## Start recovery

POST /v1/recovery/challenges

Request:
- phone: E.164 mobile number supplied by owner
- purpose: "pin-recovery"
- clientInstanceId: app installation identifier (non-secret)

Server:
- resolve phone to an enrolled business account without disclosing whether it exists
- enforce account, phone, IP and global rate limits
- create a cryptographically random six-digit OTP
- store HMAC(otp, server-side pepper) in Redis with a five-minute TTL, challenge ID, tenant reference, attempt count, resend state and audit metadata
- send SMS through the configured provider
- return challengeId, expiresInSeconds and generic status; never return OTP or OTP hash

## Verify challenge

POST /v1/recovery/challenges/{challengeId}/verify

Request:
- code: six numeric digits

Server:
- validate challenge TTL, tenant binding, attempt limits and single-use state
- compare keyed OTP digest in constant time
- consume challenge atomically on success
- issue short-lived, single-use recovery authorization bound to tenant, device instance, purpose and expiry
- never return a DEK, PIN, recovery private key or plaintext backup

## Rewrap recovery key

POST /v1/recovery/key-envelope/rewrap

Request:
- one-time recovery authorization
- vaultId and envelopeVersion
- newPinSalt and Argon2id parameter set
- client-produced new-PIN-wrapped DEK challenge/envelope
- proof that the client can unwrap the KMS recovery envelope and correctly rewrap the DEK must be designed with the selected KMS key hierarchy; raw PIN and raw DEK are prohibited

Server:
- validate authorization and tenant binding; consume authorization atomically
- use KMS/HSM to authorize recovery of the tenant's DEK recovery envelope
- verify the client's rewrap proof using a protocol designed and reviewed for this purpose
- persist the new recovery envelope and audit the KMS operation
- return only status and new envelope version

Important: the final request/response cryptographic protocol must be reviewed before implementation. A naïve endpoint that sends the PIN, KEK or plaintext DEK to the server is prohibited. The exact envelope exchange depends on the selected KMS/HSM and whether recovery uses client-side envelope rewrapping or a server-authorized re-encryption service.

## Operational controls

- OTP lifetime: 5 minutes.
- Six digits, generated with a CSPRNG.
- Maximum 5 verification attempts per challenge; lock and invalidate after limit.
- Resend cooldown: at least 60 seconds; bounded daily attempts per phone/account/IP.
- One active challenge per tenant/purpose; new challenge invalidates prior challenge.
- Single-use recovery authorization, short TTL (target 5 minutes), audience and purpose restricted.
- Store only keyed OTP digests; keep pepper in managed secrets/KMS.
- Do not log OTP, full phone number, PIN, bearer tokens, recovery authorization or key material.
- Notify owner after successful recovery; maintain tamper-evident audit trail.
- Fail closed if Redis, SMS provider, identity registry or KMS/HSM is unavailable.

## Deployment secrets (never commit)

- REDIS_URL and Redis authentication
- OTP_HMAC_PEPPER managed secret
- SMS provider credentials and sender configuration
- KMS/HSM key identifier and workload identity
- business registry database credentials
- service authentication/session signing keys

No production endpoint is considered active until deployment, provider configuration, KMS policy, monitoring and end-to-end recovery tests are complete.
