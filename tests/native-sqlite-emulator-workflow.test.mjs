import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const workflow = fs.readFileSync('.github/workflows/native-sqlite-contract.yml', 'utf8');

test('native SQLite instrumentation enables KVM before starting the emulator', () => {
  const avd = workflow.indexOf('- name: Create Android 34 AVD');
  const kvm = workflow.indexOf('- name: Require Linux KVM for Android SQLite instrumentation');
  const start = workflow.indexOf('- name: Start emulator and capture console output');
  assert.ok(avd >= 0 && kvm > avd && start > kvm);
  assert.match(workflow, /if \\?\[\[ ! -c \\/dev\\/kvm \\?\]\]/);
  assert.match(workflow, /sudo chmod 666 \\/dev\\/kvm/);
  assert.match(workflow, /emulator" -accel-check/);
  assert.match(workflow, /-accel on/);
});

test('native SQLite instrumentation fails closed instead of using software emulation', () => {
  assert.match(workflow, /refusing to run SQLCipher instrumentation under software emulation/);
  assert.match(workflow, /Hardware acceleration is mandatory/);
  assert.doesNotMatch(workflow, /-accel off|echo off > .*acceleration-mode/);
});
