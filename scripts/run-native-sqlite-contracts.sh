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

# The biometric recovery test requires both a secure lock screen and an
# enrolled strong biometric. Configure these only on this disposable emulator.
emulator_pin="246810"
adb shell locksettings set-pin "$emulator_pin" | tee "$log_dir/secure-lockscreen-setup.log"
adb shell am start -a android.settings.FINGERPRINT_ENROLL
sleep 2

ui_xml="$log_dir/fingerprint-enrollment-window.xml"
dump_enrollment_ui() {
  timeout -k 2s 10s adb shell uiautomator dump /sdcard/aurelia-fingerprint-enrollment.xml >/dev/null 2>&1
  adb pull /sdcard/aurelia-fingerprint-enrollment.xml "$ui_xml" >/dev/null 2>&1
}
ui_has_text() {
  dump_enrollment_ui
  python3 - "$ui_xml" "$1" <<'PY'
import sys
import xml.etree.ElementTree as ET
root = ET.parse(sys.argv[1]).getroot()
needle = sys.argv[2].casefold()
raise SystemExit(0 if any(needle in (node.attrib.get("text", "") + " " +
    node.attrib.get("content-desc", "")).casefold() for node in root.iter()) else 1)
PY
}
ui_has_edit_text() {
  dump_enrollment_ui
  python3 - "$ui_xml" <<'PY'
import sys
import xml.etree.ElementTree as ET
root = ET.parse(sys.argv[1]).getroot()
raise SystemExit(0 if any("EditText" in node.attrib.get("class", "") for node in root.iter()) else 1)
PY
}
tap_enrollment_label() {
  dump_enrollment_ui
  local point
  point="$(python3 - "$ui_xml" "$1" <<'PY'
import sys
import xml.etree.ElementTree as ET
root = ET.parse(sys.argv[1]).getroot()
parents = {child: parent for parent in root.iter() for child in parent}
needle = sys.argv[2].casefold()
for node in root.iter():
    value = (node.attrib.get("text", "") + " " +
             node.attrib.get("content-desc", "")).strip().casefold()
    if value != needle:
        continue
    target = node
    while target in parents and target.attrib.get("clickable") != "true":
        target = parents[target]
    bounds = target.attrib.get("bounds", "")
    if not bounds:
        continue
    import re
    match = re.fullmatch(r"\[(\d+),(\d+)\]\[(\d+),(\d+)\]", bounds)
    if match:
        x1, y1, x2, y2 = map(int, match.groups())
        print((x1 + x2) // 2, (y1 + y2) // 2)
        raise SystemExit(0)
raise SystemExit(1)
PY
)" || return 1
  read -r x y <<< "$point"
  adb shell input tap "$x" "$y"
  sleep 1
}

# Re-enter the emulator PIN if the enrollment activity requests it.
if ui_has_edit_text; then
  adb shell input text "$emulator_pin"
  adb shell input keyevent KEYCODE_ENTER
  sleep 2
fi
for attempt in {1..12}; do
  if tap_enrollment_label "More"; then continue; fi
  if tap_enrollment_label "I agree"; then break; fi
  if tap_enrollment_label "Next"; then continue; fi
  if ui_has_text "Touch the sensor"; then break; fi
  sleep 1
done
if ui_has_text "I agree"; then tap_enrollment_label "I agree"; fi
sensor_ready=false
for attempt in {1..20}; do
  if ui_has_text "Touch the sensor"; then sensor_ready=true; break; fi
  sleep 1
done
if [[ "$sensor_ready" != true ]]; then
  dump_enrollment_ui
  cp "$ui_xml" "$log_dir/fingerprint-enrollment-failed-window.xml"
  echo "::error::Fingerprint enrollment did not reach the sensor prompt."
  exit 1
fi
for touch in {1..4}; do
  adb emu finger touch 1
  sleep 1
  adb emu finger remove
  sleep 1
done
enrollment_done=false
for attempt in {1..20}; do
  if tap_enrollment_label "Done"; then enrollment_done=true; break; fi
  sleep 1
done
if [[ "$enrollment_done" != true ]]; then
  dump_enrollment_ui
  cp "$ui_xml" "$log_dir/fingerprint-enrollment-failed-window.xml"
  echo "::error::Fingerprint enrollment did not complete."
  exit 1
fi
adb shell input keyevent KEYCODE_HOME
adb shell dumpsys fingerprint > "$log_dir/fingerprint-enrollment-dump.txt" 2>&1

results_dir="$log_dir/junit-results"
rm -rf "$results_dir"
mkdir -p "$results_dir"

run_suite() {
  local suite="$1"
  local selector="$2"
  local output="$results_dir/$suite"
  rm -rf app/build/outputs/androidTest-results/connected app/build/reports/androidTests/connected
  set +e
  ./gradlew --no-daemon --stacktrace --info connectedDebugAndroidTest \
    "-Pandroid.testInstrumentationRunnerArguments.class=$selector" \
    2>&1 | tee "$log_dir/$suite.log"
  local gradle_status=${PIPESTATUS[0]}
  set -e
  echo "$gradle_status" > "$log_dir/$suite-gradle-exit-code.txt"
  if [[ "$gradle_status" -ne 0 ]]; then
    return "$gradle_status"
  fi
  local junit_root="app/build/outputs/androidTest-results/connected"
  if [[ ! -d "$junit_root" ]]; then
    echo "::error::The $suite instrumentation suite produced no JUnit result directory."
    return 1
  fi
  mkdir -p "$output"
  cp -a "$junit_root/." "$output/"
}

run_suite repository com.aurelia.pms.LocalPmsRepositoryInstrumentedTest
run_suite security com.aurelia.pms.security.AureliaSecurityInstrumentedTest

# Merge both independently executed suites for the strict 35-test result gate.
rm -rf app/build/outputs/androidTest-results/connected
mkdir -p app/build/outputs/androidTest-results/connected
cp -a "$results_dir/." app/build/outputs/androidTest-results/connected/
cat "$log_dir/repository.log" "$log_dir/security.log" > "$log_dir/connectedDebugAndroidTest.log"
echo "0" > "$log_dir/gradle-exit-code.txt"
