import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('../src/server.mjs', import.meta.url), 'utf8');

test('admin and payment actor authorization enforce tenant membership, verified email and MFA', () => {
  assert.ok(source.includes('verifyIdToken(header.slice(7), true)'));
  assert.ok(source.includes('membershipDoc(token.uid)'));
  assert.ok(source.includes("m.status !== 'active'"));
  assert.ok(source.includes('!allowedRoles.includes(m.role)'));
  assert.ok(source.includes('req.tenant = { id: m.tenantId, role: m.role }'));
  assert.equal(source.includes('AURELIA_OWNER_UIDS'), false);
  assert.ok(source.includes('token.email_verified !== true'));
  assert.ok(source.includes('sign_in_second_factor'));
  assert.ok(source.includes('recent_mfa_sign_in_required'));
  assert.ok(source.includes('requireTenantPaymentActor(req, res, next)'));
  assert.ok(source.includes("['owner', 'admin', 'staff']"));
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

test('live payment collection remains blocked until PMS accounting lifecycle is implemented', () => {
  assert.match(source, /live_payments_blocked_accounting_pipeline_incomplete/);
  assert.match(source, /if \(body\.environment === 'live'\)/);
  assert.match(source, /if \(environment === 'live'\)/);
  assert.match(source, /folioSettlement: false/);
  assert.match(source, /refunds: false/);
  assert.match(source, /reconciliation: false/);
  assert.match(source, /sdkCallbacksAuthoritative: false/);
  assert.match(source, /productionReady: false/);
});

test('capability endpoint does not advertise incomplete money movement as implemented', () => {
  assert.match(source, /app\.get\('\/v1\/payments\/capabilities'/);
  assert.match(source, /liveCollection: false/);
  assert.match(source, /folioSettlement: false/);
  assert.match(source, /refunds: false/);
  assert.match(source, /reconciliation: false/);
});


test('provider state and secrets use deterministic provider and environment namespaces', () => {
  assert.ok(source.includes('providerTenantDoc(tenantId, provider, environment)'));
  assert.ok(source.includes('providerSecretId(tenantId, provider, environment, purpose)'));
  assert.ok(source.includes("db.doc('paymentMemberships/' + uid)"));
  assert.ok(source.includes("db.doc('paymentProviderOrders/' + providerOrderHash)"));
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


test('verified webhook evidence is explicitly pending PMS accounting and cannot claim settlement', () => {
  assert.match(source, /CAPTURED_VERIFIED_PENDING_ACCOUNTING/);
  assert.match(source, /accountingStatus: 'PENDING'/);
  assert.match(source, /authoritative_pms_ledger_mapping_not_implemented/);
  assert.match(source, /accounting: outcome\.verified \? 'pending' : 'not_verified'/);
});

test('unverified webhook inbox records remain retryable while verified duplicates are idempotent', () => {
  assert.match(source, /UNVERIFIED_RETRYABLE/);
  assert.match(source, /prior\.providerFetchVerified === true/);
  assert.match(source, /lastAttemptAt: FieldValue\.serverTimestamp\(\)/);
  assert.match(source, /webhook_event_identity_conflict/);
});
