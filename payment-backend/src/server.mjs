import crypto from 'node:crypto';
import express from 'express';
import { initializeApp, applicationDefault, getApps } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';
import { SecretManagerServiceClient } from '@google-cloud/secret-manager';
import { FirestorePaymentRepository } from './intents/firestore-repository.mjs';

const projectId = process.env.GOOGLE_CLOUD_PROJECT;
const origins = new Set((process.env.AURELIA_OWNER_ORIGINS || '').split(',').map(v => v.trim()).filter(Boolean));
if (!projectId || origins.size === 0 || [...origins].some(v => !/^https:\/\/[^/]+$/.test(v))) {
  throw new Error('Set GOOGLE_CLOUD_PROJECT and exact HTTPS AURELIA_OWNER_ORIGINS before startup.');
}
if (!getApps().length) initializeApp({ credential: applicationDefault(), projectId });
const auth = getAuth();
const db = getFirestore();
const sm = new SecretManagerServiceClient();
const app = express();
app.disable('x-powered-by');
// Trust exactly one ingress proxy only when the deployment explicitly declares it.
// The ingress must overwrite X-Forwarded-Proto; the container must not be publicly reachable.
const trustProxyHops = process.env.AURELIA_TRUST_PROXY_HOPS === '1' ? 1 : false;
app.set('trust proxy', trustProxyHops);

// HTTPS is an ingress invariant. TLS termination/cipher/TLS 1.3 policy belongs
// at the load balancer or hosting edge; Express can only validate the trusted
// transport metadata it receives. Never trust X-Forwarded-Proto from an
// untrusted client connection.
app.use((req, res, next) => {
  if (!req.secure) {
    return res.status(403).json({
      error: 'insecure_connection_rejected',
      message: 'HTTPS is required.'
    });
  }
  res.set('Strict-Transport-Security', 'max-age=63072000; includeSubDomains; preload');
  next();
});

app.use((req, res, next) => {
  const origin = req.get('origin');
  if (origin && !origins.has(origin)) return res.status(403).json({ error: 'origin_not_allowed' });
  if (origin) {
    res.set('Access-Control-Allow-Origin', origin);
    res.set('Vary', 'Origin');
    res.set('Access-Control-Allow-Headers', 'Authorization, Content-Type, Idempotency-Key');
    res.set('Access-Control-Allow-Methods', 'GET, POST, PUT, OPTIONS');
  }
  if (req.method === 'OPTIONS') return res.status(204).end();
  res.set('Cache-Control', 'no-store');
  res.set('Pragma', 'no-cache');
  next();
});

const tenantIdPattern = /^[A-Za-z0-9_-]{6,64}$/;
const secretId = (tenantId, env, purpose) =>
  'aurl-' + crypto.createHash('sha256').update(tenantId + ':razorpay:' + env + ':' + purpose).digest('hex').slice(0, 32);
const secretName = id => 'projects/' + projectId + '/secrets/' + id;
const tenantDoc = (tenantId, env) => db.doc('paymentTenants/' + tenantId + '/providers/razorpay_' + env);
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
async function requireTenantAdmin(req, res, next) {
  try {
    const header = req.get('authorization') || '';
    if (!header.startsWith('Bearer ')) return fail(res, 401, 'authentication_required');
    const token = await auth.verifyIdToken(header.slice(7), true);
    if (token.email_verified !== true) return fail(res, 403, 'verified_email_required');
    if (!(token.firebase || {}).sign_in_second_factor) return fail(res, 403, 'mfa_required');
    if (!Number.isFinite(token.auth_time) || Date.now() / 1000 - token.auth_time > 600) return fail(res, 401, 'recent_mfa_sign_in_required');
    const membership = await membershipDoc(token.uid).get();
    const m = membership.exists ? membership.data() : {};
    if (m.status !== 'active' || !tenantIdPattern.test(m.tenantId || '') || !['owner', 'admin'].includes(m.role)) {
      return fail(res, 403, 'active_tenant_admin_membership_required');
    }
    req.actor = token;
    req.tenant = { id: m.tenantId, role: m.role };
    next();
  } catch {
    return fail(res, 401, 'invalid_or_revoked_token');
  }
}
const envOf = req => {
  const value = req.body?.environment || req.query?.environment;
  return value === 'test' || value === 'live' ? value : null;
};
const idempotencyOf = req => {
  const value = req.get('idempotency-key') || req.body?.idempotencyKey || '';
  return /^[A-Za-z0-9._:-]{12,100}$/.test(value) ? value : null;
};
async function razorpay(tenantId, env, method, path, body) {
  const cfg = JSON.parse(await loadSecret(secretId(tenantId, env, 'api')));
  const response = await fetch('https://api.razorpay.com/v1' + path, {
    method,
    headers: {
      Authorization: 'Basic ' + Buffer.from(cfg.keyId + ':' + cfg.keySecret).toString('base64'),
      'Content-Type': 'application/json'
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(15000)
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw Object.assign(new Error('provider_request_failed'), { providerStatus: response.status });
  return data;
}
function equalSignature(received, expected) {
  if (!/^[a-f0-9]{64}$/i.test(received || '') || !/^[a-f0-9]{64}$/i.test(expected || '')) return false;
  return crypto.timingSafeEqual(Buffer.from(received, 'hex'), Buffer.from(expected, 'hex'));
}

app.get('/healthz', (_req, res) => res.json({ ok: true }));

const paymentRepository = new FirestorePaymentRepository({
  db,
  secretManager: {
    async getProviderSecrets(tenantId, provider, environment) {
      if (provider !== 'razorpay') throw new Error('provider_not_enabled_for_checkout');
      const api = JSON.parse(await loadSecret(secretId(tenantId, environment, 'api')));
      const webhookSecret = await loadSecret(secretId(tenantId, environment, 'webhook'));
      return { ...api, webhookSecret };
    }
  }
});

app.post('/v1/payments/intents', requireTenantAdmin, express.json({ limit: '8kb', strict: true }), async (req, res) => {
  const body = req.body || {};
  const allowed = ['folioId', 'amountMinor', 'currency', 'provider', 'environment', 'idempotencyKey'];
  if (Object.keys(body).some(k => !allowed.includes(k)) ||
      !['folioId', 'amountMinor', 'currency', 'provider', 'environment'].every(k => Object.hasOwn(body, k))) {
    return fail(res, 400, 'invalid_payment_intent_schema');
  }
  const idempotencyKey = idempotencyOf(req) || body.idempotencyKey;
  if (!idempotencyKey || !/^[A-Za-z0-9._:-]{12,100}$/.test(idempotencyKey)) {
    return fail(res, 400, 'idempotency_key_required');
  }
  if (body.provider !== 'razorpay' || body.environment !== 'test') {
    return fail(res, 409, 'provider_environment_not_enabled_for_checkout');
  }
  try {
    const providerState = await tenantDoc(req.tenant.id, 'test').get();
    if (!providerState.exists || providerState.data().credentialsValidated !== true) {
      return fail(res, 409, 'razorpay_test_credentials_not_validated');
    }
    const result = await paymentRepository.initializePaymentIntent(req.actor.uid, { ...body, idempotencyKey });
    return res.status(result.isDuplicate ? 200 : result.status === 'CREATED' ? 201 : 202).json(result);
  } catch (error) {
    const status = Number.isInteger(error.statusCode) ? error.statusCode :
      error.message === 'active_tenant_membership_required' ? 403 : 400;
    return fail(res, status, String(error.message || 'payment_intent_creation_failed').slice(0, 100));
  }
});

app.get('/v1/payments/intents/:intentId', requireTenantAdmin, async (req, res) => {
  try {
    return res.json(await paymentRepository.getPaymentIntent(req.actor.uid, req.params.intentId));
  } catch (error) {
    const status = Number.isInteger(error.statusCode) ? error.statusCode :
      error.message === 'active_tenant_membership_required' ? 403 : 400;
    return fail(res, status, String(error.message || 'payment_intent_lookup_failed').slice(0, 100));
  }
});


app.get('/v1/admin/providers', requireTenantAdmin, async (req, res) => {
  const providers = await Promise.all(['test', 'live'].map(async environment => {
    const snap = await tenantDoc(req.tenant.id, environment).get();
    const d = snap.exists ? snap.data() : {};
    return {
      provider: 'razorpay', environment, configured: d.configured === true,
      credentialsValidated: d.credentialsValidated === true, sandboxTestPassed: d.sandboxTestPassed === true,
      webhookVerified: d.webhookVerified === true, active: d.active === true,
      keyId: d.keyId || null, updatedAt: d.updatedAt?.toDate?.().toISOString() || null
    };
  }));
  res.json({ providers });
});

app.put('/v1/admin/providers/razorpay/credentials', requireTenantAdmin, express.json({ limit: '8kb', strict: true }), async (req, res) => {
  const environment = envOf(req);
  const { keyId, keySecret, webhookSecret } = req.body || {};
  const keys = Object.keys(req.body || {});
  if (!environment || keys.some(k => !['environment', 'keyId', 'keySecret', 'webhookSecret'].includes(k)) ||
      !/^rzp_(test|live)_[A-Za-z0-9]{8,}$/.test(keyId || '') || !keySecret || keySecret.length > 512 ||
      !webhookSecret || webhookSecret.length > 512 ||
      (environment === 'test' && !keyId.startsWith('rzp_test_')) ||
      (environment === 'live' && !keyId.startsWith('rzp_live_'))) {
    return fail(res, 400, 'invalid_razorpay_credential_schema');
  }
  try {
    await storeSecret(secretId(req.tenant.id, environment, 'api'), JSON.stringify({ keyId, keySecret }));
    await storeSecret(secretId(req.tenant.id, environment, 'webhook'), webhookSecret);
    await tenantDoc(req.tenant.id, environment).set({
      provider: 'razorpay', environment, keyId, configured: true, credentialsValidated: false,
      sandboxTestPassed: false, webhookVerified: false, active: false,
      updatedAt: FieldValue.serverTimestamp(), updatedBy: req.actor.uid
    }, { merge: true });
    res.status(202).json({ accepted: true, provider: 'razorpay', environment, status: 'credentials_stored_validation_pending' });
  } catch {
    fail(res, 503, 'credential_storage_unavailable');
  }
});

app.post('/v1/admin/providers/razorpay/validate', requireTenantAdmin, express.json({ limit: '2kb' }), async (req, res) => {
  const environment = envOf(req);
  if (!environment) return fail(res, 400, 'invalid_environment');
  try {
    const cfg = JSON.parse(await loadSecret(secretId(req.tenant.id, environment, 'api')));
    await razorpay(req.tenant.id, environment, 'GET', '/orders?count=1');
    await tenantDoc(req.tenant.id, environment).set({
      credentialsValidated: true, validatedAt: FieldValue.serverTimestamp(), active: false
    }, { merge: true });
    res.json({ valid: true, provider: 'razorpay', environment, keyId: cfg.keyId });
  } catch (e) {
    await tenantDoc(req.tenant.id, environment).set({ credentialsValidated: false, active: false }, { merge: true });
    fail(res, e.providerStatus === 401 ? 422 : 503, e.providerStatus === 401 ? 'provider_credentials_rejected' : 'provider_validation_unavailable');
  }
});

app.post('/v1/admin/providers/razorpay/test-orders', requireTenantAdmin, express.json({ limit: '2kb' }), async (req, res) => {
  const environment = envOf(req);
  const amount = req.body?.amountPaise;
  const idem = idempotencyOf(req);
  if (environment !== 'test' || !Number.isSafeInteger(amount) || amount < 100 || amount > 10000000 || !idem) {
    return fail(res, 400, 'invalid_test_order_request');
  }
  const idemId = crypto.createHash('sha256').update(req.tenant.id + ':razorpay:test:' + idem).digest('hex');
  const idemRef = db.doc('paymentIdempotency/' + idemId);
  try {
    const state = await tenantDoc(req.tenant.id, 'test').get();
    if (!state.exists || state.data().credentialsValidated !== true) return fail(res, 409, 'test_credentials_not_validated');
    const reservationResult = await db.runTransaction(async tx => {
      const prior = await tx.get(idemRef);
      if (prior.exists) return { record: prior.data(), newlyReserved: false };
      const record = { tenantId: req.tenant.id, amount, currency: 'INR', state: 'dispatching',
        createdAt: FieldValue.serverTimestamp() };
      tx.create(idemRef, record);
      return { record, newlyReserved: true };
    });
    const reservation = reservationResult.record;
    if (reservation.tenantId !== req.tenant.id || reservation.amount !== amount) return fail(res, 409, 'idempotency_key_payload_conflict');
    if (reservation.response) return res.status(200).json(reservation.response);
    if (!reservationResult.newlyReserved) return fail(res, 409, 'order_creation_unknown_reconcile_before_retry');
    const order = await razorpay(req.tenant.id, 'test', 'POST', '/orders', {
      amount, currency: 'INR', receipt: 'aur_' + idemId.slice(0, 24)
    });
    const response = { provider: 'razorpay', environment: 'test', orderId: order.id, amount: order.amount,
      currency: order.currency, keyId: state.data().keyId, status: 'created' };
    await db.runTransaction(async tx => {
      tx.set(idemRef, { state: 'created', response, providerOrderId: order.id, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
      tx.create(db.doc('paymentOrders/' + req.tenant.id + '_' + order.id), {
        tenantId: req.tenant.id, provider: 'razorpay', environment: 'test',
        amount, currency: 'INR', state: 'created', createdAt: FieldValue.serverTimestamp()
      });
    });
    res.status(201).json(response);
  } catch (e) {
    // Do not issue a second provider order after an ambiguous network failure.
    await idemRef.set({ state: 'unknown', updatedAt: FieldValue.serverTimestamp() }, { merge: true }).catch(() => {});
    fail(res, e.providerStatus === 401 ? 422 : 503, 'order_creation_unknown_reconcile_before_retry');
  }
});

app.post('/v1/webhooks/razorpay/:tenantId/:environment', express.raw({ type: 'application/json', limit: '1mb' }), async (req, res) => {
  const { tenantId, environment } = req.params;
  if (!tenantIdPattern.test(tenantId || '') || !['test', 'live'].includes(environment) || !Buffer.isBuffer(req.body)) {
    return fail(res, 400, 'invalid_webhook_request');
  }
  const signature = req.get('x-razorpay-signature') || '';
  const eventId = req.get('x-razorpay-event-id') || '';
  if (!/^[A-Za-z0-9_-]{8,200}$/.test(eventId)) return fail(res, 400, 'invalid_event_id');
  try {
    const webhookSecret = await loadSecret(secretId(tenantId, environment, 'webhook'));
    const expected = crypto.createHmac('sha256', webhookSecret).update(req.body).digest('hex');
    if (!equalSignature(signature, expected)) return fail(res, 400, 'invalid_webhook_signature');
    const event = JSON.parse(req.body.toString('utf8'));
    const entity = event?.payload?.payment?.entity;
    if (!entity || !['payment.captured', 'order.paid', 'payment.authorized'].includes(event.event)) {
      return res.status(200).json({ received: true, ignored: true });
    }
    const orderRef = entity.order_id ? db.doc('paymentOrders/' + tenantId + '_' + entity.order_id) : null;
    if (!orderRef) return fail(res, 400, 'order_reference_missing');
    const orderSnap = await orderRef.get();
    if (!orderSnap.exists || orderSnap.data().tenantId !== tenantId ||
        orderSnap.data().environment !== environment || orderSnap.data().amount !== entity.amount ||
        orderSnap.data().currency !== entity.currency) return fail(res, 409, 'payment_order_binding_mismatch');
    const payment = await razorpay(tenantId, environment, 'GET', '/payments/' + encodeURIComponent(entity.id));
    const verified = payment.status === 'captured' && payment.order_id === entity.order_id &&
      payment.amount === orderSnap.data().amount && payment.currency === orderSnap.data().currency;
    const inboxId = crypto.createHash('sha256').update(tenantId + ':' + environment + ':' + eventId).digest('hex');
    const inbox = db.doc('razorpayWebhookInbox/' + inboxId);
    await db.runTransaction(async tx => {
      const seen = await tx.get(inbox);
      if (seen.exists) return;
      tx.create(inbox, {
        eventId, tenantId, provider: 'razorpay', environment, event: event.event,
        paymentId: entity.id, orderId: entity.order_id, signatureVerified: true,
        providerFetchVerified: verified, receivedAt: FieldValue.serverTimestamp()
      });
      if (verified) tx.set(orderRef, {
        state: 'captured_verified', paymentId: entity.id, verifiedAt: FieldValue.serverTimestamp()
      }, { merge: true });
      if (verified) tx.set(tenantDoc(tenantId, environment), environment === 'test' ? {
        sandboxTestPassed: true, webhookVerified: true, lastVerifiedTestAt: FieldValue.serverTimestamp(), active: false
      } : { webhookVerified: true, lastVerifiedLiveAt: FieldValue.serverTimestamp(), active: false }, { merge: true });
    });
    res.status(200).json({ received: true, verified });
  } catch {
    fail(res, 503, 'webhook_processing_unavailable');
  }
});

app.post('/v1/admin/providers/razorpay/activate', requireTenantAdmin, express.json({ limit: '2kb' }), async (req, res) => {
  const environment = envOf(req);
  if (!environment || req.body?.confirm !== true) return fail(res, 400, 'explicit_activation_confirmation_required');
  const ref = tenantDoc(req.tenant.id, environment);
  const snap = await ref.get();
  const state = snap.exists ? snap.data() : {};
  if (state.credentialsValidated !== true ||
      (environment === 'test' && (state.sandboxTestPassed !== true || state.webhookVerified !== true))) {
    return fail(res, 409, 'provider_onboarding_checks_incomplete');
  }
  if (environment === 'live') {
    const test = await tenantDoc(req.tenant.id, 'test').get();
    if (!test.exists || test.data().sandboxTestPassed !== true || test.data().webhookVerified !== true) {
      return fail(res, 409, 'sandbox_acceptance_required');
    }
    if (state.webhookVerified !== true) return fail(res, 409, 'live_webhook_verification_required');
  }
  await ref.set({ active: true, activatedAt: FieldValue.serverTimestamp(), activatedBy: req.actor.uid }, { merge: true });
  res.json({ active: true, provider: 'razorpay', environment });
});

app.use((err, _req, res, _next) => {
  // Deliberately do not log request bodies, tokens, provider responses or secrets.
  const status = err?.type === 'entity.too.large' ? 413 : 400;
  res.status(status).json({ error: status === 413 ? 'request_too_large' : 'invalid_request' });
});
app.listen(Number(process.env.PORT || 8080), '0.0.0.0');
