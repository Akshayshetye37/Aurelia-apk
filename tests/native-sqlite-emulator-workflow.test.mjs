import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const workflow = fs.readFileSync('.github/workflows/native-sqlite-contract.yml', 'utf8');

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



test('native SQLite gate requires non-zero execution and zero failures, errors and skips', () => {
  assert.ok(workflow.includes('totals.tests !== 35'));
  assert.ok(workflow.includes('totals.failures !== 0'));
  assert.ok(workflow.includes('totals.errors !== 0'));
  assert.ok(workflow.includes('totals.skipped !== 0'));
  assert.ok(workflow.includes('Expected exactly 35 executed tests, zero failures, zero errors and zero skipped tests.'));
});


test('nested emulator action scripts use a workspace log path instead of missing RUNNER_TEMP', () => {
  assert.equal((workflow.match(/log_dir="\$PWD\/\.\.\/\.aurelia-emulator"/g) || []).length, 2);
  assert.ok(workflow.includes('log_dir=".aurelia-emulator"'));
});


const emulatorScript = fs.readFileSync('scripts/run-native-sqlite-contracts.sh', 'utf8');

test('emulator runner invokes one checked-in shell script per attempt', () => {
  assert.ok(workflow.includes('script: bash ../scripts/run-native-sqlite-contracts.sh 1'));
  assert.ok(workflow.includes('script: bash ../scripts/run-native-sqlite-contracts.sh 2'));
  assert.ok(emulatorScript.includes('log_dir="$repo_root/.aurelia-emulator"'));
  assert.ok(emulatorScript.includes('echo "booted=true" >> "$GITHUB_OUTPUT"'));
  assert.ok(emulatorScript.includes('connectedDebugAndroidTest'));
  assert.ok(emulatorScript.includes('gradle_status=${PIPESTATUS[0]}'));
});
