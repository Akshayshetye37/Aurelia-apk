import test from 'node:test';
import assert from 'node:assert/strict';
import { secureRandomId } from '../src/aurelia-upi/security.mjs';
import { readFile } from 'node:fs/promises';

const read = path => readFile(new URL('../' + path, import.meta.url), 'utf8');

test('financial identifiers require a cryptographically secure random source', () => {
  const ids = new Set(Array.from({ length: 1000 }, () => secureRandomId('test')));
  assert.equal(ids.size, 1000);
  for (const id of ids) assert.match(id, /^test_[0-9a-f-]{36}$/i);
  assert.throws(() => secureRandomId('test', null), /secure random source is unavailable/i);
});

test('Aurelia UPI IDs never fall back to Math.random or timestamps', async () => {
  const domain = await read('src/aurelia-upi/domain.mjs');
  const repository = await read('src/aurelia-upi/repository.mjs');
  const app = await read('src/aurelia-upi/app.mjs');
  for (const source of [domain, repository, app]) {
    assert.doesNotMatch(source, /Math\\.random\\s*\\(/);
    assert.doesNotMatch(source, /Date\\.now\\(\\)\\s*\\+\\s*['"]_['"]/);
  }
  assert.match(domain, /secureRandomId/);
  assert.match(repository, /secureRandomId/);
  assert.match(app, /secureRandomId/);
});

test('financial audit writes are awaited before being reported as durable', async () => {
  const app = await read('src/aurelia-upi/app.mjs');
  const audit = app.slice(app.indexOf('async function audit'), app.indexOf('async function refreshData'));
  assert.match(audit, /await repository\\.saveAudit/);
  assert.ok(audit.indexOf('await repository.saveAudit') < audit.indexOf('state.audit.unshift'));
  const calls = app.split('\\n').filter(line => /\\baudit\\(/.test(line) && !/function audit/.test(line));
  assert.ok(calls.length >= 10);
  for (const call of calls) assert.match(call, /await audit\\(/);
});

test('payment and refund references are claimed atomically by the encrypted native database', async () => {
  const schema = await read('android/templates/LocalPmsRepository.java');
  const plugin = await read('android/templates/CapacitorPmsStoragePlugin.java');
  const repository = await read('src/aurelia-upi/repository.mjs');
  const app = await read('src/aurelia-upi/app.mjs');
  assert.match(schema, /VERSION\\s*=\\s*9/);
  assert.match(schema, /aurelia_upi_reference_claims\\(reference TEXT PRIMARY KEY NOT NULL/);
  assert.match(schema, /UNIQUE\\(reference_type,entity_id\\)/);
  assert.match(schema, /claimUpiReference/);
  assert.match(plugin, /@PluginMethod public void claimUpiReference/);
  assert.match(repository, /claimReference/);
  assert.match(app, /A bank UTR\\/reference is required/);
  assert.match(app, /await repository\\.claimReference\\(utr, "PAYMENT"/);
  assert.match(app, /await repository\\.claimReference\\(transferReference, "REFUND"/);
});
