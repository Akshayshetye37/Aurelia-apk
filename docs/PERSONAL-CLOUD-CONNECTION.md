# Aurelia personal cloud connection (optional)

## Product contract

- Local device storage remains the default and authoritative operating mode.
- Personal cloud connection is opt-in, user-owned and revocable.
- No cloud connection is required for startup or local PMS operations.
- This first connection flow verifies read access to the user's selected Google Cloud project only. It does not upload, back up, replicate or synchronize PMS data.
- Any future cloud data operation requires separate design, explicit consent and server-side authorization.

## User setup

1. The user creates or selects their own Google Cloud project.
2. The user configures the Google OAuth consent screen and creates an OAuth 2.0 Web application client ID.
3. The user adds the exact Aurelia app origin and path as an authorized redirect URI.
4. The user enables the Cloud Resource Manager API and grants their Google identity permission to view the selected project.
5. In Aurelia, open Personal cloud · optional, enter the OAuth client ID and project ID, then choose Connect Google Cloud.
6. Google handles consent. Aurelia uses authorization-code flow with PKCE and the read-only cloudplatformprojects.readonly scope.

## Security properties

- No client secret or service-account private key is requested or shipped in the APK.
- OAuth state is checked and the PKCE verifier is transient in session storage.
- Access tokens exist only in memory; they are not written to localStorage, IndexedDB, logs or app data.
- Disconnect clears the local public configuration and in-memory token, then requests token revocation.
- The selected project is verified through Cloud Resource Manager before the UI reports Connected.
- Token expiry requires fresh authorization; no persistent refresh token is requested.
- No automatic upload or sync transport is enabled.

## Constraints

- Each user must configure an OAuth client for the exact deployed app redirect URI and consent-screen audience.
- Project read access is not permission to create resources or deploy services.
- Connected does not mean PMS data is backed up or synchronized; the UI explicitly says no PMS data is uploaded.
- GitHub Actions Gate 3 continues to use separate staging-only Workload Identity Federation credentials. Personal user OAuth must never be used for CI deployment.
