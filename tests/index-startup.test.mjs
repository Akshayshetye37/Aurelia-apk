import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';

const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');

test('classic inline application scripts parse without syntax errors', () => {
  const scripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)]
    .filter(([, attributes]) => !/\bsrc\s*=/.test(attributes) && !/\btype\s*=\s*["']module["']/i.test(attributes));
  assert.ok(scripts.length > 0, 'expected inline application scripts');
  for (const [index, match] of scripts.entries()) {
    const [, attributes, source] = match;
    if (!source.trim()) continue;
    const id = attributes.match(/\bid\s*=\s*["']([^"']+)/i)?.[1] || `inline-script-${index + 1}`;
    assert.doesNotThrow(() => new vm.Script(source, { filename: `index.html#${id}` }), id);
  }
});

test('recovery guards are hoisted and status is initialized before startup recovery executes', () => {
  const guard = html.indexOf('var RECOVERY_CHECK_PENDING=false');
  assert.notEqual(guard, -1, 'recovery guard must be initialized before use');
  assert.equal(html.indexOf('RECOVERY_CHECK_PENDING'), guard + 'var '.length,
    'first recovery-guard occurrence must be its declaration, not an early read');
  const strictPersist = html.indexOf('function persistStrict(){');
  const status = html.indexOf("\nlet LOCAL_STATE_STATUS='missing';", strictPersist);
  const load = html.indexOf('function loadAll()', strictPersist);
  assert.ok(strictPersist >= 0 && status > strictPersist && load > status,
    'local state status must be initialized before loadAll executes');
});

test('empty booking and dining inventories cannot abort startup on sample-data mutations', () => {
  for (const expression of [
    'if(S.b[1])S.b[1].p=1000;',
    'if(S.t[2])S.t[2].demo=1;',
    "if(S.b[1])S.b[1].pays=[{a:1000,m:'Cash',r:'',at:new Date().toISOString()}];",
    "if(S.t[2])S.t[2].o=[];"
  ]) assert.ok(html.includes(expression), `missing empty-state guard: ${expression}`);
  const unsafe = [...html.matchAll(/S\\.(?:b|t)\\[\\d+\\]\\.[\\w$]+/g)]
    .filter(match => !html.slice(Math.max(0, match.index - 12), match.index).endsWith('if('));
  assert.equal(unsafe.length, 0, 'no unguarded fixed-index booking or table mutations may remain');
  const firstScript = [...html.matchAll(/<script\\b[^>]*>([\\s\\S]*?)<\\/script>/gi)][0]?.[1] || '';
  assert.ok(firstScript.indexOf('if(S.b[1])S.b[1].p=1000;') < firstScript.indexOf('const SUB={'),
    'guarded optional demo mutation must execute before SUB is declared');
});

test('room-type catalogue is derived from persisted inventory and refreshed before rendering', () => {
  assert.match(html, /const types=\[\];\s*function syncRoomTypes\(\)/);
  assert.match(html, /types\.splice\(0,types\.length,\.\.\.byType\.values\(\)\)/);
  assert.match(html, /syncRoomTypes\(\);syncT\(\);_r3\(\)/);
  assert.match(html, /function avail\(\)\{syncRoomTypes\(\)/);
  assert.match(html, /const rform=\(r,i\)=>\{syncRoomTypes\(\);return/);
});

test('all network endpoints use HTTPS; remaining HTTP URIs are XML namespace identifiers only', () => {
  const insecure = [...html.matchAll(/http:\/\/[^\s"'\x60<>)]*/g)];
  for (const match of insecure) {
    const before = html.slice(Math.max(0, match.index - 24), match.index);
    assert.match(before, /xmlns=["']$/,
      `non-HTTPS URL found at line ${html.slice(0, match.index).split('\n').length}: ${match[0]}`);
  }
});
