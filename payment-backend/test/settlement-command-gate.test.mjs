import test from 'node:test';
import assert from 'node:assert/strict';
import { mayIssueSettlementCommand } from '../src/webhooks/settlement-command-gate.mjs';

const enabledControls = () => ({
  schemaVersion: 1,
  emergency_stop: false,
  manual_posting: false,
  test_collection: true,
  live_collection: true,
  live_collection_enabled: true,
  automatic_settlement: true,
  native_settlement_bridge: true,
  refund_processing: false,
  updatedAt: new Date('2026-11-08T00:00:00.000Z'),
  updatedBy: 'independent-owner'
});

const evaluate = overrides => mayIssueSettlementCommand({
  controlExists: true,
  controlData: enabledControls(),
  publicEnvironment: 'test',
  settlementIssuerEnabled: true,
  ...overrides
});

test('settlement command requires all server-side release gates', () => {
  assert.equal(evaluate({}), true);
  assert.equal(evaluate({ settlementIssuerEnabled: false }), false);
  assert.equal(evaluate({ controlExists: false }), false);
  assert.equal(evaluate({ publicEnvironment: 'unknown' }), false);
  assert.equal(evaluate({ controlData: { ...enabledControls(), emergency_stop: true } }), false);
  assert.equal(evaluate({ controlData: { ...enabledControls(), test_collection: false } }), false);
  assert.equal(evaluate({ controlData: { ...enabledControls(), automatic_settlement: false } }), false);
  assert.equal(evaluate({ controlData: { ...enabledControls(), native_settlement_bridge: false } }), false);
});

test('live collection uses the live gate and cannot inherit test authorisation', () => {
  const controls = { ...enabledControls(), live_collection: false, live_collection_enabled: false };
  assert.equal(evaluate({ controlData: controls, publicEnvironment: 'live' }), false);
  assert.equal(evaluate({ publicEnvironment: 'live' }), true);
});

test('malformed or incomplete control records fail closed', () => {
  assert.equal(evaluate({ controlData: { ...enabledControls(), updatedBy: '' } }), false);
  assert.equal(evaluate({ controlData: null }), false);
});
