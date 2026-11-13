import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const workflow = fs.readFileSync('.github/workflows/native-sqlite-contract.yml', 'utf8');
const repositoryInstrumentation = fs.readFileSync(
  'android/templates/instrumentation/LocalPmsRepositoryInstrumentedTest.java', 'utf8'
);
const securityInstrumentation = fs.readFileSync(
  'android/templates/instrumentation/AureliaSecurityInstrumentedTest.java', 'utf8'
);
const repositoryTestCount = [...repositoryInstrumentation.matchAll(/@Test\b/g)].length;
const securityTestCount = [...securityInstrumentation.matchAll(/@Test\b/g)].length;

test('native SQLite instrumentation enables KVM before starting the emulator', () => {
  const kvm = workflow.indexOf('- name: Enable and require hardware KVM before any Android work');
  const image = workflow.indexOf('- name: Install Android 34 emulator image');
  const start = workflow.indexOf('- name: Boot accelerated API 30 emulator and run SQLite contracts (attempt 1)');
  assert.ok(kvm >= 0 && image > kvm && start > image);
  assert.ok(workflow.includes('if [[ ! -c /dev/kvm ]]'));
  assert.ok(workflow.includes('sudo chmod 0666 /dev/kvm'));
  assert.ok(workflow.includes('KVM device exists and is writable.'));
  assert.ok(workflow.includes('disable-linux-hw-accel: false'));
});

test('native SQLite instrumentation fails closed instead of using software emulation', () => {
  assert.ok(workflow.includes('refusing software emulation'));
  assert.ok(workflow.includes('disable-linux-hw-accel: false'));
  assert.doesNotMatch(workflow, /disable-linux-hw-accel:\s*true|-accel off|echo off > .*acceleration-mode/);
});



test('native SQLite gate executes both selected suites with exactly 35 tests and no skips', () => {
  assert.equal(repositoryTestCount, 29);
  assert.equal(securityTestCount, 6);
  assert.equal(repositoryTestCount + securityTestCount, 35);
  assert.ok(workflow.includes('totals.tests !== 35'));
  assert.ok(workflow.includes('totals.failures !== 0'));
  assert.ok(workflow.includes('totals.errors !== 0'));
  assert.ok(workflow.includes('totals.skipped !== 0'));
  assert.ok(workflow.includes('Expected exactly 35 executed repository and recovery-security tests, zero failures, zero errors and zero skipped tests.'));
  assert.ok(workflow.includes('AureliaSecurityInstrumentedTest'));
  assert.ok(emulatorScript.includes('locksettings set-pin 246810'));
});


const emulatorScript = fs.readFileSync('scripts/run-native-sqlite-contracts.sh', 'utf8');

test('emulator runner invokes one checked-in shell script per attempt', () => {
  assert.ok(workflow.includes('script: bash ../scripts/run-native-sqlite-contracts.sh 1'));
  assert.ok(workflow.includes('script: bash ../scripts/run-native-sqlite-contracts.sh 2'));
  assert.ok(emulatorScript.includes('log_dir="$repo_root/.aurelia-emulator"'));
  assert.ok(emulatorScript.includes('echo "booted=true" >> "$GITHUB_OUTPUT"'));
  assert.ok(emulatorScript.includes('connectedDebugAndroidTest'));
  assert.ok(emulatorScript.includes('com.aurelia.pms.LocalPmsRepositoryInstrumentedTest'));
  assert.ok(emulatorScript.includes('com.aurelia.pms.security.AureliaSecurityInstrumentedTest'));
  assert.ok(emulatorScript.includes('run_suite repository'));
  assert.ok(emulatorScript.includes('run_suite security'));
  assert.ok(emulatorScript.includes('gradle_status=${PIPESTATUS[0]}'));
});


test('native SQLite workflow isolates stale SHA runs from the current candidate', () => {
  assert.ok(workflow.includes('aurelia-native-sqlite-${{ github.ref }}-${{ github.sha }}'));
});
