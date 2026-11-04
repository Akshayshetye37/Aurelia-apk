import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('../src/server.mjs', import.meta.url), 'utf8');

test('admin and payment actor authorization enforce tenant membership, verified email and MFA', () => {
  // Accept the production bearer-token normalization while pinning the
  // security-critical revocation check. This avoids a brittle whitespace/
  // wrapper-specific source-string assertion.
  assert.match(source, /auth\.verifyIdToken\(header\.slice\(7\)\.trim\(\),\s*true\)/);
  assert.match(source, /if \(!\/\^Bearer\\s\+\[\^\\s\]\+\$\/i\.test\(header\)\)/);
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
  assert.match(source, /providerFetchVerified: captureVerified/);
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
  assert.match(source, /if \(!req\.secure && !platformProbe\)/);
  assert.match(source, /insecure_connection_rejected/);
  assert.match(source, /Strict-Transport-Security/);
  assert.equal(source.includes("req.headers['x-forwarded-proto'] === 'https'"), false);
});


test('verified webhook evidence is explicitly pending PMS accounting and cannot claim settlement', () => {
  assert.match(source, /CAPTURED_VERIFIED_PENDING_ACCOUNTING/);
  assert.match(source, /accountingStatus: 'PENDING'/);
  assert.match(source, /authoritative_pms_ledger_mapping_not_implemented/);
  assert.match(source, /PENDING_CONTROL_OR_BRIDGE/);
});

test('unverified webhook inbox records remain retryable while verified duplicates are idempotent', () => {
  assert.match(source, /UNVERIFIED_RETRYABLE/);
  assert.match(source, /seen\.data\(\)\.providerFetchVerified === true/);
  assert.match(source, /lastAttemptAt: FieldValue\.serverTimestamp\(\)/);
  assert.match(source, /assertWebhookReplayIntegrity\(prior/);
  assert.match(source, /const payloadHash = crypto\.createHash\('sha256'\)\.update\(req\.body\)\.digest\('hex'\)/);
  assert.match(source, /eventId, tenantId, provider, environment, paymentId, providerOrderId, payloadHash/);
});


test('webhook intent binding reads the resolved provider-order document and supports onboarding orders without an intent', () => {
  assert.match(source, /const orderData = orderSnap\.data\(\);\s*const intentRef = orderData\.intentId/);
  assert.match(source, /const intentRef = orderData\.intentId\s*\? db\.doc\('paymentIntents\/' \+ orderData\.intentId\)\s*: null/);
  assert.match(source, /if \(intentRef && \(!currentIntent\?\.exists/);
});


test('owner credential management CORS permits the actual PUT and DELETE methods', () => {
  assert.match(source, /Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS'/);
  assert.ok(source.includes("app.put('/v1/admin/providers/:provider/credentials'"));
  assert.ok(source.includes("app.delete('/v1/admin/providers/:provider/credentials'"));
});


test('readiness endpoint checks Firestore and Secret Manager separately from liveness', () => {
  assert.match(source, /app\.get\('\/healthz'/);
  assert.match(source, /app\.get\('\/readyz', async/);
  assert.match(source, /db\.doc\('aureliaSystem\/health'\)\.get\(\)/);
  assert.match(source, /aurelia-payment-backend-health/);
  assert.match(source, /checks\.firestore && checks\.secretManager/);
  assert.match(source, /res\.status\(ready \? 200 : 503\)/);
});


test('credential rotation and deletion disable provider state before secret mutations', () => {
  const rotation = source.indexOf('configured: false, credentialsValidated: false, sandboxTestPassed: false');
  const firstSecretWrite = source.indexOf("storeSecret(providerSecretId(req.tenant.id, provider, environment, 'api')");
  const deletionRoute = source.indexOf("app.delete('/v1/admin/providers/:provider/credentials'");
  const deletion = source.indexOf('await stateRef.set({\n      configured: false, credentialsValidated: false, sandboxTestPassed: false', deletionRoute);
  const disableVersions = source.indexOf('await disableAllEnabledSecretVersions(sm, secretName(id))', deletion);
  const stateDelete = source.indexOf('await stateRef.delete()', disableVersions);
  assert.ok(rotation >= 0 && firstSecretWrite > rotation);
  assert.ok(deletionRoute >= 0 && deletion > deletionRoute);
  assert.ok(disableVersions > deletion && stateDelete > disableVersions);
  assert.equal(source.includes('sm.deleteSecret('), false);
});


test('central payment control administration is tenant-scoped and owner/admin protected', () => {
  assert.match(source, /app\.get\('\/v1\/admin\/payment-controls', requireTenantAdmin/);
  assert.match(source, /app\.patch\('\/v1\/admin\/payment-controls', requireTenantAdmin/);
  assert.match(source, /actor: \{ uid: req\.actor\.uid, email: req\.actor\.email \}/);
  assert.match(source, /changes: body\.changes, reason: body\.reason/);
  assert.match(source, /paymentControls\/\' \+ req\.tenant\.id/);
});

test('financial backend routes read tenant controls on each request and remain fail-closed', () => {
  assert.match(source, /async function enforcePaymentControl\(req, res, control\)/);
  assert.match(source, /readPaymentControls\(\{ db, tenantId: req\.tenant\.id \}\)/);
  assert.match(source, /paymentControlAllows\(controls, control\)/);
  assert.match(source, /payment_controls_unavailable/);
  assert.match(source, /payment_emergency_stop/);
  assert.match(source, /payment_control_disabled/);
  assert.match(source, /enforcePaymentControl\(req, res, intentControl\)/);
  assert.match(source, /enforcePaymentControl\(req, res, 'test_collection'\)/);
  assert.match(source, /environment === 'live' \? 'live_collection' : 'test_collection'/);
  assert.match(source, /live_payments_blocked_accounting_pipeline_incomplete/);
});

test('server does not retain a second hard-coded backend kill-switch shadowing tenant controls', () => {
  assert.equal(source.includes('PAYMENT_KILL_SWITCH'), false);
  assert.equal(source.includes('paymentOperationsLocked'), false);
});


test('capability enablement requires independent, current owner release evidence', () => {
  assert.match(source, /CONTROL_RELEASE_EVIDENCE/);
  assert.ok(source.includes("db.doc('paymentControlApprovals/' + req.tenant.id + '/controls/' + control)"));
  assert.match(source, /approval\.status === 'APPROVED'/);
  assert.match(source, /approval\.approvedByOwner === true/);
  assert.match(source, /approval\.approvedBy !== actor\.uid/);
  assert.match(source, /expiresAt\.getTime\(\) > Date\.now\(\)/);
  assert.match(source, /emergency_stop_release_approval_required/);
  assert.match(source, /payment_control_release_evidence_required/);
  assert.match(source, /approval\.separateOwnerApproval === true/);
});

test('webhook capture evidence cannot become accounting authorization', () => {
  assert.match(source, /TRUSTED_SETTLEMENT_BRIDGE_NOT_IMPLEMENTED/);
  assert.match(source, /SETTLEMENT_CONTROL_DISABLED/);
  assert.match(source, /PENDING_CONTROL_OR_BRIDGE/);
  assert.match(source, /CAPTURED_VERIFIED_PENDING_ACCOUNTING/);
});

test('reconciliation cannot write the separate Firestore folio journal even after flags pass', () => {
  assert.match(source, /enforcePaymentControl\(req, res, 'automatic_settlement'\)/);
  assert.match(source, /enforcePaymentControl\(req, res, 'native_settlement_bridge'\)/);
  assert.match(source, /authoritative_pms_ledger_mapping_not_implemented/);
  assert.doesNotMatch(source, /runDurableReconciliationWorker\(/);
});
