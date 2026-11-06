import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('../src/local-server.mjs', import.meta.url), 'utf8');
const packageJson = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
const compose = await readFile(new URL('../compose.yaml', import.meta.url), 'utf8');

test('LAN runtime is the Docker entry point and is independent of cloud SDKs', () => {
  assert.equal(packageJson.scripts.start, 'node src/local-server.mjs');
  assert.ok(packageJson.devDependencies['better-sqlite3']);
  assert.equal(source.includes("from 'firebase-admin/"), false);
  assert.equal(source.includes("from '@google-cloud/"), false);
});

test('required independent secrets are validated before startup', () => {
  for (const key of ['GATEWAY_MASTER_KEY','SESSION_TOKEN_PEPPER','OWNER_SETUP_TOKEN']) {
    assert.match(source, new RegExp("requiredHex\\('" + key + "', 32\\)"));
  }
  assert.match(source, /TRUST_PROXY_HOPS !== '1'/);
  assert.match(source, /AURELIA_OWNER_ORIGINS/);
});

test('owner passwords use scrypt and persisted sessions store only a keyed digest', () => {
  assert.match(source, /scrypt\(password, salt, 64/);
  assert.match(source, /randomBytes\(32\)\.toString\('base64url'\)/);
  assert.match(source, /CREATE TABLE IF NOT EXISTS sessions/);
  assert.match(source, /tokenDigest\(token\)/);
  assert.match(source, /DELETE FROM sessions WHERE token_hash/);
  assert.doesNotMatch(source, /AureliaAdmin2026|admin123|password123/);
});

test('AES-GCM credential encryption uses a fresh 12-byte IV and authenticates ciphertext', () => {
  assert.match(source, /randomBytes\(12\)/);
  assert.match(source, /createCipheriv\('aes-256-gcm', masterKey, iv\)/);
  assert.match(source, /cipher\.getAuthTag\(\)/);
  assert.match(source, /decipher\.setAuthTag\(tag\)/);
});

test('first owner requires a one-time independent setup token and a strong password', () => {
  assert.match(source, /requiredHex\('OWNER_SETUP_TOKEN', 32\)/);
  assert.match(source, /x-aurelia-setup-token/);
  assert.match(source, /timingSafeEqual\(Buffer\.from\(suppliedSetupToken, 'hex'\), ownerSetupToken\)/);
  assert.match(source, /password\.length < 14/);
  assert.match(source, /owner_already_configured/);
});

test('login request is schema-validated before database lookup and password hashing', () => {
  const loginStart = source.indexOf("app.post('/v1/auth/login'");
  const login = source.slice(loginStart, source.indexOf("app.get('/v1/auth/session'", loginStart));
  assert.match(login, /invalid_login_schema/);
  assert.match(login, /password\.length > 1024/);
  assert.ok(login.indexOf('invalid_login_schema') < login.indexOf("SELECT * FROM owner WHERE username=?"));
});

test('owner sessions are cookie-only, Secure and HttpOnly', () => {
  assert.match(source, /HttpOnly; Secure; SameSite=None/);
  assert.doesNotMatch(source, /sessionToken: token/);
  assert.doesNotMatch(source, /x-aurelia-session/);
});

test('cookie-authenticated state mutations require an exact allowlisted Origin', () => {
  assert.match(source, /function requireBrowserMutationOrigin/);
  assert.match(source, /if \(!origin \|\| !origins\.has\(origin\)\) return fail\(res, 403, 'origin_not_allowed'\)/);
  for (const route of [
    "app.post('/v1/auth/logout', ownerAuth, requireBrowserMutationOrigin",
    "app.post('/v1/auth/change-password', ownerAuth, requireBrowserMutationOrigin",
    "app.put('/v1/admin/providers/:provider/credentials', ownerAuth, requireBrowserMutationOrigin",
    "app.post('/v1/admin/providers/:provider/validate', ownerAuth, requireBrowserMutationOrigin",
    "app.post('/v1/admin/providers/:provider/activate', ownerAuth, requireBrowserMutationOrigin",
    "app.post('/v1/admin/providers/:provider/deactivate', ownerAuth, requireBrowserMutationOrigin",
    "app.delete('/v1/admin/providers/:provider/credentials', ownerAuth, requireBrowserMutationOrigin",
    "app.post('/v1/payments/dispatch', ownerAuth, requireBrowserMutationOrigin",
    "app.post('/v1/payments/:transactionId/reconcile', ownerAuth, requireBrowserMutationOrigin",
    "app.post('/v1/admin/devices/register', ownerAuth, requireBrowserMutationOrigin"
  ]) assert.ok(source.includes(route), route);
});

test('device enrollment verifies Google Key Attestation before owner activation', () => {
  assert.match(source, /ECDSA_P256_SHA256','PENDING'/);
  assert.match(source, /CREATE TABLE IF NOT EXISTS device_challenges/);
  assert.match(source, /CREATE TABLE IF NOT EXISTS device_enrollment_challenges/);
  assert.ok(source.includes("app.post('/v1/admin/devices/enrollment/challenge', ownerAuth"));
  assert.ok(source.includes("app.post('/v1/admin/devices/enroll', ownerAuth"));
  assert.match(source, /nonce_base64 TEXT/);
  assert.match(source, /ATTESTATION_VERIFIER_URL/);
  assert.match(source, /android\/keyattestation/);
  assert.ok(source.includes("app.post('/v1/admin/devices/:deviceId/challenge', ownerAuth"));
  assert.ok(source.includes("app.post('/v1/admin/devices/:deviceId/attestation', ownerAuth"));
  assert.match(source, /attestation_challenge_invalid_or_expired/);
  assert.match(source, /attestation_challenge_race_or_expiry/);
  assert.match(source, /device_attestation_key_binding_failed/);
  assert.match(source, /attestation_verified_at/);
  assert.match(source, /status='PENDING' AND owner_id/);
  const activationStart = source.indexOf("app.post('/v1/admin/devices/:deviceId/activate'");
  const activationEnd = source.indexOf("app.post('/v1/admin/devices/:deviceId/revoke'", activationStart);
  const activation = source.slice(activationStart, activationEnd);
  assert.match(activation, /device_attestation_required/);
  assert.match(activation, /attestation_verified_boot_state !== 'VERIFIED'/);
  assert.match(activation, /attestation_device_locked !== 1/);
  assert.match(activation, /status='ACTIVE'/);
  assert.ok(source.includes("app.post('/v1/admin/devices/:deviceId/revoke', ownerAuth"));
  assert.match(source, /status='REVOKED'/);
  assert.match(source, /device_revoked/);
});

test('live activation and collection remain blocked', () => {
  assert.match(source, /if \(environment === 'live'\) return fail\(res, 409, 'live_payments_blocked_accounting_pipeline_incomplete'\)/);
  assert.match(source, /environment !== 'test'/);
  assert.match(source, /environment !== 'test'/);
});

test('payment dispatch is persisted before provider IO and ambiguous outcomes are not blindly retried', () => {
  assert.match(source, /durable_intent_created/);
  assert.match(source, /idempotency_key_payload_conflict/);
  assert.match(source, /provider_dispatch_outcome_ambiguous/);
  assert.match(source, /Never retry creation automatically/);
});

test('provider checkout session is persisted and returned for safe idempotent recovery', () => {
  assert.match(source, /provider_checkout_session_id TEXT/);
  assert.match(source, /ALTER TABLE transactions ADD COLUMN provider_checkout_session_id TEXT/);
  assert.match(source, /providerCheckoutSessionId = null/);
  assert.match(source, /paymentSessionId: existing\.provider_checkout_session_id/);
  assert.match(source, /checkout = \{ keyId: decryptCredentials\(config\)\.keyId \}/);
  assert.match(source, /order\.paymentSessionId \|\| null/);
});

test('provider reconciliation checks trusted order, amount and currency', () => {
  assert.match(source, /adapter\.getPaymentStatus\(\{ orderId: providerOrderId, \.\.\.\(requestedPaymentId \? \{ paymentId: requestedPaymentId \} : \{\}\) \}\)/);
  assert.match(source, /remote\.paymentId !== requestedPaymentId/);
  assert.match(source, /remote\.amountMinor !== tx\.amount_minor/);
  assert.match(source, /remote\.currency !== tx\.currency/);
  assert.match(source, /provider_api_confirmed_capture/);
});

test('captured command enqueue and per-device sequence allocation are transaction-scoped', () => {
  assert.match(source, /const apply = db\.transaction\(\(\) => \{/);
  assert.match(source, /INSERT OR IGNORE INTO settlement_outbox/);
  assert.match(source, /const sequenceId = counter\.last_sequence \+ 1/);
  assert.match(source, /INSERT INTO settlement_commands/);
  assert.match(source, /INSERT INTO device_command_state/);
});

test('captured commands retain exact provider and PMS folio settlement bindings', () => {
  assert.match(source, /provider_payment_id TEXT/);
  assert.match(source, /ALTER TABLE transactions ADD COLUMN provider_payment_id TEXT/);
  assert.match(source, /providerPaymentId: verifiedPaymentId/);
  assert.match(source, /bookingId: current\.folio_id/);
  assert.match(source, /amount: current\.amount_minor \/ 100/);
  assert.match(source, /method: current\.provider/);
  assert.match(source, /providerAccountId: current\.provider_account_id/);
  assert.match(source, /reference: verifiedPaymentId/);
  assert.match(source, /idempotencyKey: current\.idempotency_key/);
  assert.match(source, /providerOrderId, remote\.paymentId \|\| null/);
});

test('native device command hashes use canonical JSON for independent client verification', () => {
  assert.match(source, /const payloadHash = crypto\.createHash\('sha256'\)\.update\(canonicalJson\(command\)\)\.digest\('hex'\)/);
  assert.match(source, /payloadHash: command\.payload_hash/);
  assert.match(source, /const payload = JSON\.parse\(command\.payload\)/);
  assert.match(source, /payloadCanonical: canonicalJson\(payload\)/);
});

test('device delivery uses signed requests, ordered leases, durable receipts and cursor compare-and-set', () => {
  assert.match(source, /CREATE TABLE IF NOT EXISTS device_request_nonces/);
  assert.ok(source.includes("app.post('/v1/devices/:deviceId/commands/lease', deviceAuth"));
  assert.ok(source.includes("app.post('/v1/devices/:deviceId/commands/:commandId/ack', deviceAuth"));
  assert.match(source, /AURELIA_DEVICE_REQUEST_V1/);
  assert.match(source, /device_request_replay/);
  assert.match(source, /cursor\.last_applied_sequence \+ 1/);
  assert.match(source, /lease_expires_at/);
  assert.match(source, /durableApplied !== true/);
  assert.match(source, /command\.payload_hash !== payloadHash/);
  assert.match(source, /device_cursor_out_of_order/);
  assert.match(source, /device_cursor_advance_race/);
  assert.match(source, /UPDATE device_cursors SET last_applied_sequence/);
  assert.match(source, /status='PROCESSED'/);
  assert.match(source, /device\.status !== 'ACTIVE'/);
  assert.match(source, /!req\.path\.startsWith\('\/v1\/devices\/'\)/);
});

test('signed durable device receipt atomically finalizes PMS settlement and capture outbox', () => {
  const ackStart = source.indexOf("app.post('/v1/devices/:deviceId/commands/:commandId/ack'");
  const ackEnd = source.indexOf("app.get('/v1/auth/setup-status'", ackStart);
  const ack = source.slice(ackStart, ackEnd);
  assert.match(ack, /durableApplied !== true/);
  assert.match(ack, /payment_not_pending_accounting/);
  assert.match(ack, /UPDATE transactions SET status='SETTLED'/);
  assert.match(ack, /trusted_device_durable_folio_receipt/);
  assert.match(ack, /UPDATE settlement_outbox SET status='PROCESSED'/);
  assert.match(ack, /UPDATE device_cursors SET last_applied_sequence/);
  assert.ok(ack.indexOf("UPDATE device_command_state SET status='PROCESSED'") <
    ack.indexOf("UPDATE transactions SET status='SETTLED'"));
  assert.match(ack, /PAYMENT_FOLIO_SETTLEMENT_COMMITTED/);
});

test('webhooks verify raw request bytes and event ID payload conflicts fail closed', () => {
  assert.match(source, /express\.raw\(\{ type: 'application\/json', limit: '1mb' \}\)/);
  assert.match(source, /adapter\.verifyWebhook\(req\.body, req\.headers\)/);
  assert.match(source, /webhook_event_identity_conflict/);
  assert.match(source, /prior\.payload_sha256 !== payloadHash/);
});

test('webhook capture requires independent provider API verification before command creation', () => {
  const webhookStart = source.indexOf("app.post('/v1/webhooks/:provider/:environment'");
  const webhook = source.slice(webhookStart, source.indexOf("app.use((err", webhookStart));
  assert.match(webhook, /adapter\.verifyWebhook\(req\.body, req\.headers\)/);
  assert.match(webhook, /adapter\.getPaymentStatus\(\{ orderId: providerOrderId/);
  assert.match(webhook, /remote\.captured !== true/);
  assert.match(webhook, /remote\.amountMinor !== tx\.amount_minor/);
  assert.match(webhook, /remote\.currency !== tx\.currency/);
  assert.match(webhook, /remote\.orderId !== providerOrderId/);
  assert.match(webhook, /provider_status_binding_mismatch/);
  assert.match(webhook, /transitionPayment\(/);
  assert.match(webhook, /settlement_commands WHERE device_id/);
  assert.match(webhook, /COMMAND_CREATED/);
  assert.match(webhook, /CAPTURED_UNROUTED/);
  assert.doesNotMatch(webhook, /settlePayment\(/);
  assert.doesNotMatch(webhook, /accounting: 'not_implemented'/);
});

test('Docker publishes only the TLS reverse proxy and retains SQLite in a named volume', () => {
  assert.match(compose, /8443:443/);
  assert.match(compose, /payment-data:\/data/);
  assert.match(compose, /expose:/);
  assert.doesNotMatch(compose, /8085:8085/);
  assert.match(compose, /TRUST_PROXY_HOPS: "1"/);
});

import { assertWebhookReplayIntegrity } from '../src/webhooks/provider-webhook-router.mjs';

test('webhook event replay requires identical signed payload fingerprint and bindings', () => {
  const prior = {
    tenantId: 'tenant01', provider: 'razorpay', environment: 'test',
    providerOrderId: 'order_123', paymentId: 'pay_123', payloadHash: 'a'.repeat(64)
  };
  assert.equal(assertWebhookReplayIntegrity(prior, { ...prior }), true);
  assert.throws(() => assertWebhookReplayIntegrity(prior, { ...prior, payloadHash: 'b'.repeat(64) }),
    error => error.code === 'WEBHOOK_EVENT_PAYLOAD_CONFLICT');
  assert.throws(() => assertWebhookReplayIntegrity(prior, { ...prior, paymentId: 'pay_other' }),
    error => error.code === 'WEBHOOK_EVENT_IDENTITY_CONFLICT');
});

test('webhook replay fails closed for historical inbox rows without a payload fingerprint', () => {
  const prior = {
    tenantId: 'tenant01', provider: 'cashfree', environment: 'test',
    providerOrderId: 'order_123', paymentId: 'pay_123'
  };
  assert.throws(() => assertWebhookReplayIntegrity(prior, { ...prior, payloadHash: 'a'.repeat(64) }),
    error => error.code === 'WEBHOOK_PRIOR_FINGERPRINT_MISSING');
});
