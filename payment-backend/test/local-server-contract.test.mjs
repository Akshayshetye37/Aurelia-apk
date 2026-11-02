import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('../src/local-server.mjs', import.meta.url), 'utf8');
const packageJson = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
const compose = await readFile(new URL('../compose.yaml', import.meta.url), 'utf8');

test('local runtime is the default and does not require Firebase or Google Cloud packages', () => {
  assert.equal(packageJson.scripts.start, 'node src/local-server.mjs');
  assert.ok(packageJson.dependencies['better-sqlite3']);
  assert.equal(packageJson.dependencies['firebase-admin'], undefined);
  assert.equal(packageJson.dependencies['@google-cloud/secret-manager'], undefined);
});

test('local owner authentication uses salted scrypt and revocable persisted sessions', () => {
  assert.match(source, /scrypt\(password, salt, 64/);
  assert.match(source, /randomBytes\(32\)\.toString\('base64url'\)/);
  assert.match(source, /CREATE TABLE IF NOT EXISTS sessions/);
  assert.match(source, /DELETE FROM sessions WHERE token_hash/);
  assert.match(source, /owner_session_expired/);
  assert.doesNotMatch(source, /AureliaAdmin2026|admin123|password123/);
});

test('encryption key is mandatory and AES-GCM uses fresh 12-byte IVs', () => {
  assert.match(source, /requiredHex\('GATEWAY_MASTER_KEY', 32\)/);
  assert.match(source, /randomBytes\(12\)/);
  assert.match(source, /createCipheriv\('aes-256-gcm', masterKey, iv\)/);
  assert.match(source, /cipher\.getAuthTag\(\)/);
  assert.match(source, /decipher\.setAuthTag\(tag\)/);
});

test('first-owner setup requires a one-time high-entropy bootstrap token', () => {
  assert.match(source, /requiredHex\('OWNER_SETUP_TOKEN', 32\)/);
  assert.match(source, /x-aurelia-setup-token/);
  assert.match(source, /timingSafeEqual\(Buffer\.from\(suppliedSetupToken, 'hex'\), ownerSetupToken\)/);
  assert.match(source, /owner_setup_token_invalid/);
});

test('owner session is cookie-only and is never returned in JSON', () => {
  assert.match(source, /HttpOnly; Secure; SameSite=None/);
  assert.doesNotMatch(source, /sessionToken: token/);
  assert.doesNotMatch(source, /x-aurelia-session/);
});

test('new device registrations remain pending until proof of possession exists', () => {
  assert.match(source, /ECDSA_P256_SHA256','PENDING'/);
  assert.match(source, /proofOfPossessionRequired\s*:\s*true/);
});

test('legacy ACTIVE devices are downgraded once until proof-of-possession enrollment is implemented', () => {
  assert.match(source, /deviceEnrollmentSchemaVersion < 1/);
  assert.match(source, /UPDATE device_registrations SET status='PENDING' WHERE status='ACTIVE'/);
  assert.match(source, /PRAGMA user_version/);
});

test('provider credential rotation invalidates validation and activation', () => {
  assert.match(source, /validated=0,active=0,updated_at=excluded\.updated_at/);
  assert.match(source, /await adapter\.validateCredentials\(\)/);
  assert.match(source, /provider_validation_failed/);
});

test('live activation is blocked and provider removal checks unresolved durable states', () => {
  assert.match(source, /if \(environment === 'live'\) return fail\(res, 409, 'live_payments_blocked_accounting_pipeline_incomplete'\)/);
  assert.match(source, /'UNKNOWN'/);
  assert.match(source, /'AMBIGUOUS'/);
  assert.match(source, /unresolvedCount\(provider, environment\)/);
  assert.match(source, /provider_removal_blocked_unresolved_transactions_/);
});

test('webhook signature verification receives raw request bytes', () => {
  assert.match(source, /type: req => !req\.path\.startsWith\('\/v1\/webhooks\/'\)/);
  assert.match(source, /express\.raw\(\{ type: 'application\/json', limit: '1mb' \}\)/);
  assert.match(source, /adapter\.verifyWebhook\(req\.body, req\.headers\)/);
});

test('Docker healthcheck supplies the trusted proxy HTTPS signal required by the app', () => {
  assert.match(compose, /healthz.*X-Forwarded-Proto/);
  assert.match(compose, /TRUST_PROXY_HOPS: "1"/);
});

test('local service requires trusted HTTPS proxy and exact HTTPS origins', () => {
  assert.match(source, /TRUST_PROXY_HOPS !== '1'/);
  assert.match(source, /if \(!req\.secure\)/);
  assert.match(source, /AURELIA_OWNER_ORIGINS/);
  assert.match(source, /SameSite=None/);
  assert.match(source, /if \(origin && !origins\.has\(origin\)\)/);
});

test('payment dispatch persists an idempotent intent before provider network dispatch', () => {
  assert.match(source, /CREATE TABLE IF NOT EXISTS transaction_journal/);
  assert.match(source, /CREATE TABLE IF NOT EXISTS settlement_outbox/);
  assert.match(source, /idempotency_key_payload_conflict/);
  assert.match(source, /durable_intent_created/);
  assert.match(source, /provider_dispatch_outcome_ambiguous/);
  assert.match(source, /Never retry creation automatically/);
});

test('reconciliation queries provider API and checks amount, currency and order reference', () => {
  assert.match(source, /adapter\.getPaymentStatus\(\{ orderId: providerOrderId \}\)/);
  assert.match(source, /remote\.amountMinor !== tx\.amount_minor/);
  assert.match(source, /remote\.currency !== tx\.currency/);
  assert.match(source, /provider_api_confirmed_capture/);
  assert.doesNotMatch(source, /externalStatusVerified\s*=\s*['"]captured['"]/);
});

test('late provider-confirmed capture can supersede a prior failure for reconciliation', () => {
  assert.match(source, /'RECONCILIATION_REQUIRED','FAILED'[\s\S]*'CAPTURED_PENDING_ACCOUNTING'/);
});

test('webhook event ID reuse with a different payload is rejected', () => {
  assert.match(source, /webhook_event_identity_conflict/);
  assert.match(source, /prior\.payload_sha256 !== payloadHash/);
});

test('verified capture creates one durable accounting outbox event, not a false folio success', () => {
  assert.match(source, /CAPTURED_PENDING_ACCOUNTING/);
  assert.match(source, /INSERT OR IGNORE INTO settlement_outbox/);
  assert.match(source, /folioSettlement: 'PENDING_OUTBOX'/);
});


test('device registry accepts only registered P-256 public identities and never private keys', () => {
  assert.match(source, /CREATE TABLE IF NOT EXISTS device_registrations/);
  assert.match(source, /public_key_spki BLOB NOT NULL/);
  assert.match(source, /crypto\.createPublicKey\(publicKeyPem\)/);
  assert.match(source, /namedCurve !== 'prime256v1'/);
  assert.match(source, /PAYMENT_DEVICE_REGISTERED/);
});

test('settlement commands use immutable per-device sequences and durable cursors', () => {
  assert.match(source, /CREATE TABLE IF NOT EXISTS settlement_commands/);
  assert.match(source, /UNIQUE\(device_id, sequence_id\)/);
  assert.match(source, /CREATE TABLE IF NOT EXISTS device_cursors/);
  assert.match(source, /CREATE TABLE IF NOT EXISTS device_sequence_counters/);
  assert.match(source, /CREATE TABLE IF NOT EXISTS device_command_state/);
  assert.match(source, /AMBIGUOUS_RECONCILIATION/);
  assert.match(source, /payload_hash TEXT NOT NULL/);
});

test('captured payment, outbox event, sequence allocation and device command share one SQLite transaction', () => {
  assert.match(source, /const apply = db\.transaction\(\(\) => \{/);
  assert.match(source, /if \(nextStatus === 'CAPTURED_PENDING_ACCOUNTING'\)/);
  assert.match(source, /const sequenceId = counter\.last_sequence \+ 1/);
  assert.match(source, /UPDATE device_sequence_counters SET last_sequence=\?/);
  assert.match(source, /INSERT INTO settlement_commands/);
  assert.match(source, /INSERT INTO device_command_state/);
});

test('dispatch idempotency binds the target device and folio as immutable fields', () => {
  assert.match(source, /b\.deviceId !== undefined && \(!validOpaqueId\(b\.deviceId\) \|\| !validOpaqueId\(b\.folioId\)\)/);
  assert.match(source, /existing\.device_id === \(b\.deviceId \|\| null\)/);
  assert.match(source, /raced\.folio_id === \(b\.folioId \|\| null\)/);
});
