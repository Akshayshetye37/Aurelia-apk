# Aurelia PMS recovery authorization API contract

**Design contract only; no production recovery endpoint is enabled.** The local recovery key remains the cryptographic authority for unwrapping the DEK. OTP only authorizes continuation of the recovery workflow.

## Registered recovery phone

Settings → Security → Recovery phone requires fresh PIN or biometric authentication. Normalize to E.164 and verify with Firebase Phone Auth. App Check and Play Integrity are required risk signals. The backend verifies the Firebase ID token with the Admin SDK and binds the verified phone to the authenticated tenant only after checking the token phone claim and recent authentication time.

Changing a number requires fresh owner authentication, proof of both the old and new numbers, a 48-hour server-side delay, an alert to the previously enrolled owner device and a cancel path. The owner alert must be acknowledged by the attested app after Android accepts the notification for display. If the alert cannot be posted or acknowledged, the change/recovery remains blocked. Do not activate the new number before the delay completes.

## Recovery authorization

The backend checks that the token phone number equals the trusted phone stored for the tenant and that auth_time is less than five minutes old. Before phone recovery is enabled, the owner device must be enrolled with a server-challenge-bound Android Key Attestation certificate chain. A private IAM-only Cloud Run verifier checks Google trust roots/revocation, expected package and signer, TEE/StrongBox security level, verified boot, locked state and public-key binding; software-only keys are rejected. The first valid recovery OTP creates an ALERT_PENDING state and sends a data-only FCM alert to the previously enrolled owner device. The 24-hour timer starts only after the attested app posts the notification and acknowledges it to the backend; FCM acceptance alone does not start the timer. If delivery/display/ack fails, no grant can be issued. The owner can cancel a pending request. After the full hold, a fresh phone-auth event is mandatory. Only then does the backend issue a signed token with a five-minute expiry, one-time jti, audience recovery, tenant binding, owner-registered device-key hash and client nonce. Consume jti atomically and reject replay, expiry, wrong audience, device, nonce, tenant or phone.

This token authorizes workflow continuation only. It does not unlock a Keystore recovery wrapper and it does not reset the PIN by itself. The user must enter the offline, user-held recovery key; that key unwraps the existing DEK locally. Only then may the app wrap that same DEK under the new PIN and invalidate the old PIN wrapper. Without the user-held recovery key, the database cannot be opened or the PIN reset. If both the device and offline recovery key are lost, the encrypted data is permanently unrecoverable; there is no server escrow or OTP-only bypass. The product UI must disclose this before the user enables phone recovery. Never accept a client-supplied number, PIN, DEK or envelope as proof of recovery. Never send SMS or call external KMS inside a Firestore transaction.

## Optional self-hosted OTP

If replacing Firebase Phone Auth: six digits, five-minute expiry, single-use challenge, HMAC with server-held pepper, constant-time comparison, one challenge document per request, committed attempt counters even on failure (maximum five), rate limits per phone/account/IP/device, country allowlist, server timestamps and numeric expiry. Never store or log plaintext OTP.

## Optional assisted recovery (off by default)

A separately opted-in recovery wrapper may derive HKDF(localHalf || serverHalf). Server-half release requires OTP, a 48-hour delay, owner notifications and cancellation. This adds a server-assisted trust path and retains SIM-swap risk. It is never an automatic fallback.

## Deployment gates

All recovery callables default OFF through `RECOVERY_ENABLED=false`; enable only in a dedicated staging project. No production OTP recovery until verified phone registration, token validation, nonce/device binding, one-time jti storage, cooldown, exponential abuse controls, owner notifications, monitoring, App Check, Play Integrity, pinned signing key and end-to-end physical-device tests pass. SMS OTP never creates, unwraps or replaces the DEK.
