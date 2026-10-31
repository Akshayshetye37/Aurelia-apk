# Aurelia PMS Android regeneration

## Safe regeneration

Run from the repository root:

```bash
bash scripts/regenerate-android-safe.sh
```

The script runs the test suite and web build before changing Android files. It then backs up the complete existing `android/` directory outside the repository, regenerates the Capacitor Android project, restores the tracked native templates and any existing `google-services.json`, reapplies Aurelia's native integration patches, and syncs Capacitor.

If generation fails, the script restores the previous `android/` directory from the backup. The backup is retained after success too. It does not delete PMS web source, payment modules, tests, or signing credentials.

## Launcher icon

Save the approved 512 x 512 Aurelia PMS launcher artwork as:

```
assets/aurelia-icon.png
```

The Android patch script copies this PNG into `mipmap-nodpi` and creates adaptive launcher icon resources. This path does not require Sharp, which is useful on Termux. Existing SVG assets remain as a backward-compatible fallback.

## Build boundary

Regeneration and Capacitor sync do not themselves produce an APK. A compatible Android SDK, Java/Gradle toolchain, and release-signing identity are still required to build and sign a distributable release APK. Never commit a keystore or passwords to the repository.
