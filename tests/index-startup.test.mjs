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
  assert.ok(!html.includes(';S.b[1].p=1000;'), 'no unguarded booking payment mutation');
  assert.ok(!html.includes(';S.b[1].pays='), 'no unguarded booking payment history mutation');
  assert.ok(!html.includes(';S.t[2].demo='), 'no unguarded table demo mutation');
  assert.ok(!html.includes(';S.t[2].o='), 'no unguarded table order mutation');
  assert.ok(html.indexOf('if(S.b[1])S.b[1].p=1000;') < html.indexOf('const SUB={'),
    'guarded optional demo mutation must execute before SUB is declared');
});

test('sandboxed CodeShack preview is identified as session-only, never reported as durable storage', () => {
  assert.ok(html.includes("String(location.href).startsWith('about:srcdoc')"));
  assert.ok(html.includes("mode: ok ? 'browser-local-storage' : 'session-memory-only'"));
  assert.ok(html.includes("embedded-preview-sandbox"));
  assert.ok(html.includes("PREVIEW ONLY: CodeShack embeds this app in a sandbox that blocks persistent storage"));
  assert.ok(html.includes('if(store.memoryOnly)throw new Error(window.AureliaStorageDiagnostics?.reason'));
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

test('ordinary PMS persistence is canonical-first and has no localStorage fallback', () => {
  assert.match(html, /import \{ PmsLocalFirstWriteCoordinator \} from "\.\/src\/storage\/pms-local-first-write-coordinator\.mjs"/);
  assert.match(html, /new PmsLocalFirstWriteCoordinator\(/);
  const persistStart = html.indexOf('function persist(){');
  const persistEnd = html.indexOf('\nfunction persistStrict(){', persistStart);
  assert.ok(persistStart >= 0 && persistEnd > persistStart, 'ordinary persist() function must exist');
  const persistBody = html.slice(persistStart, persistEnd);
  assert.match(persistBody, /coordinator\.save\(snapshot\)/);
  assert.match(persistBody, /AureliaLocalOperationalLock/);
  assert.doesNotMatch(persistBody, /localStorage|setItem\(|AureliaRepositoryCompatibility\.persist/);
  assert.match(persistBody, /RECOVERY_CHECK_PENDING=true/);
  const strictStart = html.indexOf('async function persistCanonicalStrict(){');
  const strictEnd = html.indexOf('\nfunction cloneRuntimeState', strictStart);
  assert.ok(strictStart >= 0 && strictEnd > strictStart);
  assert.match(html.slice(strictStart, strictEnd), /coordinator\.save\(state\)/);
});

test('startup hydrates the UI projection from the verified canonical snapshot before script replay', () => {
  const bootstrapAt = html.indexOf('id="aurelia-async-runtime-bootstrap"');
  const canonicalHydrationAt = html.indexOf('window.__AURELIA_CANONICAL_BOOTSTRAP_RAW = JSON.stringify(canonicalAudit.data.snapshot)');
  const replayAt = html.indexOf('await replayApplicationScripts()');
  assert.ok(bootstrapAt >= 0 && canonicalHydrationAt > bootstrapAt && replayAt > canonicalHydrationAt);
  assert.match(html, /function loadAll\(\)\{\s*let raw=window\.__AURELIA_CANONICAL_BOOTSTRAP_RAW\|\|null;\s*if\(!raw\)\{try\{raw=/);
});
