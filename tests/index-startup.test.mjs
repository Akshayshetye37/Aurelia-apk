import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import test from 'node:test';

const root = fileURLToPath(new URL('../', import.meta.url));
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

test('recovery state is initialized before any startup function can access it', () => {
  const declaration = html.indexOf("let LOCAL_STATE_STATUS='missing',RECOVERY_CHECK_PENDING=false");
  assert.notEqual(declaration, -1, 'recovery state declaration must exist');
  const firstUse = html.indexOf('RECOVERY_CHECK_PENDING');
  assert.equal(firstUse, declaration + "let LOCAL_STATE_STATUS='missing',".length,
    'first recovery-state occurrence must be its declaration, not an early read');
  assert.ok(declaration < html.indexOf('function persist()'));
  assert.ok(declaration < html.indexOf('function loadAll()'));
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
