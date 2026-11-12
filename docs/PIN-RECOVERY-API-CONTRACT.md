# Aurelia PMS recovery authorization API contract

**Design contract only; no production recovery endpoint is enabled.** The local recovery key remains the cryptographic authority for unwrapping the DEK. OTP only authorizes continuation of the recovery workflow.

## Registered recovery phone

Settings → Security → Recovery phone requires fresh PIN or biometric authentication. Normalize to E.164 and verify with Firebase Phone Auth. App Check and Play Integrity are required risk signals. The backend verifies the Firebase ID token with the Admin SDK and binds the verified phone to the authenticated tenant only after checking the token phone claim and recent authentication time.

Changing a number requires PIN, OTP to the new number, a 24–72 hour cooling period, alerts to the old number and email on file, and a cancel path. Do not activate the new number before the cooling period completes.

## Recovery authorization

The backend checks that the token phone number equals the trusted phone stored for the tenant and that auth_time is less than five minutes old. It issues a signed token with a five-minute expiry, one-time jti, audience recovery, tenant binding, owner-registered device-key hash and client nonce. Consume jti atomically and reject replay, expiry, wrong audience, device, nonce, tenant or phone.

This token authorizes workflow continuation only. The offline recovery key is still required locally to unwrap the same DEK. Never accept a client-supplied number, PIN, DEK or envelope as proof of recovery. Never send SMS or call external KMS inside a Firestore transaction.

## Optional self-hosted OTP

If replacing Firebase Phone Auth: six digits, five-minute expiry, single-use challenge, HMAC with server-held pepper, constant-time comparison, one challenge document per request, committed attempt counters even on failure (maximum five), rate limits per phone/account/IP/device, country allowlist, server timestamps and numeric expiry. Never store or log plaintext OTP.

## Optional assisted recovery (off by default)

A separately opted-in recovery wrapper may derive HKDF(localHalf || serverHalf). Server-half release requires OTP, a 48-hour delay, owner notifications and cancellation. This adds a server-assisted trust path and retains SIM-swap risk. It is never an automatic fallback.

## Deployment gates

No OTP recovery until verified phone registration, token validation, nonce/device binding, one-time jti storage, abuse controls, notifications, monitoring, App Check, Play Integrity and end-to-end physical-device tests pass. SMS OTP never creates, unwraps or replaces the DEK.
