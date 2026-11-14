import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const workflow = fs.readFileSync(
  ".github/workflows/otp-recovery-android-instrumentation.yml", "utf8"
);
const nativeWorkflow = fs.readFileSync(
  ".github/workflows/native-sqlite-contract.yml", "utf8"
);
const nativeRunner = fs.readFileSync("scripts/run-native-sqlite-contracts.sh", "utf8");

test("recovery workflow runs phase one only through the host-managed force-stop boundary", () => {
  assert.ok(workflow.includes(
    'phase_one="com.aurelia.pms.RecoveryProcessDeathInstrumentedTest#phaseOnePersistsPinAAndDatabaseBeforeForceStop"'
  ));
  assert.ok(workflow.includes(
    'phase_two="com.aurelia.pms.RecoveryProcessDeathInstrumentedTest#phaseTwoUnlocksPinAAndReadsDatabaseAfterForceStop"'
  ));
  assert.ok(!workflow.includes('run_instrumentation_test process-death-phase-one "$phase_one"'));
  assert.ok(workflow.includes('timeout -k 5s 1800s "$adb_bin" shell am instrument -w -r -e class "$phase_one"'));
  assert.ok(workflow.includes('run_instrumentation_test process-death-phase-two "$phase_two"'));
});

test("phase one holds the tested target process until the host force-stops it", () => {
  const processDeathTest = fs.readFileSync(
    "android/templates/instrumentation/RecoveryProcessDeathInstrumentedTest.java", "utf8"
  );
  assert.ok(processDeathTest.includes('Log.i("RecoveryProcessDeath", "PHASE_ONE_READY")'));
  assert.ok(processDeathTest.includes("Thread.sleep(30 * 60 * 1000L)"));
  assert.ok(processDeathTest.includes("newRecoveryLockout(context).beginAttempt()"));
  assert.ok(processDeathTest.includes("recoveryThrottle.lockoutFailureCount()"));
  assert.ok(processDeathTest.includes("recoveryThrottle.completeAttempt()"));
  assert.ok(processDeathTest.includes("global recovery-key failures reset only after durable PIN-envelope commit"));
  const phaseOne = processDeathTest.slice(
    processDeathTest.indexOf("phaseOnePersistsPinAAndDatabaseBeforeForceStop"),
    processDeathTest.indexOf("phaseTwoUnlocksPinAAndReadsDatabaseAfterForceStop")
  );
  const cleanup = phaseOne.indexOf("manager.lock()", phaseOne.indexOf("finally"));
  const gateArm = phaseOne.indexOf("armAfterServerConsumption");
  assert.ok(cleanup >= 0 && gateArm > cleanup, "the final cleanup lock must happen before the test gate is armed");
  assert.ok(workflow.includes('timeout -k 5s 1800s "$adb_bin" shell am instrument -w -r -e class "$phase_one"'));
  assert.ok(workflow.includes('wait_for_log_marker "PHASE_ONE_READY"'));
  assert.ok(workflow.includes('before_pid="$(wait_for_target_pid)"'));
  assert.ok(workflow.includes('"$adb_bin" shell am force-stop com.aurelia.pms'));
  assert.ok(workflow.includes('Phase-one target app process was not alive at the durable-state marker.'));
  assert.ok(workflow.includes('if [[ -n "$after_stop" ]]'));
  assert.ok(workflow.includes('process-death-phase-one-evidence.txt'));
  assert.ok(workflow.includes('Do not fabricate a completed JUnit case'));
  assert.ok(!workflow.includes('monkey -p com.aurelia.pms'));
});

test("phase two proves a fresh process and persisted recovery state before returning", () => {
  const processDeathTest = fs.readFileSync(
    "android/templates/instrumentation/RecoveryProcessDeathInstrumentedTest.java", "utf8"
  );
  assert.ok(processDeathTest.includes('Log.i("RecoveryProcessDeath", "PHASE_TWO_VERIFIED")'));
  assert.ok(processDeathTest.includes("SystemClock.sleep(3000L)"));
  const phaseTwo = workflow.indexOf('run_instrumentation_test process-death-phase-two "$phase_two" &');
  const pidCheck = workflow.indexOf('if [[ "$after_pid" == "$before_pid" ]]', phaseTwo);
  assert.ok(phaseTwo >= 0 && pidCheck > phaseTwo);
  assert.ok(workflow.includes('wait_for_log_marker "PHASE_TWO_VERIFIED"'));
  assert.ok(workflow.includes('after_pid="$(wait_for_target_pid)"'));
  assert.ok(workflow.includes("Phase two reused the phase-one target app PID."));
  assert.ok(!workflow.includes("launch_target_app"));
  assert.ok(!workflow.includes("monkey -p com.aurelia.pms"));
});

test("recovery emulator still requires KVM and refuses software emulation", () => {
  assert.ok(workflow.includes("if [ ! -c /dev/kvm ]"));
  assert.ok(workflow.includes("refusing a slow software-emulated x86_64 test"));
  assert.ok(workflow.includes("sudo chmod 666 /dev/kvm"));
  assert.ok(workflow.includes("-accel on"));
});

test("native SQLCipher candidate executes all 35 repository and recovery-security tests", () => {
  const repositoryTests = fs.readFileSync(
    "android/templates/instrumentation/LocalPmsRepositoryInstrumentedTest.java", "utf8"
  );
  const securityTests = fs.readFileSync(
    "android/templates/instrumentation/AureliaSecurityInstrumentedTest.java", "utf8"
  );
  assert.equal([...repositoryTests.matchAll(/@Test/g)].length, 29);
  assert.equal([...securityTests.matchAll(/@Test/g)].length, 6);
  assert.ok(nativeRunner.includes("locksettings set-pin"));
  assert.ok(nativeRunner.includes("android.settings.FINGERPRINT_ENROLL"));
  assert.ok(nativeRunner.includes("uiautomator dump"));
  assert.ok(nativeRunner.includes("adb emu finger touch 1"));
  assert.ok(nativeRunner.includes("com.aurelia.pms.LocalPmsRepositoryInstrumentedTest"));
  assert.ok(nativeRunner.includes("com.aurelia.pms.security.AureliaSecurityInstrumentedTest"));
  assert.ok(nativeWorkflow.includes("totals.tests !== 35"));
  assert.ok(nativeWorkflow.includes("totals.failures !== 0"));
  assert.ok(nativeWorkflow.includes("totals.errors !== 0"));
  assert.ok(nativeWorkflow.includes("totals.skipped !== 0"));
});
