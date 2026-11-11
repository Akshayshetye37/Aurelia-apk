# Android integration and permission policy

## Same-device PMS / Pay Bridge communication

Aurelia PMS and the future Aurelia Pay Bridge are separate Android applications installed on the same device. The supported integration boundary is an explicit bound Android service using Messenger over Binder IPC.

- PMS package: `com.aurelia.pms`
- Pay Bridge package: `com.aurelia.paybridge`
- Pay Bridge service: `com.aurelia.paybridge.ipc.PayBridgeService`
- Permission: `com.aurelia.paybridge.permission.BIND_PAY_BRIDGE`

The Pay Bridge app must declare the custom permission with `android:protectionLevel="signature"`, and its exported service must require that permission. PMS declares the corresponding `uses-permission` and a narrow `<queries><package ... /></queries>` entry for only `com.aurelia.paybridge`. Do not request `QUERY_ALL_PACKAGES`.

Both APKs must be signed with the same trusted signing certificate. Android signature permissions are granted based on signing identity; package name checks alone are not authentication. PMS additionally checks the installed package signature, binds with an explicit component, validates the returned component identity and performs the nonce-based protocol handshake.

The future service must validate the caller identity and permission on every sensitive IPC operation, validate all message fields and enforce transaction idempotency. The PMS client must fail closed on identity, signature, permission, protocol or nonce mismatch.

## Permission policy

PMS does not need SMS, call-log, contacts, location, microphone, camera, accessibility, notification-listener, overlay, package-inventory or broad-storage access for its current features. These permissions are explicitly removed during Android manifest merging and checked by CI.

Use:
- Android Photo Picker for user-selected images.
- Storage Access Framework for backup folder and document access.
- Android chooser / ACTION_VIEW intents for sharing and external navigation.
- App-private storage for application data.

The only general network permission retained is `INTERNET`, which is a normal permission, not a dangerous runtime permission. The custom Pay Bridge signature permission is a same-signer IPC control, not a user-granted runtime permission.

Do not add a dangerous or special permission merely in anticipation of a future feature. If a future core feature genuinely requires one, document its purpose, request it in context, provide a functional alternative when denied, and review current Google Play policy before adding it.

## Network transport security

All application network endpoints must use HTTPS with the platform's normal TLS certificate-chain and hostname validation. Do not add cleartext fallbacks, trust-all certificate managers, permissive hostname verifiers, or downgrade redirects.

- Capacitor's Android scheme is `https`.
- The generated Android manifest sets `android:usesCleartextTraffic="false"` and references `aurelia_network_security_config.xml`.
- The network security configuration denies cleartext traffic globally. Native transports must retain platform TLS validation and must not follow redirects to another scheme.
- Cloud API base URLs must be HTTPS origins. Payment API requests reject redirects so an endpoint cannot silently move a request to a different origin or scheme.
- Emulator HTTP endpoints are permitted only in isolated test harnesses and emulator configuration; they must never be embedded in production application source or release assets.

CI scans application source and native templates for cleartext HTTP endpoints and verifies the Capacitor and Android generation policy. Android APK/device verification remains a separate qualification step.

## Navigation

Android Back is handled in this order: close an open modal/sheet, return from a nested in-app section, navigate to Home, then allow Android to finish the Activity. External links and phone actions use Android system intents. No Accessibility Service or overlay is needed for navigation.

## Release signing

Use a deliberately controlled signing key for both apps. Do not rely on each project's independently generated default debug keystore for cross-app testing. Keep private signing material out of Git; use protected CI secrets for release signing. If Google Play App Signing is used, coordinate the app-signing certificate used by both applications and verify the installed signer at runtime. Test the actual installed APK pair, not only source configuration.
