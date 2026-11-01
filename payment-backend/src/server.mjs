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
// Production contract: TLS terminates at a trusted HTTPS ingress. The ingress
// must overwrite X-Forwarded-Proto and be the only network path to this container.
if (process.env.AURELIA_HTTPS_TERMINATION !== 'trusted-proxy' ||
    process.env.AURELIA_TRUST_PROXY_HOPS !== '1') {
  throw new Error('HTTPS_ONLY: configure trusted HTTPS ingress and AURELIA_TRUST_PROXY_HOPS=1.');
}
app.set('trust proxy', 1);

// Reject cleartext requests; never redirect payment POSTs or forward credentials.
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
async function authenticateTenantMembership(req, res, next, allowedRoles, failureCode) {
  try {
    const header = req.get('authorization') || '';
    if (!header.startsWith('Bearer ')) return fail(res, 401, 'authentication_required');
    const token = await auth.verifyIdToken(header.slice(7), true);
    if (token.email_verified !== true) return fail(res, 403, 'verified_email_required');
    if (!(token.firebase || {}).sign_in_second_factor) return fail(res, 403, 'mfa_required');
    const ageSeconds = Date.now() / 1000 - token.auth_time;
    if (!Number.isFinite(token.auth_time) || ageSeconds < 0 || ageSeconds > 600) {
      return fail(res, 401, 'recent_mfa_sign_in_required');
    }
    const membership = await membershipDoc(token.uid).get();
    const m = membership.exists ? membership.data() : {};
    if (m.status !== 'active' || !tenantIdPattern.test(m.tenantId || '') || !allowedRoles.includes(m.role)) {
      return fail(res, 403, failureCode);
    }
    req.actor = token;
    req.tenant = { id: m.tenantId, role: m.role };
    return next();
  } catch {
    return fail(res, 401, 'invalid_or_revoked_token');
  }
}
function requireTenantAdmin(req, res, next) {
  return authenticateTenantMembership(req, res, next, ['owner', 'admin'], 'active_tenant_admin_membership_required');
}
function requireTenantPaymentActor(req, res, next) {
  return authenticateTenantMembership(req, res, next, ['owner', 'admin', 'staff'], 'active_tenant_payment_membership_required');
}

const envOf = req => {
  const value = req.body?.environment || req.query?.environment;
  return value === 'test' || value === 'live' ? value : null;
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

const paymentRepository = new FirestorePaymentRepository({
  db,
  secretManager: {
    async getProviderSecrets(tenantId, provider, environment) {
      if (!['razorpay', 'cashfree'].includes(provider)) throw new Error('provider_not_enabled_for_checkout');
      const api = JSON.parse(await loadSecret(providerSecretId(tenantId, provider, environment, 'api')));
      const webhookSecret = await loadSecret(providerSecretId(tenantId, provider, environment, 'webhook'));
      return { ...api, webhookSecret };
    }
  }
});
const providerCatalogue = [
  { id: 'razorpay', label: 'Razorpay', environments: ['test', 'live'], implemented: true },
  { id: 'cashfree', label: 'Cashfree Payments', environments: ['test', 'live'], implemented: true }
];
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
app.post('/v1/payments/intents', requireTenantPaymentActor, express.json({ limit: '8kb', strict: true }), async (req, res) => {
  const body = req.body || {};
  const allowed = ['folioId', 'amountMinor', 'currency', 'provider', 'environment', 'idempotencyKey', 'customer', 'returnUrl'];
  if (Object.keys(body).some(k => !allowed.includes(k)) ||
      !['folioId', 'amountMinor', 'currency', 'provider', 'environment'].every(k => Object.hasOwn(body, k))) {
    return fail(res, 400, 'invalid_payment_intent_schema');
  }
  const idempotencyKey = idempotencyOf(req) || body.idempotencyKey;
  if (!idempotencyKey || !/^[A-Za-z0-9._:-]{12,100}$/.test(idempotencyKey)) return fail(res, 400, 'idempotency_key_required');
  if (!['razorpay', 'cashfree'].includes(body.provider) || !['test', 'live'].includes(body.environment)) {
    return fail(res, 409, 'provider_environment_not_enabled_for_checkout');
  }
  try {
    const state = await providerTenantDoc(req.tenant.id, body.provider, body.environment).get();
    if (!state.exists || state.data().active !== true || state.data().credentialsValidated !== true) {
      return fail(res, 409, 'provider_not_active');
    }
    if (body.environment === 'live') {
      const sandbox = await providerTenantDoc(req.tenant.id, body.provider, 'test').get();
      if (!sandbox.exists || sandbox.data().sandboxTestPassed !== true || sandbox.data().webhookVerified !== true) {
        return fail(res, 409, 'sandbox_acceptance_required');
      }
    }
    const result = await paymentRepository.initializePaymentIntent(req.actor.uid, { ...body, idempotencyKey });
    return res.status(result.isDuplicate ? 200 : result.status === 'CREATED' ? 201 : result.status === 'FAILED_TO_INITIATE' ? 503 : 202).json(result);
  } catch (error) {
    const status = Number.isInteger(error.statusCode) ? error.statusCode :
      error.message === 'active_tenant_membership_required' ? 403 : 400;
    return fail(res, status, String(error.message || 'payment_intent_creation_failed').slice(0, 100));
  }
});

app.get('/v1/payments/intents/:intentId', requireTenantPaymentActor, async (req, res) => {
  try {
    return res.json(await paymentRepository.getPaymentIntent(req.actor.uid, req.params.intentId));
  } catch (error) {
    const status = Number.isInteger(error.statusCode) ? error.statusCode :
      error.message === 'active_tenant_membership_required' ? 403 : 400;
    return fail(res, status, String(error.message || 'payment_intent_lookup_failed').slice(0, 100));
  }
});


app.get('/v1/admin/providers', requireTenantAdmin, async (req, res) => {
  const providers = await Promise.all(providerCatalogue.flatMap(provider =>
    provider.environments.map(async environment => {
      const snap = await providerTenantDoc(req.tenant.id, provider.id, environment).get();
      const d = snap.exists ? snap.data() : {};
      return {
        provider: provider.id, label: provider.label, environment, implemented: provider.implemented,
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
  const { provider } = req.params, environment = envOf(req), body = req.body || {};
  const definitions = {
    razorpay: { publicKey: 'keyId', secretKeys: ['keySecret', 'webhookSecret'], valid: c => /^rzp_(test|live)_[A-Za-z0-9]{8,}$/.test(c.keyId || '') },
    cashfree: { publicKey: 'appId', secretKeys: ['secretKey', 'webhookSecret'], valid: c => typeof c.appId === 'string' && /^[A-Za-z0-9_-]{6,128}$/.test(c.appId) }
  };
  const def = definitions[provider];
  const allowed = new Set(['environment', def?.publicKey, ...(def?.secretKeys || [])].filter(Boolean));
  if (!def || !environment || Object.keys(body).some(k => !allowed.has(k)) || !def.valid(body) ||
      def.secretKeys.some(k => typeof body[k] !== 'string' || body[k].length < 8 || body[k].length > 512) ||
      (provider === 'razorpay' && environment === 'test' && !body.keyId.startsWith('rzp_test_')) ||
      (provider === 'razorpay' && environment === 'live' && !body.keyId.startsWith('rzp_live_'))) {
    return fail(res, 400, 'invalid_provider_credential_schema');
  }
  try {
    const apiCredentials = Object.fromEntries(
      [def.publicKey, ...def.secretKeys.filter(k => k !== 'webhookSecret')].map(k => [k, body[k]])
    );
    await storeSecret(providerSecretId(req.tenant.id, provider, environment, 'api'), JSON.stringify(apiCredentials));
    await storeSecret(providerSecretId(req.tenant.id, provider, environment, 'webhook'), body.webhookSecret);
    const patch = { provider, environment, configured: true, credentialsValidated: false,
      sandboxTestPassed: false, webhookVerified: false, active: false,
      updatedAt: FieldValue.serverTimestamp(), updatedBy: req.actor.uid };
    patch[def.publicKey] = body[def.publicKey];
    await providerTenantDoc(req.tenant.id, provider, environment).set(patch, { merge: true });
    return res.status(202).json({ accepted: true, provider, environment, status: 'credentials_stored_validation_pending' });
  } catch {
    return fail(res, 503, 'credential_storage_unavailable');
  }
});

app.post('/v1/admin/providers/:provider/validate', requireTenantAdmin, express.json({ limit: '2kb', strict: true }), async (req, res) => {
  const { provider } = req.params, environment = envOf(req);
  if (!['razorpay', 'cashfree'].includes(provider) || !environment) return fail(res, 400, 'invalid_provider_environment');
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
  const { provider } = req.params, environment = envOf(req), amountMinor = req.body?.amountMinor, idem = idempotencyOf(req);
  if (!['razorpay', 'cashfree'].includes(provider) || environment !== 'test' ||
      !Number.isSafeInteger(amountMinor) || amountMinor < 100 || amountMinor > 10000000 || !idem) {
    return fail(res, 400, 'invalid_test_order_request');
  }
  const idemId = crypto.createHash('sha256').update(req.tenant.id + ':' + provider + ':test:' + idem).digest('hex');
  const idemRef = db.doc('paymentIdempotency/' + idemId);
  try {
    const credentials = await paymentRepository.secretManager.getProviderSecrets(req.tenant.id, provider, 'test');
    const { createProviderAdapter } = await import('./providers/factory.mjs');
    const adapter = createProviderAdapter(provider, { credentials, environment: 'test' });
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
    const input = provider === 'razorpay'
      ? { amountMinor, currency: 'INR', receipt: 'aur_' + idemId.slice(0, 24) }
      : {
          orderId: 'aur_' + idemId.slice(0, 32), amountMinor, currency: 'INR',
          customer: {
            id: 'aurelia_owner_test',
            phone: '9999999999'
          },
          returnUrl: [...origins][0] + '/payment-return',
          idempotencyKey: 'aur_' + idemId.slice(0, 32)
        };
    const order = await adapter.createOrder(input);
    const response = { provider, environment: 'test', orderId: order.orderId, amountMinor: order.amountMinor,
      currency: order.currency, checkoutData: provider === 'razorpay' ? { keyId: order.keyId } :
        { paymentSessionId: order.paymentSessionId }, status: 'created' };
    await db.runTransaction(async tx => {
      tx.set(idemRef, { state: 'created', response, providerOrderId: order.orderId, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
      tx.create(db.doc('paymentOrders/' + req.tenant.id + '_' + provider + '_' + order.orderId), {
        tenantId: req.tenant.id, provider, environment: 'test', amountMinor, currency: 'INR',
        state: 'created', createdAt: FieldValue.serverTimestamp()
      });
    });
    return res.status(201).json(response);
  } catch {
    await idemRef.set({ state: 'unknown', updatedAt: FieldValue.serverTimestamp() }, { merge: true }).catch(() => {});
    return fail(res, 503, 'order_creation_unknown_reconcile_before_retry');
  }
});

app.post('/v1/webhooks/:provider/:tenantId/:environment', express.raw({ type: 'application/json', limit: '1mb' }), async (req, res) => {
  const { provider, tenantId, environment } = req.params;
  if (!['razorpay', 'cashfree'].includes(provider) || !tenantIdPattern.test(tenantId || '') ||
      !['test', 'live'].includes(environment) || !Buffer.isBuffer(req.body)) {
    return fail(res, 400, 'invalid_webhook_request');
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
    const paymentEntity = provider === 'razorpay'
      ? event?.payload?.payment?.entity
      : event?.data?.payment;
    const providerOrderId = provider === 'razorpay' ? paymentEntity?.order_id : event?.data?.order?.order_id;
    const paymentId = provider === 'razorpay' ? paymentEntity?.id : paymentEntity?.cf_payment_id;
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
    const verified = sameOrder && samePayment && sameCurrency && sameAmount && status.captured === true &&
      (provider === 'razorpay'
        ? status.paymentStatus === 'captured'
        : status.paymentStatus === 'SUCCESS');
    const eventId = provider === 'razorpay'
      ? req.get('x-razorpay-event-id')
      : req.get('x-webhook-id') || crypto.createHash('sha256').update(req.body).digest('hex');
    if (typeof eventId !== 'string' || !webhookEventIdPattern.test(eventId)) return fail(res, 400, 'invalid_event_id');
    const inboxId = crypto.createHash('sha256').update(tenantId + ':' + provider + ':' + environment + ':' + eventId).digest('hex');
    const inbox = db.doc('paymentWebhookInbox/' + inboxId);
    await db.runTransaction(async tx => {
      const [seen, currentOrder] = await Promise.all([tx.get(inbox), tx.get(orderRef)]);
      if (seen.exists) return;
      if (!currentOrder.exists || currentOrder.data().tenantId !== tenantId ||
          currentOrder.data().provider !== provider || currentOrder.data().environment !== environment) {
        throw new Error('payment_order_binding_changed');
      }
      tx.create(inbox, {
        eventId, tenantId, provider, environment, paymentId, providerOrderId,
        signatureVerified: true, providerFetchVerified: verified,
        receivedAt: FieldValue.serverTimestamp()
      });
      if (verified) tx.set(orderRef, {
        state: 'captured_verified', paymentId, verifiedAt: FieldValue.serverTimestamp()
      }, { merge: true });
      if (verified && currentOrder.data().intentId) {
        const intentRef = db.doc('paymentIntents/' + currentOrder.data().intentId);
        tx.set(intentRef, {
          providerPaymentId: paymentId,
          providerVerifiedStatus: 'CAPTURED',
          providerVerifiedAt: FieldValue.serverTimestamp()
        }, { merge: true });
      }
      if (verified) tx.set(providerTenantDoc(tenantId, provider, environment), {
        ...(environment === 'test' ? { sandboxTestPassed: true } : {}),
        webhookVerified: true, active: false, lastVerifiedWebhookAt: FieldValue.serverTimestamp()
      }, { merge: true });
    });

    return res.status(200).json({ received: true, verified });
  } catch {
    return fail(res, 503, 'webhook_processing_unavailable');
  }
});
app.post('/v1/admin/providers/:provider/activate', requireTenantAdmin, express.json({ limit: '2kb', strict: true }), async (req, res) => {
  const { provider } = req.params, environment = envOf(req);
  if (!['razorpay', 'cashfree'].includes(provider) || !environment || req.body?.confirm !== true) {
    return fail(res, 400, 'explicit_activation_confirmation_required');
  }
  const ref = providerTenantDoc(req.tenant.id, provider, environment);
  const snap = await ref.get(), state = snap.exists ? snap.data() : {};
  if (state.credentialsValidated !== true ||
      (environment === 'test' && (state.sandboxTestPassed !== true || state.webhookVerified !== true))) {
    return fail(res, 409, 'provider_onboarding_checks_incomplete');
  }
  if (environment === 'live') {
    const sandbox = await providerTenantDoc(req.tenant.id, provider, 'test').get();
    if (!sandbox.exists || sandbox.data().sandboxTestPassed !== true || sandbox.data().webhookVerified !== true) {
      return fail(res, 409, 'sandbox_acceptance_required');
    }
    if (state.webhookVerified !== true) return fail(res, 409, 'live_webhook_verification_required');
  }
  await ref.set({ active: true, activatedAt: FieldValue.serverTimestamp(), activatedBy: req.actor.uid }, { merge: true });
  return res.json({ active: true, provider, environment });
});
app.use((err, _req, res, _next) => {
  // Deliberately do not log request bodies, tokens, provider responses or secrets.
  const status = err?.type === 'entity.too.large' ? 413 : 400;
  res.status(status).json({ error: status === 413 ? 'request_too_large' : 'invalid_request' });
});
app.listen(Number(process.env.PORT || 8080), '0.0.0.0');
