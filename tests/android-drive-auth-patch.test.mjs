import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

test('Android Drive authorization patch uses SDK with account-selection prompt API', () => {
  const source = fs.readFileSync(new URL('../scripts/patch-android.js', import.meta.url), 'utf8');
  assert.match(source, /play-services-auth:21\.5\.0/);
  assert.match(source, /AuthorizationRequest\.Prompt\.SELECT_ACCOUNT/);
  assert.doesNotMatch(source, /play-services-auth:21\.4\.0/);
});
