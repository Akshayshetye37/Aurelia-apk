const fs=require('fs');const path=require('path');
const root=path.join(__dirname,'..'),src=path.join(root,'index.html'),dest=path.join(root,'www');
if(!fs.existsSync(src))throw new Error('index.html not found');
fs.mkdirSync(dest,{recursive:true});
fs.copyFileSync(src,path.join(dest,'index.html'));
const storageDest=path.join(dest,'src','storage');
fs.mkdirSync(storageDest,{recursive:true});
const androidBuild=process.argv.includes('--android');
const storageModules=['pms-repository-contract.mjs','pms-local-identity.mjs','legacy-snapshot-parser.mjs','pms-bootstrap-coordinator.mjs','pms-repository-bridge.mjs','capacitor-pms-storage.mjs'];
if(!androidBuild)storageModules.push('indexeddb-pms-repository.mjs');
for(const name of storageModules){
 const source=path.join(root,'src','storage',name);
 if(!fs.existsSync(source))throw new Error('PMS storage module not found: '+source);
 fs.copyFileSync(source,path.join(storageDest,name));
}
const settlementSrc=path.join(root,'src','payments','settlement-service.mjs');
if(!fs.existsSync(settlementSrc))throw new Error('Settlement service not found: '+settlementSrc);
const settlementDest=path.join(dest,'src','payments');
fs.mkdirSync(settlementDest,{recursive:true});
for(const name of ['canonical.mjs','settlement-trust.mjs','settlement-authorization.mjs','settlement-service.mjs','repository-settlement-service.mjs','settlement-gate.mjs','payment-safety-gate.mjs','settlement-journal.mjs','settlement-apply.mjs','settlement-projector.mjs','payment-device-bridge.mjs','payment-engine.mjs','evidence-store.mjs','reconciliation-service.mjs','backend-router.mjs']){
 const source=path.join(root,'src','payments',name);
 if(!fs.existsSync(source))throw new Error('Payment module not found: '+source);
 fs.copyFileSync(source,path.join(settlementDest,name));
}
const servicesDest=path.join(dest,'src','services');
fs.mkdirSync(servicesDest,{recursive:true});
const paymentApiSource=path.join(root,'src','services','payment-api.mjs');
if(!fs.existsSync(paymentApiSource))throw new Error('Cloud payment API client not found: '+paymentApiSource);
fs.copyFileSync(paymentApiSource,path.join(servicesDest,'payment-api.mjs'));
const reconciliationSrc=path.join(root,'src','features','payments','reconciliation-bridge.js');
if(!fs.existsSync(reconciliationSrc))throw new Error('Reconciliation bridge not found: '+reconciliationSrc);
const featuresDest=path.join(dest,'src','features','payments');
fs.mkdirSync(featuresDest,{recursive:true});
fs.copyFileSync(reconciliationSrc,path.join(featuresDest,'reconciliation-bridge.js'));
for(const name of ['reconciliation-panel.js']){
 const source=path.join(root,'src','features','payments',name);
 if(!fs.existsSync(source))throw new Error('Reconciliation UI not found: '+source);
 fs.copyFileSync(source,path.join(featuresDest,name));
}
const bookingPolicySource=path.join(root,'src','bookings','cancellation-policy.mjs');
if(!fs.existsSync(bookingPolicySource))throw new Error('Booking cancellation policy module not found: '+bookingPolicySource);
const bookingPolicyDest=path.join(dest,'src','bookings');
fs.mkdirSync(bookingPolicyDest,{recursive:true});
fs.copyFileSync(bookingPolicySource,path.join(bookingPolicyDest,'cancellation-policy.mjs'));
if(androidBuild){for(const forbidden of ['indexeddb-pms-repository.mjs','indexeddb-storage-adapter.mjs']){const target=path.join(storageDest,forbidden);if(fs.existsSync(target))fs.unlinkSync(target);}for(const forbidden of ['indexeddb-pms-repository.mjs','indexeddb-storage-adapter.mjs'])if(fs.existsSync(path.join(storageDest,forbidden)))throw new Error('Android bundle must not include IndexedDB business adapter: '+forbidden);}
console.log('Prepared '+(androidBuild?'Android SQLite':'browser IndexedDB')+' web app, settlement modules, backend routing policy, and UPI reconciliation bridge');
const platformSrc=path.join(root,'src','payments','provider-platform.mjs');
if(!fs.existsSync(platformSrc))throw new Error('Payment platform module not found: '+platformSrc);
fs.copyFileSync(platformSrc,path.join(settlementDest,'provider-platform.mjs'));
for(const name of ['pay-bridge-orchestrator.mjs','indexeddb-payment-intent-store.mjs']){
 const source=path.join(root,'src','payments',name);
 if(!fs.existsSync(source))throw new Error('Payment orchestration module not found: '+source);
 fs.copyFileSync(source,path.join(settlementDest,name));
}
console.log('Prepared optional local settlement, payment orchestration, intent journal and evidence modules for Capacitor');
