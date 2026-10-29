# Aurelia PMS

A browser-based hotel/property-management interface supplied as a single HTML file.

## Contents

- `index.html` — the supplied Aurelia PMS interface and its inline CSS/JavaScript.
- `.gitignore` — ignores common local, build, Android, and secret files.
- `docs/SECURITY.md` — security and production-readiness notes.

## Run locally

Open `index.html` in a modern browser for an initial inspection. Some features depend on network-loaded libraries or services. Android-specific features require a compatible Android WebView wrapper that implements the `AureliaNative` JavaScript bridge; that native Android project is not included in this repository yet.

## Important source limitation

The uploaded HTML source ends immediately after a CSS `</style>` block and does not include a closing `</body>` or `</html>` tag. It appears incomplete. Complete and test the source before treating this repository as a release-ready web app or building an APK.

## Before real-world use

- Replace demo/default property details, sample records, room rates, and menu items.
- Review the security notes in [docs/SECURITY.md](docs/SECURITY.md).
- Test all workflows, browser storage, backup/restore, invoice calculations, payment flows, and Android bridge behavior.
- Do not use real guest or payment data until security and privacy issues are addressed.

## Project status

Source upload and repository scaffolding only. Runtime, backend, Android, and end-to-end tests have not been completed.
