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
  assert.ok(html.includes("This is an embedded HTML preview, not the Aurelia app runtime."));
  assert.ok(html.includes("frame or sandbox blocks durable storage"));
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
  const roomHydrationAt = html.indexOf('await hydrateDomainRead(canonicalAudit.data.snapshot)');
  const canonicalHydrationAt = html.indexOf('window.__AURELIA_CANONICAL_BOOTSTRAP_RAW = JSON.stringify(hydrated)');
  const replayAt = html.indexOf('await replayApplicationScripts()');
  assert.ok(bootstrapAt >= 0 && roomHydrationAt > bootstrapAt && canonicalHydrationAt > roomHydrationAt && replayAt > canonicalHydrationAt);
  assert.match(html, /import\("\.\/src\/storage\/pms-room-read-cutover\.mjs"\)/);
  assert.match(html, /function loadAll\(\)\{\s*let raw=window\.__AURELIA_CANONICAL_BOOTSTRAP_RAW\|\|null;\s*if\(!raw\)\{try\{raw=/);
});

test('active room management commands use canonical room mutations', async () => {
  const fs = await import("node:fs");
  const html = fs.readFileSync(new URL("../index.html", import.meta.url), "utf8");
  const rsStart = html.indexOf('async function rs(n,s)');
  const rsEnd = html.indexOf('\nfunction tg(', rsStart);
  assert.ok(rsStart >= 0 && rsEnd > rsStart, 'room status command must exist');
  assert.match(html.slice(rsStart, rsEnd), /await commitRoomStatusMutation\(/);
  const roomSaveStart = html.indexOf('async function roomSave(');
  const roomSaveEnd = html.indexOf('\nfunction roomS(', roomSaveStart);
  assert.ok(roomSaveStart >= 0 && roomSaveEnd > roomSaveStart);
  assert.match(html.slice(roomSaveStart, roomSaveEnd), /commitRoomCatalogState\(/);
  const activeRoomS = html.lastIndexOf('function roomS(');
  const activeRoomEnd = html.indexOf('\nasync function rdel(', activeRoomS);
  assert.ok(activeRoomS >= 0 && activeRoomEnd > activeRoomS);
  assert.match(html.slice(activeRoomS, activeRoomEnd), /rs\('\$\{r\.n\}','\$\{k\}'\)/);
  assert.doesNotMatch(html.slice(activeRoomS, activeRoomEnd), /\.s='\$\{k\}'/);
  assert.match(html.slice(activeRoomEnd), /commitRoomCatalogState\(\{roomId:r\.n,operation:'remove'/);
});

test('fresh Android installations are not misclassified as failed recovery', async () => {
  const fs = await import("node:fs");
  const html = fs.readFileSync(new URL("../index.html", import.meta.url), "utf8");
  assert.match(html, /RECOVERY_CHECK_PENDING=!!window\.AureliaNative&&LOCAL_STATE_STATUS==='invalid'/);
});

test('room-domain bootstrap hydrates the UI from canonical room entities before script replay', async () => {
  const fs = await import("node:fs");
  const html = fs.readFileSync(new URL("../index.html", import.meta.url), "utf8");
  const loaderAt = html.indexOf('id="aurelia-async-runtime-bootstrap"');
  const loader = html.slice(loaderAt, html.indexOf("</script>", loaderAt));
  assert.match(loader, /hydrateCanonicalRoomSnapshot/);
  assert.match(loader, /hydrateCanonicalGuestSnapshot/);
  assert.match(loader, /await hydrateDomainRead\(canonicalAudit\.data\.snapshot\)/);
  assert.ok(loader.indexOf("hydrateDomainRead(canonicalAudit.data.snapshot)") < loader.indexOf("await replayApplicationScripts()"));
});

test('guest profile removal uses a canonical retirement transaction', async () => {
  const fs = await import("node:fs");
  const html = fs.readFileSync(new URL("../index.html", import.meta.url), "utf8");
  const start = html.indexOf('async function gdel(i)');
  const end = html.indexOf('\nconst _inv=', start);
  assert.ok(start >= 0 && end > start);
  const body = html.slice(start, end);
  assert.match(body, /operation:'retire'/);
  assert.match(body, /await commitGuestCatalogState\(/);
  assert.match(body, /expectedPreviousGuest:cloneRuntimeState\(g\)/);
  assert.doesNotMatch(body, /S\.g\.splice\(i,1\);aud\(/);
});
