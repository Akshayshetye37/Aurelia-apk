import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('../android/templates/RecoveryPhoneStore.kt', import.meta.url), 'utf8');

test('recovery phone registration persists the exact unverified E.164 number', () => {
  assert.match(source, /write\(Record\(State\.UNVERIFIED, typedE164, null, 0L, old\.otpRequired\)\)/);
  assert.match(source, /require\(old\.state == State\.UNSET \|\| old\.state == State\.UNVERIFIED\)/);
});

test('an existing encrypted recovery record never creates a replacement Keystore key on read', () => {
  const readStart = source.indexOf('fun read(): Record');
  const readEnd = source.indexOf('@Synchronized', readStart + 1);
  assert.ok(readStart >= 0 && readEnd > readStart);
  const readMethod = source.slice(readStart, readEnd);
  assert.match(readMethod, /if \(!keyStore\.containsAlias\(KEY_ALIAS\)\)/);
  assert.match(readMethod, /refusing to replace it/);
  assert.doesNotMatch(readMethod, /KeyGenerator\.getInstance/);
});

test('verified recovery phone changes remain protected by the cooldown state machine', () => {
  assert.match(source, /require\(old\.state == State\.VERIFIED && old\.currentE164 != null\)/);
  assert.match(source, /State\.CHANGE_PENDING/);
  assert.match(source, /nowEpochMs >= old\.effectiveAtEpochMs/);
});
