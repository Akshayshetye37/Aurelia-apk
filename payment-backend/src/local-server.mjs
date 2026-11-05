import crypto from 'node:crypto';
import express from 'express';
import Database from 'better-sqlite3';
import { scrypt as scryptCallback, randomBytes, timingSafeEqual, createCipheriv, createDecipheriv, createHmac } from 'node:crypto';
import { promisify } from 'node:util';
import { createProviderAdapter } from './providers/factory.mjs';

const scrypt = promisify(scryptCallback);
const app = express();
app.disable('x-powered-by');
app.set('trust proxy', process.env.TRUST_PROXY_HOPS === '1' ? 1 : false);

const PORT = Number(process.env.PORT || 8085);
const DB_PATH = process.env.DATABASE_PATH || '/data/aurelia-payments.sqlite';
const PROPERTY_ID = process.env.AURELIA_PROPERTY_ID || '';
const ATTESTATION_VERIFIER_URL = 'http://127.0.0.1:8091/verify';
if (!/^[A-Za-z0-9_-]{3,64}$/.test(PROPERTY_ID)) throw new Error('AURELIA_PROPERTY_ID_must_be_configured_as_3_to_64_safe_characters');
const SESSION_TTL_SECONDS = 2 * 60 * 60;
const SESSION_COOKIE = 'aurelia_owner_session';
const PROVIDERS = new Set(['razorpay', 'cashfree']);
const UNRESOLVED = ['CREATED', 'PENDING', 'PROCESSING', 'DISPATCHING', 'UNKNOWN', 'AMBIGUOUS', 'CAPTURED_PENDING_ACCOUNTING', 'REFUND_PENDING', 'RECONCILIATION_REQUIRED'];

function requiredHex(name, bytes) {
  const value = process.env[name] || '';
  if (!(new RegExp('^[a-f0-9]{' + (bytes * 2) + '}$', 'i')).test(value)) {
    throw new Error(name + '_must_be_' + (bytes * 2) + '_hex_characters');
  }
  return Buffer.from(value, 'hex');
}
const masterKey = requiredHex('GATEWAY_MASTER_KEY', 32);
const sessionPepper = requiredHex('SESSION_TOKEN_PEPPER', 32);
const ownerSetupToken = requiredHex('OWNER_SETUP_TOKEN', 32);
const origins = new Set((process.env.AURELIA_OWNER_ORIGINS || '').split(',').map(v => v.trim()).filter(Boolean));
if (!origins.size || [...origins].some(v => !/^https:\/\/[^/]+$/.test(v))) {
  throw new Error('AURELIA_OWNER_ORIGINS must contain exact HTTPS origins.');
}
if (process.env.TRUST_PROXY_HOPS !== '1') throw new Error('Configure one trusted HTTPS proxy and TRUST_PROXY_HOPS=1.');
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.exec(`
CREATE TABLE IF NOT EXISTS owner (
 id INTEGER PRIMARY KEY CHECK(id=1), username TEXT NOT NULL UNIQUE,
 password_salt TEXT NOT NULL, password_hash TEXT NOT NULL, password_n INTEGER NOT NULL,
 password_r INTEGER NOT NULL, password_p INTEGER NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
 token_hash TEXT PRIMARY KEY, owner_id INTEGER NOT NULL REFERENCES owner(id) ON DELETE CASCADE,
 expires_at INTEGER NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS provider_config (
 provider TEXT NOT NULL, environment TEXT NOT NULL CHECK(environment IN ('test','live')),
 ciphertext TEXT NOT NULL, iv TEXT NOT NULL, auth_tag TEXT NOT NULL,
 configured INTEGER NOT NULL DEFAULT 1, validated INTEGER NOT NULL DEFAULT 0,
 active INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL,
 PRIMARY KEY(provider, environment)
);
CREATE TABLE IF NOT EXISTS device_registrations (
 device_id TEXT PRIMARY KEY, public_key_spki BLOB NOT NULL,
 key_algorithm TEXT NOT NULL CHECK(key_algorithm='ECDSA_P256_SHA256'),
 key_version INTEGER NOT NULL DEFAULT 1 CHECK(key_version > 0),
 status TEXT NOT NULL DEFAULT 'PENDING' CHECK(status IN ('PENDING','ACTIVE','REVOKED')),
 created_at TEXT NOT NULL, last_seen_at TEXT, revoked_at TEXT,
 owner_id INTEGER, property_id TEXT,
 attestation_verified_at TEXT, attestation_security_level TEXT,
 attestation_verified_boot_state TEXT, attestation_device_locked INTEGER,
 attestation_chain_sha256 TEXT, attestation_metadata TEXT
);
CREATE TABLE IF NOT EXISTS device_challenges (
 challenge_id TEXT PRIMARY KEY,
 device_id TEXT NOT NULL REFERENCES device_registrations(device_id) ON DELETE CASCADE,
 nonce_sha256 TEXT NOT NULL,
 expires_at INTEGER NOT NULL,
 owner_id INTEGER, property_id TEXT, nonce_base64 TEXT,
 created_at TEXT NOT NULL,
 consumed_at TEXT
);
CREATE INDEX IF NOT EXISTS device_challenge_expiry ON device_challenges(device_id,expires_at,consumed_at);
CREATE TABLE IF NOT EXISTS device_enrollment_challenges (
 challenge_id TEXT PRIMARY KEY,
 device_id TEXT NOT NULL,
 owner_id INTEGER NOT NULL,
 property_id TEXT NOT NULL,
 nonce_sha256 TEXT NOT NULL,
 nonce_base64 TEXT NOT NULL,
 expires_at INTEGER NOT NULL,
 created_at TEXT NOT NULL,
 consumed_at TEXT
);
CREATE INDEX IF NOT EXISTS device_enrollment_challenge_expiry
 ON device_enrollment_challenges(device_id,owner_id,property_id,expires_at,consumed_at);
CREATE TABLE IF NOT EXISTS device_request_nonces (
 device_id TEXT NOT NULL REFERENCES device_registrations(device_id) ON DELETE CASCADE,
 nonce_sha256 TEXT NOT NULL,
 expires_at INTEGER NOT NULL,
 created_at TEXT NOT NULL,
 PRIMARY KEY(device_id,nonce_sha256)
);
CREATE INDEX IF NOT EXISTS device_request_nonce_expiry ON device_request_nonces(expires_at);
CREATE TABLE IF NOT EXISTS device_cursors (
 device_id TEXT PRIMARY KEY REFERENCES device_registrations(device_id),
 last_applied_sequence INTEGER NOT NULL DEFAULT 0 CHECK(last_applied_sequence >= 0),
 updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS device_sequence_counters (
 device_id TEXT PRIMARY KEY REFERENCES device_registrations(device_id),
 last_sequence INTEGER NOT NULL DEFAULT 0 CHECK(last_sequence >= 0)
);
CREATE TABLE IF NOT EXISTS transactions (
 id TEXT PRIMARY KEY, provider TEXT NOT NULL, environment TEXT NOT NULL,
 provider_order_id TEXT, provider_payment_id TEXT, provider_checkout_session_id TEXT, amount_minor INTEGER NOT NULL, currency TEXT NOT NULL,
 status TEXT NOT NULL, idempotency_key TEXT NOT NULL UNIQUE,
 device_id TEXT REFERENCES device_registrations(device_id), folio_id TEXT,
 created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
 CHECK ((device_id IS NULL AND folio_id IS NULL) OR (device_id IS NOT NULL AND folio_id IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS transactions_provider_status ON transactions(provider, environment, status);
CREATE TABLE IF NOT EXISTS transaction_journal (
 id INTEGER PRIMARY KEY AUTOINCREMENT, transaction_id TEXT NOT NULL REFERENCES transactions(id),
 from_status TEXT, to_status TEXT NOT NULL, reason TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS settlement_outbox (
 id TEXT PRIMARY KEY, transaction_id TEXT NOT NULL UNIQUE REFERENCES transactions(id),
 event_type TEXT NOT NULL, payload TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'PENDING',
 attempts INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, processed_at TEXT
);

CREATE TABLE IF NOT EXISTS settlement_commands (
 command_id TEXT PRIMARY KEY,
 device_id TEXT NOT NULL REFERENCES device_registrations(device_id),
 sequence_id INTEGER NOT NULL CHECK(sequence_id > 0),
 transaction_id TEXT NOT NULL REFERENCES transactions(id),
 idempotency_key TEXT NOT NULL, folio_id TEXT NOT NULL,
 amount_minor INTEGER NOT NULL CHECK(amount_minor > 0),
 currency TEXT NOT NULL CHECK(currency='INR'),
 payload_hash TEXT NOT NULL, payload TEXT NOT NULL, created_at TEXT NOT NULL,
 UNIQUE(device_id, sequence_id), UNIQUE(device_id, transaction_id),
 UNIQUE(device_id, idempotency_key)
);
CREATE TABLE IF NOT EXISTS device_command_state (
 command_id TEXT PRIMARY KEY REFERENCES settlement_commands(command_id),
 status TEXT NOT NULL DEFAULT 'PENDING'
  CHECK(status IN ('PENDING','LEASED','DELIVERING','ACKNOWLEDGED','PROCESSED','AMBIGUOUS_RECONCILIATION','CONFLICT')),
 lease_token TEXT, lease_expires_at TEXT,
 attempt_count INTEGER NOT NULL DEFAULT 0 CHECK(attempt_count >= 0),
 next_attempt_at TEXT, ledger_ack_id TEXT, receipt_payload TEXT, receipt_signature TEXT,
 acknowledged_at TEXT, processed_at TEXT, last_error TEXT,
 CHECK ((lease_token IS NULL AND lease_expires_at IS NULL) OR (lease_token IS NOT NULL AND lease_expires_at IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS commands_device_sequence ON settlement_commands(device_id,sequence_id);
CREATE INDEX IF NOT EXISTS command_delivery_retry ON device_command_state(status,next_attempt_at);
CREATE INDEX IF NOT EXISTS command_delivery_lease ON device_command_state(status,lease_expires_at);

-- Database-level invariants: a queued command is an immutable projection of
-- one captured transaction, and SETTLED is impossible without its durable
-- device receipt and an advanced sequence cursor.
CREATE TRIGGER IF NOT EXISTS settlement_command_binding_guard
BEFORE INSERT ON settlement_commands
BEGIN
 SELECT CASE WHEN NOT EXISTS (
   SELECT 1 FROM transactions t
   WHERE t.id=NEW.transaction_id
     AND t.device_id=NEW.device_id
     AND t.folio_id=NEW.folio_id
     AND t.amount_minor=NEW.amount_minor
     AND t.currency=NEW.currency
     AND t.status='CAPTURED_PENDING_ACCOUNTING'
 ) THEN RAISE(ABORT,'settlement_command_transaction_binding_mismatch') END;
END;
CREATE TRIGGER IF NOT EXISTS settlement_command_immutable_guard
BEFORE UPDATE ON settlement_commands
BEGIN
 SELECT RAISE(ABORT,'settlement_command_is_immutable');
END;
CREATE TRIGGER IF NOT EXISTS transaction_settled_receipt_guard
BEFORE UPDATE OF status ON transactions
WHEN NEW.status='SETTLED' AND OLD.status<>'SETTLED'
BEGIN
 SELECT CASE WHEN NOT EXISTS (
   SELECT 1
   FROM settlement_commands c
   JOIN device_command_state s ON s.command_id=c.command_id
   JOIN device_cursors d ON d.device_id=c.device_id
   WHERE c.transaction_id=NEW.id
     AND c.device_id=NEW.device_id
     AND c.folio_id=NEW.folio_id
     AND c.amount_minor=NEW.amount_minor
     AND c.currency=NEW.currency
     AND s.status='PROCESSED'
     AND s.ledger_ack_id IS NOT NULL AND length(trim(s.ledger_ack_id))>0
     AND s.receipt_payload IS NOT NULL
     AND s.receipt_signature IS NOT NULL
     AND s.acknowledged_at IS NOT NULL
     AND d.last_applied_sequence>=c.sequence_id
 ) THEN RAISE(ABORT,'settled_transaction_requires_durable_device_receipt') END;
END;
CREATE TABLE IF NOT EXISTS webhook_inbox (
 event_key TEXT PRIMARY KEY, provider TEXT NOT NULL, environment TEXT NOT NULL,
 received_at TEXT NOT NULL, signature_verified INTEGER NOT NULL,
 processing_status TEXT NOT NULL, payload_sha256 TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS audit (
 id INTEGER PRIMARY KEY AUTOINCREMENT, action TEXT NOT NULL, subject TEXT,
 created_at TEXT NOT NULL
);
`);

// Additive migration for databases created by earlier backend versions.
// Existing payment history is preserved; legacy transactions remain untargeted
// until a future explicit routing migration assigns both fields.
const registrationColumns = new Set(db.prepare('PRAGMA table_info(device_registrations)').all().map(column => column.name));
for (const [name, declaration] of [
  ['owner_id', 'INTEGER'], ['property_id', 'TEXT'], ['attestation_verified_at', 'TEXT'],
  ['attestation_security_level', 'TEXT'], ['attestation_verified_boot_state', 'TEXT'],
  ['attestation_device_locked', 'INTEGER'], ['attestation_chain_sha256', 'TEXT'],
  ['attestation_metadata', 'TEXT']
]) {
  if (!registrationColumns.has(name)) db.exec('ALTER TABLE device_registrations ADD COLUMN ' + name + ' ' + declaration);
}
const challengeColumns = new Set(db.prepare('PRAGMA table_info(device_challenges)').all().map(column => column.name));
for (const [name, declaration] of [
  ['owner_id', 'INTEGER'], ['property_id', 'TEXT'], ['nonce_base64', 'TEXT']
]) {
  if (!challengeColumns.has(name)) db.exec('ALTER TABLE device_challenges ADD COLUMN ' + name + ' ' + declaration);
}

const transactionColumns = new Set(db.prepare('PRAGMA table_info(transactions)').all().map(column => column.name));
if (!transactionColumns.has('device_id')) {
  db.exec('ALTER TABLE transactions ADD COLUMN device_id TEXT REFERENCES device_registrations(device_id)');
}
if (!transactionColumns.has('folio_id')) {
  db.exec('ALTER TABLE transactions ADD COLUMN folio_id TEXT');
}
if (!transactionColumns.has('provider_payment_id')) {
  db.exec('ALTER TABLE transactions ADD COLUMN provider_payment_id TEXT');
}
if (!transactionColumns.has('provider_checkout_session_id')) {
  db.exec('ALTER TABLE transactions ADD COLUMN provider_checkout_session_id TEXT');
}

// Existing registrations were previously marked ACTIVE without proof of
// possession. Downgrade them once so an old database cannot bypass the new
// pending-enrollment gate. PRAGMA user_version makes this migration one-shot.
const deviceEnrollmentSchemaVersion = db.pragma('user_version', { simple: true });
if (deviceEnrollmentSchemaVersion < 1) {
  db.prepare("UPDATE device_registrations SET status='PENDING' WHERE status='ACTIVE'").run();
  db.pragma('user_version = 1');
}

const now = () => new Date().toISOString();
const fail = (res, status, error) => res.status(status).json({ error });
const audit = db.prepare('INSERT INTO audit(action,subject,created_at) VALUES(?,?,?)');
function writeAudit(action, subject = null) { audit.run(action, subject, now()); }
function encryptCredentials(value) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', masterKey, iv);
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
  return { ciphertext: ciphertext.toString('base64'), iv: iv.toString('hex'), authTag: cipher.getAuthTag().toString('hex') };
}
function decryptCredentials(row) {
  const iv = Buffer.from(row.iv, 'hex'), tag = Buffer.from(row.auth_tag, 'hex');
  if (iv.length !== 12 || tag.length !== 16) throw new Error('credential_ciphertext_invalid');
  const decipher = createDecipheriv('aes-256-gcm', masterKey, iv);
  decipher.setAuthTag(tag);
  return JSON.parse(Buffer.concat([
    decipher.update(Buffer.from(row.ciphertext, 'base64')), decipher.final()
  ]).toString('utf8'));
}
function tokenDigest(token) {
  return createHmac('sha256', sessionPepper).update(token).digest('hex');
}
async function hashPassword(password, salt = randomBytes(16)) {
  const key = await scrypt(password, salt, 64, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
  return { salt: salt.toString('hex'), hash: Buffer.from(key).toString('hex'), N: 32768, r: 8, p: 1 };
}
async function verifyPassword(password, row) {
  if (typeof password !== 'string' || password.length < 1 || password.length > 1024) return false;
  try {
    const expected = Buffer.from(row.password_hash, 'hex');
    if (expected.length !== 64 || !/^[a-f0-9]{32}$/i.test(row.password_salt)) return false;
    const actual = Buffer.from(await scrypt(password, Buffer.from(row.password_salt, 'hex'), 64, {
      N: row.password_n, r: row.password_r, p: row.password_p, maxmem: 64 * 1024 * 1024
    }));
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  } catch { return false; }
}
function originGuard(req, res, next) {
  const origin = req.get('origin');
  const browserMutation = ['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method) &&
    !req.path.startsWith('/v1/webhooks/') && !req.path.startsWith('/v1/devices/');
  if (browserMutation && !origin) return fail(res, 403, 'origin_required');
  if (origin && !origins.has(origin)) return fail(res, 403, 'origin_not_allowed');
  if (origin) {
    res.set('Access-Control-Allow-Origin', origin);
    res.set('Vary', 'Origin');
    res.set('Access-Control-Allow-Credentials', 'true');
    res.set('Access-Control-Allow-Headers', 'Content-Type, X-Aurelia-Setup-Token');
    res.set('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  }
  if (req.method === 'OPTIONS') return res.status(204).end();
  res.set('Cache-Control', 'no-store');
  res.set('Pragma', 'no-cache');
  next();
}
app.use(originGuard);
app.use((req, res, next) => {
  if (!req.secure) return fail(res, 403, 'https_required');
  next();
});
app.use(express.json({ limit: '512kb', strict: true, type: req => !req.path.startsWith('/v1/webhooks/') }));

const loginAttempts = new Map();
function loginRateLimit(req, res, next) {
  const key = req.ip || 'unknown', current = Date.now();
  for (const [ip, entry] of loginAttempts) {
    if (entry.reset <= current) loginAttempts.delete(ip);
  }
  if (!loginAttempts.has(key) && loginAttempts.size >= 10000) {
    const oldest = loginAttempts.keys().next().value;
    if (oldest !== undefined) loginAttempts.delete(oldest);
  }
  const item = loginAttempts.get(key) || { count: 0, reset: current + 15 * 60_000 };
  item.count++;
  loginAttempts.set(key, item);
  if (item.count > 5) return fail(res, 429, 'login_rate_limited');
  next();
}
// SameSite=None is required for the cross-origin Capacitor WebView -> LAN appliance
// cookie flow. Require exact-Origin validation on every cookie-authenticated
// browser mutation so a hostile site cannot ride the HttpOnly session.
function requireBrowserMutationOrigin(req, res, next) {
  const origin = req.get('origin');
  if (!origin || !origins.has(origin)) return fail(res, 403, 'origin_not_allowed');
  return next();
}

function canonicalJson(value) {
  if (Array.isArray(value)) return '[' + value.map(canonicalJson).join(',') + ']';
  if (value && typeof value === 'object') {
    return '{' + Object.keys(value).sort().map(key =>
      JSON.stringify(key) + ':' + canonicalJson(value[key])
    ).join(',') + '}';
  }
  return JSON.stringify(value);
}
function deviceAuth(req, res, next) {
  const deviceId = req.params.deviceId;
  if (!validOpaqueId(deviceId)) return fail(res, 400, 'invalid_device_id');
  const timestampText = req.get('x-aurelia-device-timestamp') || '';
  const nonce = req.get('x-aurelia-device-nonce') || '';
  const signature = req.get('x-aurelia-device-signature') || '';
  if (!/^\d{10}$/.test(timestampText) || !/^[A-Za-z0-9_-]{16,128}$/.test(nonce) ||
      !/^[A-Za-z0-9_-]{80,160}$/.test(signature)) return fail(res, 401, 'device_request_signature_required');
  const timestamp = Number(timestampText), current = Math.floor(Date.now() / 1000);
  if (!Number.isSafeInteger(timestamp) || Math.abs(current - timestamp) > 60) return fail(res, 401, 'device_request_timestamp_out_of_range');
  const device = db.prepare('SELECT public_key_spki,status FROM device_registrations WHERE device_id=?').get(deviceId);
  if (!device || device.status !== 'ACTIVE') return fail(res, 403, 'device_not_active');
  const bodyHash = crypto.createHash('sha256').update(canonicalJson(req.body || {})).digest('hex');
  const transcript = [
    'AURELIA_DEVICE_REQUEST_V1', deviceId, req.method.toUpperCase(),
    req.originalUrl, timestampText, nonce, bodyHash
  ].join('\n');
  let verified = false;
  try {
    const publicKey = crypto.createPublicKey({ key: Buffer.from(device.public_key_spki), type: 'spki', format: 'der' });
    verified = crypto.verify('sha256', Buffer.from(transcript, 'utf8'), publicKey, Buffer.from(signature, 'base64url'));
  } catch { verified = false; }
  if (!verified) return fail(res, 403, 'device_request_signature_invalid');
  const nonceHash = crypto.createHash('sha256').update(nonce).digest('hex');
  try {
    const accept = db.transaction(() => {
      db.prepare('DELETE FROM device_request_nonces WHERE expires_at<=?').run(current);
      db.prepare('INSERT INTO device_request_nonces(device_id,nonce_sha256,expires_at,created_at) VALUES(?,?,?,?)')
        .run(deviceId, nonceHash, current + 5 * 60, now());
      db.prepare('UPDATE device_registrations SET last_seen_at=? WHERE device_id=? AND status=\'ACTIVE\'')
        .run(now(), deviceId);
    });
    accept();
  } catch { return fail(res, 409, 'device_request_replay'); }
  req.device = { deviceId };
  req.deviceSignature = signature;
  next();
}

function ownerAuth(req, res, next) {
  const cookieHeader = req.get('cookie') || '';
  const cookieToken = cookieHeader.split(';').map(v => v.trim()).find(v => v.startsWith(SESSION_COOKIE + '='))?.slice(SESSION_COOKIE.length + 1);
  const token = cookieToken;
  if (typeof token !== 'string' || token.length < 40 || token.length > 256) return fail(res, 401, 'owner_session_required');
  const digest = tokenDigest(token);
  const row = db.prepare('SELECT s.expires_at,o.id,o.username FROM sessions s JOIN owner o ON o.id=s.owner_id WHERE s.token_hash=?').get(digest);
  if (!row || row.expires_at <= Math.floor(Date.now() / 1000)) {
    db.prepare('DELETE FROM sessions WHERE token_hash=?').run(digest);
    return fail(res, 401, 'owner_session_expired');
  }
  req.owner = { id: row.id, username: row.username };
  req.sessionDigest = digest;
  next();
}

app.get('/healthz', (_req, res) => res.json({ ok: true }));
app.get('/readyz', async (_req, res) => {
  try {
    db.prepare('SELECT 1').get();
    const verifier = await fetch('http://127.0.0.1:8091/healthz', { signal: AbortSignal.timeout(2500) });
    if (!verifier.ok) return fail(res, 503, 'attestation_verifier_unready');
    return res.json({ ok: true, database: 'ready', attestationVerifier: 'ready' });
  } catch { return fail(res, 503, 'attestation_verifier_or_database_unavailable'); }
});
// Challenge-first enrollment: the device key does not exist until the owner-bound
// challenge has been issued. This is the canonical flow for challenge-bound Android
// Key Attestation; it avoids registering a legacy, unattested key before key creation.
app.post('/v1/admin/devices/enrollment/challenge', ownerAuth, requireBrowserMutationOrigin, (req, res) => {
  const { deviceId } = req.body || {};
  if (!validOpaqueId(deviceId)) return fail(res, 400, 'invalid_device_id');
  const existing = db.prepare('SELECT status,owner_id,property_id,attestation_verified_at FROM device_registrations WHERE device_id=?')
    .get(deviceId);
  if (existing && (existing.status !== 'PENDING' || existing.owner_id !== req.owner.id ||
      existing.property_id !== PROPERTY_ID || existing.attestation_verified_at))
    return fail(res, 409, 'device_identity_already_enrolled_or_conflicted');

  const challengeId = crypto.randomUUID();
  const nonce = randomBytes(32).toString('base64url');
  const expiresAt = Math.floor(Date.now() / 1000) + 5 * 60;
  const issue = db.transaction(() => {
    db.prepare('UPDATE device_enrollment_challenges SET consumed_at=COALESCE(consumed_at,?) WHERE device_id=? AND owner_id=? AND property_id=? AND consumed_at IS NULL')
      .run(now(), deviceId, req.owner.id, PROPERTY_ID);
    db.prepare('INSERT INTO device_enrollment_challenges(challenge_id,device_id,owner_id,property_id,nonce_sha256,nonce_base64,expires_at,created_at) VALUES(?,?,?,?,?,?,?,?)')
      .run(challengeId, deviceId, req.owner.id, PROPERTY_ID,
        crypto.createHash('sha256').update(Buffer.from(nonce, 'base64url')).digest('hex'),
        nonce, expiresAt, now());
    writeAudit('PAYMENT_DEVICE_ATTESTATION_CHALLENGE_ISSUED', deviceId);
  });
  issue();
  return res.status(201).json({ challengeId, nonce });
});

app.post('/v1/admin/devices/enroll', ownerAuth, requireBrowserMutationOrigin, async (req, res) => {
  const { deviceId, challengeId, publicKeyPem, certificateChainBase64 } = req.body || {};
  if (!validOpaqueId(deviceId) || typeof challengeId !== 'string' ||
      !/^[0-9a-f-]{36}$/i.test(challengeId) || typeof publicKeyPem !== 'string' ||
      publicKeyPem.length > 4096 || !Array.isArray(certificateChainBase64) ||
      certificateChainBase64.length < 2 || certificateChainBase64.length > 8 ||
      certificateChainBase64.some(value => typeof value !== 'string' || value.length < 128 || value.length > 90000))
    return fail(res, 400, 'invalid_attested_enrollment_submission');

  let suppliedKey;
  try { suppliedKey = crypto.createPublicKey(publicKeyPem); }
  catch { return fail(res, 400, 'invalid_device_public_key'); }
  if (suppliedKey.asymmetricKeyType !== 'ec' || suppliedKey.asymmetricKeyDetails?.namedCurve !== 'prime256v1')
    return fail(res, 400, 'device_key_must_be_p256');
  const suppliedSpki = suppliedKey.export({ type: 'spki', format: 'der' });

  const challenge = db.prepare('SELECT * FROM device_enrollment_challenges WHERE challenge_id=? AND device_id=?')
    .get(challengeId, deviceId);
  const current = Math.floor(Date.now() / 1000);
  if (!challenge || challenge.consumed_at || challenge.expires_at <= current ||
      challenge.owner_id !== req.owner.id || challenge.property_id !== PROPERTY_ID)
    return fail(res, 409, 'attestation_challenge_invalid_or_expired');
  const challengeBytes = Buffer.from(challenge.nonce_base64, 'base64url');
  if (crypto.createHash('sha256').update(challengeBytes).digest('hex') !== challenge.nonce_sha256)
    return fail(res, 409, 'attestation_challenge_integrity_failure');

  const existing = db.prepare('SELECT status,owner_id,property_id,attestation_verified_at FROM device_registrations WHERE device_id=?')
    .get(deviceId);
  if (existing && (existing.status !== 'PENDING' || existing.owner_id !== req.owner.id ||
      existing.property_id !== PROPERTY_ID || existing.attestation_verified_at))
    return fail(res, 409, 'device_identity_already_enrolled_or_conflicted');

  let verification;
  try {
    const response = await fetch(ATTESTATION_VERIFIER_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ challengeBase64: challenge.nonce_base64, certificateChainBase64 }),
      signal: AbortSignal.timeout(30000)
    });
    verification = await response.json();
    if (!response.ok || verification?.status !== 'VERIFIED') {
      db.prepare('UPDATE device_enrollment_challenges SET consumed_at=? WHERE challenge_id=? AND consumed_at IS NULL')
        .run(now(), challengeId);
      writeAudit('PAYMENT_DEVICE_ATTESTATION_REJECTED', deviceId + ':' + String(verification?.reason || 'verifier_rejected').slice(0, 80));
      return fail(res, 422, 'device_attestation_verification_failed');
    }
  } catch {
    writeAudit('PAYMENT_DEVICE_ATTESTATION_VERIFIER_UNAVAILABLE', deviceId);
    return fail(res, 503, 'device_attestation_verifier_unavailable');
  }

  const verifiedSpki = Buffer.from(verification.publicKeySpkiBase64 || '', 'base64');
  if (!verifiedSpki.length || !verifiedSpki.equals(suppliedSpki)) {
    db.prepare('UPDATE device_enrollment_challenges SET consumed_at=? WHERE challenge_id=? AND consumed_at IS NULL')
      .run(now(), challengeId);
    writeAudit('PAYMENT_DEVICE_ATTESTATION_KEY_BINDING_REJECTED', deviceId);
    return fail(res, 422, 'device_attestation_key_binding_failed');
  }

  let chainDigest;
  try {
    const chainBytes = certificateChainBase64.map(value => Buffer.from(value, 'base64'));
    if (chainBytes.some((value, index) => !value.length || value.length > 65536 ||
        value.toString('base64').replace(/=+$/, '') !== certificateChainBase64[index].replace(/=+$/, '')))
      throw new Error('certificate_encoding_invalid');
    chainDigest = crypto.createHash('sha256').update(Buffer.concat(chainBytes)).digest('hex');
  } catch {
    db.prepare('UPDATE device_enrollment_challenges SET consumed_at=? WHERE challenge_id=? AND consumed_at IS NULL')
      .run(now(), challengeId);
    writeAudit('PAYMENT_DEVICE_ATTESTATION_CHAIN_ENCODING_REJECTED', deviceId);
    return fail(res, 422, 'device_attestation_chain_invalid');
  }

  const verifiedAt = now();
  const metadata = {
    verifier: 'android/keyattestation',
    verifierVersion: 'v0.4',
    challengeId,
    ownerId: req.owner.id,
    propertyId: PROPERTY_ID,
    securityLevel: verification.securityLevel,
    verifiedBootState: verification.verifiedBootState,
    deviceLocked: verification.deviceLocked === true,
    certificateChainSha256: chainDigest,
    publicKeySha256: crypto.createHash('sha256').update(verifiedSpki).digest('hex')
  };
  const persist = db.transaction(() => {
    const consumed = db.prepare('UPDATE device_enrollment_challenges SET consumed_at=? WHERE challenge_id=? AND device_id=? AND owner_id=? AND property_id=? AND consumed_at IS NULL AND expires_at>?')
      .run(verifiedAt, challengeId, deviceId, req.owner.id, PROPERTY_ID, current);
    if (consumed.changes !== 1) throw new Error('attestation_challenge_race_or_expiry');
    if (existing) {
      const updated = db.prepare("UPDATE device_registrations SET public_key_spki=?,key_algorithm='ECDSA_P256_SHA256',attestation_verified_at=?,attestation_security_level=?,attestation_verified_boot_state=?,attestation_device_locked=1,attestation_chain_sha256=?,attestation_metadata=? WHERE device_id=? AND status='PENDING' AND owner_id=? AND property_id=? AND attestation_verified_at IS NULL")
        .run(verifiedSpki, verifiedAt, verification.securityLevel, verification.verifiedBootState,
          chainDigest, JSON.stringify(metadata), deviceId, req.owner.id, PROPERTY_ID);
      if (updated.changes !== 1) throw new Error('device_attestation_persistence_conflict');
    } else {
      db.prepare("INSERT INTO device_registrations(device_id,public_key_spki,key_algorithm,status,created_at,owner_id,property_id,attestation_verified_at,attestation_security_level,attestation_verified_boot_state,attestation_device_locked,attestation_chain_sha256,attestation_metadata) VALUES(?,?,'ECDSA_P256_SHA256','PENDING',?,?,?,?,?,?,1,?,?)")
        .run(deviceId, verifiedSpki, verifiedAt, req.owner.id, PROPERTY_ID, verifiedAt,
          verification.securityLevel, verification.verifiedBootState, chainDigest, JSON.stringify(metadata));
    }
    db.prepare('INSERT OR IGNORE INTO device_cursors(device_id,last_applied_sequence,updated_at) VALUES(?,0,?)')
      .run(deviceId, verifiedAt);
    db.prepare('INSERT OR IGNORE INTO device_sequence_counters(device_id,last_sequence) VALUES(?,0)')
      .run(deviceId);
    writeAudit('PAYMENT_DEVICE_ATTESTATION_VERIFIED', deviceId);
  });
  try { persist(); }
  catch {
    writeAudit('PAYMENT_DEVICE_ATTESTATION_PERSISTENCE_REJECTED', deviceId);
    return fail(res, 409, 'device_attestation_persistence_conflict');
  }
  return res.status(201).json({
    deviceId, status: 'PENDING', attestationVerified: true,
    securityLevel: verification.securityLevel,
    verifiedBootState: verification.verifiedBootState,
    deviceLocked: true
  });
});

// The Android app generates and retains its private key in Android Keystore.
// Only the P-256 public key is registered with this service.
app.post('/v1/admin/devices/register', ownerAuth, requireBrowserMutationOrigin, (req, res) => {
  const { deviceId, publicKeyPem } = req.body || {};
  if (!validOpaqueId(deviceId) || typeof publicKeyPem !== 'string' || publicKeyPem.length > 4096)
    return fail(res, 400, 'invalid_device_registration');
  let key;
  try { key = crypto.createPublicKey(publicKeyPem); }
  catch { return fail(res, 400, 'invalid_device_public_key'); }
  if (key.asymmetricKeyType !== 'ec' || key.asymmetricKeyDetails?.namedCurve !== 'prime256v1')
    return fail(res, 400, 'device_key_must_be_p256');
  const der = key.export({type:'spki',format:'der'});
  const existing = db.prepare('SELECT public_key_spki,status,owner_id,property_id FROM device_registrations WHERE device_id=?').get(deviceId);
  if (existing) {
    if (!Buffer.from(existing.public_key_spki).equals(der) || existing.status === 'REVOKED' ||
        (existing.owner_id !== null && existing.owner_id !== req.owner.id) ||
        (existing.property_id !== null && existing.property_id !== PROPERTY_ID))
      return fail(res, 409, 'device_identity_conflict');
    if (existing.owner_id === null && existing.property_id === null && existing.status === 'PENDING') {
      db.prepare('UPDATE device_registrations SET owner_id=?,property_id=? WHERE device_id=? AND owner_id IS NULL AND property_id IS NULL')
        .run(req.owner.id, PROPERTY_ID, deviceId);
    }
    return res.status(200).json({deviceId,status:existing.status,duplicate:true});
  }
  const register = db.transaction(() => {
    db.prepare("INSERT INTO device_registrations(device_id,public_key_spki,key_algorithm,status,created_at,owner_id,property_id) VALUES(?,?,'ECDSA_P256_SHA256','PENDING',?,?,?)").run(deviceId,der,now(),req.owner.id,PROPERTY_ID);
    db.prepare('INSERT INTO device_cursors(device_id,last_applied_sequence,updated_at) VALUES(?,0,?)').run(deviceId,now());
    db.prepare('INSERT INTO device_sequence_counters(device_id,last_sequence) VALUES(?,0)').run(deviceId);
    writeAudit('PAYMENT_DEVICE_REGISTERED',deviceId);
  });
  try { register(); } catch { return fail(res,409,'device_registration_conflict'); }
  return res.status(201).json({
    deviceId, status: 'PENDING', keyAlgorithm: 'ECDSA_P256_SHA256',
    attestationRequired: true, activationBlockedUntilAttestationVerified: true
  });
});

// Owner-authorized challenge issuance. The nonce is returned once; only its
// digest and a short expiry are retained by the appliance.
app.post('/v1/admin/devices/:deviceId/challenge', ownerAuth, requireBrowserMutationOrigin, (req, res) => {
  const deviceId = req.params.deviceId;
  if (!validOpaqueId(deviceId)) return fail(res, 400, 'invalid_device_id');
  const device = db.prepare('SELECT status,key_version,owner_id,property_id FROM device_registrations WHERE device_id=?').get(deviceId);
  if (!device) return fail(res, 404, 'device_not_found');
  if (device.status !== 'PENDING') return fail(res, 409, 'device_not_pending');
  if (device.owner_id !== req.owner.id || device.property_id !== PROPERTY_ID)
    return fail(res, 403, 'device_owner_or_property_mismatch');
  const challengeId = crypto.randomUUID();
  const nonce = randomBytes(32).toString('base64url');
  const expiresAt = Math.floor(Date.now() / 1000) + 5 * 60;
  const issueChallenge = db.transaction(() => {
    db.prepare('UPDATE device_challenges SET consumed_at=COALESCE(consumed_at,?) WHERE device_id=? AND consumed_at IS NULL').run(now(), deviceId);
    db.prepare('INSERT INTO device_challenges(challenge_id,device_id,nonce_sha256,expires_at,created_at,owner_id,property_id,nonce_base64) VALUES(?,?,?,?,?,?,?,?)')
      .run(challengeId, deviceId, crypto.createHash('sha256').update(Buffer.from(nonce, 'base64url')).digest('hex'), expiresAt, now(), req.owner.id, PROPERTY_ID, nonce);
  });
  issueChallenge();
  // The exact decoded nonce bytes are the Android Key Attestation challenge.
  // The verifier must compare the extension challenge to these bytes.
  writeAudit('PAYMENT_DEVICE_ATTESTATION_CHALLENGE_ISSUED', deviceId);
  return res.status(201).json({
    deviceId, challengeId, nonce, attestationChallenge: nonce, expiresAt,
    algorithm: 'ECDSA_P256_SHA256', attestationRequired: true
  });
});

// The device signs a domain-separated transcript with its Android Keystore
// P-256 key. A challenge is single-use and activation is an atomic state change.
app.post('/v1/admin/devices/:deviceId/attestation', ownerAuth, requireBrowserMutationOrigin, async (req, res) => {
  const deviceId = req.params.deviceId;
  const { challengeId, certificateChainBase64 } = req.body || {};
  if (!validOpaqueId(deviceId) || typeof challengeId !== 'string' ||
      !/^[0-9a-f-]{36}$/i.test(challengeId) || !Array.isArray(certificateChainBase64) ||
      certificateChainBase64.length < 2 || certificateChainBase64.length > 8 ||
      certificateChainBase64.some(value => typeof value !== 'string' || value.length < 128 || value.length > 90000))
    return fail(res, 400, 'invalid_attestation_submission');

  const device = db.prepare('SELECT public_key_spki,status,owner_id,property_id FROM device_registrations WHERE device_id=?').get(deviceId);
  if (!device) return fail(res, 404, 'device_not_found');
  if (device.status !== 'PENDING') return fail(res, 409, 'device_not_pending');
  if (device.owner_id !== req.owner.id || device.property_id !== PROPERTY_ID)
    return fail(res, 403, 'device_owner_or_property_mismatch');

  const challenge = db.prepare('SELECT challenge_id,nonce_sha256,nonce_base64,expires_at,consumed_at,owner_id,property_id FROM device_challenges WHERE challenge_id=? AND device_id=?')
    .get(challengeId, deviceId);
  const current = Math.floor(Date.now() / 1000);
  if (!challenge || challenge.consumed_at || challenge.expires_at <= current ||
      challenge.owner_id !== req.owner.id || challenge.property_id !== PROPERTY_ID || !challenge.nonce_base64)
    return fail(res, 409, 'attestation_challenge_invalid_or_expired');

  const challengeBytes = Buffer.from(challenge.nonce_base64, 'base64url');
  const challengeDigest = crypto.createHash('sha256').update(challengeBytes).digest('hex');
  if (challengeDigest !== challenge.nonce_sha256) return fail(res, 409, 'attestation_challenge_integrity_failure');

  let verification;
  try {
    const verifierResponse = await fetch(ATTESTATION_VERIFIER_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ challengeBase64: challenge.nonce_base64, certificateChainBase64 }),
      signal: AbortSignal.timeout(30000)
    });
    verification = await verifierResponse.json();
    if (!verifierResponse.ok || verification?.status !== 'VERIFIED') {
      writeAudit('PAYMENT_DEVICE_ATTESTATION_REJECTED', deviceId + ':' + String(verification?.reason || 'verifier_rejected').slice(0, 80));
      db.prepare('UPDATE device_challenges SET consumed_at=? WHERE challenge_id=? AND consumed_at IS NULL').run(now(), challengeId);
      return fail(res, 422, 'device_attestation_verification_failed');
    }
  } catch {
    writeAudit('PAYMENT_DEVICE_ATTESTATION_VERIFIER_UNAVAILABLE', deviceId);
    return fail(res, 503, 'device_attestation_verifier_unavailable');
  }

  const verifiedSpki = Buffer.from(verification.publicKeySpkiBase64 || '', 'base64');
  if (!verifiedSpki.length || !verifiedSpki.equals(Buffer.from(device.public_key_spki))) {
    db.prepare('UPDATE device_challenges SET consumed_at=? WHERE challenge_id=? AND consumed_at IS NULL').run(now(), challengeId);
    writeAudit('PAYMENT_DEVICE_ATTESTATION_KEY_BINDING_REJECTED', deviceId);
    return fail(res, 422, 'device_attestation_key_binding_failed');
  }

  let chainDigest;
  try {
    const chainBytes = certificateChainBase64.map(value => Buffer.from(value, 'base64'));
    if (chainBytes.some((value, index) => !value.length || value.length > 65536 ||
        value.toString('base64').replace(/=+$/, '') !== certificateChainBase64[index].replace(/=+$/, ''))) {
      throw new Error('certificate_encoding_invalid');
    }
    chainDigest = crypto.createHash('sha256').update(Buffer.concat(chainBytes)).digest('hex');
  } catch {
    db.prepare('UPDATE device_challenges SET consumed_at=? WHERE challenge_id=? AND consumed_at IS NULL').run(now(), challengeId);
    writeAudit('PAYMENT_DEVICE_ATTESTATION_CHAIN_ENCODING_REJECTED', deviceId);
    return fail(res, 422, 'device_attestation_chain_invalid');
  }

  const verifiedAt = now();
  const metadata = {
    verifier: 'android/keyattestation',
    verifierVersion: 'v0.4',
    challengeId,
    ownerId: req.owner.id,
    propertyId: PROPERTY_ID,
    securityLevel: verification.securityLevel,
    verifiedBootState: verification.verifiedBootState,
    deviceLocked: verification.deviceLocked === true,
    certificateChainSha256: chainDigest,
    publicKeySha256: crypto.createHash('sha256').update(verifiedSpki).digest('hex')
  };
  const persist = db.transaction(() => {
    const consumed = db.prepare('UPDATE device_challenges SET consumed_at=? WHERE challenge_id=? AND device_id=? AND owner_id=? AND property_id=? AND consumed_at IS NULL AND expires_at>?')
      .run(verifiedAt, challengeId, deviceId, req.owner.id, PROPERTY_ID, current);
    if (consumed.changes !== 1) throw new Error('attestation_challenge_race_or_expiry');
    const saved = db.prepare("UPDATE device_registrations SET attestation_verified_at=?,attestation_security_level=?,attestation_verified_boot_state=?,attestation_device_locked=1,attestation_chain_sha256=?,attestation_metadata=? WHERE device_id=? AND status='PENDING' AND owner_id=? AND property_id=? AND public_key_spki=? AND attestation_verified_at IS NULL")
      .run(verifiedAt, verification.securityLevel, verification.verifiedBootState, chainDigest,
        JSON.stringify(metadata), deviceId, req.owner.id, PROPERTY_ID, verifiedSpki);
    if (saved.changes !== 1) throw new Error('device_attestation_persistence_conflict');
    writeAudit('PAYMENT_DEVICE_ATTESTATION_VERIFIED', deviceId);
  });
  try { persist(); }
  catch {
    writeAudit('PAYMENT_DEVICE_ATTESTATION_PERSISTENCE_REJECTED', deviceId);
    return fail(res, 409, 'device_attestation_persistence_conflict');
  }
  return res.status(200).json({
    deviceId, status: 'PENDING', attestationVerified: true,
    securityLevel: verification.securityLevel,
    verifiedBootState: verification.verifiedBootState,
    deviceLocked: true
  });
});

app.post('/v1/admin/devices/:deviceId/activate', ownerAuth, requireBrowserMutationOrigin, (req, res) => {
  const deviceId = req.params.deviceId;
  if (!validOpaqueId(deviceId)) return fail(res, 400, 'invalid_device_id');
  const activate = db.transaction(() => {
    const device = db.prepare('SELECT status,owner_id,property_id,attestation_verified_at,attestation_security_level,attestation_verified_boot_state,attestation_device_locked FROM device_registrations WHERE device_id=?').get(deviceId);
    if (!device) return { missing: true };
    if (device.status !== 'PENDING') return { conflict: true };
    if (device.owner_id !== req.owner.id || device.property_id !== PROPERTY_ID) return { forbidden: true };
    if (!device.attestation_verified_at ||
        !['TRUSTED_ENVIRONMENT','STRONG_BOX'].includes(device.attestation_security_level) ||
        device.attestation_verified_boot_state !== 'VERIFIED' || device.attestation_device_locked !== 1)
      return { attestationRequired: true };
    const updated = db.prepare("UPDATE device_registrations SET status='ACTIVE' WHERE device_id=? AND status='PENDING' AND attestation_verified_at IS NOT NULL").run(deviceId);
    if (updated.changes !== 1) return { conflict: true };
    writeAudit('PAYMENT_DEVICE_ACTIVATED_AFTER_VERIFIED_ATTESTATION', deviceId);
    return { activated: true };
  });
  const result = activate();
  if (result.missing) return fail(res, 404, 'device_not_found');
  if (result.forbidden) return fail(res, 403, 'device_owner_or_property_mismatch');
  if (result.attestationRequired) return fail(res, 409, 'device_attestation_required');
  if (result.conflict) return fail(res, 409, 'device_not_pending');
  return res.json({ deviceId, status: 'ACTIVE' });
});

app.post('/v1/admin/devices/:deviceId/revoke', ownerAuth, requireBrowserMutationOrigin, (req, res) => {
  const deviceId = req.params.deviceId;
  if (!validOpaqueId(deviceId)) return fail(res, 400, 'invalid_device_id');
  const revoke = db.transaction(() => {
    const device = db.prepare('SELECT status FROM device_registrations WHERE device_id=?').get(deviceId);
    if (!device) return { missing: true };
    if (device.status === 'REVOKED') return { duplicate: true };
    db.prepare("UPDATE device_registrations SET status='REVOKED',revoked_at=?,last_seen_at=? WHERE device_id=?")
      .run(now(), now(), deviceId);
    db.prepare('UPDATE device_challenges SET consumed_at=COALESCE(consumed_at,?) WHERE device_id=?')
      .run(now(), deviceId);
    db.prepare("UPDATE device_command_state SET status='CONFLICT',lease_token=NULL,lease_expires_at=NULL,last_error='device_revoked' WHERE command_id IN (SELECT command_id FROM settlement_commands WHERE device_id=?) AND status IN ('PENDING','LEASED','DELIVERING')")
      .run(deviceId);
    writeAudit('PAYMENT_DEVICE_REVOKED', deviceId);
    return { revoked: true };
  });
  const result = revoke();
  if (result.missing) return fail(res, 404, 'device_not_found');
  return res.json({ deviceId, status: 'REVOKED', duplicate: !!result.duplicate });
});

// A device can lease only its next contiguous sequence. Lease expiry permits
// redelivery; it never advances the cursor.
app.post('/v1/devices/:deviceId/commands/lease', deviceAuth, (req, res) => {
  const deviceId = req.device.deviceId;
  const leaseSeconds = 60;
  const leaseToken = randomBytes(32).toString('base64url');
  const leaseDigest = crypto.createHash('sha256').update(leaseToken).digest('hex');
  const currentTime = Math.floor(Date.now() / 1000);
  const lease = db.transaction(() => {
    const device = db.prepare('SELECT status FROM device_registrations WHERE device_id=?').get(deviceId);
    if (!device || device.status !== 'ACTIVE') throw new Error('device_not_active');
    const cursor = db.prepare('SELECT last_applied_sequence FROM device_cursors WHERE device_id=?').get(deviceId);
    if (!cursor) throw new Error('device_cursor_missing');
    const command = db.prepare(`SELECT c.*,s.status AS delivery_status,s.lease_expires_at
      FROM settlement_commands c JOIN device_command_state s ON s.command_id=c.command_id
      WHERE c.device_id=? AND c.sequence_id=?`).get(deviceId, cursor.last_applied_sequence + 1);
    if (!command) return { command: null, cursor: cursor.last_applied_sequence };
    const leaseExpired = command.lease_expires_at && Date.parse(command.lease_expires_at) <= Date.now();
    if (command.delivery_status === 'PROCESSED' || command.delivery_status === 'ACKNOWLEDGED') {
      return { command: null, cursor: cursor.last_applied_sequence };
    }
    if (!['PENDING','LEASED','DELIVERING'].includes(command.delivery_status) ||
        (['LEASED','DELIVERING'].includes(command.delivery_status) && !leaseExpired)) {
      return { command: null, cursor: cursor.last_applied_sequence };
    }
    const expiresAt = new Date(Date.now() + leaseSeconds * 1000).toISOString();
    db.prepare(`UPDATE device_command_state SET status='LEASED',lease_token=?,lease_expires_at=?,
      attempt_count=attempt_count+1,next_attempt_at=NULL,last_error=NULL WHERE command_id=?`)
      .run(leaseDigest, expiresAt, command.command_id);
    return {
      command: {
        commandId: command.command_id, deviceId, sequenceId: command.sequence_id,
        transactionId: command.transaction_id, idempotencyKey: command.idempotency_key,
        folioId: command.folio_id, amountMinor: command.amount_minor,
        currency: command.currency, payload: JSON.parse(command.payload),
        payloadCanonical: canonicalJson(JSON.parse(command.payload)),
        payloadHash: command.payload_hash
      },
      cursor: cursor.last_applied_sequence, leaseToken, leaseExpiresAt: expiresAt
    };
  });
  try {
    const result = lease();
    return res.json(result);
  } catch { return fail(res, 409, 'device_command_lease_conflict'); }
});

app.post('/v1/devices/:deviceId/commands/:commandId/ack', deviceAuth, (req, res) => {
  const deviceId = req.device.deviceId;
  const { commandId } = req.params;
  const { leaseToken, sequenceId, payloadHash, durableApplied, ledgerAckId } = req.body || {};
  if (!/^[0-9a-f-]{36}$/i.test(commandId) || typeof leaseToken !== 'string' ||
      !/^[A-Za-z0-9_-]{40,64}$/.test(leaseToken) || !Number.isSafeInteger(sequenceId) ||
      typeof payloadHash !== 'string' || !/^[a-f0-9]{64}$/.test(payloadHash) ||
      durableApplied !== true || !validOpaqueId(ledgerAckId)) {
    return fail(res, 400, 'invalid_device_command_receipt');
  }
  const leaseDigest = crypto.createHash('sha256').update(leaseToken).digest('hex');
  const result = db.transaction(() => {
    const device = db.prepare('SELECT status FROM device_registrations WHERE device_id=?').get(deviceId);
    if (!device || device.status !== 'ACTIVE') throw new Error('device_not_active');
    const command = db.prepare(`SELECT c.*,s.status AS delivery_status,s.lease_token,s.lease_expires_at,
      s.ledger_ack_id,s.receipt_payload FROM settlement_commands c
      JOIN device_command_state s ON s.command_id=c.command_id
      WHERE c.command_id=? AND c.device_id=?`).get(commandId, deviceId);
    if (!command) return { error: 'device_command_not_found' };
    const receipt = { commandId, deviceId, sequenceId, payloadHash, durableApplied, ledgerAckId };
    const receiptJson = canonicalJson(receipt);
    if (command.delivery_status === 'PROCESSED') {
      if (command.receipt_payload === receiptJson) return { acknowledged: true, duplicate: true };
      return { error: 'device_command_receipt_conflict' };
    }
    if (command.sequence_id !== sequenceId || command.payload_hash !== payloadHash) {
      return { error: 'device_command_binding_mismatch' };
    }
    const transaction = db.prepare('SELECT status FROM transactions WHERE id=? AND device_id=? AND folio_id=?')
      .get(command.transaction_id, deviceId, command.folio_id);
    if (!transaction || transaction.status !== 'CAPTURED_PENDING_ACCOUNTING') {
      return { error: 'payment_not_pending_accounting' };
    }
    const cursor = db.prepare('SELECT last_applied_sequence FROM device_cursors WHERE device_id=?').get(deviceId);
    if (!cursor || sequenceId !== cursor.last_applied_sequence + 1) return { error: 'device_cursor_out_of_order' };
    if (!command.lease_token || command.lease_token !== leaseDigest ||
        !command.lease_expires_at || Date.parse(command.lease_expires_at) <= Date.now() ||
        !['LEASED','DELIVERING'].includes(command.delivery_status)) {
      return { error: 'device_command_lease_invalid' };
    }
    const acknowledgedAt = now();
    const changed = db.prepare(`UPDATE device_command_state SET status='PROCESSED',lease_token=NULL,
      lease_expires_at=NULL,ledger_ack_id=?,receipt_payload=?,receipt_signature=?,acknowledged_at=?,processed_at=?
      WHERE command_id=? AND status IN ('LEASED','DELIVERING')`)
      .run(ledgerAckId, receiptJson, req.deviceSignature, acknowledgedAt, acknowledgedAt, commandId);
    if (changed.changes !== 1) return { error: 'device_command_ack_race' };
    const cursorUpdate = db.prepare('UPDATE device_cursors SET last_applied_sequence=?,updated_at=? WHERE device_id=? AND last_applied_sequence=?')
      .run(sequenceId, acknowledgedAt, deviceId, cursor.last_applied_sequence);
    if (cursorUpdate.changes !== 1) throw new Error('device_cursor_advance_race');
    // Finalize the PMS settlement boundary in the same SQLite transaction as
    // the signed device receipt and sequence cursor. A retry can never post a
    // second credit or advance accounting without its matching durable receipt.
    const settled = db.prepare(`UPDATE transactions SET status='SETTLED',updated_at=?
      WHERE id=? AND device_id=? AND folio_id=? AND status='CAPTURED_PENDING_ACCOUNTING'`)
      .run(acknowledgedAt, command.transaction_id, deviceId, command.folio_id);
    if (settled.changes !== 1) throw new Error('payment_settlement_state_race');
    db.prepare(`INSERT INTO transaction_journal(transaction_id,from_status,to_status,reason,created_at)
      VALUES(?,'CAPTURED_PENDING_ACCOUNTING','SETTLED','trusted_device_durable_folio_receipt',?)`)
      .run(command.transaction_id, acknowledgedAt);
    db.prepare(`UPDATE settlement_outbox SET status='PROCESSED',processed_at=?
      WHERE transaction_id=? AND event_type='PAYMENT_CAPTURED' AND status='PENDING'`)
      .run(acknowledgedAt, command.transaction_id);
    writeAudit('PAYMENT_DEVICE_COMMAND_ACKNOWLEDGED', deviceId + ':' + commandId);
    writeAudit('PAYMENT_FOLIO_SETTLEMENT_COMMITTED', command.transaction_id);
    return { acknowledged: true, duplicate: false, cursor: sequenceId, transactionStatus: 'SETTLED' };
  })();
  if (result.error) return fail(res, 409, result.error);
  return res.json(result);
});

app.get('/v1/auth/setup-status', (_req, res) => {
  res.json({ setupRequired: !db.prepare('SELECT 1 FROM owner WHERE id=1').get() });
});
app.post('/v1/auth/setup', loginRateLimit, async (req, res) => {
  if (db.prepare('SELECT 1 FROM owner WHERE id=1').get()) return fail(res, 409, 'owner_already_configured');
  const suppliedSetupToken = req.get('x-aurelia-setup-token') || '';
  if (!/^[a-f0-9]{64}$/i.test(suppliedSetupToken) ||
      !crypto.timingSafeEqual(Buffer.from(suppliedSetupToken, 'hex'), ownerSetupToken)) {
    return fail(res, 403, 'owner_setup_token_invalid');
  }
  const { username, password } = req.body || {};
  if (!req.body || Object.keys(req.body).some(key => !['username', 'password'].includes(key)) ||
      typeof username !== 'string' || !/^[A-Za-z0-9._-]{3,48}$/.test(username) ||
      typeof password !== 'string' || password.length < 14 || password.length > 1024) {
    return fail(res, 400, 'owner_setup_password_or_username_policy_failed');
  }
  const hash = await hashPassword(password);
  try {
    db.prepare('INSERT INTO owner(id,username,password_salt,password_hash,password_n,password_r,password_p,created_at) VALUES(1,?,?,?,?,?,?,?)')
      .run(username, hash.salt, hash.hash, hash.N, hash.r, hash.p, now());
    writeAudit('OWNER_INITIALIZED', username);
    return res.status(201).json({ configured: true });
  } catch { return fail(res, 409, 'owner_setup_conflict'); }
});
app.post('/v1/auth/login', loginRateLimit, async (req, res) => {
  const { username, password } = req.body || {};
  if (!req.body || Object.keys(req.body).some(key => !['username', 'password'].includes(key)) ||
      typeof username !== 'string' || !/^[A-Za-z0-9._-]{3,48}$/.test(username) ||
      typeof password !== 'string' || password.length < 1 || password.length > 1024) {
    return fail(res, 400, 'invalid_login_schema');
  }
  const row = db.prepare('SELECT * FROM owner WHERE username=?').get(username);
  if (!row || !(await verifyPassword(password, row))) {
    writeAudit('LOGIN_FAILED', typeof username === 'string' ? username.slice(0, 48) : null);
    return fail(res, 401, 'invalid_credentials');
  }
  const token = randomBytes(32).toString('base64url');
  const expires = Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS;
  db.prepare('INSERT INTO sessions(token_hash,owner_id,expires_at,created_at) VALUES(?,?,?,?)')
    .run(tokenDigest(token), row.id, expires, now());
  res.setHeader('Set-Cookie', SESSION_COOKIE + '=' + token + '; Path=/; HttpOnly; Secure; SameSite=None; Max-Age=' + SESSION_TTL_SECONDS);
  writeAudit('LOGIN_SUCCESS', row.username);
  return res.json({ authenticated: true, expiresAt: expires });
});
app.get('/v1/auth/session', ownerAuth, (req, res) => res.json({ authenticated: true, username: req.owner.username }));
app.post('/v1/auth/logout', ownerAuth, requireBrowserMutationOrigin, (req, res) => {
  db.prepare('DELETE FROM sessions WHERE token_hash=?').run(req.sessionDigest);
  res.setHeader('Set-Cookie', SESSION_COOKIE + '=; Path=/; HttpOnly; Secure; SameSite=None; Max-Age=0');
  writeAudit('LOGOUT', req.owner.username);
  res.json({ authenticated: false });
});
app.post('/v1/auth/change-password', ownerAuth, requireBrowserMutationOrigin, async (req, res) => {
  const { oldPassword, newPassword } = req.body || {};
  const row = db.prepare('SELECT * FROM owner WHERE id=?').get(req.owner.id);
  if (!(await verifyPassword(oldPassword, row))) return fail(res, 400, 'current_password_incorrect');
  if (typeof newPassword !== 'string' || newPassword.length < 14 || newPassword.length > 1024) {
    return fail(res, 400, 'new_password_policy_failed');
  }
  const hash = await hashPassword(newPassword);
  db.prepare('UPDATE owner SET password_salt=?,password_hash=?,password_n=?,password_r=?,password_p=? WHERE id=?')
    .run(hash.salt, hash.hash, hash.N, hash.r, hash.p, req.owner.id);
  db.prepare('DELETE FROM sessions').run();
  writeAudit('PASSWORD_CHANGED', req.owner.username);
  res.setHeader('Set-Cookie', SESSION_COOKIE + '=; Path=/; HttpOnly; Secure; SameSite=None; Max-Age=0');
  res.json({ changed: true, reauthenticationRequired: true });
});

function validateCredentialShape(provider, environment, c) {
  if (!c || typeof c !== 'object' || Array.isArray(c)) return false;
  if (provider === 'razorpay') return Object.keys(c).every(k => ['keyId','keySecret','webhookSecret'].includes(k)) &&
    /^rzp_(test|live)_[A-Za-z0-9]{8,}$/.test(c.keyId || '') &&
    (environment === 'test' ? c.keyId.startsWith('rzp_test_') : c.keyId.startsWith('rzp_live_')) &&
    ['keySecret','webhookSecret'].every(k => typeof c[k] === 'string' && c[k].length >= 8 && c[k].length <= 512);
  return Object.keys(c).every(k => ['appId','secretKey','webhookSecret'].includes(k)) &&
    typeof c.appId === 'string' && /^[A-Za-z0-9_-]{6,128}$/.test(c.appId) &&
    ['secretKey','webhookSecret'].every(k => typeof c[k] === 'string' && c[k].length >= 8 && c[k].length <= 512);
}
function providerRow(provider, environment) {
  return db.prepare('SELECT * FROM provider_config WHERE provider=? AND environment=?').get(provider, environment);
}
function unresolvedCount(provider, environment) {
  const marks = UNRESOLVED.map(() => '?').join(',');
  return db.prepare('SELECT COUNT(*) AS count FROM transactions WHERE provider=? AND environment=? AND status IN (' + marks + ')')
    .get(provider, environment, ...UNRESOLVED).count;
}
app.get('/v1/admin/providers', ownerAuth, (_req, res) => {
  const rows = db.prepare('SELECT provider,environment,configured,validated,active,updated_at FROM provider_config ORDER BY provider,environment').all();
  res.json({ providers: ['razorpay','cashfree'].flatMap(provider => ['test','live'].map(environment => {
    const row = rows.find(x => x.provider === provider && x.environment === environment);
    return { provider, environment, configured: !!row?.configured, validated: !!row?.validated,
      active: !!row?.active, updatedAt: row?.updated_at || null, unresolvedTransactions: unresolvedCount(provider, environment) };
  })) });
});
app.put('/v1/admin/providers/:provider/credentials', ownerAuth, requireBrowserMutationOrigin, (req, res) => {
  const { provider } = req.params, environment = req.query.environment || req.body?.environment;
  const credentials = req.body?.credentials;
  if (!PROVIDERS.has(provider) || !['test','live'].includes(environment) ||
      !validateCredentialShape(provider, environment, credentials)) return fail(res, 400, 'invalid_provider_credentials');
  const encrypted = encryptCredentials(credentials);
  db.prepare(`INSERT INTO provider_config(provider,environment,ciphertext,iv,auth_tag,configured,validated,active,updated_at)
    VALUES(?,?,?,?,?,1,0,0,?) ON CONFLICT(provider,environment) DO UPDATE SET
    ciphertext=excluded.ciphertext,iv=excluded.iv,auth_tag=excluded.auth_tag,configured=1,validated=0,active=0,updated_at=excluded.updated_at`)
    .run(provider, environment, encrypted.ciphertext, encrypted.iv, encrypted.authTag, now());
  writeAudit('PROVIDER_CREDENTIALS_ROTATED', provider + ':' + environment);
  res.status(202).json({ saved: true, validated: false, active: false });
});
app.post('/v1/admin/providers/:provider/validate', ownerAuth, requireBrowserMutationOrigin, async (req, res) => {
  const { provider } = req.params, environment = req.body?.environment;
  if (!PROVIDERS.has(provider) || !['test','live'].includes(environment)) return fail(res, 400, 'invalid_provider_environment');
  const row = providerRow(provider, environment);
  if (!row?.configured) return fail(res, 404, 'provider_not_configured');
  try {
    const adapter = createProviderAdapter(provider, { credentials: decryptCredentials(row), environment });
    const validation = await adapter.validateCredentials();
    if (validation?.valid !== true) throw new Error('provider_validation_not_confirmed');
    db.prepare('UPDATE provider_config SET validated=1,active=0,updated_at=? WHERE provider=? AND environment=?')
      .run(now(), provider, environment);
    writeAudit('PROVIDER_VALIDATED', provider + ':' + environment);
    return res.json({ valid: true, provider, environment, active: false });
  } catch {
    db.prepare('UPDATE provider_config SET validated=0,active=0,updated_at=? WHERE provider=? AND environment=?')
      .run(now(), provider, environment);
    return fail(res, 502, 'provider_validation_failed');
  }
});
app.post('/v1/admin/providers/:provider/activate', ownerAuth, requireBrowserMutationOrigin, (req, res) => {
  const { provider } = req.params, environment = req.body?.environment;
  if (!PROVIDERS.has(provider) || !['test','live'].includes(environment) || req.body?.confirm !== true) {
    return fail(res, 400, 'explicit_activation_confirmation_required');
  }
  if (environment === 'live') return fail(res, 409, 'live_payments_blocked_accounting_pipeline_incomplete');
  const row = providerRow(provider, environment);
  if (!row?.configured || !row.validated) return fail(res, 409, 'provider_validation_required');
  if (unresolvedCount(provider, environment) > 0) return fail(res, 422, 'unresolved_transactions_block_activation');
  db.prepare('UPDATE provider_config SET active=1,updated_at=? WHERE provider=? AND environment=?')
    .run(now(), provider, environment);
  writeAudit('PROVIDER_ACTIVATED', provider + ':' + environment);
  res.json({ active: true, provider, environment });
});
app.post('/v1/admin/providers/:provider/deactivate', ownerAuth, requireBrowserMutationOrigin, (req, res) => {
  const { provider } = req.params, environment = req.body?.environment;
  if (!PROVIDERS.has(provider) || !['test','live'].includes(environment)) return fail(res, 400, 'invalid_provider_environment');
  const count = unresolvedCount(provider, environment);
  if (count) return fail(res, 422, 'provider_deactivation_blocked_unresolved_transactions_' + count);
  db.prepare('UPDATE provider_config SET active=0,updated_at=? WHERE provider=? AND environment=?')
    .run(now(), provider, environment);
  writeAudit('PROVIDER_DEACTIVATED', provider + ':' + environment);
  res.json({ active: false });
});
app.delete('/v1/admin/providers/:provider/credentials', ownerAuth, requireBrowserMutationOrigin, (req, res) => {
  const { provider } = req.params, environment = req.query.environment;
  if (!PROVIDERS.has(provider) || !['test','live'].includes(environment)) return fail(res, 400, 'invalid_provider_environment');
  const count = unresolvedCount(provider, environment);
  if (count) return fail(res, 422, 'provider_removal_blocked_unresolved_transactions_' + count);
  db.prepare('DELETE FROM provider_config WHERE provider=? AND environment=?').run(provider, environment);
  writeAudit('PROVIDER_CREDENTIALS_REMOVED', provider + ':' + environment);
  res.json({ removed: true });
});


function providerReference(transactionId) {
  return 'au_' + crypto.createHash('sha256').update(transactionId).digest('hex').slice(0, 37);
}

function validOpaqueId(value) {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{8,64}$/.test(value);
}
function transitionPayment(transactionId, expectedStatuses, nextStatus, reason, providerOrderId = null, providerPaymentId = null, providerCheckoutSessionId = null) {
  const allowed = new Set(expectedStatuses);
  const apply = db.transaction(() => {
    const current = db.prepare('SELECT * FROM transactions WHERE id=?').get(transactionId);
    if (!current) throw new Error('transaction_not_found');
    if (!allowed.has(current.status)) return { changed: false, status: current.status };
    db.prepare('UPDATE transactions SET status=?,provider_order_id=COALESCE(?,provider_order_id),provider_payment_id=COALESCE(?,provider_payment_id),provider_checkout_session_id=COALESCE(?,provider_checkout_session_id),updated_at=? WHERE id=?')
      .run(nextStatus, providerOrderId, providerPaymentId, providerCheckoutSessionId, now(), transactionId);
    db.prepare('INSERT INTO transaction_journal(transaction_id,from_status,to_status,reason,created_at) VALUES(?,?,?,?,?)')
      .run(transactionId, current.status, nextStatus, reason, now());
    if (nextStatus === 'CAPTURED_PENDING_ACCOUNTING') {
      const outboxId = crypto.randomUUID();
      const capturedPayload = { transactionId, amountMinor: current.amount_minor,
        currency: current.currency, provider: current.provider,
        providerOrderId: providerOrderId || current.provider_order_id };
      db.prepare('INSERT OR IGNORE INTO settlement_outbox(id,transaction_id,event_type,payload,status,created_at) VALUES(?,?,?,?,?,?)')
        .run(outboxId,transactionId,'PAYMENT_CAPTURED',JSON.stringify(capturedPayload),'PENDING',now());
      // The command, per-device sequence, and outbox event commit atomically
      // with the captured payment transition.
      if (current.device_id && current.folio_id) {
        const prior = db.prepare('SELECT command_id FROM settlement_commands WHERE device_id=? AND transaction_id=?')
          .get(current.device_id,transactionId);
        if (!prior) {
          db.prepare('INSERT OR IGNORE INTO device_sequence_counters(device_id,last_sequence) VALUES(?,0)').run(current.device_id);
          const counter = db.prepare('SELECT last_sequence FROM device_sequence_counters WHERE device_id=?').get(current.device_id);
          const sequenceId = counter.last_sequence + 1;
          db.prepare('UPDATE device_sequence_counters SET last_sequence=? WHERE device_id=?').run(sequenceId,current.device_id);
          const commandId = crypto.randomUUID();
          const command = {
            commandId, deviceId: current.device_id, sequenceId, transactionId,
            idempotencyKey: current.idempotency_key, folioId: current.folio_id,
            amountMinor: current.amount_minor, currency: current.currency,
            provider: current.provider, providerPaymentId: current.provider_payment_id || null,
            settlement: {
              provider: current.provider, commandId, bookingId: current.folio_id,
              amount: current.amount_minor / 100, method: current.provider,
              reference: current.provider_payment_id || current.provider_order_id || current.id,
              source: 'staff_review', verificationConfirmed: true,
              idempotencyKey: 'settlement:' + current.provider + ':command:' + commandId
            }
          };
          const payload = JSON.stringify(command);
          // Hash the protocol's canonical representation, not insertion-order JSON.
          // Native clients independently canonicalize the parsed payload before accepting it.
          const payloadHash = crypto.createHash('sha256').update(canonicalJson(command)).digest('hex');
          db.prepare(`INSERT INTO settlement_commands(command_id,device_id,sequence_id,transaction_id,
            idempotency_key,folio_id,amount_minor,currency,payload_hash,payload,created_at)
            VALUES(?,?,?,?,?,?,?,?,?,?,?)`).run(commandId,current.device_id,sequenceId,transactionId,
              current.idempotency_key,current.folio_id,current.amount_minor,current.currency,payloadHash,payload,now());
          db.prepare('INSERT INTO device_command_state(command_id,status,next_attempt_at) VALUES(?,?,?)')
            .run(commandId,'PENDING',now());
        }
      }
    }
    writeAudit('PAYMENT_STATE_TRANSITION', transactionId + ':' + current.status + '->' + nextStatus);
    return { changed: true, status: nextStatus };
  });
  return apply();
}

// Persist intent before making any network call. A repeated idempotency key
// must describe the exact same economic operation or it is rejected.
app.post('/v1/payments/dispatch', ownerAuth, requireBrowserMutationOrigin, async (req, res) => {
  const b = req.body || {};
  const provider = b.provider, environment = b.environment || 'test';
  if (!PROVIDERS.has(provider) || environment !== 'test' ||
      !validOpaqueId(b.transactionId) || !validOpaqueId(b.idempotencyKey) ||
      !Number.isSafeInteger(b.amountMinor) || b.amountMinor <= 0 ||
      b.currency !== 'INR' ||
      ((b.deviceId === undefined) !== (b.folioId === undefined)) ||
      (b.deviceId !== undefined && (!validOpaqueId(b.deviceId) || !validOpaqueId(b.folioId))))
    return fail(res, 400, 'invalid_payment_intent');
  if (b.deviceId) {
    const device = db.prepare('SELECT status FROM device_registrations WHERE device_id=?').get(b.deviceId);
    if (device?.status !== 'ACTIVE') return fail(res, 409, 'payment_device_not_registered');
  }
  const config = providerRow(provider, environment);
  if (!config?.configured || !config.validated || !config.active) return fail(res, 409, 'provider_not_active_and_validated');
  const existing = db.prepare('SELECT * FROM transactions WHERE idempotency_key=?').get(b.idempotencyKey);
  if (existing) {
    const same = existing.id === b.transactionId && existing.provider === provider &&
      existing.environment === environment && existing.amount_minor === b.amountMinor &&
      existing.currency === b.currency && existing.device_id === (b.deviceId || null) &&
      existing.folio_id === (b.folioId || null);
    if (!same) return fail(res, 409, 'idempotency_key_payload_conflict');
    let checkout = null;
    if (existing.provider_order_id && existing.status === 'PENDING') {
      if (provider === 'razorpay') {
        try { checkout = { keyId: decryptCredentials(config).keyId }; } catch { checkout = null; }
      } else if (existing.provider_checkout_session_id) {
        checkout = { paymentSessionId: existing.provider_checkout_session_id };
      }
    }
    return res.status(200).json({ transactionId: existing.id, status: existing.status, duplicate: true,
      ...(existing.provider_order_id ? { providerOrderId: existing.provider_order_id } : {}),
      ...(checkout ? { checkout } : {}),
      ...(!checkout && existing.status === 'PENDING' ? { reconciliationRequired: true } : {}) });
  }
  const insert = db.transaction(() => {
    db.prepare(`INSERT INTO transactions(id,provider,environment,amount_minor,currency,status,idempotency_key,device_id,folio_id,created_at,updated_at)
      VALUES(?,?,?,?,?,'DISPATCHING',?,?,?,?,?)`).run(
      b.transactionId, provider, environment, b.amountMinor, b.currency, b.idempotencyKey,
      b.deviceId || null, b.folioId || null, now(), now());
    db.prepare('INSERT INTO transaction_journal(transaction_id,from_status,to_status,reason,created_at) VALUES(?,NULL,?,?,?)')
      .run(b.transactionId, 'DISPATCHING', 'durable_intent_created', now());
    writeAudit('PAYMENT_INTENT_CREATED', b.transactionId);
  });
  try { insert(); }
  catch {
    const raced = db.prepare('SELECT * FROM transactions WHERE idempotency_key=?').get(b.idempotencyKey);
    if (raced && raced.id === b.transactionId && raced.provider === provider &&
        raced.amount_minor === b.amountMinor && raced.currency === b.currency &&
        raced.device_id === (b.deviceId || null) && raced.folio_id === (b.folioId || null)) {
      return res.status(200).json({ transactionId: raced.id, status: raced.status, duplicate: true });
    }
    return fail(res, 409, 'idempotency_conflict');
  }
  try {
    const adapter = createProviderAdapter(provider, { credentials: decryptCredentials(config), environment });
    const orderInput = provider === 'razorpay'
      ? { amountMinor: b.amountMinor, currency: b.currency, receipt: providerReference(b.transactionId) }
      : { orderId: providerReference(b.transactionId), amountMinor: b.amountMinor, currency: b.currency,
          idempotencyKey: b.idempotencyKey, customer: b.customer, returnUrl: b.returnUrl };
    const order = await adapter.createOrder(orderInput);
    if (!order?.orderId || order.amountMinor !== b.amountMinor || order.currency !== b.currency) {
      transitionPayment(b.transactionId, ['DISPATCHING'], 'UNKNOWN', 'provider_order_response_mismatch');
      return res.status(202).json({ transactionId: b.transactionId, status: 'UNKNOWN', reconciliationRequired: true });
    }
    transitionPayment(b.transactionId, ['DISPATCHING'], 'PENDING', 'provider_order_created', order.orderId, null, order.paymentSessionId || null);
    return res.status(201).json({ transactionId: b.transactionId, status: 'PENDING',
      providerOrderId: order.orderId, checkout: provider === 'cashfree'
        ? { paymentSessionId: order.paymentSessionId, checkoutUrl: order.checkoutUrl }
        : { keyId: order.keyId } });
  } catch {
    // The provider may have accepted the request before the connection failed.
    // Never retry creation automatically; retain the durable intent as UNKNOWN.
    transitionPayment(b.transactionId, ['DISPATCHING'], 'UNKNOWN', 'provider_dispatch_outcome_ambiguous');
    return res.status(202).json({ transactionId: b.transactionId, status: 'UNKNOWN', reconciliationRequired: true });
  }
});

app.post('/v1/payments/:transactionId/reconcile', ownerAuth, requireBrowserMutationOrigin, async (req, res) => {
  const tx = db.prepare('SELECT * FROM transactions WHERE id=?').get(req.params.transactionId);
  if (!tx) return fail(res, 404, 'transaction_not_found');
  if (['CAPTURED_PENDING_ACCOUNTING','SETTLED'].includes(tx.status)) {
    return res.json({ transactionId: tx.id, status: tx.status, duplicate: true });
  }
  const config = providerRow(tx.provider, tx.environment);
  if (!config?.configured) return fail(res, 409, 'provider_credentials_unavailable');
  try {
    const adapter = createProviderAdapter(tx.provider, { credentials: decryptCredentials(config), environment: tx.environment });
    let providerOrderId = tx.provider_order_id;
    if (!providerOrderId) {
      if (typeof adapter.findOrderByReference !== 'function') {
        return fail(res, 409, 'provider_order_reference_missing_manual_review_required');
      }
      const recovered = await adapter.findOrderByReference({ reference: providerReference(tx.id) });
      if (!recovered?.found || recovered.amountMinor !== tx.amount_minor ||
          recovered.currency !== tx.currency || !recovered.orderId) {
        // An unsuccessful or ambiguous reference search does not establish
        // definitive provider failure. Keep the transaction unresolved.
        if (recovered?.ambiguous) {
          transitionPayment(tx.id, ['DISPATCHING','UNKNOWN','AMBIGUOUS'], 'RECONCILIATION_REQUIRED', 'provider_reference_lookup_ambiguous');
        }
        return res.status(202).json({ transactionId: tx.id, status: tx.status, reconciliationRequired: true,
          reason: recovered?.ambiguous ? 'provider_reference_lookup_ambiguous' : 'provider_order_not_found' });
      }
      providerOrderId = recovered.orderId;
      const existingOrder = db.prepare('SELECT id FROM transactions WHERE provider=? AND environment=? AND provider_order_id=? AND id<>?')
        .get(tx.provider, tx.environment, providerOrderId, tx.id);
      if (existingOrder) {
        transitionPayment(tx.id, ['DISPATCHING','PENDING','UNKNOWN','AMBIGUOUS','RECONCILIATION_REQUIRED'],
          'RECONCILIATION_REQUIRED', 'provider_order_already_bound_to_another_transaction');
        return fail(res, 409, 'provider_order_binding_conflict_manual_review_required');
      }
      const bindOrder = db.transaction(() => {
        const current = db.prepare('SELECT provider_order_id FROM transactions WHERE id=?').get(tx.id);
        if (!current) throw new Error('transaction_not_found');
        if (current.provider_order_id && current.provider_order_id !== providerOrderId) {
          throw new Error('provider_order_binding_conflict');
        }
        db.prepare('UPDATE transactions SET provider_order_id=?,updated_at=? WHERE id=?')
          .run(providerOrderId, now(), tx.id);
      });
      bindOrder();
    }
    const requestedPaymentId = req.body?.paymentId;
    if (requestedPaymentId !== undefined && (typeof requestedPaymentId !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(requestedPaymentId))) {
      return fail(res, 400, 'invalid_provider_payment_id');
    }
    const remote = await adapter.getPaymentStatus({ orderId: providerOrderId, ...(requestedPaymentId ? { paymentId: requestedPaymentId } : {}) });
    if (remote.amountMinor !== tx.amount_minor || remote.currency !== tx.currency ||
        remote.orderId !== providerOrderId || (requestedPaymentId && remote.paymentId !== requestedPaymentId)) {
      transitionPayment(tx.id, ['DISPATCHING','PENDING','UNKNOWN','AMBIGUOUS','RECONCILIATION_REQUIRED'],
        'RECONCILIATION_REQUIRED', 'provider_amount_currency_or_order_mismatch', providerOrderId);
      return fail(res, 409, 'provider_payment_details_mismatch_manual_review_required');
    }
    if (remote.captured === true) {
      const result = transitionPayment(tx.id,
        ['DISPATCHING','PENDING','UNKNOWN','AMBIGUOUS','RECONCILIATION_REQUIRED','FAILED'],
        'CAPTURED_PENDING_ACCOUNTING', 'provider_api_confirmed_capture', providerOrderId, remote.paymentId || null);
      return res.json({ transactionId: tx.id, status: result.status, folioSettlement: 'PENDING_OUTBOX' });
    }
    if (['failed','declined','cancelled','expired'].includes(String(remote.paymentStatus || '').toLowerCase())) {
      const result = transitionPayment(tx.id,
        ['DISPATCHING','PENDING','UNKNOWN','AMBIGUOUS','RECONCILIATION_REQUIRED'],
        'FAILED', 'provider_api_confirmed_failure', providerOrderId);
      return res.json({ transactionId: tx.id, status: result.status });
    }
    return res.status(202).json({ transactionId: tx.id, status: tx.status, reconciliationRequired: true });
  } catch {
    return res.status(202).json({ transactionId: tx.id, status: tx.status, reconciliationRequired: true });
  }
});

// Webhooks are parsed as raw bytes so the provider adapter verifies the exact signed payload.
app.post('/v1/webhooks/:provider/:environment', express.raw({ type: 'application/json', limit: '1mb' }), async (req, res) => {
  const { provider, environment } = req.params;
  if (!PROVIDERS.has(provider) || !['test','live'].includes(environment) || !Buffer.isBuffer(req.body)) {
    return fail(res, 400, 'invalid_webhook_request');
  }
  const row = providerRow(provider, environment);
  if (!row?.configured) return fail(res, 404, 'provider_not_configured');
  let key = null;
  try {
    const adapter = createProviderAdapter(provider, { credentials: decryptCredentials(row), environment });
    const checked = await adapter.verifyWebhook(req.body, req.headers);
    if (!checked.valid || !checked.event || typeof checked.event !== 'object') {
      return fail(res, 400, 'invalid_webhook_signature_or_payload');
    }
    const eventId = provider === 'razorpay'
      ? req.get('x-razorpay-event-id')
      : req.get('x-webhook-id') || crypto.createHash('sha256').update(req.body).digest('hex');
    if (typeof eventId !== 'string' || !/^[A-Za-z0-9._:-]{1,200}$/.test(eventId)) return fail(res, 400, 'invalid_event_id');
    key = crypto.createHash('sha256').update(provider + ':' + environment + ':' + eventId).digest('hex');
    const payloadHash = crypto.createHash('sha256').update(req.body).digest('hex');
    const inserted = db.prepare(`INSERT OR IGNORE INTO webhook_inbox(event_key,provider,environment,received_at,signature_verified,processing_status,payload_sha256)
      VALUES(?,?,?,?,1,'RECEIVED',?)`).run(key, provider, environment, now(), payloadHash);
    if (inserted.changes === 0) {
      const prior = db.prepare('SELECT payload_sha256,processing_status FROM webhook_inbox WHERE event_key=?').get(key);
      if (!prior || prior.payload_sha256 !== payloadHash) {
        writeAudit('WEBHOOK_EVENT_IDENTITY_CONFLICT', provider + ':' + environment);
        return fail(res, 409, 'webhook_event_identity_conflict');
      }
      if (prior.processing_status === 'COMMAND_CREATED') {
        return res.status(200).json({ received: true, duplicate: true, accounting: 'command_created' });
      }
    }
    // Webhook fields are lookup hints only. Provider API status below is the
    // authority for capture, amount, currency, order and payment identity.
    let providerOrderId = null, providerPaymentId = null;
    if (provider === 'razorpay') {
      const payment = checked.event?.payload?.payment?.entity;
      providerOrderId = payment?.order_id || null;
      providerPaymentId = payment?.id || null;
      if (checked.event?.event !== 'payment.captured') {
        db.prepare("UPDATE webhook_inbox SET processing_status='VERIFIED_NON_CAPTURE_EVENT' WHERE event_key=?").run(key);
        return res.status(200).json({ received: true, accounting: 'not_a_capture_event' });
      }
    } else {
      const data = checked.event?.data || {};
      providerOrderId = data?.order?.order_id || null;
      providerPaymentId = data?.payment?.cf_payment_id == null ? null : String(data.payment.cf_payment_id);
      if (!String(checked.event?.type || '').toUpperCase().includes('PAYMENT_SUCCESS')) {
        db.prepare("UPDATE webhook_inbox SET processing_status='VERIFIED_NON_CAPTURE_EVENT' WHERE event_key=?").run(key);
        return res.status(200).json({ received: true, accounting: 'not_a_capture_event' });
      }
    }
    if (typeof providerOrderId !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(providerOrderId) ||
        (providerPaymentId !== null && (typeof providerPaymentId !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(providerPaymentId)))) {
      db.prepare("UPDATE webhook_inbox SET processing_status='UNRESOLVED' WHERE event_key=?").run(key);
      return res.status(202).json({ received: true, accounting: 'unresolved', reason: 'provider_order_or_payment_id_missing' });
    }
    const tx = db.prepare('SELECT * FROM transactions WHERE provider=? AND environment=? AND provider_order_id=?')
      .get(provider, environment, providerOrderId);
    if (!tx) {
      db.prepare("UPDATE webhook_inbox SET processing_status='UNRESOLVED' WHERE event_key=?").run(key);
      writeAudit('WEBHOOK_TRANSACTION_UNMATCHED', provider + ':' + providerOrderId);
      return res.status(202).json({ received: true, accounting: 'unresolved', reason: 'local_transaction_not_found' });
    }
    const remote = await adapter.getPaymentStatus({ orderId: providerOrderId, ...(providerPaymentId ? { paymentId: providerPaymentId } : {}) });
    if (remote.orderId !== providerOrderId ||
        (providerPaymentId && String(remote.paymentId) !== providerPaymentId) ||
        remote.amountMinor !== tx.amount_minor || remote.currency !== tx.currency) {
      db.prepare("UPDATE webhook_inbox SET processing_status='RECONCILIATION_REQUIRED' WHERE event_key=?").run(key);
      writeAudit('WEBHOOK_PROVIDER_BINDING_MISMATCH', tx.id);
      return res.status(202).json({ received: true, accounting: 'unresolved', reason: 'provider_status_binding_mismatch' });
    }
    if (remote.captured !== true) {
      db.prepare("UPDATE webhook_inbox SET processing_status='VERIFIED_NOT_CAPTURED' WHERE event_key=?").run(key);
      return res.status(202).json({ received: true, accounting: 'pending_provider_capture_confirmation' });
    }
    const transition = transitionPayment(tx.id,
      ['DISPATCHING','PENDING','UNKNOWN','AMBIGUOUS','RECONCILIATION_REQUIRED','FAILED'],
      'CAPTURED_PENDING_ACCOUNTING', 'webhook_provider_api_confirmed_capture', providerOrderId, remote.paymentId || null);
    const command = tx.device_id && tx.folio_id
      ? db.prepare('SELECT command_id,sequence_id,payload_hash FROM settlement_commands WHERE device_id=? AND transaction_id=?')
          .get(tx.device_id, tx.id)
      : null;
    const accounting = command ? 'command_created' : 'captured_unrouted';
    db.prepare('UPDATE webhook_inbox SET processing_status=? WHERE event_key=?')
      .run(command ? 'COMMAND_CREATED' : 'CAPTURED_UNROUTED', key);
    writeAudit('WEBHOOK_PROVIDER_CAPTURE_RECONCILED', tx.id);
    return res.status(200).json({
      received: true, duplicate: inserted.changes === 0,
      transactionId: tx.id, status: transition.status, accounting,
      ...(command ? { commandId: command.command_id, sequenceId: command.sequence_id, payloadHash: command.payload_hash } : {})
    });
  } catch {
    try {
      if (typeof key === 'string') db.prepare("UPDATE webhook_inbox SET processing_status='RETRYABLE_ERROR' WHERE event_key=?").run(key);
    } catch {}
    return fail(res, 503, 'webhook_processing_unavailable');
  }
});
app.use((err, _req, res, _next) => {
  const status = err?.type === 'entity.too.large' ? 413 : 400;
  res.status(status).json({ error: status === 413 ? 'request_too_large' : 'invalid_request' });
});
app.listen(PORT, '0.0.0.0', () => {
  process.stdout.write('Aurelia local payment administration listening on ' + PORT + '\
');
});
