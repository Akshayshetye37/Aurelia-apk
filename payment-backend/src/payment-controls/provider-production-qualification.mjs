const PROVIDERS = new Set(['razorpay', 'cashfree', 'payu', 'phonepe', 'paytm', 'jiopay']);
export const REQUIRED_PROVIDER_RELEASE_EVIDENCE = Object.freeze([
  'merchant_uat',
  'signed_webhook_verification',
  'provider_status_reconciliation',
  'refund_lifecycle_uat',
  'android_physical_device_acceptance',
  'canonical_pms_ledger_parity',
  'incident_response_and_alerting',
  'production_readiness_review'
]);

function asDate(value) {
  if (value instanceof Date) return value;
  if (value && typeof value.toDate === 'function') return value.toDate();
  return null;
}

function validEvidence(value, now, approvedBy, approvedAt) {
  if (!value || typeof value !== 'object' || value.status !== 'PASSED' ||
      typeof value.evidenceRef !== 'string' || value.evidenceRef.trim().length < 8 ||
      value.evidenceRef.length > 500 || /[\u0000-\u001f\u007f]/.test(value.evidenceRef) ||
      typeof value.verifiedBy !== 'string' || !value.verifiedBy.trim() || value.verifiedBy === approvedBy) return false;
  const verifiedAt = asDate(value.verifiedAt);
  const expiresAt = asDate(value.expiresAt);
  return verifiedAt instanceof Date && Number.isFinite(verifiedAt.getTime()) &&
    expiresAt instanceof Date && Number.isFinite(expiresAt.getTime()) &&
    verifiedAt.getTime() <= now && verifiedAt.getTime() <= approvedAt.getTime() && expiresAt.getTime() > now &&
    expiresAt.getTime() > verifiedAt.getTime();
}

/**
 * Production collection is an independently qualified capability, not a
 * mutable provider status string. Every required evidence item must be
 * current, attributable and backed by a durable reference.
 */
export function evaluateProviderProductionQualification({
  provider, record, now = new Date()
}) {
  if (!PROVIDERS.has(provider)) return { ready: false, reason: 'provider_not_implemented' };
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) {
    return { ready: false, reason: 'qualification_clock_invalid' };
  }
  if (!record || typeof record !== 'object' || Array.isArray(record) ||
      record.schemaVersion !== 1 || record.provider !== provider ||
      record.environment !== 'production' || record.status !== 'APPROVED' ||
      record.approvedByOwner !== true ||
      typeof record.approvedBy !== 'string' || !record.approvedBy.trim()) {
    return { ready: false, reason: 'provider_qualification_not_approved' };
  }
  const approvedAt = asDate(record.approvedAt);
  const expiresAt = asDate(record.expiresAt);
  if (!(approvedAt instanceof Date) || !Number.isFinite(approvedAt.getTime()) ||
      !(expiresAt instanceof Date) || !Number.isFinite(expiresAt.getTime()) ||
      approvedAt.getTime() > now.getTime() || expiresAt.getTime() <= now.getTime()) {
    return { ready: false, reason: 'provider_qualification_expired_or_invalid' };
  }
  const evidence = record.evidence;
  const missing = REQUIRED_PROVIDER_RELEASE_EVIDENCE.filter(key => !validEvidence(evidence?.[key], now.getTime(), record.approvedBy, approvedAt));
  if (missing.length) return { ready: false, reason: 'provider_qualification_evidence_incomplete', missing };
  return { ready: true, reason: null, qualifiedAt: approvedAt.toISOString(), expiresAt: expiresAt.toISOString() };
}
