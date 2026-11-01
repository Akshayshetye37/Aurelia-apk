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

test('provider-neutral credentials are namespaced by tenant, provider, environment and purpose', () => {
  assert.match(source, /providerSecretId\(tenantId, provider, environment, purpose\)/);
  assert.match(source, /storeSecret\(providerSecretId\(req\.tenant\.id, provider, environment, 'api'\)/);
  assert.match(source, /storeSecret\(providerSecretId\(req\.tenant\.id, provider, environment, 'webhook'\)/);
  assert.match(source, /\['razorpay', 'cashfree'\]/);
  assert.match(source, /keySecret/);
  assert.match(source, /webhookSecret/);
  assert.equal(source.includes('res.json({ keySecret'), false);
});

test('provider-neutral webhook route verifies raw body with provider adapter before accepting payment', () => {
  assert.match(source, /express\.raw\(\{ type: 'application\/json'/);
  assert.match(source, /adapter\.verifyWebhook\(req\.body, req\.headers\)/);
  assert.match(source, /adapter\.getPaymentStatus\(\{ orderId: providerOrderId, paymentId \}\)/);
  assert.match(source, /providerFetchVerified: verified/);
  assert.match(source, /timingSafeEqual/);
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
  assert.match(source, /providerSecretId\(tenantId, provider, environment, purpose\)/);
  assert.match(source, /providerTenantDoc\(tenantId, provider, environment\)/);
  assert.match(source, /:provider:environment/);
  assert.equal(source.includes('ownerDoc('), false);
  assert.equal(source.includes('ownerUids'), false);
});

test('client-supplied tenant identifiers are not used to authorize admin requests', () => {
  assert.match(source, /membershipDoc\(token\.uid\)\.get\(\)/);
  assert.equal(source.includes('req.body.tenantId'), false);
  assert.equal(source.includes('req.query.tenantId'), false);
});


test('HTTP runtime rejects requests without trusted HTTPS transport and emits HSTS', () => {
  assert.match(source, /process\.env\.AURELIA_HTTPS_TERMINATION !== 'trusted-proxy'/);
  assert.match(source, /process\.env\.AURELIA_TRUST_PROXY_HOPS !== '1'/);
  assert.match(source, /app\.set\('trust proxy', 1\)/);
  assert.match(source, /must overwrite X-Forwarded-Proto/);
  assert.match(source, /if \(!req\.secure\)/);
  assert.match(source, /insecure_connection_rejected/);
  assert.match(source, /Strict-Transport-Security/);
  assert.equal(source.includes("req.headers['x-forwarded-proto'] === 'https'"), false);
});
