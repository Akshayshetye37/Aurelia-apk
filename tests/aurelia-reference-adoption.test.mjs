import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const root = new URL('../', import.meta.url);
const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
const css = await readFile(new URL('../assets/aurelia-reference-adoption.css', import.meta.url), 'utf8');
const runtime = await readFile(new URL('../assets/aurelia-reference-adoption.js', import.meta.url), 'utf8');

test('reference adoption loads local design assets without external font or chart dependencies', () => {
  assert.match(html, /aurelia-reference-adoption\.css/);
  assert.match(html, /aurelia-reference-adoption\.js/);
  assert.doesNotMatch(css, /fonts\.googleapis\.com|fonts\.gstatic\.com|cdn\.jsdelivr\.net/);
});

test('desktop navigation exposes all existing PMS modules in the reference information architecture', () => {
  for (const key of ['home', 'rooms', 'stays', 'dining', 'upi', 'guests', 'hk', 'inv', 'exp', 'rep', 'aud', 'io', 'set']) {
    assert.ok(runtime.includes("'" + key + "'") || runtime.includes('"' + key + '"'), 'missing navigation key: ' + key);
  }
  assert.match(runtime, /Front Desk/);
  assert.match(runtime, /Operations/);
  assert.match(runtime, /Governance/);
});

test('secondary navigation delegates to the existing More subview state instead of replacing the PMS router', () => {
  assert.match(runtime, /S\.tab\s*=\s*['"]more['"]/);
  assert.match(runtime, /S\.sub\s*=\s*key/);
  assert.match(runtime, /typeof render\s*===\s*['"]function['"]/);
  assert.doesNotMatch(runtime, /localStorage\.setItem|STORAGE_KEY|function persist/);
});

test('desktop and mobile navigation are responsive, accessible and keep the six-item dock', () => {
  assert.match(css, /@media\s*\(max-width:\s*900px\)/);
  assert.match(css, /\.aurelia-reference-sidebar/);
  assert.match(css, /:focus-visible/);
  assert.match(css, /prefers-reduced-motion/);
  assert.match(runtime, /mobile-dock|dock/);
  assert.match(runtime, /aria-current/);
});

test('new reservation action delegates to the existing reservation function', () => {
  assert.match(runtime, /typeof resv\s*===\s*['"]function['"]/);
  assert.match(runtime, /resv\(\)/);
});
