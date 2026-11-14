import test from 'node:test';
import assert from 'node:assert/strict';
import {
  PROVIDER_TEST_ENVIRONMENTS, requiredAcceptanceCases, evaluateProviderAcceptance
} from '../src/qualification/provider-acceptance.mjs';

const capabilities = ['validateCredentials','createOrder','findOrderByReference','getPaymentStatus',
  'verifyWebhook','createRefund','getRefundStatus'];
const now = new Date('2026-11-08T12:00:00.000Z');

function evidenceFor(providerId) {
  const environment = PROVIDER_TEST_ENVIRONMENTS[providerId];
  return requiredAcceptanceCases(providerId).map((caseId, index) => ({
    caseId, providerId, environment, result: 'passed',
    runId: 'uat-run-' + providerId + '-' + index,
    merchantAccountRef: 'merchant-ref-' + providerId,
    transactionRef: 'txn-' + providerId + '-' + index,
    evidenceRef: 'https://evidence.example.test/' + providerId + '/' + caseId,
    executedAt: '2026-11-08T11:00:00.000Z'
  }));
}

test('acceptance matrix covers exactly the seven configured providers and correct test environments', () => {
  assert.deepEqual(Object.keys(PROVIDER_TEST_ENVIRONMENTS),
    ['razorpay','cashfree','payu','phonepe','paytm','jiopay','ccavenue']);
  assert.equal(PROVIDER_TEST_ENVIRONMENTS.paytm, 'staging');
  assert.equal(PROVIDER_TEST_ENVIRONMENTS.jiopay, 'uat');
  for (const providerId of Object.keys(PROVIDER_TEST_ENVIRONMENTS)) {
    assert.ok(requiredAcceptanceCases(providerId).includes('payment.success_authoritative'));
    assert.ok(requiredAcceptanceCases(providerId).includes('refund.status_authoritative'));
  }
});

test('complete six-provider merchant evidence can pass but never authorizes live collection', () => {
  for (const providerId of ['razorpay','cashfree','payu','phonepe','paytm','jiopay']) {
    const result = evaluateProviderAcceptance({
      providerId, environment: PROVIDER_TEST_ENVIRONMENTS[providerId],
      evidence: evidenceFor(providerId), capabilities, now
    });
    assert.equal(result.status, 'ACCEPTED', providerId);
    assert.equal(result.liveCollectionAuthorized, false);
  }
});

test('CCAvenue remains blocked until complete ordinary refund lifecycle exists', () => {
  const result = evaluateProviderAcceptance({
    providerId: 'ccavenue', environment: 'test', evidence: evidenceFor('ccavenue'),
    capabilities: ['validateCredentials','createOrder','findOrderByReference','getPaymentStatus','verifyWebhook'], now
  });
  assert.equal(result.status, 'BLOCKED');
  assert.ok(result.blockers.includes('complete_refund_lifecycle_not_implemented'));
  assert.ok(result.blockers.includes('missing_capability:createRefund'));
  assert.ok(result.blockers.includes('missing_capability:getRefundStatus'));
});

test('missing, duplicate, failed, stale and malformed evidence all fail closed', () => {
  const baseline = evidenceFor('razorpay');
  const cases = [
    baseline.slice(1),
    [...baseline, baseline[0]],
    baseline.map((item, i) => i === 0 ? { ...item, result: 'failed' } : item),
    baseline.map((item, i) => i === 0 ? { ...item, executedAt: '2026-01-01T00:00:00.000Z' } : item),
    baseline.map((item, i) => i === 0 ? { ...item, evidenceRef: 'http://evidence.example.test/x' } : item),
    baseline.map((item, i) => i === 0 ? { ...item, transactionRef: '' } : item)
  ];
  for (const evidence of cases) {
    const result = evaluateProviderAcceptance({
      providerId: 'razorpay', environment: 'test', evidence, capabilities, now
    });
    assert.equal(result.status, 'BLOCKED');
  }
});

test('wrong provider environment and unknown provider fail closed', () => {
  const wrongEnvironment = evaluateProviderAcceptance({
    providerId: 'paytm', environment: 'test', evidence: evidenceFor('paytm'), capabilities, now
  });
  assert.equal(wrongEnvironment.status, 'BLOCKED');
  assert.ok(wrongEnvironment.blockers.includes('wrong_test_environment'));
  assert.equal(evaluateProviderAcceptance({
    providerId: 'unknown', environment: 'test', evidence: [], capabilities, now
  }).status, 'REJECTED');
});
