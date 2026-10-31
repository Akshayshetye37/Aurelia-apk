import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('../src/server.mjs', import.meta.url), 'utf8');

test('admin API verifies revoked Firebase tokens, owner allowlist, verified email and MFA', () => {
  assert.match(source, /verifyIdToken\(header\.slice\(7\), true\)/);
  assert.match(source, /ownerUids\.has\(token\.uid\)/);
  assert.match(source, /token\.email_verified !== true/);
  assert.match(source, /sign_in_second_factor/);
  assert.match(source, /recent_mfa_sign_in_required/);
});

test('provider secrets are written to Secret Manager and never returned in status', () => {
  assert.match(source, /storeSecret\(secretId\(req\.owner\.uid, environment, 'api'\)/);
  assert.match(source, /storeSecret\(secretId\(req\.owner\.uid, environment, 'webhook'\)/);
  assert.match(source, /keySecret/);
  assert.match(source, /webhookSecret/);
  assert.match(source, /keyId: d\.keyId \|\| null/);
  assert.doesNotMatch(source, /res\\.json\\(\\{[^}]*\\bkeySecret\\b/);
});

test('Razorpay webhook uses raw bytes, constant-time HMAC comparison and provider fetch', () => {
  assert.match(source, /express\.raw\(\{ type: 'application\/json'/);
  assert.match(source, /createHmac\('sha256', webhookSecret\)\.update\(req\.body\)/);
  assert.match(source, /timingSafeEqual/);
  assert.match(source, /GET', '\/payments\/'/);
  assert.match(source, /payment\.status === 'captured'/);
});

test('ambiguous order creation is not retried with the same idempotency key', () => {
  assert.match(source, /newlyReserved: false/);
  assert.match(source, /if \(!reservationResult\.newlyReserved\) return fail/);
  assert.match(source, /order_creation_unknown_reconcile_before_retry/);
});

test('activation requires sandbox acceptance and explicit confirmation', () => {
  assert.match(source, /req\.body\?\.confirm !== true/);
  assert.match(source, /sandbox_acceptance_required/);
  assert.match(source, /live_webhook_verification_required/);
});
