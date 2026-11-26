# Aurelia Gateway — Provider Integration Workspace

This branch contains the separate **Aurelia Gateway** Android companion application scaffold and provider/backend integration material for the Aurelia product ecosystem.

- **Companion app display name:** Aurelia Gateway
- **Android application ID:** \`com.aurelia.paybridge\`
- **PMS application ID:** \`com.aurelia.pms\`
- **Android app project:** \`gateway-app/\`
- **PMS integration:** built into the Aurelia PMS \`main\` branch; see [PMS PayBridge integration](https://github.com/Akshayshetye37/Aurelia-apk/blob/main/README.md#aurelia-paybridge-and-the-future-aurelia-gateway-app).

The Gateway app is a separate optional install. Its current Android service implements an explicitly approved, signature-protected protocol-v1 handshake only. Provider adapters and backend code in this branch are integration material; they are not yet connected to the Android IPC service and do not enable live collection.

## Pairing security and current limits

- The Gateway user must approve Aurelia PMS connection in the Gateway app.
- The PMS user must separately approve the connection in Aurelia PMS Settings.
- Both APKs must be signed with the same controlled signing certificate.
- The service checks the signature-level bind permission, PMS package identity and Gateway-side approval before responding to the handshake.
- The only advertised capability is \`handshake\`. Provider catalogue exchange, payment initiation, refunds, webhook delivery and reconciliation are not enabled over IPC.
- Provider secrets remain in the trusted backend. Gateway never writes directly to the PMS ledger.
- Do not enable live collection or automatic settlement based on this app-to-app handshake.

## Build the companion Android source

Requirements: JDK 17, Android SDK Platform 36, Android Build Tools 36 and Gradle 8.11.1.

\`\`\`sh
gradle --no-daemon -p gateway-app compileDebugJavaWithJavac
\`\`\`

This is a compile-only command. It does not assemble or sign an APK and does not prove an installed two-app connection. Physical-device qualification is still required.

## Provider backend

The \`payment-backend/\` directory contains the separate trusted-backend/provider adapter foundation. Consult [payment-backend/README.md](payment-backend/README.md) and [Provider Integration Status](docs/PROVIDER_INTEGRATION_STATUS.md) for exact provider qualification boundaries. A provider appearing in a catalogue is not proof of merchant UAT, production certification or live-payment readiness.
