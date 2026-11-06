import crypto from 'node:crypto';
import express from 'express';
import { initializeApp, applicationDefault, getApps } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';
import { SecretManagerServiceClient } from '@google-cloud/secret-manager';
import { FirestorePaymentRepository } from './intents/firestore-repository.mjs';
import { implementedProviderAdapters, providerQualificationStatus, createProviderAdapter } from './providers/factory.mjs';
import { PROVIDERS } from './providers/registry.mjs';
import { assertWebhookReplayIntegrity } from './webhooks/provider-webhook-router.mjs';
import { installAsyncRouteErrorHandling } from './http/async-route-errors.mjs';
import { createGracefulShutdown } from './http/graceful-shutdown.mjs';
import { configureHttpServerTimeouts } from './http/server-timeouts.mjs';
import { publicHttpError } from './http/public-http-error.mjs';
import { paymentRouteError } from './http/payment-route-errors.mjs';
import { inspectReadinessDependencies } from './http/readiness-probe.mjs';
import { disableAllEnabledSecretVersions } from './secrets/secret-version-management.mjs';
import { canonicalBytes } from '../../src/payments/canonical.mjs';
import { createSettlementSigner } from './settlement/authorization-signer.mjs';
import {
  createDeviceEnrollmentChallenge, verifyAndRegisterDevice, activatePaymentDevice,
  revokePaymentDevice, authenticatePaymentDeviceRequest, leaseNextSettlementCommand,
  acknowledgeSettlementCommand, paymentDeviceRef
} from './devices/firestore-device-service.mjs';
import { verifiedWebhookProviderPatch } from './webhooks/provider-webhook-state.mjs';
import {
  PAYMENT_CONTROL_DEFAULTS, PAYMENT_CONTROL_IDS, readPaymentControls,
  paymentControlAllows, updatePaymentControls
} from './payment-controls/firestore-controls.mjs';
// No folio settlement writer is imported: this service records provider evidence
// only until a trusted local accounting bridge passes its separate release gates.

const projectId = process.env.GOOGLE_CLOUD_PROJECT;
const origins = new Set((process.env.AURELIA_OWNER_ORIGINS || '').split(',').map(v => v.trim()).filter(Boolean));
function isExactHttpsOrigin(value) {
  if (typeof value !== 'string' || !value || value.includes('*')) return false;
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'https:' && parsed.origin === value &&
      !parsed.username && !parsed.password && parsed.pathname === '/' &&
      !parsed.search && !parsed.hash;
  } catch {
    return false;
  }
}
if (!projectId || origins.size === 0 || [...origins].some(value => !isExactHttpsOrigin(value))) {
  throw new Error('Set GOOGLE_CLOUD_PROJECT and exact HTTPS AURELIA_OWNER_ORIGINS before startup.');
}
if (process.env.NODE_ENV === 'production') {
  const port = process.env.PORT;
  if (!/^[0-9]{1,5}$/.test(port || '') || Number(port) < 1 || Number(port) > 65535) {
    throw new Error('PRODUCTION_CONFIG_INVALID: explicit valid PORT is required.');
  }
  if ([...origins].some(value => /localhost|127\.0\.0\.1|\[::1\]|\.local(?::|$)/i.test(value))) {
    throw new Error('PRODUCTION_CONFIG_INVALID: local development origins are forbidden.');
  }
}
if (!getApps().length) initializeApp({ credential: applicationDefault(), projectId });
const auth = getAuth();
const db = getFirestore();
const sm = new SecretManagerServiceClient();
const app = express();
// Express 4 must forward async route rejections to the final error middleware.
installAsyncRouteErrorHandling(app);
app.disable('x-powered-by');
// Production contract: TLS terminates at a trusted HTTPS ingress. The ingress
// must overwrite X-Forwarded-Proto and be the only network path to this container.
if (process.env.AURELIA_HTTPS_TERMINATION !== 'trusted-proxy' ||
    process.env.AURELIA_TRUST_PROXY_HOPS !== '1') {
  throw new Error('HTTPS_ONLY: configure trusted HTTPS ingress and AURELIA_TRUST_PROXY_HOPS=1.');
}
app.set('trust proxy', 1);

// Reject cleartext requests; never redirect payment POSTs or forward credentials.
app.use((req, res, next) => {
  // Cloud Run health probes originate inside the platform and use the
  // container port directly. Keep these two non-sensitive probe paths usable
  // without forwarded TLS metadata; every business route still requires HTTPS.
  const platformProbe = req.path === '/healthz' || req.path === '/readyz';
  if (!req.secure && !platformProbe) {
    return res.status(403).json({
      error: 'insecure_connection_rejected',
      message: 'HTTPS is required.'
    });
  }
  if (req.secure) {
    res.set('Strict-Transport-Security', 'max-age=63072000; includeSubDomains; preload');
  }
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('X-Frame-Options', 'DENY');
  res.set('Referrer-Policy', 'no-referrer');
  res.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  next();
});

app.use((req, res, next) => {
  const origin = req.get('origin');
  if (origin && !origins.has(origin)) return res.status(403).json({ error: 'origin_not_allowed' });
  if (origin) {
    res.set('Access-Control-Allow-Origin', origin);
    res.set('Vary', 'Origin');
    res.set('Access-Control-Allow-Headers', 'Authorization, Content-Type, Idempotency-Key');
    res.set('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  }
  if (req.method === 'OPTIONS') return res.status(204).end();
  res.set('Cache-Control', 'no-store');
  res.set('Pragma', 'no-cache');
  next();
});

const tenantIdPattern = /^[A-Za-z0-9_-]{6,64}$/;
const webhookEventIdPattern = /^[A-Za-z0-9._:-]{1,200}$/;
const secretName = id => 'projects/' + projectId + '/secrets/' + id;
const membershipDoc = uid => db.doc('paymentMemberships/' + uid);
const fail = (res, status, error) => res.status(status).json({ error });

async function storeSecret(id, value) {
  const parent = 'projects/' + projectId;
  const name = secretName(id);
  try { await sm.getSecret({ name }); }
  catch (e) {
    if (e.code !== 5) throw e;
    await sm.createSecret({ parent, secretId: id, secret: { replication: { automatic: {} } } });
  }
  await sm.addSecretVersion({ parent: name, payload: { data: Buffer.from(value, 'utf8') } });
}
async function loadSecret(id) {
  const [version] = await sm.accessSecretVersion({ name: secretName(id) + '/versions/latest' });
  return Buffer.from(version.payload.data).toString('utf8');
}
const settlementIssuerEnabled = process.env.SETTLEMENT_AUTH_ISSUER_ENABLED === 'true';
const settlementSigningSecretId = process.env.SETTLEMENT_AUTH_SIGNING_SECRET_ID || 'aurelia-settlement-signing-key';
const settlementSigningKeyId = process.env.SETTLEMENT_AUTH_KEY_ID || 'aurelia-settlement-2026-01';
let settlementSignerPromise = null;
async function getSettlementSigner() {
  if (!settlementIssuerEnabled) throw new Error('settlement_authority_not_enabled');
  if (!settlementSignerPromise) {
    settlementSignerPromise = loadSecret(settlementSigningSecretId)
      .then(privateKeyPem => createSettlementSigner({ privateKeyPem, keyId: settlementSigningKeyId }))
      .catch(error => { settlementSignerPromise = null; throw error; });
  }
  return settlementSignerPromise;
}
const attestationVerifierUrl = process.env.ATTESTATION_VERIFIER_URL || 'http://127.0.0.1:8091';
async function authenticateTenantMembership(req, res, next, allowedRoles, failureCode) {
  const header = req.get('authorization') || '';
  if (!/^Bearer\s+[^\s]+$/i.test(header)) return fail(res, 401, 'authentication_required');
  let token;
  try {
    // Firebase Admin validates signature, issuer, audience, expiry and revocation.
    token = await auth.verifyIdToken(header.slice(7).trim(), true);
  } catch (error) {
    if (error?.code === 'auth/id-token-expired') return fail(res, 401, 'token_expired');
    if (error?.code === 'auth/id-token-revoked' || error?.code === 'auth/user-disabled') {
      return fail(res, 401, 'token_revoked');
    }
    return fail(res, 401, 'invalid_token');
  }
  if (token.email_verified !== true) return fail(res, 403, 'verified_email_required');
  const secondFactor = token.firebase?.sign_in_second_factor;
  if (typeof secondFactor !== 'string' || !['phone','totp'].includes(secondFactor)) {
    return fail(res, 403, 'mfa_required');
  }
  const now = Math.floor(Date.now() / 1000);
  if (!Number.isSafeInteger(token.auth_time) || token.auth_time <= 0 || token.auth_time > now) {
    return fail(res, 401, 'invalid_auth_time');
  }
  if (now - token.auth_time > 600) return fail(res, 401, 'recent_mfa_sign_in_required');
  let membership;
  try {
    membership = await membershipDoc(token.uid).get();
  } catch {
    // Infrastructure failure is not an authentication failure.
    return fail(res, 503, 'membership_service_unavailable');
  }
  const m = membership.exists ? membership.data() : {};
  if (m.status !== 'active' || !tenantIdPattern.test(m.tenantId || '') || !allowedRoles.includes(m.role)) {
    return fail(res, 403, failureCode);
  }
  req.actor = token;
  req.tenant = { id: m.tenantId, role: m.role };
  return next();
}
function requireTenantAdmin(req, res, next) {
  return authenticateTenantMembership(req, res, next, ['owner', 'admin'], 'active_tenant_admin_membership_required');
}
function requireTenantPaymentActor(req, res, next) {
  return authenticateTenantMembership(req, res, next, ['owner', 'admin', 'staff'], 'active_tenant_payment_membership_required');
}

async function requireRegisteredPaymentDevice(req, res, next) {
  try {
    req.device = await authenticatePaymentDeviceRequest({
      db, tenantId: req.tenant.id, deviceId: req.params.deviceId,
      method: req.method, originalUrl: req.originalUrl,
      body: req.body || {}, headers: req.headers
    });
    return next();
  } catch (error) {
    const code = String(error?.message || 'device_request_rejected');
    const status = code.includes('signature_required') || code.includes('timestamp_out_of_range') ? 401 :
      code.includes('replay') ? 409 : 403;
    return fail(res, status, code.slice(0, 96));
  }
}

async function enforcePaymentControl(req, res, control) {
  let controls;
  try {
    controls = await readPaymentControls({ db, tenantId: req.tenant.id });
  } catch {
    return fail(res, 503, 'payment_controls_unavailable');
  }
  if (!paymentControlAllows(controls, control)) {
    const unavailable = ['READ_FAILED', 'INVALID_CONTEXT', 'INVALID_FAIL_CLOSED'].includes(controls.controlState);
    return fail(res, unavailable ? 503 : 423,
      unavailable ? 'payment_controls_unavailable' :
        controls.emergency_stop !== false ? 'payment_emergency_stop' : 'payment_control_disabled');
  }
  req.paymentControls = controls;
  return null;
}

// Hardware-attested Android device lifecycle. The attestation verifier is a
// private Cloud Run sidecar; if it is unavailable, enrollment fails closed.
app.post('/v1/admin/devices/enrollment/challenge', requireTenantAdmin,
  express.json({ limit: '2kb', strict: true }), async (req, res) => {
    const deviceId = req.body?.deviceId;
    if (Object.keys(req.body || {}).some(key => key !== 'deviceId') ||
        typeof deviceId !== 'string' || !/^[A-Za-z0-9_-]{6,64}$/.test(deviceId)) {
      return fail(res, 400, 'invalid_payment_device_enrollment_request');
    }
    try {
      const challenge = await createDeviceEnrollmentChallenge({
        db, tenantId: req.tenant.id, actorUid: req.actor.uid, deviceId
      });
      return res.status(201).json(challenge);
    } catch (error) {
      return fail(res, 409, String(error?.message || 'payment_device_challenge_failed').slice(0, 96));
    }
  });

app.post('/v1/admin/devices/enroll', requireTenantAdmin,
  express.json({ limit: '512kb', strict: true }), async (req, res) => {
    const body = req.body || {};
    if (Object.keys(body).some(key => !['deviceId','challengeId','publicKeyPem','certificateChainBase64'].includes(key)) ||
        !['deviceId','challengeId','publicKeyPem','certificateChainBase64'].every(key => Object.hasOwn(body,key))) {
      return fail(res, 400, 'invalid_payment_device_enrollment_request');
    }
    try {
      const result = await verifyAndRegisterDevice({
        db, tenantId: req.tenant.id, actorUid: req.actor.uid,
        deviceId: body.deviceId, challengeId: body.challengeId,
        publicKeyPem: body.publicKeyPem, certificateChainBase64: body.certificateChainBase64,
        attestationVerifierUrl
      });
      return res.status(202).json(result);
    } catch (error) {
      return fail(res, 422, String(error?.message || 'android_key_attestation_rejected').slice(0, 96));
    }
  });

app.post('/v1/admin/devices/:deviceId/activate', requireTenantAdmin, async (req, res) => {
  if (req.tenant.role !== 'owner') return fail(res, 403, 'payment_device_owner_approval_required');
  try {
    return res.json(await activatePaymentDevice({
      db, tenantId: req.tenant.id, actorUid: req.actor.uid, deviceId: req.params.deviceId
    }));
  } catch (error) {
    return fail(res, 409, String(error?.message || 'payment_device_activation_failed').slice(0, 96));
  }
});

app.post('/v1/admin/devices/:deviceId/revoke', requireTenantAdmin, async (req, res) => {
  if (req.tenant.role !== 'owner') return fail(res, 403, 'payment_device_owner_approval_required');
  try {
    return res.json(await revokePaymentDevice({
      db, tenantId: req.tenant.id, actorUid: req.actor.uid, deviceId: req.params.deviceId
    }));
  } catch (error) {
    return fail(res, 409, String(error?.message || 'payment_device_revocation_failed').slice(0, 96));
  }
});

app.post('/v1/devices/:deviceId/commands/lease', requireTenantPaymentActor,
  express.json({ limit: '2kb', strict: true }), requireRegisteredPaymentDevice, async (req, res) => {
    if (!settlementIssuerEnabled) return fail(res, 503, 'settlement_authority_not_configured');
    const controls = await readPaymentControls({ db, tenantId: req.tenant.id });
    const settlementAllowed = paymentControlAllows(controls, 'test_collection') &&
      paymentControlAllows(controls, 'automatic_settlement') &&
      paymentControlAllows(controls, 'native_settlement_bridge');
    try {
      const signer = await getSettlementSigner();
      const lease = await leaseNextSettlementCommand({
        db, tenantId: req.tenant.id, deviceId: req.device.deviceId,
        signer, settlementAllowed
      });
      return res.json(lease || { command: null });
    } catch (error) {
      return fail(res, 409, String(error?.message || 'payment_device_command_lease_failed').slice(0, 96));
    }
  });

app.post('/v1/devices/:deviceId/commands/:commandId/ack', requireTenantPaymentActor,
  express.json({ limit: '2kb', strict: true }), requireRegisteredPaymentDevice, async (req, res) => {
    try {
      const result = await acknowledgeSettlementCommand({
        db, tenantId: req.tenant.id, deviceId: req.device.deviceId,
        commandId: req.params.commandId, body: req.body || {}
      });
      return res.json(result);
    } catch (error) {
      return fail(res, 409, String(error?.message || 'payment_device_acknowledgement_failed').slice(0, 96));
    }
  });

// Owner/admin control plane. Authentication middleware enforces verified email,
// recent MFA, active tenant membership and owner/admin role.
app.get('/v1/admin/payment-controls', requireTenantAdmin, async (req, res) => {
  const controls = await readPaymentControls({ db, tenantId: req.tenant.id });
  const auditSnap = await db.doc('paymentControls/' + req.tenant.id)
    .collection('audit').orderBy('at', 'desc').limit(50).get().catch(() => null);
  return res.json({
    controls: controls.controlState === 'CONFIGURED'
      ? Object.fromEntries(PAYMENT_CONTROL_IDS.map(key => [key, controls[key]]))
      : { ...PAYMENT_CONTROL_DEFAULTS },
    controlState: controls.controlState,
    auditAvailable: !!auditSnap,
    audit: auditSnap ? auditSnap.docs.map(doc => ({
      id: doc.id,
      ...(doc.data()),
      at: doc.data().at?.toDate?.().toISOString() || null
    })) : []
  });
});

const CONTROL_RELEASE_EVIDENCE = Object.freeze({
  manual_posting: ['real_data_diagnostic', 'owner_discrepancy_classification'],
  test_collection: ['local_credential_vault', 'test_order_creation', 'staff_confirmation_acceptance'],
  native_settlement_bridge: ['signed_authorization', 'signature_verification', 'ack_recovery'],
  automatic_settlement: ['crash_duplicate_offline_restore_acceptance'],
  live_collection: ['production_readiness_review', 'separate_owner_approval'],
  refund_processing: ['refund_state_machine', 'cumulative_limits', 'reversal_tests']
});

function isControlReleaseApprovalValid(approval, control, actor, role) {
  if (role !== 'owner' || !approval || typeof approval !== 'object') return false;
  const required = CONTROL_RELEASE_EVIDENCE[control] || [];
  const approvedAt = approval.approvedAt?.toDate?.();
  const expiresAt = approval.expiresAt?.toDate?.();
  return approval.status === 'APPROVED' &&
    approval.approvedByOwner === true &&
    typeof approval.approvedBy === 'string' && approval.approvedBy.length > 0 &&
    approval.approvedBy !== actor.uid &&
    Array.isArray(approval.evidence) &&
    required.every(item => approval.evidence.includes(item)) &&
    approvedAt instanceof Date && Number.isFinite(approvedAt.getTime()) &&
    expiresAt instanceof Date && Number.isFinite(expiresAt.getTime()) &&
    approvedAt.getTime() <= Date.now() &&
    expiresAt.getTime() > Date.now() &&
    (control !== 'live_collection' ||
      (approval.productionReadinessReview === true && approval.separateOwnerApproval === true));
}

app.patch('/v1/admin/payment-controls', requireTenantAdmin,
  express.json({ limit: '2kb', strict: true }), async (req, res) => {
    const body = req.body || {};
    if (Object.keys(body).some(key => !['changes', 'reason'].includes(key)) ||
        !body.changes || typeof body.changes !== 'object' || Array.isArray(body.changes) ||
        typeof body.reason !== 'string' || !body.reason.trim()) {
      return fail(res, 400, 'invalid_payment_control_update');
    }
    // Emergency stop may always be engaged. Disengaging it is a separately
    // approved release action; capability flags require current owner evidence.
    if (body.changes.emergency_stop === false) {
      return fail(res, 423, 'emergency_stop_release_approval_required');
    }
    const releaseApprovalRefs = Object.fromEntries(
      Object.entries(body.changes)
        .filter(([control, enabled]) => enabled === true && control !== 'emergency_stop')
        .map(([control]) => [control,
          db.doc('paymentControlApprovals/' + req.tenant.id + '/controls/' + control)])
    );
    try {
      const result = await updatePaymentControls({
        db, tenantId: req.tenant.id,
        actor: { uid: req.actor.uid, email: req.actor.email },
        changes: body.changes, reason: body.reason,
        releaseApprovalRefs,
        validateReleaseApproval: (approval, control) =>
          isControlReleaseApprovalValid(approval, control, req.actor, req.tenant.role)
      });
      return res.json({
        updated: true,
        controls: result.controls,
        audit: result.audit
      });
    } catch (error) {
      if (error.code === 'PAYMENT_CONTROLS_INVALID') return fail(res, 409, 'stored_payment_controls_invalid');
      if (error.code === 'PAYMENT_CONTROL_RELEASE_APPROVAL_REQUIRED') return fail(res, 423, 'payment_control_release_evidence_required');
      if (error instanceof TypeError) return fail(res, 400, 'invalid_payment_control_update');
      return fail(res, 503, 'payment_control_update_unavailable');
    }
  });

const envOf = req => {
  const value = req.body?.environment || req.query?.environment;
  return value === 'test' || value === 'live' ? value : null;
};
const adapterEnvironmentOf = (provider, publicEnvironment) => {
  if (!providerQualificationStatus(provider).implemented || !['test', 'live'].includes(publicEnvironment)) return null;
  if (provider === 'paytm') return publicEnvironment === 'test' ? 'staging' : 'production';
  if (provider === 'jiopay') return publicEnvironment === 'test' ? 'uat' : 'production';
  return publicEnvironment;
};
const idempotencyOf = req => {
  const value = req.get('idempotency-key') || req.body?.idempotencyKey || '';
  return /^[A-Za-z0-9._:-]{12,100}$/.test(value) ? value : null;
};
function equalSignature(received, expected) {
  if (!/^[a-f0-9]{64}$/i.test(received || '') || !/^[a-f0-9]{64}$/i.test(expected || '')) return false;
  return crypto.timingSafeEqual(Buffer.from(received, 'hex'), Buffer.from(expected, 'hex'));
}

app.get('/healthz', (_req, res) => res.json({ ok: true }));

// Readiness is intentionally separate from liveness. It verifies that the
// runtime identity can reach the two Google Cloud dependencies used by the
// service without exposing project, tenant, secret or provider information.
app.get('/readyz', async (_req, res) => {
  const result = await inspectReadinessDependencies({
    firestoreCheck: () => db.doc('aureliaSystem/health').get(),
    secretManagerCheck: async () => {
      const healthSecret = 'projects/' + projectId + '/secrets/aurelia-payment-backend-health/versions/latest';
      const [version] = await sm.accessSecretVersion({ name: healthSecret });
      return version?.payload?.data;
    }
  });
  const checks = { firestore: result.firestore, secretManager: result.secretManager };
  return res.status(result.ready ? 200 : 503).json({ ok: result.ready, checks });
});

const paymentRepository = new FirestorePaymentRepository({
  db,
  secretManager: {
    async getProviderSecrets(tenantId, provider, environment) {
      if (!implementedProviderAdapters().includes(provider) || !PROVIDERS[provider]) throw new Error('provider_not_enabled_for_checkout');
      const api = JSON.parse(await loadSecret(providerSecretId(tenantId, provider, environment, 'api')));
      const webhookValue = await loadSecret(providerSecretId(tenantId, provider, environment, 'webhook'));
      const webhook = provider === 'phonepe' ? JSON.parse(webhookValue) : { webhookSecret: webhookValue };
      return { ...api, ...webhook };
    }
  }
});
// Capability truth is deliberately stricter than adapter method availability.
// A provider API adapter is not an end-to-end PMS payment implementation.
const providerCatalogue = implementedProviderAdapters().map(id => ({
  id, label: PROVIDERS[id].label, environments: ['test', 'live'],
  credentials: PROVIDERS[id].credentials.map(({ key, label, type, secret, required }) => ({ key, label, type, secret, required })),
  capabilities: { testCheckout: true, liveCollection: false, verifiedWebhook: true,
    providerStatusLookup: true, folioSettlement: false, refunds: false, reconciliation: false },
  productionReady: false
}));
function providerTenantDoc(tenantId, provider, environment) {
  return db.doc('paymentTenants/' + tenantId + '/providers/' + provider + '_' + environment);
}
function providerSecretId(tenantId, provider, environment, purpose) {
  return 'aurl-' + crypto.createHash('sha256')
    .update(tenantId + ':' + provider + ':' + environment + ':' + purpose).digest('hex').slice(0, 32);
}
async function providerAdapterForTenant(tenantId, provider, environment) {
  const state = await providerTenantDoc(tenantId, provider, environment).get();
  if (!state.exists || state.data().configured !== true) {
    throw Object.assign(new Error('provider_credentials_not_configured'), { statusCode: 409 });
  }
  const credentials = await paymentRepository.secretManager.getProviderSecrets(tenantId, provider, environment);
  const { createProviderAdapter } = await import('./providers/factory.mjs');
  return { adapter: createProviderAdapter(provider, { credentials, environment }), state: state.data() };
}

app.post('/v1/admin/payments/reconcile', requireTenantAdmin,
  express.json({ limit: '1kb', strict: true }), async (req, res) => {
    const blocked = await enforcePaymentControl(req, res, 'automatic_settlement');
    if (blocked) return blocked;
    const bridgeBlocked = await enforcePaymentControl(req, res, 'native_settlement_bridge');
    if (bridgeBlocked) return bridgeBlocked;
    const limit = req.body?.limit === undefined ? 50 : req.body.limit;
    if (!Number.isInteger(limit) || limit < 1 || limit > 50 ||
        Object.keys(req.body || {}).some(key => key !== 'limit')) {
      return fail(res, 400, 'invalid_reconciliation_request');
    }
    // The current worker writes a separate Firestore paymentFolios journal.
    // It is not proven to be the authoritative local PMS ledger, so this
    // endpoint remains blocked even if control flags and release records exist.
    return fail(res, 423, 'authoritative_pms_ledger_mapping_not_implemented');
  });

app.post('/v1/payments/intents', requireTenantPaymentActor, express.json({ limit: '8kb', strict: true }), async (req, res) => {
  const body = req.body || {};
  const allowed = ['folioId', 'amountMinor', 'currency', 'provider', 'environment', 'idempotencyKey', 'customer', 'returnUrl', 'deviceId'];
  if (Object.keys(body).some(k => !allowed.includes(k)) ||
      !['folioId', 'amountMinor', 'currency', 'provider', 'environment'].every(k => Object.hasOwn(body, k)) ||
      (body.deviceId !== undefined && !/^[A-Za-z0-9_-]{6,64}$/.test(body.deviceId))) {
    return fail(res, 400, 'invalid_payment_intent_schema');
  }
  const idempotencyKey = idempotencyOf(req) || body.idempotencyKey;
  if (!idempotencyKey || !/^[A-Za-z0-9._:-]{12,100}$/.test(idempotencyKey)) return fail(res, 400, 'idempotency_key_required');
  const adapterEnvironment = adapterEnvironmentOf(body.provider, body.environment);
  if (!implementedProviderAdapters().includes(body.provider) || !adapterEnvironment) return fail(res, 400, 'provider_not_supported');
  if (body.environment !== 'test') return fail(res, 403, 'live_collection_not_enabled');

  const customerFields = {
    razorpay: [], cashfree: ['id', 'phone', 'email'], payu: ['firstName', 'email', 'phone'],
    phonepe: ['id', 'phone', 'email'], paytm: ['id'], jiopay: ['id', 'phone', 'email']
  }[body.provider];
  if (body.customer !== undefined && (!body.customer || typeof body.customer !== 'object' ||
      Array.isArray(body.customer) || Object.keys(body.customer).some(k => !customerFields.includes(k)))) {
    return fail(res, 400, 'invalid_provider_customer_schema');
  }
  if (['cashfree', 'phonepe', 'paytm', 'jiopay', 'payu'].includes(body.provider)) {
    let returnUrl;
    try { returnUrl = new URL(body.returnUrl); } catch { return fail(res, 400, 'invalid_provider_return_url'); }
    if (returnUrl.protocol !== 'https:' || returnUrl.username || returnUrl.password || !origins.has(returnUrl.origin)) {
      return fail(res, 400, 'provider_return_url_origin_not_allowed');
    }
  }
  if (body.provider === 'payu' && (!body.customer || typeof body.customer.firstName !== 'string' ||
      !body.customer.firstName.trim() || typeof body.customer.email !== 'string' ||
      !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(body.customer.email))) {
    return fail(res, 400, 'invalid_payu_customer_schema');
  }
  if (['cashfree', 'phonepe', 'jiopay'].includes(body.provider) &&
      (!body.customer || typeof body.customer.id !== 'string' || !/^[A-Za-z0-9_-]{6,64}$/.test(body.customer.id) ||
       typeof body.customer.phone !== 'string' || !/^\+?[0-9]{8,15}$/.test(body.customer.phone))) {
    return fail(res, 400, 'invalid_provider_customer_schema');
  }
  if (body.provider === 'paytm' && (!body.customer || typeof body.customer.id !== 'string' ||
      !/^[A-Za-z0-9_-]{6,64}$/.test(body.customer.id))) return fail(res, 400, 'invalid_paytm_customer_schema');

  const intentControl = body.environment === 'live' ? 'live_collection' : 'test_collection';
  const blocked = await enforcePaymentControl(req, res, intentControl);
  if (blocked) return blocked;
  try {
    const state = await providerTenantDoc(req.tenant.id, body.provider, adapterEnvironment).get();
    if (!state.exists || state.data().active !== true || state.data().credentialsValidated !== true) {
      return fail(res, 409, 'provider_not_active');
    }
    const result = await paymentRepository.initializePaymentIntent(req.actor.uid, {
      ...body, environment: adapterEnvironment, idempotencyKey
    });
    return res.status(result.isDuplicate ? 200 : result.status === 'CREATED' ? 201 : result.status === 'FAILED_TO_INITIATE' ? 503 : 202).json(result);
  } catch (error) {
    const response = paymentRouteError(error);
    return fail(res, response.status, response.error);
  }
});

function refundState(provider, status) {
  const value = String(status || '').toUpperCase();
  if ((provider === 'razorpay' && value === 'PROCESSED') ||
      (provider === 'cashfree' && value === 'SUCCESS') ||
      (provider === 'payu' && value === 'SUCCESS') ||
      (provider === 'phonepe' && value === 'COMPLETED') ||
      (provider === 'paytm' && ['SUCCESS', 'TXN_SUCCESS', 'COMPLETED'].includes(value)) ||
      (provider === 'jiopay' && ['SUCCESS', 'SUCCESSFUL', 'COMPLETED', 'CAPTURED', 'S0000', 'SUC'].includes(value))) return 'SUCCEEDED';
  if ((provider === 'razorpay' && value === 'FAILED') ||
      (provider === 'cashfree' && value === 'FAILED') ||
      (provider === 'payu' && value === 'FAILED') ||
      (provider === 'phonepe' && value === 'FAILED') ||
      (provider === 'paytm' && ['FAILED', 'FAILURE', 'TXN_FAILURE', 'REJECTED'].includes(value)) ||
      (provider === 'jiopay' && ['FAILED', 'FAILURE'].includes(value))) return 'FAILED';
  return value === 'NOT_FOUND' ? 'UNKNOWN' : 'PENDING';
}
function refundCreateInput(record, reason) {
  const common = { orderId: record.providerOrderId, paymentId: record.providerPaymentId,
    refundId: record.refundId, amountMinor: record.amountMinor };
  switch (record.provider) {
    case 'razorpay': return { paymentId: record.providerPaymentId, amountMinor: record.amountMinor,
      receipt: record.refundId, notes: { aurelia_intent_id: record.intentId } };
    case 'cashfree': return { ...common, idempotencyKey: record.idempotencyKey, reason };
    case 'payu': case 'paytm': return common;
    case 'phonepe': case 'jiopay': return { orderId: record.providerOrderId,
      refundId: record.refundId, amountMinor: record.amountMinor };
    default: throw new TypeError('provider_not_supported');
  }
}
function refundLookupInput(record) {
  switch (record.provider) {
    case 'razorpay': return { refundId: record.providerRefundId, paymentId: record.providerPaymentId };
    case 'cashfree': return { orderId: record.providerOrderId, paymentId: record.providerPaymentId, refundId: record.refundId };
    case 'payu': return { refundId: record.refundId, paymentId: record.providerPaymentId, requestId: record.providerRequestId || undefined };
    case 'phonepe': case 'paytm': return { orderId: record.providerOrderId, refundId: record.refundId };
    case 'jiopay': return { refundId: record.refundId };
    default: throw new TypeError('provider_not_supported');
  }
}
async function updateRefundEvidence(refundRef, intentRef, remote, record) {
  if (!remote || (remote.refundId && record.provider !== 'razorpay' && remote.refundId !== record.refundId) ||
      (remote.amountMinor != null && remote.amountMinor !== record.amountMinor) ||
      (remote.currency != null && remote.currency !== 'INR') ||
      (remote.paymentId != null && ['razorpay', 'cashfree', 'payu'].includes(record.provider) &&
        String(remote.paymentId) !== record.providerPaymentId) ||
      (remote.orderId != null && remote.orderId !== record.providerOrderId)) {
    throw new Error('provider_refund_binding_mismatch');
  }
  const next = refundState(record.provider, remote.status);
  await db.runTransaction(async tx => {
    const [refundSnap, intentSnap] = await Promise.all([tx.get(refundRef), tx.get(intentRef)]);
    if (!refundSnap.exists || !intentSnap.exists ||
        refundSnap.data().tenantId !== record.tenantId || intentSnap.data().tenantId !== record.tenantId) {
      throw new Error('refund_binding_not_found');
    }
    const current = refundSnap.data(), intent = intentSnap.data();
    if (current.state === 'FAILED' || current.state === 'SUCCEEDED') return;
    const patch = { state: next, providerStatus: String(remote.status || 'UNKNOWN'),
      providerRefundId: remote.refundId || current.providerRefundId || null,
      providerRequestId: remote.providerRequestId || current.providerRequestId || null,
      updatedAt: FieldValue.serverTimestamp() };
    tx.update(refundRef, patch);
    if (next === 'FAILED') {
      tx.update(intentRef, { refundReservedMinor: Math.max(0, Number(intent.refundReservedMinor || 0) - record.amountMinor),
        updatedAt: FieldValue.serverTimestamp() });
    }
  });
  const latest = await refundRef.get();
  return latest.exists ? latest.data() : null;
}

app.post('/v1/payments/intents/:intentId/refunds', requireTenantAdmin,
  express.json({ limit: '2kb', strict: true }), async (req, res) => {
    const { intentId } = req.params, amountMinor = req.body?.amountMinor;
    const idempotencyKey = idempotencyOf(req) || req.body?.idempotencyKey;
    const reason = req.body?.reason == null ? 'Customer refund' : req.body.reason;
    if (!/^[0-9a-f-]{36}$/i.test(intentId || '') || !Number.isSafeInteger(amountMinor) || amountMinor < 100 ||
        (req.body?.idempotencyKey && req.get('Idempotency-Key') && req.body.idempotencyKey !== req.get('Idempotency-Key')) ||
        typeof idempotencyKey !== 'string' || !/^[A-Za-z0-9._:-]{12,100}$/.test(idempotencyKey) ||
        typeof reason !== 'string' || reason.length < 3 || reason.length > 100 ||
        /[\u0000-\u001f\u007f]/.test(reason) ||
        Object.keys(req.body || {}).some(k => !['amountMinor', 'idempotencyKey', 'reason'].includes(k))) {
      return fail(res, 400, 'invalid_refund_request');
    }
    const intentRef = db.collection('paymentIntents').doc(intentId);
    try {
      const intentSnap = await intentRef.get();
      if (!intentSnap.exists || intentSnap.data().tenantId !== req.tenant.id) return fail(res, 404, 'payment_intent_not_found');
      const intent = intentSnap.data(), environment = intent.environment;
      if (!implementedProviderAdapters().includes(intent.provider)) return fail(res, 400, 'provider_not_supported');
      if (environment !== adapterEnvironmentOf(intent.provider, 'test')) return fail(res, 403, 'live_refunds_not_enabled');
      if (intent.state !== 'CAPTURED' || typeof intent.providerOrderId !== 'string' ||
          typeof intent.providerPaymentId !== 'string' || !intent.providerPaymentId) return fail(res, 409, 'captured_payment_required');
      const refundKey = crypto.createHash('sha256').update(req.tenant.id + ':' + intent.provider + ':' +
        environment + ':' + intent.providerAccountId + ':' + intentId + ':' + idempotencyKey).digest('hex');
      const refundId = 'rf_' + refundKey.slice(0, 17);
      const refundRef = db.collection('paymentRefunds').doc(refundId);
      const reservation = await db.runTransaction(async tx => {
        const [currentIntentSnap, priorSnap] = await Promise.all([tx.get(intentRef), tx.get(refundRef)]);
        if (!currentIntentSnap.exists || currentIntentSnap.data().tenantId !== req.tenant.id) throw new Error('payment_intent_not_found');
        const currentIntent = currentIntentSnap.data();
        if (priorSnap.exists) {
          const prior = priorSnap.data();
          if (prior.tenantId !== req.tenant.id || prior.intentId !== intentId ||
              prior.amountMinor !== amountMinor || prior.idempotencyKey !== idempotencyKey) throw new Error('idempotency_key_payload_conflict');
          return { record: prior, created: false };
        }
        if (currentIntent.state !== 'CAPTURED' || currentIntent.provider !== intent.provider ||
            currentIntent.providerOrderId !== intent.providerOrderId || currentIntent.providerPaymentId !== intent.providerPaymentId) {
          throw new Error('captured_payment_binding_changed');
        }
        const reserved = Number(currentIntent.refundReservedMinor || 0);
        if (!Number.isSafeInteger(reserved) || reserved < 0 || amountMinor > currentIntent.amountMinor - reserved) {
          throw new Error('refund_amount_exceeds_unrefunded_capture');
        }
        const record = { refundId, tenantId: req.tenant.id, intentId, provider: intent.provider,
          environment, providerAccountId: intent.providerAccountId, providerOrderId: intent.providerOrderId,
          providerPaymentId: intent.providerPaymentId, amountMinor, currency: 'INR',
          idempotencyKey, reason, state: 'DISPATCHING', createdAt: FieldValue.serverTimestamp() };
        tx.create(refundRef, record);
        tx.update(intentRef, { refundReservedMinor: reserved + amountMinor, updatedAt: FieldValue.serverTimestamp() });
        return { record, created: true };
      });
      let record = reservation.record;
      const { adapter, state } = await providerAdapterForTenant(req.tenant.id, record.provider, record.environment);
      const accountField = { razorpay: 'keyId', cashfree: 'appId', payu: 'merchantKey',
        phonepe: 'clientId', paytm: 'mid', jiopay: 'merchantId' }[record.provider];
      if (state[accountField] !== record.providerAccountId) return fail(res, 409, 'provider_account_binding_mismatch');
      if (state.credentialsValidated !== true) return fail(res, 409, 'provider_credentials_not_validated');
      if (!reservation.created) {
        if (['SUCCEEDED', 'FAILED'].includes(record.state)) return res.status(200).json(record);
        // DISPATCHING/UNKNOWN is resolved only by provider status lookup; never dispatch a duplicate refund.
        const lookupId = record.provider === 'razorpay' ? record.providerRefundId : record.refundId;
        if (!lookupId) return res.status(202).json({ ...record, status: 'UNKNOWN' });
        const remote = await adapter.getRefundStatus(refundLookupInput(record));
        record = await updateRefundEvidence(refundRef, intentRef, remote, record);
        return res.status(202).json(record);
      }
      try {
        const remote = await adapter.createRefund(refundCreateInput(record, reason));
        if (record.provider === 'razorpay') record.providerRefundId = remote.refundId;
        record = await updateRefundEvidence(refundRef, intentRef, remote, record);
        return res.status(202).json(record);
      } catch {
        await refundRef.set({ state: 'UNKNOWN', updatedAt: FieldValue.serverTimestamp() }, { merge: true }).catch(() => {});
        return res.status(202).json({ ...record, state: 'UNKNOWN' });
      }
    } catch (error) {
      const response = paymentRouteError(error);
      return fail(res, response.status || 409, response.error || 'refund_request_failed');
    }
  });

app.get('/v1/payments/intents/:intentId/refunds/:refundId', requireTenantAdmin, async (req, res) => {
  const { intentId, refundId } = req.params;
  if (!/^[0-9a-f-]{36}$/i.test(intentId || '') || !/^rf_[a-f0-9]{17}$/.test(refundId || '')) {
    return fail(res, 400, 'invalid_refund_lookup');
  }
  try {
    const [intentSnap, refundSnap] = await Promise.all([
      db.collection('paymentIntents').doc(intentId).get(),
      db.collection('paymentRefunds').doc(refundId).get()
    ]);
    if (!intentSnap.exists || intentSnap.data().tenantId !== req.tenant.id ||
        !refundSnap.exists || refundSnap.data().tenantId !== req.tenant.id ||
        refundSnap.data().intentId !== intentId) return fail(res, 404, 'refund_not_found');
    let record = refundSnap.data();
    if (['SUCCEEDED', 'FAILED'].includes(record.state)) return res.json(record);
    const { adapter, state } = await providerAdapterForTenant(req.tenant.id, record.provider, record.environment);
    const accountField = { razorpay: 'keyId', cashfree: 'appId', payu: 'merchantKey',
      phonepe: 'clientId', paytm: 'mid', jiopay: 'merchantId' }[record.provider];
    if (state[accountField] !== record.providerAccountId) return fail(res, 409, 'provider_account_binding_mismatch');
    const lookupId = record.provider === 'razorpay' ? record.providerRefundId : record.refundId;
    if (!lookupId) return res.status(202).json({ ...record, status: 'UNKNOWN' });
    const remote = await adapter.getRefundStatus(refundLookupInput(record));
    record = await updateRefundEvidence(db.collection('paymentRefunds').doc(refundId),
      db.collection('paymentIntents').doc(intentId), remote, record);
    return res.status(200).json(record);
  } catch {
    return fail(res, 503, 'refund_status_unavailable');
  }
});

app.get('/v1/payments/capabilities', requireTenantPaymentActor, async (req, res) => {
  const providers = await Promise.all(providerCatalogue.flatMap(provider =>
    provider.environments.map(async environment => {
      const adapterEnvironment = adapterEnvironmentOf(provider.id, environment);
      const snap = await providerTenantDoc(req.tenant.id, provider.id, adapterEnvironment).get();
      const state = snap.exists ? snap.data() : {};
      return {
        provider: provider.id, label: provider.label, environment, adapterEnvironment,
        capabilities: provider.capabilities, productionReady: provider.productionReady,
        configured: state.configured === true,
        credentialsValidated: state.credentialsValidated === true,
        sandboxTestPassed: state.sandboxTestPassed === true,
        webhookVerified: state.webhookVerified === true,
        active: state.active === true
      };
    })
  ));
  return res.json({
    liveCollection: false,
    folioSettlement: false,
    refunds: false,
    reconciliation: false,
    sdkCallbacksAuthoritative: false,
    providers
  });
});

app.post('/v1/payments/intents/:intentId/reconcile', requireTenantPaymentActor, async (req, res) => {
  try {
    return res.json(await paymentRepository.reconcilePaymentIntent(req.actor.uid, req.params.intentId));
  } catch (error) {
    const response = paymentRouteError(error);
    return fail(res, response.status, response.error);
  }
});

app.get('/v1/payments/intents/:intentId', requireTenantPaymentActor, async (req, res) => {
  try {
    return res.json(await paymentRepository.getPaymentIntent(req.actor.uid, req.params.intentId));
  } catch (error) {
    const response = paymentRouteError(error);
    return fail(res, response.status, response.error);
  }
});


app.get('/v1/admin/providers', requireTenantAdmin, async (req, res) => {
  const providers = await Promise.all(providerCatalogue.flatMap(provider =>
    provider.environments.map(async environment => {
      const snap = await providerTenantDoc(req.tenant.id, provider.id, environment).get();
      const d = snap.exists ? snap.data() : {};
      return {
        provider: provider.id, label: provider.label, environment,
        capabilities: provider.capabilities, productionReady: provider.productionReady,
        configured: d.configured === true, credentialsValidated: d.credentialsValidated === true,
        sandboxTestPassed: d.sandboxTestPassed === true, webhookVerified: d.webhookVerified === true,
        active: d.active === true, merchantId: d.merchantId || d.keyId || d.appId || null,
        updatedAt: d.updatedAt?.toDate?.().toISOString() || null
      };
    })
  ));
  res.json({ providers });
});

app.put('/v1/admin/providers/:provider/credentials', requireTenantAdmin, express.json({ limit: '8kb', strict: true }), async (req, res) => {
  const { provider } = req.params, publicEnvironment = envOf(req), environment = adapterEnvironmentOf(provider, publicEnvironment), body = req.body || {};
  const definitions = {
    razorpay: { publicKey: 'keyId', secretKeys: ['keySecret', 'webhookSecret'], valid: x => /^rzp_(test|live)_[A-Za-z0-9]{8,}$/.test(x.keyId || '') },
    cashfree: { publicKey: 'appId', secretKeys: ['secretKey', 'webhookSecret'], valid: x => typeof x.appId === 'string' && /^[A-Za-z0-9_-]{6,128}$/.test(x.appId) },
    payu: { publicKey: 'merchantKey', secretKeys: ['salt'], valid: x => /^[A-Za-z0-9_-]{4,50}$/.test(x.merchantKey || '') },
    phonepe: { publicKey: 'clientId', secretKeys: ['clientSecret', 'webhookPassword'], extra: ['clientVersion', 'webhookUsername'], valid: x => typeof x.clientId === 'string' && /^\d{1,8}$/.test(String(x.clientVersion || '')) && typeof x.webhookUsername === 'string' && x.webhookUsername.length > 0 },
    paytm: { publicKey: 'mid', secretKeys: ['merchantKey'], extra: ['websiteName'], valid: x => typeof x.mid === 'string' && /^[A-Za-z0-9._@-]{6,50}$/.test(x.mid) && Buffer.byteLength(x.merchantKey || '', 'utf8') === 16 && typeof x.websiteName === 'string' && /^[A-Za-z0-9_-]{1,50}$/.test(x.websiteName) },
    jiopay: { publicKey: 'merchantId', secretKeys: ['saltOrHashKey'], extra: ['aggregatorId'], valid: x => typeof x.merchantId === 'string' && /^[A-Za-z0-9_-]{6,50}$/.test(x.merchantId) && (x.aggregatorId === undefined || typeof x.aggregatorId === 'string') }
  };
  const def = definitions[provider], allowed = new Set(['environment', def?.publicKey, ...(def?.secretKeys || []), ...(def?.extra || [])].filter(Boolean));
  if (!def || !environment || !providerQualificationStatus(provider).implemented ||
      Object.keys(body).some(k => !allowed.has(k)) || !def.valid(body) ||
      def.secretKeys.some(k => typeof body[k] !== 'string' || body[k].length < 8 || body[k].length > 512) ||
      (provider === 'razorpay' && publicEnvironment === 'test' && !body.keyId.startsWith('rzp_test_')) ||
      (provider === 'razorpay' && publicEnvironment === 'live' && !body.keyId.startsWith('rzp_live_'))) {
    return fail(res, 400, 'invalid_provider_credential_schema');
  }
  if (publicEnvironment === 'live' && providerQualificationStatus(provider).liveCollection !== true) return fail(res, 403, 'live_collection_not_enabled');
  try {
    const stateRef = providerTenantDoc(req.tenant.id, provider, environment);
    await stateRef.set({ configured: false, credentialsValidated: false, sandboxTestPassed: false,
      webhookVerified: false, active: false, updatedAt: FieldValue.serverTimestamp(), updatedBy: req.actor.uid }, { merge: true });
    const apiFields = [def.publicKey, ...(def.secretKeys || []), ...(def.extra || [])]
      .filter(k => !['webhookPassword', 'webhookSecret'].includes(k));
    const apiCredentials = Object.fromEntries(apiFields.map(k => [k, body[k]]).filter(([,v]) => v !== undefined));
    const webhookValue = provider === 'phonepe'
      ? JSON.stringify({ webhookUsername: body.webhookUsername, webhookPassword: body.webhookPassword })
      : (body.webhookSecret || '');
    await storeSecret(providerSecretId(req.tenant.id, provider, environment, 'api'), JSON.stringify(apiCredentials));
    await storeSecret(providerSecretId(req.tenant.id, provider, environment, 'webhook'), webhookValue);
    let credentialsValid = false;
    try {
      const savedCredentials = await paymentRepository.secretManager.getProviderSecrets(req.tenant.id, provider, environment);
      const adapter = createProviderAdapter(provider, { credentials: savedCredentials, environment });
      await adapter.validateCredentials();
      credentialsValid = true;
    } catch {
      credentialsValid = false;
    }
    const patch = { provider, environment, publicEnvironment, configured: true, credentialsValidated: credentialsValid,
      ...(credentialsValid ? { validatedAt: FieldValue.serverTimestamp() } : {}),
      sandboxTestPassed: false, webhookVerified: false, active: false,
      updatedAt: FieldValue.serverTimestamp(), updatedBy: req.actor.uid };
    patch[def.publicKey] = body[def.publicKey];
    await stateRef.set(patch, { merge: true });
    if (!credentialsValid) return fail(res, 422, 'provider_credentials_validation_failed');
    return res.status(200).json({ accepted: true, valid: true, provider, environment: publicEnvironment,
      adapterEnvironment: environment, status: 'credentials_validated_test_only' });
  } catch {
    return fail(res, 503, 'credential_storage_unavailable');
  }
});

app.delete('/v1/admin/providers/:provider/credentials', requireTenantAdmin, async (req, res) => {
  const { provider } = req.params, publicEnvironment = req.query?.environment;
  const environment = adapterEnvironmentOf(provider, publicEnvironment);
  if (!environment) return fail(res, 400, 'invalid_provider_environment');
  if (publicEnvironment === 'live' && providerQualificationStatus(provider).liveCollection !== true) return fail(res, 403, 'live_collection_not_enabled');
  try {
    const stateRef = providerTenantDoc(req.tenant.id, provider, environment);
    const state = await stateRef.get();
    if (!state.exists) return res.json({ removed: true, provider, environment, alreadyAbsent: true });
    // Disable provider use before disabling either secret version. Retaining
    // the secret resources allows safe re-provisioning and avoids project-wide
    // secret deletion permission in the runtime service account.
    await stateRef.set({
      configured: false, credentialsValidated: false, sandboxTestPassed: false,
      webhookVerified: false, active: false, updatedAt: FieldValue.serverTimestamp()
    }, { merge: true });
    const ids = [
      providerSecretId(req.tenant.id, provider, environment, 'api'),
      providerSecretId(req.tenant.id, provider, environment, 'webhook')
    ];
    for (const id of ids) {
      await disableAllEnabledSecretVersions(sm, secretName(id));
    }
    await stateRef.delete();
    return res.json({ removed: true, provider, environment, active: false });
  } catch {
    return fail(res, 503, 'provider_credential_removal_unavailable');
  }
});

app.post('/v1/admin/providers/:provider/validate', requireTenantAdmin, express.json({ limit: '2kb', strict: true }), async (req, res) => {
  const { provider } = req.params, publicEnvironment = envOf(req), environment = adapterEnvironmentOf(provider, publicEnvironment);
  if (!environment) return fail(res, 400, 'invalid_provider_environment');
  if (publicEnvironment === 'live' && providerQualificationStatus(provider).liveCollection !== true) return fail(res, 403, 'live_collection_not_enabled');
  try {
    const credentials = await paymentRepository.secretManager.getProviderSecrets(req.tenant.id, provider, environment);
    const { createProviderAdapter } = await import('./providers/factory.mjs');
    const adapter = createProviderAdapter(provider, { credentials, environment });
    await adapter.validateCredentials();
    await providerTenantDoc(req.tenant.id, provider, environment).set({
      credentialsValidated: true, validatedAt: FieldValue.serverTimestamp(), active: false
    }, { merge: true });
    return res.json({ valid: true, provider, environment });
  } catch (error) {
    await providerTenantDoc(req.tenant.id, provider, environment)
      .set({ credentialsValidated: false, active: false }, { merge: true }).catch(() => {});
    return fail(res, error.statusCode || 503, error.statusCode ? error.message : 'provider_validation_unavailable');
  }
});

app.post('/v1/admin/providers/:provider/test-orders', requireTenantAdmin, express.json({ limit: '2kb', strict: true }), async (req, res) => {
  const blocked = await enforcePaymentControl(req, res, 'test_collection');
  if (blocked) return blocked;
  const { provider } = req.params, publicEnvironment = envOf(req), environment = adapterEnvironmentOf(provider, publicEnvironment),
    amountMinor = req.body?.amountMinor, idem = idempotencyOf(req);
  if (!implementedProviderAdapters().includes(provider) || publicEnvironment !== 'test' || !environment ||
      !Number.isSafeInteger(amountMinor) || amountMinor < 100 || amountMinor > 10000000 || !idem) return fail(res, 400, 'invalid_test_order_request');
  const providerState = await providerTenantDoc(req.tenant.id, provider, environment).get();
  if (!providerState.exists || providerState.data().configured !== true ||
      providerState.data().credentialsValidated !== true) {
    return fail(res, 409, 'provider_credentials_not_validated');
  }
  const idemId = crypto.createHash('sha256').update(req.tenant.id + ':' + provider + ':test:' + idem).digest('hex');
  const idemRef = db.doc('paymentIdempotency/' + idemId);
  try {
    const credentials = await paymentRepository.secretManager.getProviderSecrets(req.tenant.id, provider, environment);
    const adapter = createProviderAdapter(provider, { credentials, environment });
    const reservationResult = await db.runTransaction(async tx => {
      const prior = await tx.get(idemRef);
      if (prior.exists) return { record: prior.data(), newlyReserved: false };
      const record = { tenantId: req.tenant.id, provider, amountMinor, currency: 'INR',
        state: 'dispatching', createdAt: FieldValue.serverTimestamp() };
      tx.create(idemRef, record);
      return { record, newlyReserved: true };
    });
    const reservation = reservationResult.record;
    if (reservation.tenantId !== req.tenant.id || reservation.provider !== provider || reservation.amountMinor !== amountMinor) {
      return fail(res, 409, 'idempotency_key_payload_conflict');
    }
    if (reservation.response) return res.status(200).json(reservation.response);
    if (!reservationResult.newlyReserved) return fail(res, 409, 'order_creation_unknown_reconcile_before_retry');
    const orderId = 'a_' + idemId.slice(0, 18);
    const customer = { id: 'aurelia_owner_test', phone: '9999999999',
      firstName: 'Aurelia', email: 'owner-sandbox@example.invalid' };
    const returnUrl = [...origins][0] + '/payment-return';
    const input = provider === 'razorpay' ? { amountMinor, currency: 'INR', receipt: orderId }
      : provider === 'payu' ? { orderId, amountMinor, currency: 'INR', customer, returnUrl }
      : { orderId, amountMinor, currency: 'INR', customer, returnUrl, callbackUrl: returnUrl, idempotencyKey: orderId };
    const order = await adapter.createOrder(input);
    if (!order || typeof order.orderId !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(order.orderId) ||
        order.amountMinor !== amountMinor || order.currency !== 'INR') throw new Error('provider_test_order_response_binding_invalid');
    const checkoutData = provider === 'razorpay' ? { keyId: order.keyId }
      : provider === 'cashfree' ? { paymentSessionId: order.paymentSessionId, checkoutUrl: order.checkoutUrl || null }
      : (provider === 'payu' || provider === 'paytm') ? { checkout: order.checkout }
      : provider === 'phonepe' ? { checkoutUrl: order.checkoutUrl }
      : { checkoutUrl: order.checkoutUrl, transactionContext: order.transactionContext };
    const checkoutValid = provider === 'razorpay' ? typeof checkoutData.keyId === 'string'
      : provider === 'cashfree' ? typeof checkoutData.paymentSessionId === 'string'
      : provider === 'payu' ? typeof checkoutData.checkout?.action === 'string' && checkoutData.checkout.action.startsWith('https://')
      : provider === 'paytm' ? typeof checkoutData.checkout?.txnToken === 'string'
      : provider === 'phonepe' ? typeof checkoutData.checkoutUrl === 'string' && checkoutData.checkoutUrl.startsWith('https://')
      : typeof checkoutData.checkoutUrl === 'string' && checkoutData.checkoutUrl.startsWith('https://') && typeof checkoutData.transactionContext === 'string';
    if (!checkoutValid) throw new Error('provider_test_order_checkout_invalid');
    const response = { provider, environment: publicEnvironment, adapterEnvironment: environment,
      orderId: order.orderId, amountMinor: order.amountMinor, currency: 'INR', checkoutData, status: 'created' };
    await db.runTransaction(async tx => {
      tx.set(idemRef, { state: 'created', response, providerOrderId: order.orderId, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
      tx.create(db.doc('paymentOrders/' + req.tenant.id + '_' + provider + '_' + order.orderId), {
        tenantId: req.tenant.id, provider, environment,
        providerOrderId: order.orderId, amountMinor, currency: 'INR',
        state: 'created', createdAt: FieldValue.serverTimestamp()
      });
    });
    return res.status(201).json(response);
  } catch {
    await idemRef.set({ state: 'unknown', updatedAt: FieldValue.serverTimestamp() }, { merge: true }).catch(() => {});
    return fail(res, 503, 'order_creation_unknown_reconcile_before_retry');
  }
});

app.post('/v1/webhooks/:provider/:tenantId/:environment', express.raw({ type: '*/*', limit: '1mb' }), async (req, res) => {
  const { provider, tenantId, environment: publicEnvironment } = req.params;
  const environment = adapterEnvironmentOf(provider, publicEnvironment);
  if (!implementedProviderAdapters().includes(provider) || !tenantIdPattern.test(tenantId || '') ||
      !environment || !Buffer.isBuffer(req.body)) return fail(res, 400, 'invalid_webhook_request');
  if (publicEnvironment === 'live' && providerQualificationStatus(provider).liveCollection !== true) {
    return fail(res, 403, 'live_collection_not_enabled');
  }
  try {
    const hookState = await providerTenantDoc(tenantId, provider, environment).get();
    if (!hookState.exists || hookState.data().configured !== true) {
      return fail(res, 404, 'webhook_provider_not_configured');
    }
    const credentials = await paymentRepository.secretManager.getProviderSecrets(tenantId, provider, environment);
    const { createProviderAdapter } = await import('./providers/factory.mjs');
    const adapter = createProviderAdapter(provider, { credentials, environment });
    const checked = await adapter.verifyWebhook(req.body, req.headers);
    if (!checked.valid) return fail(res, 400, 'invalid_webhook_signature');
    const event = checked.event;
    const paymentEntity = provider === 'razorpay' ? event?.payload?.payment?.entity
      : provider === 'cashfree' ? event?.data?.payment
      : provider === 'phonepe' ? event?.payload : event;
    const providerOrderId = provider === 'razorpay' ? paymentEntity?.order_id
      : provider === 'cashfree' ? event?.data?.order?.order_id
      : provider === 'payu' ? event?.txnid
      : provider === 'phonepe' ? paymentEntity?.merchantOrderId
      : provider === 'paytm' ? event?.ORDERID : event?.merchantTxnNo;
    const paymentId = provider === 'razorpay' ? paymentEntity?.id
      : provider === 'cashfree' ? paymentEntity?.cf_payment_id
      : provider === 'payu' ? event?.mihpayid
      : provider === 'phonepe' ? (paymentEntity?.transactionId || paymentEntity?.paymentDetails?.[0]?.transactionId)
      : provider === 'paytm' ? event?.TXNID : event?.pgTransactionId;
    if (!providerOrderId || !paymentId) return res.status(200).json({ received: true, ignored: true });
    const providerOrderHash = crypto.createHash('sha256')
      .update(tenantId + ':' + provider + ':' + environment + ':' + providerOrderId).digest('hex');
    const intentOrderRef = db.doc('paymentProviderOrders/' + providerOrderHash);
    const onboardingOrderRef = db.doc('paymentOrders/' + tenantId + '_' + provider + '_' + providerOrderId);
    const intentOrderSnap = await intentOrderRef.get();
    const onboardingOrderSnap = intentOrderSnap.exists ? null : await onboardingOrderRef.get();
    const orderRef = intentOrderSnap.exists ? intentOrderRef : onboardingOrderRef;
    const orderSnap = intentOrderSnap.exists ? intentOrderSnap : onboardingOrderSnap;
    if (!orderSnap?.exists || orderSnap.data().tenantId !== tenantId ||
        orderSnap.data().provider !== provider || orderSnap.data().environment !== environment ||
        orderSnap.data().providerOrderId && orderSnap.data().providerOrderId !== providerOrderId) {
      return fail(res, 409, 'payment_order_binding_mismatch');
    }
    const status = await adapter.getPaymentStatus({ orderId: providerOrderId, paymentId });
    const sameOrder = status.orderId === providerOrderId;
    const samePayment = status.paymentId === paymentId;
    const sameCurrency = status.currency === orderSnap.data().currency;
    const sameAmount = status.amountMinor === orderSnap.data().amountMinor;
    const verified = sameOrder && samePayment && sameCurrency && sameAmount && status.captured === true;
    const eventId = provider === 'razorpay' ? req.get('x-razorpay-event-id')
      : provider === 'cashfree' ? (req.get('x-webhook-id') || crypto.createHash('sha256').update(req.body).digest('hex'))
      : provider === 'phonepe' ? String(event.eventId || event.id || crypto.createHash('sha256').update(req.body).digest('hex'))
      : provider === 'payu' ? String(event.mihpayid || event.txnid || '')
      : provider === 'paytm' ? String(event.ORDERID || '') + ':' + String(event.TXNID || 'event')
      : String(event.merchantTxnNo || '') + ':' + String(event.pgTransactionId || 'event');
    if (typeof eventId !== 'string' || !webhookEventIdPattern.test(eventId)) return fail(res, 400, 'invalid_event_id');
    const inboxId = crypto.createHash('sha256').update(tenantId + ':' + provider + ':' + environment + ':' + eventId).digest('hex');
    const payloadHash = crypto.createHash('sha256').update(req.body).digest('hex');
    const inbox = db.doc('paymentWebhookInbox/' + inboxId);
    const orderData = orderSnap.data();
    const intentRef = orderData.intentId
      ? db.doc('paymentIntents/' + orderData.intentId)
      : null;
    const deviceId = orderData.deviceId || null;
    const deviceRef = deviceId ? paymentDeviceRef(db, tenantId, deviceId) : null;
    const outcome = await db.runTransaction(async tx => {
      const refs = [tx.get(inbox), tx.get(orderRef)];
      if (intentRef) refs.push(tx.get(intentRef));
      if (deviceRef) refs.push(tx.get(deviceRef));
      const [seen, currentOrder, currentIntent, currentDevice] = await Promise.all(refs);
      if (!currentOrder.exists || currentOrder.data().tenantId !== tenantId ||
          currentOrder.data().provider !== provider || currentOrder.data().environment !== environment ||
          currentOrder.data().providerOrderId !== providerOrderId) {
        throw new Error('payment_order_binding_changed');
      }
      if (seen.exists) {
        const prior = seen.data();
        assertWebhookReplayIntegrity(prior, { tenantId, provider, environment, providerOrderId, paymentId, payloadHash });
        // Only a completed folio post is terminal. Verified captures that have
        // not posted must re-enter the settlement path on duplicate delivery.
        if (prior.accountingStatus === 'POSTED' ||
            prior.processingStatus === 'POSTED_TO_FOLIO') {
          return { duplicate: true, verified: true, accountingPosted: true };
        }
      }
      if (intentRef && (!currentIntent?.exists ||
          currentIntent.data().tenantId !== tenantId ||
          currentIntent.data().providerOrderId !== providerOrderId ||
          currentIntent.data().folioId !== currentOrder.data().folioId ||
          currentIntent.data().amountMinor !== currentOrder.data().amountMinor ||
          currentIntent.data().currency !== currentOrder.data().currency)) {
        throw new Error('payment_intent_binding_mismatch');
      }
      // Do not downgrade previously persisted capture verification evidence
      // if a retry races a transient provider-status response.
      const captureVerified = verified || (seen.exists && seen.data().providerFetchVerified === true);
      let settlementCommandId = seen.exists ? (seen.data().settlementCommandId || null) : null;
      let settlementSequenceId = seen.exists ? (seen.data().settlementSequenceId || null) : null;
      let commandCreated = false;
      const deviceData = currentDevice?.exists ? currentDevice.data() : null;
      const intentData = currentIntent?.exists ? currentIntent.data() : null;
      const providerAccountId = currentOrder.data().providerAccountId || intentData?.providerAccountId || null;
      const deviceReady = !!deviceData && deviceData.status === 'ACTIVE' &&
        deviceData.tenantId === tenantId && deviceData.deviceId === deviceId &&
        deviceData.attestationVerifiedAt &&
        ['TRUSTED_ENVIRONMENT','STRONG_BOX'].includes(deviceData.attestationSecurityLevel) &&
        deviceData.attestationVerifiedBootState === 'VERIFIED' &&
        deviceData.attestationDeviceLocked === true;
      if (captureVerified && intentRef && intentData && deviceReady && providerAccountId &&
          intentData.deviceId === deviceId && !settlementCommandId) {
        const sequenceId = (Number.isSafeInteger(deviceData.lastSequence) ? deviceData.lastSequence : 0) + 1;
        const commandId = crypto.randomUUID();
        const authorizationId = crypto.randomUUID();
        const leaseId = crypto.randomUUID();
        const settlement = {
          tenantId, deviceId, provider, providerAccountId, environment, commandId,
          providerTransactionId: paymentId, bookingId: currentOrder.data().folioId,
          amountPaise: currentOrder.data().amountMinor, method: provider, reference: paymentId
        };
        const commandPayload = {
          commandId, deviceId, sequenceId, transactionId: intentRef.id,
          idempotencyKey: intentData.idempotencyKey, folioId: currentOrder.data().folioId,
          amountMinor: currentOrder.data().amountMinor, currency: currentOrder.data().currency,
          provider, providerAccountId, providerPaymentId: paymentId, settlement
        };
        const payloadCanonical = Buffer.from(canonicalBytes(commandPayload)).toString('utf8');
        const commandPayloadHash = crypto.createHash('sha256').update(payloadCanonical).digest('hex');
        const commandRef = deviceRef.collection('commands').doc(String(sequenceId));
        tx.create(commandRef, {
          ...commandPayload, payload: commandPayload, payloadCanonical,
          payloadHash: commandPayloadHash, authorizationId, leaseId,
          webhookInboxId: inboxId, status: 'PENDING',
          leaseTokenHash: null, leaseExpiresAt: null, createdAt: FieldValue.serverTimestamp()
        });
        tx.update(deviceRef, { lastSequence: sequenceId, lastCommandAt: FieldValue.serverTimestamp() });
        settlementCommandId = commandId;
        settlementSequenceId = sequenceId;
        commandCreated = true;
      }
      const evidence = {
        eventId, tenantId, provider, environment, paymentId, providerOrderId, payloadHash,
        signatureVerified: true, providerFetchVerified: captureVerified,
        processingStatus: captureVerified ? 'CAPTURED_VERIFIED_PENDING_ACCOUNTING' : 'UNVERIFIED_RETRYABLE',
        accountingStatus: seen.exists ? (seen.data().accountingStatus || 'PENDING') : 'PENDING',
        ...(settlementCommandId ? { settlementCommandId, settlementSequenceId } : {}),
        receivedAt: seen.exists ? (seen.data().receivedAt || FieldValue.serverTimestamp()) : FieldValue.serverTimestamp(),
        lastAttemptAt: FieldValue.serverTimestamp()
      };
      tx.set(inbox, evidence, { merge: true });
      if (captureVerified) {
        tx.set(orderRef, {
          state: 'captured_verified', paymentId, verifiedAt: FieldValue.serverTimestamp()
        }, { merge: true });
        if (intentRef) {
          tx.set(intentRef, {
            providerPaymentId: paymentId,
            providerEventId: eventId,
            providerVerifiedStatus: 'CAPTURED',
            providerVerifiedAt: FieldValue.serverTimestamp(),
            accountingStatus: 'PENDING',
            accountingBlockReason: FieldValue.delete()
          }, { merge: true });
        }
        tx.set(providerTenantDoc(tenantId, provider, environment),
          verifiedWebhookProviderPatch(environment, () => FieldValue.serverTimestamp()),
          { merge: true });
      }
      return { duplicate: false, verified: captureVerified, commandCreated,
        deviceReady, settlementCommandId, settlementSequenceId };
    });

    let accounting = outcome.accountingPosted ? 'posted' : 'not_verified';
    // Webhooks may persist signed/provider-fetched evidence, never accounting
    // authorization. Even if switches are later enabled, the trusted native
    // issuer/projector is a separate release gate and is not implemented here.
    if (outcome.verified && !outcome.accountingPosted) {
      const controls = await readPaymentControls({ db, tenantId });
      const environmentControl = environment === 'live' ? 'live_collection' : 'test_collection';
      const controlsAllowCapture = paymentControlAllows(controls, environmentControl);
      const controlsAllowSettlement = paymentControlAllows(controls, 'automatic_settlement') &&
        paymentControlAllows(controls, 'native_settlement_bridge');
      const blockReason = controls.emergency_stop !== false
        ? 'PAYMENT_EMERGENCY_STOP'
        : !controlsAllowCapture
          ? 'COLLECTION_CONTROL_DISABLED'
          : !controlsAllowSettlement
            ? 'SETTLEMENT_CONTROL_DISABLED'
            : !settlementIssuerEnabled
              ? 'SETTLEMENT_AUTHORITY_NOT_CONFIGURED'
              : !deviceId
                ? 'TRUSTED_DEVICE_NOT_BOUND_TO_INTENT'
                : !outcome.deviceReady
                  ? 'TRUSTED_DEVICE_NOT_ACTIVE'
                  : !outcome.commandCreated && !outcome.settlementCommandId
                    ? 'SETTLEMENT_COMMAND_NOT_CREATED'
                    : 'AWAITING_TRUSTED_DEVICE_ACK';
      await inbox.set({
        accountingStatus: 'PENDING_CONTROL_OR_BRIDGE',
        processingStatus: 'CAPTURED_VERIFIED_PENDING_ACCOUNTING',
        accountingBlockReason: blockReason,
        lastAttemptAt: FieldValue.serverTimestamp()
      }, { merge: true }).catch(() => {});
      accounting = 'verified_pending_accounting';
    } else if (outcome.verified && outcome.accountingPosted) {
      accounting = 'previously_posted';
    }
    return res.status(200).json({
      received: true, verified: outcome.verified, duplicate: outcome.duplicate === true,
      accounting
    });
  } catch {
    return fail(res, 503, 'webhook_processing_unavailable');
  }
});
app.post('/v1/admin/providers/:provider/activate', requireTenantAdmin, express.json({ limit: '2kb', strict: true }), async (req, res) => {
  const { provider } = req.params, publicEnvironment = envOf(req), environment = adapterEnvironmentOf(provider, publicEnvironment);
  if (!implementedProviderAdapters().includes(provider) || !environment || req.body?.confirm !== true) {
    return fail(res, 400, 'explicit_activation_confirmation_required');
  }
  if (publicEnvironment === 'live' && providerQualificationStatus(provider).liveCollection !== true) {
    return fail(res, 403, 'live_collection_not_enabled');
  }
  const blocked = await enforcePaymentControl(req, res, 'test_collection');
  if (blocked) return blocked;
  const ref = providerTenantDoc(req.tenant.id, provider, environment);
  const snap = await ref.get(), state = snap.exists ? snap.data() : {};
  if (state.credentialsValidated !== true) return fail(res, 409, 'provider_credentials_not_validated');
  if (state.sandboxTestPassed !== true) return fail(res, 409, 'sandbox_acceptance_required');
  if (state.webhookVerified !== true) return fail(res, 409, 'webhook_verification_required');
  await ref.set({ active: true, activatedAt: FieldValue.serverTimestamp(), activatedBy: req.actor.uid }, { merge: true });
  return res.json({ active: true, provider, environment: publicEnvironment, adapterEnvironment: environment });
});
app.use((err, _req, res, next) => {
  // Deliberately do not log request bodies, tokens, provider responses or secrets.
  // Delegate if headers were already sent; writing a second response would
  // create another unhandled error during provider/webhook failure recovery.
  if (res.headersSent) return next(err);
  const response = publicHttpError(err);
  return res.status(response.status).json({ error: response.error });
});
const httpServer = configureHttpServerTimeouts(app.listen(Number(process.env.PORT || 8080), '0.0.0.0'));
const shutdown = createGracefulShutdown({
  server: httpServer,
  timeoutMs: 7000,
  dependencies: [
    async () => db.terminate(),
    async () => sm.close()
  ]
});
for (const signal of ['SIGTERM', 'SIGINT']) {
  process.once(signal, () => {
    shutdown().catch(() => {
      // Do not print dependency errors: provider/infra exceptions may carry
      // sensitive metadata. A non-zero exit lets the platform replace the task.
      process.exitCode = 1;
    });
  });
}
