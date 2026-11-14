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

test("recovery workflow runs two explicit instrumentation phases with host force-stop between them", () => {
  assert.ok(workflow.includes(
    'phase_one="com.aurelia.pms.RecoveryProcessDeathInstrumentedTest#phaseOnePersistsPinAAndDatabaseBeforeForceStop"'
  ));
  assert.ok(workflow.includes(
    'phase_two="com.aurelia.pms.RecoveryProcessDeathInstrumentedTest#phaseTwoUnlocksPinAAndReadsDatabaseAfterForceStop"'
  ));
  assert.ok(workflow.includes('run_instrumentation_test process-death-phase-one "$phase_one" 1'));
  assert.ok(workflow.includes('run_instrumentation_test process-death-phase-two "$phase_two" 2'));
  assert.ok(workflow.includes('-e phase "$phase"'));
  assert.ok(workflow.includes('"$adb_bin" shell am force-stop com.aurelia.pms'));
  assert.ok(workflow.includes('for attempt in {1..30}'));
  assert.ok(workflow.includes('if [[ -n "$after_stop" ]]'));
  assert.ok(workflow.includes('process-death-phase-one-evidence.txt'));
  assert.ok(workflow.includes('process-death-phase-two-evidence.txt'));
});

test("phase one returns after durable persistence and records a checksum before host force-stop", () => {
  const processDeathTest = fs.readFileSync(
    "android/templates/instrumentation/RecoveryProcessDeathInstrumentedTest.java", "utf8"
  );
  assert.ok(processDeathTest.includes('Log.i("RecoveryProcessDeath", "PHASE_ONE_READY")'));
  assert.ok(processDeathTest.includes('requirePhase("1")'));
  assert.ok(processDeathTest.includes("sha256Hex(persistedValue)"));
  assert.doesNotMatch(processDeathTest, /Thread\.sleep\(30 \* 60 \* 1000L\)/);
  assert.ok(workflow.includes('run_instrumentation_test process-death-phase-one "$phase_one" 1'));
  assert.ok(workflow.includes('PHASE_ONE_READY'));
  assert.ok(workflow.includes('pidof com.aurelia.pms'));
  assert.ok(workflow.includes('target_pid_after_force_stop=absent'));
  assert.ok(workflow.includes('process-death-phase-one-evidence.txt'));
});

test("phase two opens the database in the second invocation and verifies the phase-one checksum", () => {
  const processDeathTest = fs.readFileSync(
    "android/templates/instrumentation/RecoveryProcessDeathInstrumentedTest.java", "utf8"
  );
  assert.ok(processDeathTest.includes('Log.i("RecoveryProcessDeath", "PHASE_TWO_VERIFIED")'));
  assert.ok(processDeathTest.includes('requirePhase("2")'));
  assert.ok(processDeathTest.includes("SystemClock.sleep(3000L)"));
  assert.ok(processDeathTest.includes('sha256Hex(persistedData.getString("value"))'));
  const phaseTwo = workflow.indexOf('run_instrumentation_test process-death-phase-two "$phase_two" 2 &');
  const pidCheck = workflow.indexOf('if [[ -n "$before_pid" && "$after_pid" == "$before_pid" ]]', phaseTwo);
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
