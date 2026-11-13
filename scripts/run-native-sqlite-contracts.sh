#!/usr/bin/env bash
set -euo pipefail

attempt="${1:-1}"
case "$attempt" in
  1) boot_error="Emulator did not report completed boot."; package_error="Package manager did not become responsive after emulator boot." ;;
  2) boot_error="Second emulator boot attempt did not complete."; package_error="Package manager did not become responsive on second boot attempt." ;;
  *) echo "::error::Unsupported emulator attempt: $attempt"; exit 2 ;;
esac

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
log_dir="$repo_root/.aurelia-emulator"
mkdir -p "$log_dir"
: "${GITHUB_OUTPUT:?GitHub Actions output file is not set}"

capture_logcat() {
  adb logcat -b all -d -v threadtime > "$log_dir/logcat-full.txt" 2>&1 || true
  adb logcat -b crash -d -v threadtime > "$log_dir/logcat-crash.txt" 2>&1 || true
}
trap capture_logcat EXIT

if ! timeout -k 2s 15s adb shell getprop sys.boot_completed | grep -qx "1"; then
  echo "::error::$boot_error"
  exit 1
fi

package_manager_ready=false
for wait_attempt in {1..18}; do
  if timeout -k 2s 15s adb shell pm list packages >/dev/null 2>&1; then
    package_manager_ready=true
    break
  fi
  echo "Package manager not ready; waiting 10 seconds (attempt $wait_attempt/18)."
  sleep 10
done
if [[ "$package_manager_ready" != true ]]; then
  echo "::error::$package_error"
  exit 1
fi

# Distinguish a failed emulator boot from a failed test run.
# Once true, the workflow must never retry the instrumentation test.
echo "booted=true" >> "$GITHUB_OUTPUT"
adb shell getprop ro.build.fingerprint | tee "$log_dir/emulator-build-fingerprint.txt"
test "$(adb shell getprop ro.build.version.sdk | tr -d "\r")" = "30"

cd "$repo_root/android"
set +e
./gradlew --no-daemon --stacktrace --info connectedDebugAndroidTest \
  -Pandroid.testInstrumentationRunnerArguments.class=com.aurelia.pms.LocalPmsRepositoryInstrumentedTest \
  2>&1 | tee "$log_dir/connectedDebugAndroidTest.log"
gradle_status=${PIPESTATUS[0]}
echo "$gradle_status" > "$log_dir/gradle-exit-code.txt"
exit "$gradle_status"
