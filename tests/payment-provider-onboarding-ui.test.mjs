import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');

test('PMS provider directory never renders merchant credential inputs', () => {
  assert.match(html, /Credential onboarding is disabled in this PMS build/);
  assert.doesNotMatch(html, /id="provider-backend-/);
  assert.doesNotMatch(html, /id="provider-auth-/);
  assert.doesNotMatch(html, /data-provider-field=/);
});

test('PMS provider UI cannot submit merchant secrets to an arbitrary HTTPS host', () => {
  assert.doesNotMatch(html, /fetch\(backend\+'\/api\/admin\/payment-providers/);
  assert.doesNotMatch(html, /Authorization':\s*'Bearer '\+authToken/);
  assert.match(html, /Provider onboarding is disabled until the owner-controlled backend console is deployed/);
});

test('provider catalogue remains documentation-only until trusted backend deployment', () => {
  assert.match(html, /Provider Directory &amp; Onboarding|Provider Directory & Onboarding/);
  assert.match(html, /owner-controlled backend console/);
  assert.match(html, /non-secret provider status only/);
});


test('Pay Bridge connection UI diagnoses signing and protocol pairing failures', () => {
  assert.match(html, /untrusted_signer/);
  assert.match(html, /same signing certificate/);
  assert.match(html, /Independently built debug APKs/);
  assert.match(html, /protocol_mismatch/);
  assert.match(html, /permission_denied/);
});
