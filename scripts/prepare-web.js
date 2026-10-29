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
console.log('Prepared web app and payment settlement modules for Capacitor');