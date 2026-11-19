# Aurelia Public SaaS Permission Matrix

Status: proposed; server enforcement and emulator tests are required before use.
Related: [Public SaaS Identity and Tenancy Strategy](PUBLIC-SAAS-IDENTITY-TENANCY-STRATEGY.md).

## Authorization model

A role is a default permission bundle. A request must be authenticated, have an active membership in the requested property, and pass the resource-specific permission check. Property IDs, UIDs, role names, and resource IDs supplied by the client are never sufficient authority.

The server is authoritative. Client-side permission checks may hide controls but cannot grant or deny security by themselves. Admin SDK callables must perform their own checks because Admin SDK bypasses Firestore rules.

## Initial role matrix

Legend:
- **Full**: allowed for the role, subject to validation/audit.
- **Scoped**: allowed only for assigned resources or limited fields.
- **Read**: read-only.
- **No**: denied.
- **Owner-only**: only the active property owner.

| Permission | Owner | Manager | Front desk | Housekeeping | Kitchen | Accountant |
|---|---|---|---|---|---|---|
| Read property profile | Full | Full | Read | Read | Read | Read |
| Edit property settings | Full | Scoped | No | No | No | No |
| Read rooms | Full | Full | Full | Scoped | Scoped | Read |
| Manage room inventory/status | Full | Full | Scoped | Scoped | No | No |
| Read reservations | Full | Full | Full | Scoped | Scoped (room orders only) | Read |
| Create/update reservations | Full | Full | Full | No | No | No |
| Cancel reservations | Full | Full | Scoped | No | No | No |
| Read guest profiles | Full | Full | Scoped | No | Scoped (billing context only) | Read |
| Manage guest profiles | Full | Full | Scoped | No | No | No |
| Housekeeping tasks/status | Full | Full | Read | Scoped | No | No |
| Restaurant orders | Full | Full | Scoped | Full | Full | Read |
| Menu management | Full | Full | No | No | Scoped | No |
| Inventory | Full | Full | Read | Scoped | No | Read |
| Expense entry | Full | Full | No | No | Scoped (approved kitchen expenses only) | Full |
| Financial reports | Full | Full | Scoped | No | No | Full |
| Create/edit financial entries | Full | Scoped | Scoped (folio charges only) | No | No | Full |
| Refund/void/settlement actions | Full | No by default | No | No | No | Scoped only with explicit policy |
| Export property data | Full | Scoped | No | No | No | Scoped |
| Backup/restore | Full | No | No | No | No | No |
| Invite staff | Full | Scoped (non-owner roles only) | No | No | No | No |
| Revoke/change staff roles | Full | Scoped (cannot change owner/manager or self) | No | No | No | No |
| Transfer ownership | Owner-only | No | No | No | No | No |
| Delete property | Owner-only | No | No | No | No | No |
| Delete account | User lifecycle; property ownership must be resolved first | User lifecycle | User lifecycle | User lifecycle | User lifecycle | User lifecycle |

## Permission identifiers

Use stable, explicit permission names in the implementation. Role labels must not be used as permission checks in UI or service code.

Proposed identifiers:

- `property.read`, `property.settings.write`
- `membership.invite`, `membership.revoke`, `membership.role.change`
- `property.owner.transfer`, `property.delete`
- `rooms.read`, `rooms.manage`
- `reservations.read`, `reservations.create`, `reservations.update`, `reservations.cancel`
- `guests.read`, `guests.manage`
- `housekeeping.read`, `housekeeping.manage`
- `restaurant.orders.read`, `restaurant.orders.manage`, `restaurant.menu.manage`
- `inventory.read`, `inventory.manage`
- `finance.read`, `finance.entry.create`, `finance.entry.manage`, `finance.refund`, `finance.settlement`
- `data.export`, `backup.create`, `backup.restore`

## Rules for role changes and membership lifecycle

1. Membership status must be `ACTIVE`; pending, suspended, and revoked memberships grant no access.
2. Owners can grant only supported roles. The client cannot write role/membership documents.
3. Managers cannot grant owner or manager roles unless a later explicit policy permits it.
4. The last active owner cannot be removed, demoted, or transferred without a validated owner-transfer transaction.
5. A user cannot revoke their own membership if that would leave no active owner.
6. Invitation acceptance is authenticated and recipient-bound; tokens are hashed, one-use, and expire.
7. Role changes and revocations create audit records.
8. Online access must be denied after revocation. Offline behavior and stale-cache expiry require an explicit policy and qualification.
9. Sensitive financial operations must use explicit permissions and audit events, not broad manager/owner shortcuts.
10. Unknown roles and unknown permissions deny access.

## Required authorization tests

For every role/resource pair, test both allowed and denied cases. Include:

- Unauthenticated request.
- Authenticated user without membership.
- Pending membership.
- Suspended/revoked membership.
- Cross-property resource ID.
- Client-supplied role/UID/property ID tampering.
- Owner-only operation by manager.
- Manager attempting to grant owner.
- Last-owner removal/demotion.
- Expired/replayed invitation.
- Invitation accepted by wrong account/phone.
- Admin SDK callable with missing or wrong auth context.
- Storage object path belonging to another property.
- Membership revoked while a session/device is active.
- Account switch with local cache present.

A permission-matrix test suite must be generated from the matrix so policy drift is detected. The matrix is not authorization evidence until the rules and server implementation are tested against it.
