# Printer subsystem security contract

Status: security foundation in progress. This document is a design constraint, not a statement that printer discovery or physical printing is implemented.

## Trust boundaries

1. The web application submits a semantic document (invoice, receipt, kitchen ticket, label or test page). It never submits printer command bytes, ESC/POS/ZPL/TSPL snippets, arbitrary HTML, socket destinations or arbitrary file paths.
2. Native Android code owns device discovery, OS permission prompts, pairing, USB authorization, network connections, protocol encoding and print execution.
3. A discovered device is untrusted until a user explicitly selects it. Discovery is not authorization.
4. A model name, Bluetooth name, MAC address, mDNS service name or advertised capability is untrusted metadata. It cannot establish paper width, protocol or device authenticity by itself.
5. The canonical folio/invoice remains the source of truth. Printing is a projection of a saved business document and must never mutate accounting, issue an invoice, record payment or mark a folio settled.

## Transport policy

- **Bluetooth Classic SPP:** request BLUETOOTH_SCAN only while the user is discovering devices and BLUETOOTH_CONNECT when connecting to a selected/paired printer on Android 12+. Use neverForLocation only because printer discovery is not used to derive location. Do not request BLUETOOTH_ADVERTISE; do not guess PINs or silently pair.
- **BLE:** treat BLE as a separate GATT transport. Do not assume an SPP printer supports BLE or that a BLE printer exposes an ESC/POS-compatible service. Require an explicit supported service/characteristic profile.
- **USB/OTG:** enumerate attached USB devices and request Android's per-device USB permission before opening interfaces/endpoints. No silent access to devices.
- **Wi-Fi/LAN:** prefer Android NSD/mDNS service discovery and a user-selected printer. Do not scan arbitrary subnets or probe arbitrary ports. A discovered service remains untrusted until selected.
- **Raw TCP 9100:** this protocol is commonly unauthenticated and unencrypted. Permit it only for a printer the user explicitly trusts, and only after checking the resolved peer address is still a private/link-local LAN address at connection time. Never send credentials, guest identity documents or payment secrets over raw TCP. Do not silently downgrade TLS/IPP to raw TCP.
- **Office/network printers:** prefer Android PrintManager / platform print services / IPP rather than implementing arbitrary PCL or raw network printing.
- **Android local-network permission:** when targeting Android 17 / API 37 or later, implement the platform local-network permission flow before NSD/mDNS or direct LAN socket access. Re-check the current target-SDK requirements when wiring the native adapter.

## Semantic print-document contract

The JavaScript boundary currently accepts three strict document variants:
- `folio-invoice` with an A4 layout, hotel identity, invoice identity, primary guest, itemized folio lines, tax summary, payments and reconciled totals.
- `thermal-receipt` with a 58 mm or 80 mm layout and the same canonical invoice/folio fields.
- `kitchen-ticket` with a 58 mm or 80 mm layout, outlet/order identity and bounded item/modifier/note fields.

Money is represented as integer minor units (paise for INR), not floating-point currency values. The validator rejects unknown fields, command/markup payload fields, invalid accounting totals, invalid dates, control characters, unbounded collections and mismatched document kinds. It returns an immutable snapshot so later caller mutation cannot change an accepted job. The document is a print projection only; the caller must build it from the saved canonical invoice/folio and must not accept guest-submitted totals as accounting authority.

## Native bridge and input validation

- Do not add printer commands to the generic AureliaNative.postMessage command surface.
- A typed JavaScript Capacitor plugin facade and fail-closed web stub exist. The corresponding native Kotlin plugin is not implemented yet; all web-stub calls reject. Do not enable UI entry points until native methods independently validate input and enforce trust.
- Keep the native bridge limited to a small set of actions (discover candidates, explicitly trust/select, verify capabilities, print, cancel/status); reject unknown keys and unknown enum values.
- Validate every request natively even when the JavaScript validator has already accepted it. JavaScript validation is defense in depth, not a security boundary.
- Never accept raw command bytes, arbitrary URLs, host/port pairs, arbitrary file paths, shell commands or caller-provided HTML from the WebView.
- Bound document bytes, nesting depth, item counts, string lengths, copies, connection timeouts, response sizes and queued jobs. Fail closed on malformed input, permission denial, disconnects and unsupported capabilities.
- Do not log guest PII, invoice content, payment data, credentials, raw printer data or pairing material. Audit only job identifiers, selected printer profile identifiers, status and timestamps.

## Printer identity and media profile

- Store trust only after explicit user selection and a successful controlled test.
- Confirm protocol and media geometry from authoritative model capability data where available, then verify with a calibration/test print. A name heuristic is not verification.
- Keep physical paper width (58/80 mm), printable dot width, DPI, margins and driver protocol as distinct profile fields.
- Persist a profile as unverified until the capability source is manufacturer-confirmed or calibration succeeds. Do not silently substitute 58 mm for 80 mm or vice versa.
- A device replacement, changed hardware identity, firmware/protocol change or failed calibration invalidates the verified profile and requires a new test.

## Job integrity and accounting isolation

- Assign an idempotency key to every print job. Duplicate retries must not create multiple uncontrolled prints; where the printer protocol cannot guarantee exactly-once delivery, show an explicit uncertain state rather than claiming success.
- A successful socket write is not proof of physical printing. Report transport acceptance separately from device acknowledgement and user-confirmed output.
- Invoice and POS documents must be rendered from immutable/canonical folio data. Reprints retain the original invoice identity and must not allocate a new invoice number or write accounting entries.
- Printer failure must never roll back or duplicate a folio/payment transaction.

## Required verification before enabling a transport

Automated tests must cover malformed/oversized input, unknown fields, command injection, HTML injection, untrusted/public destinations, DNS rebinding/peer-address validation, port restrictions, permission denial, device spoofing, disconnects, timeouts, duplicate jobs, cancellation, profile mismatch and audit redaction. Android instrumentation tests must cover permission and lifecycle behavior. Physical qualification must record exact printer models, firmware, transport, paper width, DPI, print density, cut/drawer behavior and test evidence.

Current implementation status: semantic JavaScript schema + native Kotlin Capacitor plugin scaffold + Android-confirmed LAN trust + AES-256-GCM/Android Keystore trust persistence + pinned-peer DNS revalidation + native semantic document validation + bounded ESC/POS renderer are present. The plugin intentionally rejects print and capability verification with `printer_profile_calibration_required` until a real printer-profile calibration workflow is implemented. No native socket write is enabled yet. LAN discovery is disabled (no subnet scanning); USB/Bluetooth/BLE transports and physical qualification remain unimplemented. Raw TCP results must remain `uncertain` unless a device protocol supplies a reliable acknowledgement.\n\nNo universal printer compatibility claim is valid without a qualified model/firmware/transport matrix.