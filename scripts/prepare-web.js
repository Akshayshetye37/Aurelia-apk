const fs=require('fs');const path=require('path');
const root=path.join(__dirname,'..'),src=path.join(root,'index.html'),dest=path.join(root,'www');
if(!fs.existsSync(src))throw new Error('index.html not found');
fs.mkdirSync(dest,{recursive:true});
fs.copyFileSync(src,path.join(dest,'index.html'));
const settlementSrc=path.join(root,'src','payments','settlement-service.mjs');
if(!fs.existsSync(settlementSrc))throw new Error('Settlement service not found: '+settlementSrc);
const settlementDest=path.join(dest,'src','payments');
fs.mkdirSync(settlementDest,{recursive:true});
for(const name of ['settlement-service.mjs','settlement-gate.mjs']){
 const source=path.join(root,'src','payments',name);
 if(!fs.existsSync(source))throw new Error('Payment module not found: '+source);
 fs.copyFileSync(source,path.join(settlementDest,name));
}
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
console.log('Prepared web app, settlement modules, and UPI reconciliation bridge for Capacitor');