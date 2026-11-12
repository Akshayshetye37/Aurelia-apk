# Recovery owner primary-auth token contract

Owner acknowledgement and cancellation are deliberately stricter than ordinary app access. A recovery-phone OTP is never an owner factor.

The callable backend requires all of the following in the verified Firebase ID token:

- `role=owner` and the matching `tenantId`.
- A fresh integer `auth_time`: not in the future and less than 300 seconds old.
- A server-issued `ownerAuthFactor` custom claim equal to `email_link` or `passkey`.
- A server-issued `ownerAuthFactorAuthTime` custom claim exactly equal to the token's `auth_time`.
- For `email_link`, Firebase provider `password` plus an email identity.
- For `passkey`, Firebase provider `custom`.

## Provisioning rule

Only the trusted authentication backend may set these custom claims, after it has independently verified the actual email-link completion or passkey challenge for that sign-in. It must set `ownerAuthFactorAuthTime` to the authenticated session's Firebase `auth_time`, refresh/issue the ID token, and clear or replace the factor claims on every subsequent authentication method change.

Never set these claims from Android client input, a phone OTP callback, a recovery callable, an unverified request parameter, or a stale user profile. Firebase custom claims are signed into the ID token; the server checks the factor and timestamp again on every acknowledgement/cancellation call.

## Current integration limitation

This repository does not currently contain the primary email-link/passkey sign-in issuer that can prove those factors and mint the session-bound custom claims. Until that trusted issuer is connected and verified, acknowledgement and cancellation fail closed. Do not relax the checks to make emulator tests pass. The emulator fixtures model a token already minted by that trusted issuer.

No PIN, recovery key, DEK, OTP or raw phone number belongs in these claims.
