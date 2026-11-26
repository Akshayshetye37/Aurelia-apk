# Aurelia Gateway Android companion

This is the separate Android companion application for Aurelia PMS.

- Display name: **Aurelia Gateway**
- Application ID: `com.aurelia.paybridge`
- PMS application ID: `com.aurelia.pms`
- IPC service: `com.aurelia.paybridge.ipc.PayBridgeService`
- Protocol: version 1, authenticated handshake only

## Pairing and user approval

1. Install Aurelia PMS and Aurelia Gateway. Both APKs must be signed with the same controlled signing certificate; debug signing is not a production trust arrangement.
2. Open Aurelia Gateway and explicitly approve the Aurelia PMS connection.
3. Open Aurelia PMS → More → Settings → Aurelia Gateway connection.
4. Select Connect Aurelia Gateway and approve the native confirmation in Aurelia PMS.
5. PMS checks the installed package, signing identity, signature-level service permission and nonce-bound protocol handshake.
6. Either application owner can revoke the local approval or disconnect.

Package discovery alone never grants access. The service denies the handshake until the Gateway app's user approval is stored. PMS also requires an explicit in-app confirmation before it binds.

## Deliberate implementation boundary

This app currently implements only the approved, signed app-to-app handshake. It advertises only the `handshake` capability. Provider catalogue exchange, provider selection, payment creation, status, refunds, webhooks and reconciliation are not enabled by this scaffold.

The provider backend files elsewhere in this branch are separate integration material. They are not connected to this Android service and do not make any provider live.

Merchant credentials and webhook secrets must remain in a trusted backend. The Android application must not store provider secrets or write to the PMS ledger.

## Build

Requirements: JDK 17, Android SDK Platform 36, Build Tools 36, Gradle 8.11.1.

```sh
gradle --no-daemon -p gateway-app compileDebugJavaWithJavac
```

A compile-only check does not create an APK or demonstrate an installed two-app handshake. Device verification must use two APKs signed with the same test certificate and exercise both approval and revocation.
