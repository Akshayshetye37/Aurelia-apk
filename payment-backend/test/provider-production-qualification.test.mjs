import test from 'node:test';
import assert from 'node:assert/strict';
import {
  REQUIRED_PROVIDER_RELEASE_EVIDENCE,
  evaluateProviderProductionQualification
} from '../src/payment-controls/provider-production-qualification.mjs';

const now = new Date('2026-11-08T12:00:00.000Z');
function approved(provider = 'razorpay') {
  const evidence = Object.fromEntries(REQUIRED_PROVIDER_RELEASE_EVIDENCE.map(key => [key, {
    status: 'PASSED',
    evidenceRef: 'audit://qualification/' + key,
    verifiedBy: 'independent-reviewer',
    verifiedAt: new Date('2026-11-07T12:00:00.000Z'),
    expiresAt: new Date('2026-12-08T12:00:00.000Z')
  }]));
  return {
    schemaVersion: 1, provider, environment: 'production', status: 'APPROVED',
    approvedByOwner: true, approvedBy: 'property-owner',
    approvedAt: new Date('2026-11-07T12:00:00.000Z'),
    expiresAt: new Date('2026-12-08T12:00:00.000Z'), evidence
  };
}

test('all six implemented providers can qualify only with every current evidence item', () => {
  for (const provider of ['razorpay', 'cashfree', 'payu', 'phonepe', 'paytm', 'jiopay']) {
    assert.equal(evaluateProviderProductionQualification({ provider, record: approved(provider), now }).ready, true);
  }
});

test('catalog-only and unknown providers can never qualify', () => {
  assert.equal(evaluateProviderProductionQualification({ provider: 'ccavenue', record: approved('ccavenue'), now }).reason,
    'provider_not_implemented');
  assert.equal(evaluateProviderProductionQualification({ provider: 'unknown', record: approved('unknown'), now }).ready, false);
});

test('missing, unapproved, wrong-environment and mismatched provider records fail closed', () => {
  assert.equal(evaluateProviderProductionQualification({ provider: 'razorpay', record: null, now }).ready, false);
  for (const patch of [
    { status: 'PENDING' }, { approvedByOwner: false }, { environment: 'test' }, { provider: 'cashfree' }
  ]) {
    assert.equal(evaluateProviderProductionQualification({
      provider: 'razorpay', record: { ...approved(), ...patch }, now
    }).ready, false);
  }
});

test('any missing or failed qualification evidence blocks production', () => {
  for (const key of REQUIRED_PROVIDER_RELEASE_EVIDENCE) {
    const record = approved();
    delete record.evidence[key];
    assert.equal(evaluateProviderProductionQualification({ provider: 'razorpay', record, now }).ready, false, key);
  }
  const failed = approved();
  failed.evidence.merchant_uat.status = 'FAILED';
  assert.equal(evaluateProviderProductionQualification({ provider: 'razorpay', record: failed, now }).ready, false);
});

test('expired evidence, future verification and expired owner approval fail closed', () => {
  const expiredEvidence = approved();
  expiredEvidence.evidence.merchant_uat.expiresAt = new Date('2026-11-08T11:59:59.000Z');
  assert.equal(evaluateProviderProductionQualification({ provider: 'razorpay', record: expiredEvidence, now }).ready, false);

  const futureEvidence = approved();
  futureEvidence.evidence.merchant_uat.verifiedAt = new Date('2026-11-08T12:00:01.000Z');
  assert.equal(evaluateProviderProductionQualification({ provider: 'razorpay', record: futureEvidence, now }).ready, false);

  const expiredApproval = approved();
  expiredApproval.expiresAt = new Date('2026-11-08T11:59:59.000Z');
  assert.equal(evaluateProviderProductionQualification({ provider: 'razorpay', record: expiredApproval, now }).ready, false);
});

test('malformed evidence references and identities are rejected', () => {
  const record = approved();
  record.evidence.refund_lifecycle_uat.evidenceRef = 'x';
  assert.equal(evaluateProviderProductionQualification({ provider: 'razorpay', record, now }).ready, false);
  const missingReviewer = approved();
  missingReviewer.evidence.android_physical_device_acceptance.verifiedBy = '';
  assert.equal(evaluateProviderProductionQualification({ provider: 'razorpay', record: missingReviewer, now }).ready, false);
});
