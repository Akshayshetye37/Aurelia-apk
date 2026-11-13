import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const workflow = fs.readFileSync(
  ".github/workflows/otp-recovery-android-instrumentation.yml", "utf8"
);

test("recovery workflow preserves separate phase-one and phase-two process-death invocations", () => {
  assert.ok(workflow.includes(
    "run_suite process-death-phase-one com.aurelia.pms.RecoveryProcessDeathInstrumentedTest#phaseOnePersistsPinAAndDatabaseBeforeForceStop"
  ));
  assert.ok(workflow.includes(
    "run_suite process-death-phase-two com.aurelia.pms.RecoveryProcessDeathInstrumentedTest#phaseTwoUnlocksPinAAndReadsDatabaseAfterForceStop"
  ));
});

test("host explicitly launches and observes the target process before force-stop", () => {
  assert.ok(workflow.includes('launch_target_app()'));
  assert.ok(workflow.includes('"$adb_bin" shell monkey -p com.aurelia.pms 1'));
  assert.ok(workflow.includes('before_pid="$(wait_for_target_pid)"'));
  assert.ok(workflow.includes('"$adb_bin" shell am force-stop com.aurelia.pms'));
  assert.ok(workflow.includes('if [[ -n "$after_stop" ]]'));
});

test("phase two is followed by a fresh app launch and distinct process identity", () => {
  const phaseTwo = workflow.indexOf(
    "run_suite process-death-phase-two com.aurelia.pms.RecoveryProcessDeathInstrumentedTest#phaseTwoUnlocksPinAAndReadsDatabaseAfterForceStop"
  );
  const relaunch = workflow.indexOf("launch_target_app", phaseTwo);
  const pidCheck = workflow.indexOf('if [[ "$after_pid" == "$before_pid" ]]', phaseTwo);
  assert.ok(phaseTwo >= 0 && relaunch > phaseTwo && pidCheck > relaunch);
  assert.ok(workflow.includes("Phase two did not produce a newly started target app process."));
});

test("recovery emulator still requires KVM and refuses software emulation", () => {
  assert.ok(workflow.includes("if [ ! -c /dev/kvm ]"));
  assert.ok(workflow.includes("refusing a slow software-emulated x86_64 test"));
  assert.ok(workflow.includes("sudo chmod 666 /dev/kvm"));
  assert.ok(workflow.includes("-accel on"));
});
