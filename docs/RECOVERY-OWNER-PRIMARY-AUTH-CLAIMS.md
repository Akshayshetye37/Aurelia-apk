# Primary owner authentication for recovery actions

Owner acknowledgement and cancellation require a fresh, server-verified primary-owner session. A phone OTP session can never satisfy this requirement.

## Email-link flow

1. On an enrolled owner device, the owner enters the email address of the Firebase owner account and requests a passwordless email sign-in link.
2. The Android app opens the Firebase email action link, or the owner pastes the complete link into the recovery owner screen.
3. The app sends the email address, one-time link, tenant ID and device hash to the `exchangeOwnerEmailLink` callable. The callable is App Check protected and enabled only when `RECOVERY_ENABLED=true`.
4. The backend validates the HTTPS Firebase project link domain, API key, `mode=signIn`, and one-time `oobCode`; exchanges it with Firebase Identity Toolkit; verifies the resulting ID token and recent `auth_time`; then checks that the Firebase UID is exactly the immutable `ownerUid` stored in the recovery-phone record.
5. The backend also requires the requesting device to be currently attested and enrolled for that same owner UID. It then mints a Firebase custom token with server-issued `ownerAuthFactor=email_link` and `ownerAuthFactorAuthTime` claims.
6. Android signs in with that custom token. Acknowledgement/cancellation callables independently re-check the signed claims, fresh `auth_time`, tenant, UID, and active attested owner-device enrollment.

The email link is single-use. Wrong email, wrong UID, wrong tenant, untrusted link host, invalid API key, expired/replayed link, non-owner account, unregistered device or stale authentication fails closed. The backend never accepts a client-supplied `ownerAuthFactor` claim.

## Passkey support

The backend recognizes a server-issued `ownerAuthFactor=passkey` session only when the Firebase sign-in provider is `custom` and the factor timestamp is fresh. A WebAuthn/passkey challenge verifier is not currently implemented in this repository; do not mint passkey claims until a trusted WebAuthn verifier is deployed and covered by tests.

## Configuration

The staging deployment must set `FIREBASE_WEB_API_KEY` to the API key from the same staging `google-services.json`. This is a Firebase client API key, not a private signing secret. The deployment workflow verifies that the configured value matches the Android Firebase project configuration before deployment.

The app link host is derived from the staging Firebase project ID (`<projectId>.firebaseapp.com` and `<projectId>.web.app)). Register the Android package and release signing SHA-256 in Firebase Authentication/App Links settings. Never place email addresses, one-time email links, OOB codes, custom tokens or ID tokens in logs or repository files.
