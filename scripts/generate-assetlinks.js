import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),"..");
const RP=/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(?:\.(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?))+$/;
const PACKAGE=/^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*)+$/;
export function normalizeFingerprint(value){
 const hex=String(value??"").replace(/:/g,"").trim().toUpperCase();
 if(!/^[A-F0-9]{64}$/.test(hex))throw new TypeError("Invalid SHA-256 signing-certificate fingerprint.");
 return hex.match(/.{2}/g).join(":");
}
export function buildAssetLinks({rpId,packageName,fingerprints}){
 const domain=String(rpId??"").trim().toLowerCase(),appId=String(packageName??"").trim();
 if(!RP.test(domain))throw new TypeError("WEBAUTHN_RP_ID must be a public DNS domain.");
 if(!PACKAGE.test(appId))throw new TypeError("ANDROID_APPLICATION_ID is invalid.");
 const certs=[...new Set((fingerprints??[]).map(normalizeFingerprint))];
 if(!certs.length)throw new TypeError("At least one Android signing-certificate fingerprint is required.");
 const origins=certs.map(fp=>"android:apk-key-hash:"+Buffer.from(fp.replace(/:/g,""),"hex").toString("base64url"));
 return {rpId:domain,packageName:appId,origins,assetLinks:[{relation:[
  "delegate_permission/common.handle_all_urls","delegate_permission/common.get_login_creds"
 ],target:{namespace:"android_app",package_name:appId,sha256_cert_fingerprints:certs}}]};
}
export function generateAssetLinks({env=process.env,rootDir=ROOT}={}){
 const fingerprints=String(env.WEBAUTHN_ANDROID_SHA256_CERT_FINGERPRINTS??"").split(/[;,\s]+/).filter(Boolean);
 const config=buildAssetLinks({rpId:env.WEBAUTHN_RP_ID,packageName:env.ANDROID_APPLICATION_ID||"com.aurelia.pms",fingerprints});
 const outputPath=path.join(rootDir,"public",".well-known","assetlinks.json");
 fs.mkdirSync(path.dirname(outputPath),{recursive:true});
 fs.writeFileSync(outputPath,JSON.stringify(config.assetLinks,null,2)+"\n");
 return {outputPath,rpId:config.rpId,certificateCount:config.origins.length,origins:config.origins};
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 try{
  const result=generateAssetLinks();
  process.stdout.write("Generated Digital Asset Links for "+result.rpId+" ("+result.certificateCount+" certificate(s)).\n");
  process.stdout.write("WEBAUTHN_ANDROID_ORIGINS="+result.origins.join(",")+"\n");
  process.stdout.write("Set WEBAUTHN_ASSETLINKS_VERIFIED=true only after the hosted file has been independently verified.\n");
 }catch(error){process.stderr.write(String(error?.message||"Asset Links generation failed.")+"\n");process.exitCode=1;}
}
