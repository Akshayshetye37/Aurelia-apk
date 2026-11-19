# Aurelia Public SaaS Identity and Tenancy Strategy

Status: proposed architecture; implementation must follow staged gates.
Branch: `work/public-saas-foundation`
Scope: public Google Play distribution to unrelated businesses and users.

## Product contract

Aurelia is one public application backed by shared platform infrastructure. Every customer registers their own account, creates or joins one or more properties, and receives access only through explicit property membership and permissions. No developer, founder, hotel, phone number, or property identity is hardcoded as the default customer.

A user may own multiple properties. A property may have multiple staff members. A user may be a member of multiple properties with different roles. Property names, business type, address, rooms, restaurant configuration, bookings, guest records, and operational data are customer-created data.

## Current-state evidence

- PMS local identity is generated per installation and is explicitly scoped `LOCAL_ONLY`.
- The existing personal-cloud connection verifies read access to a user-selected Google Cloud project. It does not upload, back up, replicate, or synchronize PMS data.
- Cloud sync is disabled by default and has no transport.
- The local-first architecture document states that canonical PMS migration and atomic outbox/UI cutover are incomplete.
- Recovery phone authentication and recovery-owner claims are separate from ordinary PMS authentication. Recovery remains disabled by default.
- Firestore rules currently deny direct access to recovery/security collections; there is no general public-customer PMS authorization system in those rules.

These findings prohibit treating the existing local installation ID, recovery tenant claim, recovery phone, or personal Google OAuth connection as the public SaaS account identity.

## Architecture decisions

### 1. Shared platform, customer-owned tenant data

Use the existing Firebase platform as the candidate shared backend, subject to a dedicated implementation review. Do not introduce a second BaaS solely to implement tenancy.

The shared Firebase project is platform infrastructure. It is not a personal cloud project belonging to the app developer or first customer. Customer records are scoped by server-authorized property IDs.

### 2. Primary PMS authentication

Initial public onboarding should use Firebase Authentication with verified phone-number sign-in, matching the mobile-first registration requirement. Phone OTP is an authentication mechanism only; it must not be treated as a vault recovery credential or DEK derivation input.

The primary PMS Auth instance/session must be distinct from the dedicated recovery Auth instance. Authenticated UID is derived from the verified Firebase token, never from a client-supplied UID.

Account lifecycle requirements: sign-in, sign-out, session revocation, phone-change re-verification, account deletion, and recovery of the account itself must be designed and tested. SMS abuse controls, cost limits, rate limits, App Check, and provider configuration are launch requirements.

### 3. Tenant is a property/business, not a user or device

Canonical cloud tenant scope is `propertyId`. A property can represent a hotel, homestay, restaurant, or combined operation. Business type is a validated property attribute, not a security boundary.

Local `LOCAL_ONLY` installation IDs remain local until an explicit claim/link flow succeeds. Never silently convert a local ID to a cloud tenant or merge snapshots.

### 4. Membership and role authorization

A user gains property access through a server-created membership. Roles are permission bundles, not identity claims that the client can self-assign.

Initial roles:
- `owner`: property lifecycle, membership administration, configuration, and all permitted operations.
- `manager`: operational administration, but no owner transfer or security-sensitive owner actions.
- `front_desk`: reservations, check-in/out, guest-facing operational workflows.
- `housekeeping`: assigned room status and housekeeping tasks.
- `kitchen`: restaurant order preparation and service.
- `accountant`: permitted billing and financial views/operations.

Start with a deny-by-default permission matrix. Avoid broad `write` permissions for every member. Permission checks are enforced in Firestore rules and trusted Cloud Functions; UI visibility is only presentation.

### 5. Proposed Firestore data model

- `users/{uid}`: minimal account profile and lifecycle metadata. Do not duplicate raw phone numbers unless required; Firebase Auth is the identity source.
- `users/{uid}/propertyMemberships/{propertyId}`: user-facing list of memberships. Server-maintained.
- `properties/{propertyId}`: property name, type, owner UID, status, settings, created/updated timestamps.
- `properties/{propertyId}/members/{uid}`: role, membership status, permissions version, joined/updated timestamps.
- `properties/{propertyId}/invitations/{inviteId}`: server-generated, hashed, single-use invitation token metadata, intended recipient binding, role, expiry and status.
- Property operational data stays below `properties/{propertyId}/...` or uses an immutable property scope field validated by the server. Avoid global collections whose authorization depends on client-side filtering.

Property IDs are opaque identifiers, not secrets or authorization tokens.

### 6. Provisioning and membership operations

Trusted Cloud Functions should perform:
- Create property and owner membership atomically.
- Create invitation with limited role, recipient binding, expiry, and one-time token.
- Accept invitation after authenticated recipient verification.
- Revoke membership and invalidate relevant sessions/device access.
- Change role with owner-only rules and prevent removal/demotion of the last active owner.
- Owner transfer with explicit confirmation, audit record, and rollback-safe transaction.
- Delete property/account through a defined retention and export process.

Clients must not create their own owner membership, choose an authoritative owner UID, or modify membership/role documents directly.

### 7. Data and file isolation

- Every cloud operational record is property-scoped.
- Rules/functions verify active membership and role before access.
- Cloud Storage paths use `properties/{propertyId}/...`; rules independently verify membership. A path is not proof of authorization.
- Never accept a property ID as the sole authorization input.
- Validate ownership of referenced records (room, booking, guest, order, file) to prevent cross-property object-reference attacks.
- Admin SDK functions bypass Firestore rules; each callable must perform explicit authentication and authorization checks.
- Deny by default for unknown collections and fields.

### 8. Local-first and synchronization boundary

Cloud account registration/property setup must not automatically upload existing local PMS data.

Before enabling sync:
1. Complete canonical repository/UI cutover on Android SQLite and browser IndexedDB.
2. Prove business mutation and outbox event atomicity on each platform.
3. Define local installation/device enrollment and tenant binding.
4. Build explicit opt-in cloud sync and snapshot bootstrap.
5. Define idempotency, aggregate versioning, retry, conflict quarantine, deletion propagation, and membership-revocation behavior.
6. Add server-side schema validation and audit.
7. Verify migration from existing `LOCAL_ONLY` installations without data loss or accidental merge.
8. Qualify offline operation and reconnect on physical devices.

Cloud sync is not backup. Backup, restore, export, and sync have separate authorization and user-consent contracts.

### 9. Vault and recovery separation

PMS account authentication, property authorization, local vault unlock, recovery-phone proof, recovery grant, and cloud administrator identity are distinct authorities.

- PMS sign-in does not unlock the vault.
- Property membership does not automatically share a DEK.
- Phone OTP does not derive, regenerate, replace, or unwrap a DEK.
- Recovery grants are owner/tenant/device/scope/nonce/expiry/one-use bound.
- Backup export/restore is bound to the source vault owner and explicit authorized destination.
- No implicit cross-user restore, merge, owner transfer, or key sharing.

The existing vault design remains local and owner-specific until a separate key-sharing/revocation architecture is reviewed. Do not invent a property-wide DEK or retrofit owner UID into legacy backup envelopes without migration and recovery semantics.

## Public onboarding flow

1. Welcome: sign in or create account.
2. Verify mobile number through the primary PMS Auth provider.
3. Create minimal user profile.
4. Choose: create a property or accept an invitation.
5. Create property: name, business type (hotel/homestay/restaurant/combined), optional address and initial settings.
6. Trusted backend creates property and owner membership.
7. Show explicit cloud-data/sync consent; local PMS mode remains available.
8. If existing local data is present, offer a separately reviewed claim/import flow. Preview, validate, back up, and require confirmation before any data migration.
9. Add staff through invitation, never by entering a UID and assigning a role directly.

## Threat model and invariants

Protect against:
- Client tampering with UID, property ID, role, owner UID, resource ID, invitation recipient, or storage path.
- Cross-tenant reads/writes and IDOR/object-reference attacks.
- Staff privilege escalation and unauthorized owner transfer.
- Replayed/expired invitations and duplicate property provisioning.
- Revoked users using stale sessions or offline caches.
- Account switching exposing another user's local data.
- SMS abuse, account enumeration, OTP interception/SIM swap.
- Admin SDK functions bypassing security rules.
- Local data being uploaded during onboarding without consent.
- Sync conflicts silently overwriting reservations, folios, or financial records.
- Recovery identity being reused as PMS login or vault authorization.

Security invariants:
1. Server derives UID from verified Auth token.
2. Server validates active membership for every property-scoped operation.
3. Client cannot create or mutate authoritative membership/role/owner documents.
4. Property creation atomically creates the property and first owner membership.
5. No cross-property resource references.
6. Default deny.
7. Revocation blocks online access immediately; offline revocation semantics are explicitly bounded and tested.
8. No secret or private credential is committed to the repository or APK.
9. Production recovery remains disabled until recovery qualification is complete.
10. Cloud sync remains disabled until local canonical repository and atomic outbox requirements are satisfied.

## Phased implementation plan

### Phase 0 — Architecture and threat model
- Record current-state evidence and decisions.
- Define role/permission matrix and property lifecycle.
- Define account, membership, invitation, deletion, export, and revocation semantics.
- Review Firestore and Storage rule constraints.

Acceptance: reviewed architecture; no unresolved owner/vault/key-sharing assumptions.

### Phase 1 — Authentication foundation
- Implement public account registration/sign-in using primary Firebase Auth.
- Separate primary Auth from recovery FirebaseApp/Auth.
- Add lifecycle/session state, sign-out, revocation, phone-change re-verification and error handling.
- Add App Check and server-side abuse controls.
- Test account switching and stale-session handling.

Acceptance: verified UID comes only from Firebase Auth; no recovery state or local installation ID can masquerade as a PMS account.

### Phase 2 — Property provisioning
- Implement create-property callable/transaction.
- Create owner membership and user membership index atomically.
- Validate property name/type/address and idempotency.
- Add property selector and multiple-property support.

Acceptance: independently registered users create isolated properties; duplicate/replayed requests cannot create inconsistent owner state.

### Phase 3 — Authorization and data rules
- Add deny-by-default Firestore and Storage rules.
- Add permission helpers and trusted callable authorization.
- Add membership lifecycle and owner protections.
- Add negative tests for cross-tenant access, role escalation, stale membership, object references, and Storage path manipulation.

Acceptance: comprehensive emulator tests prove unauthorized access is denied; no client-only isolation.

### Phase 4 — Invitations and staff
- One-time recipient-bound invitation.
- Role assignment/revocation.
- Last-owner protection and owner transfer.
- Membership audit.

Acceptance: invited staff access only assigned properties and permissions; revocation is tested.

### Phase 5 — Local identity linking and cloud sync
- Complete canonical PMS UI cutover.
- Android SQLite and browser IndexedDB contract parity.
- Atomic outbox on each engine.
- Device enrollment and property binding.
- Explicit opt-in; snapshot/bootstrap; conflict handling; deletion propagation; membership revocation.
- Existing local-only migration/claim workflow.

Acceptance: no data loss; no accidental upload; exact tenant binding; offline/reconnect qualification.

### Phase 6 — Vault, backup and account lifecycle
- Explicit vault-owner binding to account/property where applicable.
- Backup authorization, export, restore, and account/property deletion semantics.
- No implicit DEK sharing.
- Data retention/erasure and support/break-glass policies.

Acceptance: negative tests prove PMS login cannot unlock a vault and unauthorized user cannot export/restore another owner's backup.

### Phase 7 — Public launch qualification
- Play Store privacy/data-safety declarations and privacy policy.
- Terms, support, account deletion, data export.
- Firebase quotas, SMS cost/abuse controls, alerts and incident response.
- Production WIF/IAM, environment protections, two-admin ownership.
- Gate 3/4/5 evidence and release sign-off.
- Production recovery remains disabled until separately approved.

Acceptance: release checklist and exact-SHA evidence; no launch claims based on emulator-only or documentation-only tests.

## Risks and dependencies

- Firebase Phone Auth can incur SMS costs and is vulnerable to SIM-swap/social engineering; rate limits, App Check, account recovery and alternative identity options require product review.
- Firestore rules cannot safely express every complex transaction; sensitive membership/provisioning flows should be server-side.
- Existing local data is not automatically cloud-ready. The UI still uses compatibility/local paths; sync transport must not be enabled prematurely.
- Staff access revocation and offline devices require an explicit stale-access policy.
- Shared-property cloud data and local encrypted vaults are different security models; key sharing is not implied.
- Account/property deletion has legal, financial-record retention and backup implications.
- Cloud service costs and operational ownership must be established before public onboarding.

## Acceptance criteria for the public multi-tenant foundation

- A new user can register with their own verified mobile number.
- A new user can create a property using their own business name/type.
- Another user cannot read, write, list, export, restore, or reference the first user's property data.
- A user can own/join multiple properties.
- Staff invitations are recipient-bound, expiring and one-use.
- Role changes and revocation are server-authorized and audited.
- Last active owner cannot be accidentally removed.
- Client-supplied UID/property/role values cannot elevate access.
- Account switching cannot expose prior user's local or cached data.
- Existing local-only data remains local until explicit reviewed migration and consent.
- PMS authentication cannot unlock or recover the encrypted vault.
- Sync, production recovery, and live payments remain disabled until their separate qualification gates pass.
