/**
 * Seven-provider merchant acceptance evidence contract.
 *
 * This evaluates auditable sandbox evidence only. It never enables live
 * collection and never treats a mock/unit test as merchant UAT evidence.
 */
export const ACCEPTANCE_SCHEMA_VERSION = 1;

export const PROVIDER_TEST_ENVIRONMENTS = Object.freeze({
  razorpay: 'test',
  cashfree: 'test',
  payu: 'test',
  phonepe: 'test',
  paytm: 'staging',
  jiopay: 'uat',
  ccavenue: 'test'
});

const COMMON_CASES = Object.freeze([
  'credentials.validated',
  'checkout.order_created',
  'payment.success_authoritative',
  'payment.failure',
  'payment.cancelled',
  'payment.pending_recovery',
  'status.server_side_verification',
  'webhook.valid_authentication',
  'webhook.invalid_authentication_rejected',
  'webhook.duplicate_idempotent',
  'payment.amount_currency_binding',
  'payment.concurrent_duplicate_idempotency',
  'payment.timeout_reconciliation',
  'refund.created',
  'refund.status_authoritative',
  'refund.duplicate_idempotent',
  'refund.cumulative_amount_limit',
  'reconciliation.provider_reference_match',
  'recovery.provider_outage_and_restart'
]);

const PROVIDER_CASES = Object.freeze({
  razorpay: ['webhook.raw_body_signature'],
  cashfree: ['webhook.timestamp_signature'],
  payu: ['callback.reverse_hash'],
  phonepe: ['callback.authorization_header'],
  paytm: ['callback.checksum'],
  jiopay: ['request.hmac_signature'],
  ccavenue: [
    'checkout.encrypted_request',
    'callback.encrypted_response',
    'webhook.dynamic_event_is_trigger_only',
    'status.encrypted_order_status_api',
    'network.public_egress_ip_allowlisted'
  ]
});

const COMPLETE_LIFECYCLE = new Set([
  'razorpay', 'cashfree', 'payu', 'phonepe', 'paytm', 'jiopay'
]);

export function requiredAcceptanceCases(providerId) {
  if (!Object.hasOwn(PROVIDER_TEST_ENVIRONMENTS, providerId)) return null;
  return [...COMMON_CASES, ...PROVIDER_CASES[providerId]];
}

function validEvidenceRecord(record, providerId, environment, nowMs) {
  if (!record || typeof record !== 'object') return 'malformed_evidence';
  if (record.providerId !== providerId || record.environment !== environment) return 'provider_or_environment_mismatch';
  if (record.result !== 'passed') return 'test_not_passed';
  if (typeof record.runId !== 'string' || !/^[A-Za-z0-9._:-]{4,160}$/.test(record.runId)) return 'missing_run_id';
  if (typeof record.merchantAccountRef !== 'string' || !/^[A-Za-z0-9._:-]{3,120}$/.test(record.merchantAccountRef)) return 'missing_nonsecret_merchant_reference';
  if (typeof record.evidenceRef !== 'string') return 'missing_evidence_reference';
  try {
    const url = new URL(record.evidenceRef);
    if (url.protocol !== 'https:' || !url.hostname || url.username || url.password) return 'invalid_evidence_reference';
  } catch {
    return 'invalid_evidence_reference';
  }
  const executedAt = Date.parse(record.executedAt);
  if (!Number.isFinite(executedAt) || executedAt > nowMs || nowMs - executedAt > 90 * 24 * 60 * 60 * 1000) return 'evidence_timestamp_invalid_or_stale';
  if (typeof record.transactionRef !== 'string' || !/^[A-Za-z0-9._:-]{3,160}$/.test(record.transactionRef)) return 'missing_transaction_reference';
  return null;
}

/**
 * Evidence records are expected to be loaded from a trusted server-side
 * evidence store. Never pass browser-supplied evidence directly to this API.
 */
export function evaluateProviderAcceptance({
  providerId, environment, evidence, capabilities, now = new Date()
}) {
  const required = requiredAcceptanceCases(providerId);
  if (!required) return { status: 'REJECTED', accepted: false, reason: 'unknown_provider', missingCases: [], blockers: ['unknown_provider'] };
  const expectedEnvironment = PROVIDER_TEST_ENVIRONMENTS[providerId];
  const blockers = [];
  const missingCases = [];
  const invalidEvidence = [];
  if (environment !== expectedEnvironment) blockers.push('wrong_test_environment');
  if (!Array.isArray(evidence)) blockers.push('evidence_collection_missing');

  const byCase = new Map();
  for (const record of Array.isArray(evidence) ? evidence : []) {
    if (!record || typeof record.caseId !== 'string') {
      invalidEvidence.push({ caseId: null, reason: 'missing_case_id' });
      continue;
    }
    if (!byCase.has(record.caseId)) byCase.set(record.caseId, []);
    byCase.get(record.caseId).push(record);
  }

  const nowMs = now instanceof Date ? now.getTime() : Date.parse(now);
  for (const caseId of required) {
    const records = byCase.get(caseId) || [];
    if (records.length !== 1) {
      missingCases.push(caseId);
      if (records.length > 1) invalidEvidence.push({ caseId, reason: 'duplicate_evidence_record' });
      continue;
    }
    const reason = validEvidenceRecord(records[0], providerId, expectedEnvironment, nowMs);
    if (reason) invalidEvidence.push({ caseId, reason });
  }

  if (!COMPLETE_LIFECYCLE.has(providerId)) blockers.push('complete_refund_lifecycle_not_implemented');
  const requiredCapabilities = ['validateCredentials','createOrder','findOrderByReference','getPaymentStatus','verifyWebhook','createRefund','getRefundStatus'];
  for (const capability of requiredCapabilities) {
    if (!Array.isArray(capabilities) || !capabilities.includes(capability)) {
      blockers.push('missing_capability:' + capability);
    }
  }

  const accepted = blockers.length === 0 && missingCases.length === 0 && invalidEvidence.length === 0;
  return {
    schemaVersion: ACCEPTANCE_SCHEMA_VERSION,
    providerId,
    environment: expectedEnvironment,
    status: accepted ? 'ACCEPTED' : 'BLOCKED',
    accepted,
    liveCollectionAuthorized: false,
    requiredCaseCount: required.length,
    passedCaseCount: required.length - missingCases.length - invalidEvidence.length,
    missingCases,
    invalidEvidence,
    blockers: [...new Set(blockers)]
  };
}
