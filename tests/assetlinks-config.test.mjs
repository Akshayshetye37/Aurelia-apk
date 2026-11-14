import test from "node:test";
import assert from "node:assert/strict";
import {buildAssetLinks,normalizeFingerprint} from "../scripts/generate-assetlinks.js";
const fingerprint="0123456789abcdef".repeat(4);
test("builds matching Credential Manager Digital Asset Links and Android RP origin",()=>{
 const x=buildAssetLinks({rpId:"login.aurelia.example",packageName:"com.aurelia.pms",fingerprints:[fingerprint,fingerprint]});
 assert.equal(x.assetLinks.length,1);
 assert.deepEqual(x.assetLinks[0].relation,["delegate_permission/common.handle_all_urls","delegate_permission/common.get_login_creds"]);
 assert.deepEqual(x.assetLinks[0].target.sha256_cert_fingerprints,[normalizeFingerprint(fingerprint)]);
 assert.equal(x.assetLinks[0].target.package_name,"com.aurelia.pms");
 assert.match(x.origins[0],/^android:apk-key-hash:[A-Za-z0-9_-]{43}$/);
});
test("rejects missing or malformed RP, package and signing certificate values",()=>{
 assert.throws(()=>buildAssetLinks({rpId:"",packageName:"com.aurelia.pms",fingerprints:[fingerprint]}),/WEBAUTHN_RP_ID/);
 assert.throws(()=>buildAssetLinks({rpId:"login.aurelia.example",packageName:"bad package",fingerprints:[fingerprint]}),/ANDROID_APPLICATION_ID/);
 assert.throws(()=>buildAssetLinks({rpId:"login.aurelia.example",packageName:"com.aurelia.pms",fingerprints:["bad"]}),/SHA-256/);
 assert.throws(()=>normalizeFingerprint("AA:BB"),/SHA-256/);
});
