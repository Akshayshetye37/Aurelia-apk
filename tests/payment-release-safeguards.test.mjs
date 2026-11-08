import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const read = path => fs.readFileSync(path, 'utf8');

test('Android native checkout uses the immutable release safeguard before SDK handoff', () => {
  const patcher = read('scripts/patch-android.js');
  const safeguard = read('android/templates/security/PaymentReleaseSafeguards.kt');
  const call = patcher.indexOf('PaymentReleaseSafeguards.assertSandboxCheckoutAllowed(provider, environment)');
  const order = patcher.indexOf('String orderId = obj.optString("providerOrderId", "");', call);
  assert.ok(call >= 0, 'native checkout invokes the safeguard');
  assert.ok(order > call, 'safeguard executes before provider order and SDK dispatch');
  assert.match(patcher, /'PaymentReleaseSafeguards\.kt'/);
  assert.match(safeguard, /private const val LIVE_GATEWAY_COLLECTION = false/);
  assert.match(safeguard, /private const val AUTOMATIC_SETTLEMENT = false/);
  assert.match(safeguard, /private const val AUTOMATIC_REFUND_POSTING = false/);
});

test('Android release safeguard permits only sandbox environments for the six wired providers', () => {
  const source = read('android/templates/security/PaymentReleaseSafeguards.kt');
  for (const [provider, environment] of [
    ['razorpay', 'test'], ['cashfree', 'test'], ['payu', 'test'],
    ['phonepe', 'test'], ['paytm', 'staging'], ['jiopay', 'uat']
  ]) {
    assert.match(source, new RegExp('"' + provider + '" to PaymentImplementationStatus\\.SANDBOX_ONLY'));
    assert.ok(source.includes('"' + provider + '"'));
    assert.ok(source.includes('"' + environment + '"'));
  }
  assert.match(source, /"ccavenue" to PaymentImplementationStatus\.NOT_IMPLEMENTED/);
  assert.match(source, /production_payment_environment_blocked_on_device/);
});

test('Android safeguards cannot authorize settlement or refund posting', () => {
  const source = read('android/templates/security/PaymentReleaseSafeguards.kt');
  assert.match(source, /fun isAutomaticSettlementAllowed\(\): Boolean = AUTOMATIC_SETTLEMENT/);
  assert.match(source, /fun isAutomaticRefundPostingAllowed\(\): Boolean = AUTOMATIC_REFUND_POSTING/);
  assert.match(source, /fun isLiveCollectionAllowed\(\): Boolean = LIVE_GATEWAY_COLLECTION/);
});

test('backend blocks external refund dispatch until owner-approved refund processing is enabled', () => {
  const server = read('payment-backend/src/server.mjs');
  const start = server.indexOf("app.post('/v1/payments/intents/:intentId/refunds'");
  const end = server.indexOf("app.get('/v1/payments/intents/:intentId/refunds/:refundId'", start);
  assert.ok(start >= 0 && end > start, 'refund create and read routes exist');
  const route = server.slice(start, end);
  const gate = route.indexOf("enforcePaymentControl(req, res, 'refund_processing')");
  const reservation = route.indexOf('db.runTransaction');
  const dispatch = route.indexOf('adapter.createRefund');
  assert.ok(gate >= 0 && reservation > gate && dispatch > gate,
    'refund gate must execute before reservation and external provider dispatch');
});

test('live collection requires tenant flags, evidence qualification and validated production credentials', () => {
  const server = read('payment-backend/src/server.mjs');
  assert.match(server, /evaluateProviderProductionQualification/);
  assert.match(server, /paymentProviderQualifications\/' \+ tenantId \+ '\/providers\/' \+ provider/);
  assert.match(server, /providerState\.data\(\)\.credentialsValidated !== true/);
  assert.match(server, /controls\.live_collection_enabled !== true/);
});


test('Android Play Integrity client is copied and SDK dependency is installed', () => {
  const patcher = read('scripts/patch-android.js');
  const client = read('android/templates/security/AureliaPlayIntegrityClient.kt');
  assert.match(patcher, /'AureliaPlayIntegrityClient\.kt'/);
  assert.match(patcher, /'CloudPaymentDeviceEnrollmentClient\.kt'/);
  assert.match(patcher, /com\.google\.android\.play:integrity:1\.5\.0/);
  assert.match(client, /setRequestHash\(serverRequestHash\)/);
  assert.match(client, /play_integrity_provider_not_prepared/);
});

test('cloud device enrollment requires Google-decoded Play Integrity and hardware key attestation', () => {
  const server = read('payment-backend/src/server.mjs');
  const service = read('payment-backend/src/devices/firestore-device-service.mjs');
  const verifier = read('payment-backend/src/devices/play-integrity-verifier.mjs');
  assert.match(server, /scopes: \['https:\/\/www\.googleapis\.com\/auth\/playintegrity'\]/);
  assert.match(server, /decodeGooglePlayIntegrityToken/);
  assert.match(server, /integrityToken: body\.integrityToken/);
  assert.match(service, /evaluatePlayIntegrityVerdict/);
  assert.match(service, /playIntegrityAppRecognitionVerdict: integrity\.appRecognitionVerdict/);
  assert.match(service, /playIntegrityAppLicensingVerdict: integrity\.appLicensingVerdict/);
  assert.match(service, /playIntegrityDeviceRecognitionVerdicts/);
  assert.match(service, /attestationSecurityLevel: verified\.securityLevel/);
  assert.match(verifier, /PLAY_RECOGNIZED/);
  assert.match(verifier, /LICENSED/);
  assert.match(verifier, /MEETS_DEVICE_INTEGRITY/);
  assert.match(verifier, /requestHash !== expectedRequestHash/);
});


test('native cloud enrollment binds server challenge, Play token and attested key before owner activation', () => {
  const client = read('android/templates/security/CloudPaymentDeviceEnrollmentClient.kt');
  assert.match(client, /playIntegrity\.prepare/);
  assert.match(client, /playIntegrity\.requestToken/);
  assert.match(client, /createAttestedIdentity\(challengeBytes\)/);
  assert.match(client, /playIntegrityRequestHash/);
  assert.match(client, /certificateChainBase64/);
  assert.match(client, /integrityToken/);
  assert.match(client, /expectedStatus = 202/);
  assert.match(client, /status == "PENDING"/);
  assert.doesNotMatch(client, /\/activate/);
});


test('device enrollment challenges are single-current, one-use and freshness-bounded at activation', () => {
  const service = read('payment-backend/src/devices/firestore-device-service.mjs');
  assert.match(service, /enrollmentChallengeId: challengeId/);
  assert.match(service, /deviceSnap\.data\(\)\.enrollmentChallengeId !== challengeId/);
  assert.match(service, /data\.consumedAt/);
  assert.match(service, /payment_device_attestation_already_submitted_owner_activation_required/);
  assert.match(service, /currentTime\.getTime\(\) - integrityVerifiedAt > 10 \* 60_000/);
  assert.match(service, /playIntegrityStrongIntegrityRequired/);
});
