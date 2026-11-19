#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

echo "== 1/5: Verify application source =="
npm test
npm run build

STAMP="$(date +%Y%m%d-%H%M%S)"
BACKUP="$ROOT/../Aurelia-apk-android-backup-$STAMP"
TMP="$(mktemp -d)"
HAD_ANDROID=0
if [ -d "$ROOT/android" ]; then
  HAD_ANDROID=1
  cp -a "$ROOT/android" "$BACKUP"
  echo "Existing Android project backed up to: $BACKUP"
  if [ -d "$BACKUP/templates" ]; then
    cp -a "$BACKUP/templates" "$TMP/templates"
  fi
  if [ -f "$BACKUP/app/google-services.json" ]; then
    cp -a "$BACKUP/app/google-services.json" "$TMP/google-services.json"
  fi
fi

restore_on_failure() {
  status=$?
  if [ "$status" -ne 0 ] && [ "$HAD_ANDROID" -eq 1 ] && [ -d "$BACKUP" ]; then
    echo "Generation failed. Restoring the previous Android directory from backup."
    rm -rf "$ROOT/android"
    cp -a "$BACKUP" "$ROOT/android"
  fi
  rm -rf "$TMP"
  exit "$status"
}
trap restore_on_failure EXIT

echo "== 2/5: Generate a clean Capacitor Android project =="
rm -rf "$ROOT/android"
npx cap add android
test -f "$ROOT/android/app/src/main/AndroidManifest.xml"

echo "== 3/5: Restore Aurelia native templates and Firebase config =="
mkdir -p "$ROOT/android/templates"
if [ -d "$TMP/templates" ]; then
  cp -a "$TMP/templates/." "$ROOT/android/templates/"
else
  echo "ERROR: Native templates were not present in the Android backup."
  exit 1
fi
if [ -f "$TMP/google-services.json" ]; then
  cp -a "$TMP/google-services.json" "$ROOT/android/app/google-services.json"
fi

echo "== 4/5: Apply Aurelia native integrations =="
node scripts/patch-android.js

echo "== 5/5: Sync Capacitor plugins and web assets =="
npx cap sync android

echo "Android project regenerated and synced successfully."
if [ "$HAD_ANDROID" -eq 1 ]; then
  echo "Previous Android project remains available at: $BACKUP"
fi
echo "No PMS source files, payment modules, tests, or signing credentials were deleted."
