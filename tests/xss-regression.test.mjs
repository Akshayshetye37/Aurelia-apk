import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');

test('reviewed HTML injection sinks do not grow without a deliberate security review', () => {
  const count = pattern => [...html.matchAll(pattern)].length;
  assert.ok(count(/\.innerHTML\s*=/g) <= 43, 'innerHTML assignment inventory increased');
  assert.ok(count(/\.insertAdjacentHTML\s*\(/g) <= 7, 'insertAdjacentHTML inventory increased');
  assert.ok(count(/document\.write\s*\(/g) <= 2, 'document.write inventory increased');
  assert.equal(count(/\beval\s*\(/g), 0);
  assert.equal(count(/\bnew\s+Function\s*\(/g), 0);
  assert.equal(count(/\b(?:setTimeout|setInterval)\s*\(\s*(['"`])/g), 0);
  assert.equal(count(/javascript\s*:/gi), 0);
});

test('the shared HTML escaper encodes hostile guest-controlled markup', () => {
  const match = html.match(/^const esc=.*$/m);
  assert.ok(match, 'shared HTML escaper is present');
  const escapeHtml = new Function(match[0] + '\nreturn esc;')();
  const hostile = `"><img src=x onerror=alert(1)>&'`;
  assert.equal(escapeHtml(hostile), '&quot;&gt;&lt;img src=x onerror=alert(1)&gt;&amp;\'');
});

test('Gitleaks allowlists are scoped to reviewed synthetic fixture lines', async () => {
  const config = await readFile(new URL('../.gitleaks.toml', import.meta.url), 'utf8');
  assert.match(config, /useDefault = true/);
  assert.match(config, /condition = "AND"/);
  assert.match(config, /regexTarget = "line"/);
  assert.match(config, /payment-backend\/test/);
  assert.ok(config.includes('payment-backend/\\.env\\.example'));
  assert.match(config, /stopwords = \[\"replace\", \"your\"\]/);
  assert.doesNotMatch(config, /paths = \[.*\*\*.*\]/s);
});

test('secret scanning checks the complete reachable Git history', async () => {
  const workflow = await readFile(new URL('../.github/workflows/secret-scan.yml', import.meta.url), 'utf8');
  assert.match(workflow, /fetch-depth:\s*0/);
  assert.match(workflow, /gitleaks\/gitleaks-action@e0c47f4f8be36e29cdc102c57e68cb5cbf0e8d1e/);
  assert.match(workflow, /persist-credentials:\s*false/);
  assert.match(workflow, /gitleaks detect --source \. --redact --verbose --exit-code 2 --log-opts='--all'/);
});
