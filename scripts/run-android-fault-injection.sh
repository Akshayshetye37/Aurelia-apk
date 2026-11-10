#!/usr/bin/env bash
set -euo pipefail

APP_ID="${AURELIA_APP_ID:-com.aurelia.pms}"
TEST_PACKAGE="${AURELIA_TEST_PACKAGE:-${APP_ID}.test}"
RUNNER="${AURELIA_TEST_RUNNER:-androidx.test.runner.AndroidJUnitRunner}"
TEST_CLASS="com.aurelia.pms.LocalPmsRepositoryInstrumentedTest"
DEVICE_ARGS=()
if [[ -n "${ANDROID_SERIAL:-}" ]]; then DEVICE_ARGS=(-s "$ANDROID_SERIAL"); fi

adb_cmd() { adb "${DEVICE_ARGS[@]}" "$@"; }
wait_for_boot() {
  adb_cmd wait-for-device
  adb_cmd shell 'while [ "$(getprop sys.boot_completed)" != "1" ]; do sleep 2; done'
}
run_instrumentation() {
  timeout 120s adb_cmd shell am instrument -w "$@"
}

checkpoints=(
  before_write
  mid_transaction
  before_commit
  after_commit_before_checkpoint
  mid_migration
)

for checkpoint in "${checkpoints[@]}"; do
  echo "=== Injecting process death at ${checkpoint} ==="
  injection_log="$(mktemp)"
  set +e
  run_instrumentation \
    -e class "${TEST_CLASS}#debugFaultCheckpointCanKillProcessForDeviceMatrix" \
    -e faultCheckpoint "$checkpoint" \
    -e killProcess true \
    "${TEST_PACKAGE}/${RUNNER}" >"$injection_log" 2>&1
  injection_status=$?
  set -e
  cat "$injection_log"
  if grep -q "configured fault checkpoint did not terminate" "$injection_log" ||
     grep -q "OK (1 test)" "$injection_log"; then
    echo "Fault hook did not terminate the instrumentation process at ${checkpoint}." >&2
    exit 1
  fi
  if [[ $injection_status -eq 0 ]]; then
    echo "Expected instrumentation process termination at ${checkpoint}, but command exited successfully." >&2
    exit 1
  fi
  rm -f "$injection_log"

  adb_cmd shell am force-stop "$APP_ID" || true
  adb_cmd reboot
  wait_for_boot

  expected=false
  [[ "$checkpoint" == "after_commit_before_checkpoint" ]] && expected=true
  echo "=== Verifying database recovery after ${checkpoint}; committed=${expected} ==="
  recovery_log="$(mktemp)"
  run_instrumentation \
    -e class "${TEST_CLASS}#verifyRecoveryAfterInjectedCrash" \
    -e preserveDatabase true \
    -e faultCheckpoint "$checkpoint" \
    "${TEST_PACKAGE}/${RUNNER}" >"$recovery_log" 2>&1 || {
      cat "$recovery_log"
      rm -f "$recovery_log"
      echo "Recovery verification failed at ${checkpoint}." >&2
      exit 1
    }
  cat "$recovery_log"
  if ! grep -q "OK (1 test)" "$recovery_log"; then
    rm -f "$recovery_log"
    echo "Recovery test did not report one passing test at ${checkpoint}." >&2
    exit 1
  fi
  rm -f "$recovery_log"
done

echo "All physical-device transaction and migration crash checkpoints recovered."
