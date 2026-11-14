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

test("recovery workflow preserves separate phase-one and phase-two process-death invocations", () => {
  assert.ok(workflow.includes(
    'phase_one="com.aurelia.pms.RecoveryProcessDeathInstrumentedTest#phaseOnePersistsPinAAndDatabaseBeforeForceStop"'
  ));
  assert.ok(workflow.includes(
    'phase_two="com.aurelia.pms.RecoveryProcessDeathInstrumentedTest#phaseTwoUnlocksPinAAndReadsDatabaseAfterForceStop"'
  ));
  assert.ok(workflow.includes('run_instrumentation_test process-death-phase-one "$phase_one"'));
  assert.ok(workflow.includes('run_instrumentation_test process-death-phase-two "$phase_two"'));
});

test("host force-stops both app and exact AndroidJUnitRunner process without manufacturing a replacement", () => {
  assert.ok(workflow.includes('instrumentation_package="com.aurelia.pms.test"'));
  assert.ok(workflow.includes('before_pid="$(wait_for_instrumentation_pid)"'));
  assert.ok(workflow.includes('pidof "$instrumentation_package"'));
  assert.ok(workflow.includes('Phase-one instrumentation process exited before the explicit force-stop boundary.'));
  assert.ok(workflow.includes('install -r "$app_apk"'));
  assert.ok(workflow.includes('install -r -t "$test_apk"'));
  assert.ok(workflow.includes('shell am instrument -w -r -e class "$selector"'));
  assert.ok(workflow.includes('"$adb_bin" shell am force-stop com.aurelia.pms'));
  assert.ok(workflow.includes('"$adb_bin" shell am force-stop "$instrumentation_package"'));
  assert.ok(workflow.includes('for package in com.aurelia.pms "$instrumentation_package"; do'));
  assert.ok(workflow.includes('if [[ -n "$after_stop" ]]'));
  assert.ok(!workflow.includes('monkey -p com.aurelia.pms'));
});

test("phase two itself must leave a new instrumentation process without a synthetic app launch", () => {
  const phaseTwo = workflow.indexOf('run_instrumentation_test process-death-phase-two "$phase_two"');
  const pidCheck = workflow.indexOf('if [[ "$after_pid" == "$before_pid" ]]', phaseTwo);
  assert.ok(phaseTwo >= 0 && pidCheck > phaseTwo);
  assert.ok(workflow.includes("Phase-two instrumentation did not start a new test process."));
  assert.ok(workflow.includes('after_pid="$(wait_for_instrumentation_pid)"'));
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
