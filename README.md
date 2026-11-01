# Aurelia APK / PMS workspace

This repository currently contains two distinct application codebases. They are intentionally kept separate while architecture and integration contracts are established.

## Repository layout

- Root `index.html`, `package.json`, `capacitor.config.json`, `scripts/`, and root `.github/workflows/`: existing root Capacitor application and its build pipeline.
- `pms/`: source-preserving import of `Akshayshetye37/Designer-apk@main`, including its web UI, standalone Android project, native activity, build workflow source and source ZIP.
- `docs/IMPLEMENTATION_ROADMAP.md`: architecture decisions, trust boundaries, phased delivery plan, exit criteria and immediate priorities.
- Aurelia Pay Bridge remains a separate repository and Android application. Payment backend services are not included in this repository.

## Important separation

The root application and imported `pms/` snapshot are not currently integrated. Their web entry points are different versions. The root Capacitor Android project and `pms/android` are separate Android projects and both currently use the `com.aurelia.pms` application ID. Do not build/install them as separate production apps until the application-ID and packaging strategy is resolved.

The imported files under `pms/` are retained unchanged from the source snapshot. Do not edit them as part of root application work unless a task explicitly authorizes changing the imported PMS.

## Build the root Capacitor application

```bash
npm ci
npm run build
npx cap sync android
```

The root Android project must already be generated/available for Android build commands. See the root GitHub Actions workflows for the current CI build sequence.

## Imported PMS source

The imported PMS source is under `pms/`. Its README and native Android project describe the source snapshot. Its nested `pms/.github/workflows/android-apk.yml` is retained as source material; GitHub does not execute workflow files nested below the repository-root `.github/workflows/` directory. The workflow also assumes its project files are at repository root, so it must not be copied into the root workflow directory unchanged.

## Payment architecture

- PMS owns booking, guest, folio and property-accounting records.
- Aurelia Pay Bridge owns native checkout and validated IPC.
- A separate server-side Payment API owns provider credentials, payment/refund state, webhook verification, idempotency and reconciliation.
- PMS folio credits are posted only from authenticated, verified, idempotent backend events.
- Local payment matching, manual confirmation, UI state and provider SDK callbacks are not authoritative proof of payment.

## Production status

This branch is a source import and planning baseline, not a production payment integration. Do not process real guest data or live payments based solely on the presence of these files. Follow [the implementation roadmap](docs/IMPLEMENTATION_ROADMAP.md) and its release gates.
