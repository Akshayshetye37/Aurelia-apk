import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
let Database;
try { Database = (await import('better-sqlite3')).default; } catch {}

const packageRoot = path.resolve(new URL('..', import.meta.url).pathname);

function canonicalJson(value) {
  if (Array.isArray(value)) return '[' + value.map(canonicalJson).join(',') + ']';
  if (value && typeof value === 'object') {
    return '{' + Object.keys(value).sort().map(key =>
      JSON.stringify(key) + ':' + canonicalJson(value[key])
    ).join(',') + '}';
  }
  return JSON.stringify(value);
}

function signDeviceRequest(privateKey, { deviceId, method, path: requestPath, body }) {
  const timestamp = String(Math.floor(Date.now() / 1000));
  const nonce = crypto.randomBytes(24).toString('base64url');
  const bodyHash = crypto.createHash('sha256').update(canonicalJson(body || {})).digest('hex');
  const transcript = [
    'AURELIA_DEVICE_REQUEST_V1', deviceId, method, requestPath, timestamp, nonce, bodyHash
  ].join('\n');
  const signature = crypto.sign('sha256', Buffer.from(transcript), privateKey).toString('base64url');
  return {
    'x-aurelia-device-timestamp': timestamp,
    'x-aurelia-device-nonce': nonce,
    'x-aurelia-device-signature': signature
  };
}

test('LAN activation gate, signed lease transport, durable acknowledgement, cursor and revocation', { skip: !Database }, async t => {
  const temp = mkdtempSync(path.join(os.tmpdir(), 'aurelia-device-protocol-'));
  const databasePath = path.join(temp, 'payments.sqlite');
  const port = 18000 + Math.floor(Math.random() * 20000);
  const setupToken = crypto.randomBytes(32).toString('hex');
  const ownerPassword = 'TestOwnerPassword!2026';
  const child = spawn(process.execPath, ['src/local-server.mjs'], {
    cwd: packageRoot,
    env: {
      ...process.env,
      PORT: String(port),
      DATABASE_PATH: databasePath,
      GATEWAY_MASTER_KEY: crypto.randomBytes(32).toString('hex'),
      SESSION_TOKEN_PEPPER: crypto.randomBytes(32).toString('hex'),
      OWNER_SETUP_TOKEN: setupToken,
      AURELIA_OWNER_ORIGINS: 'https://localhost',
      TRUST_PROXY_HOPS: '1',
      AURELIA_PROPERTY_ID: 'test-property'
    },
    stdio: 'ignore'
  });
  let db;
  t.after(() => {
    try { child.kill('SIGTERM'); } catch {}
    try { db?.close(); } catch {}
    rmSync(temp, { recursive: true, force: true });
  });

  const originHeaders = { Origin: 'https://localhost', 'X-Forwarded-Proto': 'https' };
  const baseUrl = 'http://127.0.0.1:' + port;
  let ready = false;
  for (let attempt = 0; attempt < 80; attempt++) {
    if (child.exitCode !== null) throw new Error('LAN server exited during startup');
    try {
      const response = await fetch(baseUrl + '/healthz', { headers: { 'X-Forwarded-Proto': 'https' } });
      if (response.ok) { ready = true; break; }
    } catch {}
    await delay(125);
  }
  assert.equal(ready, true, 'LAN server should become ready');

  const setup = await fetch(baseUrl + '/v1/auth/setup', {
    method: 'POST', headers: { ...originHeaders, 'Content-Type': 'application/json', 'X-Aurelia-Setup-Token': setupToken },
    body: JSON.stringify({ username: 'device-owner', password: ownerPassword })
  });
  assert.equal(setup.status, 201);
  const login = await fetch(baseUrl + '/v1/auth/login', {
    method: 'POST', headers: { ...originHeaders, 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'device-owner', password: ownerPassword })
  });
  assert.equal(login.status, 200);
  const cookie = (login.headers.get('set-cookie') || '').split(';')[0];
  assert.match(cookie, /^aurelia_owner_session=/);

  const ownerHeaders = { ...originHeaders, Cookie: cookie, 'Content-Type': 'application/json' };
  const deviceId = 'device_test_001';
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' });
  const enrollmentChallengeResponse = await fetch(baseUrl + '/v1/admin/devices/enrollment/challenge', {
    method: 'POST', headers: ownerHeaders, body: JSON.stringify({ deviceId })
  });
  assert.equal(enrollmentChallengeResponse.status, 201);
  const enrollmentChallenge = await enrollmentChallengeResponse.json();
  assert.match(enrollmentChallenge.challengeId, /^[0-9a-f-]{36}$/i);
  assert.match(enrollmentChallenge.nonce, /^[A-Za-z0-9_-]{40,64}$/);
  const replacementChallengeResponse = await fetch(baseUrl + '/v1/admin/devices/enrollment/challenge', {
    method: 'POST', headers: ownerHeaders, body: JSON.stringify({ deviceId })
  });
  assert.equal(replacementChallengeResponse.status, 201);
  const replacementChallenge = await replacementChallengeResponse.json();

  // A newer challenge invalidates the previous outstanding challenge.
  const staleChallengeAttempt = await fetch(baseUrl + '/v1/admin/devices/enroll', {
    method: 'POST', headers: ownerHeaders,
    body: JSON.stringify({
      deviceId, challengeId: enrollmentChallenge.challengeId, publicKeyPem,
      certificateChainBase64: [
        Buffer.alloc(128, 0x41).toString('base64'),
        Buffer.alloc(128, 0x42).toString('base64')
      ]
    })
  });
  assert.equal(staleChallengeAttempt.status, 409);
  assert.equal((await staleChallengeAttempt.json()).error, 'attestation_challenge_invalid_or_expired');

  // No verifier sidecar is started in this transport integration test. The
  // challenge-first enrollment endpoint must fail closed and must not create
  // a device registration when independent attestation verification is absent.
  const unavailableEnrollment = await fetch(baseUrl + '/v1/admin/devices/enroll', {
    method: 'POST', headers: ownerHeaders,
    body: JSON.stringify({
      deviceId, challengeId: replacementChallenge.challengeId, publicKeyPem,
      certificateChainBase64: [
        Buffer.alloc(128, 0x41).toString('base64'),
        Buffer.alloc(128, 0x42).toString('base64')
      ]
    })
  });
  assert.equal(unavailableEnrollment.status, 503);
  assert.equal((await unavailableEnrollment.json()).error, 'device_attestation_verifier_unavailable');

  db = new Database(databasePath);
  assert.equal(db.prepare('SELECT device_id FROM device_registrations WHERE device_id=?').get(deviceId), undefined);
  const ownerId = db.prepare('SELECT id FROM owner WHERE username=?').get('device-owner').id;
  const stamp = new Date().toISOString();
  db.prepare("INSERT INTO device_registrations(device_id,public_key_spki,key_algorithm,status,created_at,owner_id,property_id) VALUES(?,?,'ECDSA_P256_SHA256','PENDING',?,?,?)")
    .run(deviceId, publicKey.export({ type: 'spki', format: 'der' }), stamp, ownerId, 'test-property');
  db.prepare('INSERT INTO device_cursors(device_id,last_applied_sequence,updated_at) VALUES(?,0,?)').run(deviceId, stamp);
  db.prepare('INSERT INTO device_sequence_counters(device_id,last_sequence) VALUES(?,0)').run(deviceId);

  const activate = await fetch(baseUrl + '/v1/admin/devices/' + deviceId + '/activate', {
    method: 'POST', headers: ownerHeaders, body: JSON.stringify({})
  });
  assert.equal(activate.status, 409);
  assert.equal((await activate.json()).error, 'device_attestation_required');

  // The remaining lease/ack assertions isolate the transport protocol. Promote
  // the fixture directly in SQLite; this is deliberately NOT an enrollment test.
  assert.equal(db.prepare('SELECT status FROM device_registrations WHERE device_id=?').get(deviceId).status, 'PENDING');
  db.prepare("UPDATE device_registrations SET status='ACTIVE' WHERE device_id=?").run(deviceId);
  const transactionId = 'txn_test_0001';
  const commandId = crypto.randomUUID();
  const commandPayload = {
    commandId, deviceId, sequenceId: 1, transactionId, folioId: 'folio_0001',
    amountMinor: 12500, currency: 'INR', provider: 'razorpay',
    settlement: {
      provider: 'razorpay', commandId, bookingId: 'folio_0001', amount: 125,
      method: 'razorpay', reference: 'pay_test_001', source: 'staff_review',
      verificationConfirmed: true, idempotencyKey: 'settlement:razorpay:command:' + commandId
    }
  };
  const payloadText = JSON.stringify(commandPayload);
  const payloadHash = crypto.createHash('sha256').update(canonicalJson(commandPayload)).digest('hex');
  const commandStamp = new Date().toISOString();
  db.prepare(`INSERT INTO transactions(id,provider,environment,amount_minor,currency,status,idempotency_key,device_id,folio_id,created_at,updated_at)
    VALUES(?,?,?,?,'INR','CAPTURED_PENDING_ACCOUNTING',?,?,?,?,?)`)
    .run(transactionId, 'razorpay', 'test', 12500, 'idem_test_001', deviceId, 'folio_0001', commandStamp, commandStamp);
  db.prepare(`INSERT INTO settlement_commands(command_id,device_id,sequence_id,transaction_id,idempotency_key,folio_id,
    amount_minor,currency,payload_hash,payload,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)`)
    .run(commandId, deviceId, 1, transactionId, 'idem_test_001', 'folio_0001', 12500, 'INR', payloadHash, payloadText, commandStamp);
  db.prepare('INSERT INTO device_command_state(command_id,status,next_attempt_at) VALUES(?,?,?)')
    .run(commandId, 'PENDING', commandStamp);
  db.prepare('UPDATE device_sequence_counters SET last_sequence=1 WHERE device_id=?').run(deviceId);

  const leasePath = '/v1/devices/' + deviceId + '/commands/lease';
  const leaseHeaders = signDeviceRequest(privateKey, { deviceId, method: 'POST', path: leasePath, body: {} });
  const leaseResponse = await fetch(baseUrl + leasePath, {
    method: 'POST', headers: { ...leaseHeaders, 'Content-Type': 'application/json', 'X-Forwarded-Proto': 'https' },
    body: JSON.stringify({})
  });
  const leaseBody = await leaseResponse.json();
  assert.equal(leaseResponse.status, 200, JSON.stringify(leaseBody));
  const lease = leaseBody;
  assert.equal(lease.command.commandId, commandId);
  assert.equal(lease.command.payloadHash, payloadHash);
  assert.equal(lease.command.payloadCanonical, canonicalJson(commandPayload));
  assert.equal(
    crypto.createHash('sha256').update(lease.command.payloadCanonical).digest('hex'),
    lease.command.payloadHash
  );
  assert.equal(lease.cursor, 0);
  assert.ok(lease.leaseToken);

  const replayedLease = await fetch(baseUrl + leasePath, {
    method: 'POST', headers: { ...leaseHeaders, 'Content-Type': 'application/json', 'X-Forwarded-Proto': 'https' },
    body: JSON.stringify({})
  });
  assert.equal(replayedLease.status, 409);
  assert.equal((await replayedLease.json()).error, 'device_request_replay');

  const ackPath = '/v1/devices/' + deviceId + '/commands/' + commandId + '/ack';
  const receipt = {
    leaseToken: lease.leaseToken, sequenceId: 1, payloadHash,
    durableApplied: true, ledgerAckId: 'ledger_ack_001'
  };
  const ackHeaders = signDeviceRequest(privateKey, { deviceId, method: 'POST', path: ackPath, body: receipt });
  const ackResponse = await fetch(baseUrl + ackPath, {
    method: 'POST', headers: { ...ackHeaders, 'Content-Type': 'application/json', 'X-Forwarded-Proto': 'https' },
    body: JSON.stringify(receipt)
  });
  assert.equal(ackResponse.status, 200);
  const ack = await ackResponse.json();
  assert.equal(ack.acknowledged, true);
  assert.equal(ack.cursor, 1);
  assert.equal(db.prepare('SELECT last_applied_sequence FROM device_cursors WHERE device_id=?').get(deviceId).last_applied_sequence, 1);
  assert.equal(db.prepare('SELECT status FROM device_command_state WHERE command_id=?').get(commandId).status, 'PROCESSED');
  assert.equal(db.prepare('SELECT status FROM transactions WHERE id=?').get(transactionId).status, 'SETTLED');
  assert.equal(db.prepare("SELECT status FROM settlement_outbox WHERE transaction_id=? AND event_type='PAYMENT_CAPTURED'").get(transactionId).status, 'PROCESSED');
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM transaction_journal WHERE transaction_id=? AND to_status=\'SETTLED\'').get(transactionId).count, 1);

  const duplicateAckHeaders = signDeviceRequest(privateKey, { deviceId, method: 'POST', path: ackPath, body: receipt });
  const duplicateAck = await fetch(baseUrl + ackPath, {
    method: 'POST', headers: { ...duplicateAckHeaders, 'Content-Type': 'application/json', 'X-Forwarded-Proto': 'https' },
    body: JSON.stringify(receipt)
  });
  assert.equal(duplicateAck.status, 200);
  assert.equal((await duplicateAck.json()).duplicate, true);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM transaction_journal WHERE transaction_id=? AND to_status=\'SETTLED\'').get(transactionId).count, 1);

  const revoke = await fetch(baseUrl + '/v1/admin/devices/' + deviceId + '/revoke', {
    method: 'POST', headers: ownerHeaders, body: JSON.stringify({})
  });
  assert.equal(revoke.status, 200);
  assert.equal((await revoke.json()).status, 'REVOKED');

  const revokedLeaseHeaders = signDeviceRequest(privateKey, { deviceId, method: 'POST', path: leasePath, body: {} });
  const revokedLease = await fetch(baseUrl + leasePath, {
    method: 'POST', headers: { ...revokedLeaseHeaders, 'Content-Type': 'application/json', 'X-Forwarded-Proto': 'https' },
    body: JSON.stringify({})
  });
  assert.equal(revokedLease.status, 403);
  assert.equal((await revokedLease.json()).error, 'device_not_active');
});
