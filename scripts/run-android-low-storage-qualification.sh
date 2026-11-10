#!/usr/bin/env bash
set -euo pipefail

: "${CONFIRM_DESTRUCTIVE_LOW_STORAGE_TEST:?Set CONFIRM_DESTRUCTIVE_LOW_STORAGE_TEST=YES on a dedicated test device}"
[[ "$CONFIRM_DESTRUCTIVE_LOW_STORAGE_TEST" == "YES" ]] || { echo "Explicit confirmation required." >&2; exit 2; }

APP_ID="${AURELIA_APP_ID:-com.aurelia.pms}"
TEST_PACKAGE="${AURELIA_TEST_PACKAGE:-${APP_ID}.test}"
RUNNER="${AURELIA_TEST_RUNNER:-androidx.test.runner.AndroidJUnitRunner}"
TEST_CLASS="com.aurelia.pms.LocalPmsRepositoryInstrumentedTest"
LEAVE_KB=49152
MAX_FILL_MB="${AURELIA_MAX_FILL_MB:-4096}"
DEVICE_ARGS=()
if [[ -n "${ANDROID_SERIAL:-}" ]]; then DEVICE_ARGS=(-s "$ANDROID_SERIAL"); fi
adb_cmd() { adb "${DEVICE_ARGS[@]}" "$@"; }

FILL_FILE="/data/local/tmp/aurelia-low-storage-qualification.bin"
cleanup() {
  adb_cmd shell rm -f "$FILL_FILE" >/dev/null 2>&1 || true
  adb_cmd shell am force-stop "$APP_ID" >/dev/null 2>&1 || true
}
trap cleanup EXIT

available_kb="$(adb_cmd shell df -k /data | tr -d '\r' | awk 'NR==2 {print $4}')"
[[ "$available_kb" =~ ^[0-9]+$ ]] || { echo "Could not determine /data free space." >&2; exit 1; }
fill_kb=$((available_kb - LEAVE_KB))
if (( fill_kb <= 0 )); then
  echo "Device already has 48 MiB or less free; refusing to write a filler file." >&2
  exit 1
fi
fill_mb=$((fill_kb / 1024))
if (( fill_mb > MAX_FILL_MB )); then
  echo "Would need to write ${fill_mb} MiB; exceeds AURELIA_MAX_FILL_MB=${MAX_FILL_MB}. Raise the cap only for a dedicated device." >&2
  exit 1
fi

echo "Filling /data to approximately 48 MiB free (${fill_mb} MiB filler)."
adb_cmd shell "dd if=/dev/zero of=${FILL_FILE} bs=1M count=${fill_mb}"
adb_cmd shell sync
adb_cmd shell df -h /data

echo "Running migration and atomic-write qualification under low storage."
timeout 240s adb "${DEVICE_ARGS[@]}" shell am instrument -w \
  -e class "${TEST_CLASS}#lowStorageQualificationKeepsMigrationAndWritesAtomic" \
  -e runLowStorage true \
  "${TEST_PACKAGE}/${RUNNER}"

echo "Low-storage database qualification passed."
