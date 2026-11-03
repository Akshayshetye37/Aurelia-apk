import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('../src/local-server.mjs', import.meta.url), 'utf8');
const packageJson = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
const compose = await readFile(new URL('../compose.yaml', import.meta.url), 'utf8');

test('LAN runtime is the Docker entry point and is independent of cloud SDKs', () => {
  assert.equal(packageJson.scripts.start, 'node src/local-server.mjs');
  assert.ok(packageJson.dependencies['better-sqlite3']);
  assert.equal(packageJson.dependencies['firebase-admin'], undefined);
  assert.equal(packageJson.dependencies['@google-cloud/secret-manager'], undefined);
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

test('device enrollment uses short-lived single-use P-256 proof-of-possession challenges', () => {
  assert.match(source, /ECDSA_P256_SHA256','PENDING'/);
  assert.match(source, /proofOfPossessionRequired:true/);
  assert.match(source, /CREATE TABLE IF NOT EXISTS device_challenges/);
  assert.match(source, /expires_at INTEGER NOT NULL/);
  assert.ok(source.includes("app.post('/v1/admin/devices/:deviceId/challenge', ownerAuth"));
  assert.ok(source.includes("app.post('/v1/admin/devices/:deviceId/activate', ownerAuth"));
  assert.match(source, /AURELIA_DEVICE_ACTIVATE_V1/);
  assert.ok(source.includes("crypto.verify('sha256'"));
  assert.match(source, /consumed_at IS NULL AND expires_at/);
  assert.match(source, /status='ACTIVE'.*status='PENDING'/);
  assert.ok(source.includes("app.post('/v1/admin/devices/:deviceId/revoke', ownerAuth"));
  assert.match(source, /status='REVOKED'/);
  assert.match(source, /device_revoked/);
});

test('live activation and collection remain blocked', () => {
  assert.match(source, /if \(environment === 'live'\) return fail\(res, 409, 'live_payments_blocked_accounting_pipeline_incomplete'\)/);
  assert.match(source, /environment !== 'test'/);
  assert.match(source, /accounting: 'not_implemented'/);
});

test('payment dispatch is persisted before provider IO and ambiguous outcomes are not blindly retried', () => {
  assert.match(source, /durable_intent_created/);
  assert.match(source, /idempotency_key_payload_conflict/);
  assert.match(source, /provider_dispatch_outcome_ambiguous/);
  assert.match(source, /Never retry creation automatically/);
});

test('provider reconciliation checks trusted order, amount and currency', () => {
  assert.match(source, /adapter\.getPaymentStatus\(\{ orderId: providerOrderId \}\)/);
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

test('webhooks verify raw request bytes and event ID payload conflicts fail closed', () => {
  assert.match(source, /express\.raw\(\{ type: 'application\/json', limit: '1mb' \}\)/);
  assert.match(source, /adapter\.verifyWebhook\(req\.body, req\.headers\)/);
  assert.match(source, /webhook_event_identity_conflict/);
  assert.match(source, /prior\.payload_sha256 !== payloadHash/);
});

test('webhook handler does not settle or acknowledge the PMS folio', () => {
  const webhookStart = source.indexOf("app.post('/v1/webhooks/:provider/:environment'");
  const webhook = source.slice(webhookStart);
  assert.match(webhook, /accounting: 'not_implemented'/);
  assert.doesNotMatch(webhook, /settlePayment\(|folio\.update|ACKNOWLEDGED|PROCESSED/);
});

test('Docker publishes only the TLS reverse proxy and retains SQLite in a named volume', () => {
  assert.match(compose, /8443:443/);
  assert.match(compose, /payment-data:\/data/);
  assert.match(compose, /expose:/);
  assert.doesNotMatch(compose, /8085:8085/);
  assert.match(compose, /TRUST_PROXY_HOPS: "1"/);
});
