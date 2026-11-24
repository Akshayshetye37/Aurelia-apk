import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const html = fs.readFileSync('index.html', 'utf8');

test('HTML sink inventory does not regress beyond the reviewed baseline', () => {
  const count = pattern => (html.match(pattern) || []).length;
  assert.ok(count(/\.innerHTML\s*=/g) <= 43, 'new innerHTML assignment added');
  assert.ok(count(/\.insertAdjacentHTML\s*\(/g) <= 7, 'new insertAdjacentHTML call added');
  assert.ok(count(/document\.write\s*\(/g) <= 2, 'new document.write call added');
  assert.ok(count(/\son[a-z]+\s*=/gi) <= 280, 'new inline event handler added');
  assert.equal(count(/\beval\s*\(/g), 0, 'eval() is prohibited');
  assert.equal(count(/\bnew\s+Function\s*\(/g), 0, 'new Function() is prohibited');
  assert.equal(count(/setTimeout\s*\(\s*['"`]/g), 0, 'string-based setTimeout is prohibited');
  assert.equal(count(/javascript\s*:/gi), 0, 'javascript: URLs are prohibited');
});

test('shared HTML escaper encodes an attacker-controlled guest name payload', () => {
  const match = html.match(/const esc\s*=\s*(s=>String\(s\)\.replace\([\s\S]*?\);)/);
  assert.ok(match, 'shared esc helper must remain present');
  const esc = vm.runInNewContext(`(${match[1]})`);
  const payload = '\"><img src=x onerror=alert(1)>';
  const escaped = esc(payload);
  assert.equal(escaped, '&quot;&gt;&lt;img src=x onerror=alert(1)&gt;');
  assert.doesNotMatch(escaped, /<\s*img/i);
});
