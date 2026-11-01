import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('../src/server.mjs', import.meta.url), 'utf8');

test('admin API verifies revoked Firebase tokens, server-resolved tenant membership, verified email and MFA', () => {
  assert.match(source, /verifyIdToken\(header\.slice\(7\), true\)/);
  assert.match(source, /membershipDoc\(token\.uid\)/);
  assert.match(source, /m\.status !== 'active'/);
  assert.match(source, /!\['owner', 'admin'\]\.includes\(m\.role\)/);
  assert.match(source, /req\.tenant = \{ id: m\.tenantId, role: m\.role \}/);
  assert.equal(source.includes('AURELIA_OWNER_UIDS'), false);
  assert.match(source, /token\.email_verified !== true/);
  assert.match(source, /sign_in_second_factor/);
  assert.match(source, /recent_mfa_sign_in_required/);
});

test('provider secrets are written to Secret Manager and never returned in status', () => {
  assert.match(source, /storeSecret\(secretId\(req\.tenant\.id, environment, 'api'\)/);
  assert.match(source, /storeSecret\(secretId\(req\.tenant\.id, environment, 'webhook'\)/);
  assert.match(source, /keySecret/);
  assert.match(source, /webhookSecret/);
  assert.match(source, /keyId: d\.keyId \|\| null/);
  assert.equal(source.includes('res.json({ keySecret'), false);
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


test('all provider state and secrets are scoped to server-resolved tenant IDs', () => {
  assert.match(source, /paymentTenants\/' \+ tenantId/);
  assert.match(source, /paymentMemberships\/' \+ uid/);
  assert.equal(source.includes('const secretId = (tenantId, env, purpose) =>'), true);
  assert.match(source, /update\(req\.tenant\.id \+ ':razorpay:test:' \+ idem\)/);
  assert.match(source, /orderSnap\.data\(\)\.tenantId !== tenantId/);
  assert.match(source, /:tenantId\/:environment/);
  assert.match(source, /paymentOrders\/' \+ req\.tenant\.id \+ '_' \+ order\.id/);
  assert.equal(source.includes('ownerDoc('), false);
  assert.equal(source.includes('ownerUids'), false);
});

test('client-supplied tenant identifiers are not used to authorize admin requests', () => {
  assert.match(source, /membershipDoc\(token\.uid\)\.get\(\)/);
  assert.equal(source.includes('req.body.tenantId'), false);
  assert.equal(source.includes('req.query.tenantId'), false);
});


test('HTTP runtime rejects requests without trusted HTTPS transport and emits HSTS', () => {
  assert.match(source, /app\.set\('trust proxy', trustProxyHops\)/);
  assert.match(source, /process\.env\.AURELIA_TRUST_PROXY_HOPS === '1' \? 1 : false/);
  assert.match(source, /if \(!req\.secure\)/);
  assert.match(source, /insecure_connection_rejected/);
  assert.match(source, /Strict-Transport-Security/);
  assert.equal(source.includes("req.headers['x-forwarded-proto'] === 'https'"), false);
});
