import test from "node:test";import assert from "node:assert/strict";import {readFile} from "node:fs/promises";
const html=await readFile(new URL("../index.html",import.meta.url),"utf8"),prepare=await readFile(new URL("../scripts/prepare-web.js",import.meta.url),"utf8");
test("PMS UI scripts are deferred until canonical repository bootstrap completes",()=>{const bootstrap=html.indexOf('id="aurelia-async-runtime-bootstrap"');assert.ok(bootstrap>0);assert.ok(html.includes('type="application/x-aurelia-deferred"'));assert.ok(html.indexOf('id="aurelia-bootstrap-watchdog"')<bootstrap);assert.ok(html.includes('aurelia-runtime-shield'));assert.match(html,/await replayApplicationScripts\(\);[\s\S]*phase="READY"/)});
test("ordinary PMS persistence writes to canonical repository and verifies read-back",()=>{const start=html.indexOf("async function persist(){"),end=html.indexOf("\nlet LOCAL_STATE_STATUS=",start);assert.ok(start>=0&&end>start);const fn=html.slice(start,end);assert.match(fn,/window\.AureliaLocalFirstWrites/);assert.match(fn,/coordinator\.save\(snapshot\)/);assert.match(fn,/result\.committed!==true/);assert.doesNotMatch(fn,/localStorage|setItem\(SK/)});
test("PMS startup hydrates from canonical snapshot, not browser cache",()=>{const start=html.indexOf("function loadAll(){"),end=html.indexOf("\nfunction openGlobalSearch",start);assert.ok(start>=0&&end>start);const fn=html.slice(start,end);assert.match(fn,/window\.__AURELIA_CANONICAL_BOOTSTRAP_RAW/);assert.doesNotMatch(fn,/localStorage|__aureliaStorage/)});
test("device reset cannot erase only browser cache while leaving canonical records behind",()=>{const start=html.indexOf("function resetAll(){"),end=html.indexOf("/* backup engine */",start);assert.ok(start>=0&&end>start);const fn=html.slice(start,end);assert.match(fn,/Device reset is disabled/);assert.doesNotMatch(fn,/removeItem\(SK\)|localStorage/)});
test("manual UPI payment, check-in/out and dining folio commits await durable persistence",()=>{assert.match(html,/async function pay\(i\)/);assert.match(html,/async function completeCheckIn\(i\)/);assert.match(html,/async function completeCheckOut\(i\)/);assert.match(html,/async function confirmDiningRoomCharge\(id\)/);assert.match(html,/if\(!await persist\(\)\)/)});
test("stay extension waits for canonical commit before reporting success",()=>{const start=html.indexOf('id="aurelia-persistence-and-stay-extension"'),end=html.indexOf("</script>",start),block=html.slice(start,end);assert.match(block,/if\(!await persist\(\)\)/)});
test("UPI folio posting awaits the PMS commit and web build excludes gateway modules",()=>{assert.match(html,/if\(!await window\.pay\(id\)\)/);assert.match(html,/const guardedPay=async function/);assert.match(prepare,/src', 'storage/);assert.match(prepare,/src', 'folios/);assert.match(prepare,/src', 'bookings/);assert.doesNotMatch(prepare,/provider-platform|gateway|pay-bridge|webhooks/i)});

test("restaurant UPI posting awaits the durable snapshot commit",()=>{
 const start=html.indexOf("async function recordRestPay(){"),end=html.indexOf("/* Paid restaurant receipts",start);
 assert.ok(start>=0&&end>start);
 const record=html.slice(start,end);
 assert.match(record,/if\(!await persist\(\)\)/);
 assert.match(record,/restorePmsRuntimeState\(before,oldId\)/);
 const upiStart=html.indexOf("applyRestaurantPayment:async"),upiEnd=html.indexOf("},\n };",upiStart);
 const apply=html.slice(upiStart,upiEnd);
 assert.match(apply,/await window\.recordRestPay\(\)/);
});
test("render safety net persists any remaining legacy PMS mutation and skips unchanged snapshots",()=>{
 assert.match(html,/if\(window\.__AURELIA_RUNTIME_READY&&typeof window\.persist==='function'\)window\.persist\(\)/);
 assert.match(html,/snapshotJson===LAST_PMS_COMMITTED_SNAPSHOT/);
});

test("photo persistence has no localStorage or volatile-memory fallback",()=>{
 const start=html.indexOf("async function photoPut("),end=html.indexOf("function openOriginalPhoto(",start);
 assert.ok(start>=0&&end>start);
 const block=html.slice(start,end);
 assert.match(block,/AureliaPhotoArchive\.put/);
 assert.match(block,/AureliaPhotoArchive\.get/);
 assert.doesNotMatch(block,/localStorage|PHOTO_FALLBACK_PREFIX|PHOTO_MEMORY_FALLBACK/);
 assert.match(html,/await window\.AureliaPhotoArchive\.migrateLegacyPhotos\(\)/);
 const safe=html.slice(html.indexOf('id="aurelia-safe-storage"'),html.indexOf("</script>",html.indexOf('id="aurelia-safe-storage"')));
 assert.match(safe,/preferences\.setItem/);
 assert.doesNotMatch(safe,/localStorage/);
});

test("backup restore verifies the canonical snapshot instead of the preferences-only Web Storage adapter", () => {
 const start=html.indexOf("async function restoreGo(){"),end=html.indexOf("\nfunction clonePmsRuntimeState",start);
 assert.ok(start>=0&&end>start);
 const restore=html.slice(start,end);
 assert.match(restore,/AureliaRepositoryCompatibility\.readBack\(\)/);
 assert.match(restore,/readBack\?\.snapshot/);
 assert.doesNotMatch(restore,/localStorage|__aureliaStorage/);
});
