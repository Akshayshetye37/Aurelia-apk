import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import {accountingReceiptId,accountingReceiptSigningBytes,verifyAndAcceptAccountingReceipt} from "../src/devices/accounting-receipt-service.mjs";
const tenantId="tenant_001",deviceId="device_001";
const commandId="123e4567-e89b-42d3-a456-426614174000",intentId="123e4567-e89b-42d3-a456-426614174001";
const now=new Date("2026-11-14T12:00:00.000Z"),hash=v=>crypto.createHash("sha256").update(v).digest("hex");
const keys=crypto.generateKeyPairSync("ec",{namedCurve:"prime256v1"});
const publicKeySpkiBase64=keys.publicKey.export({type:"spki",format:"der"}).toString("base64");
class Doc{constructor(db,path){this.db=db;this.path=path;}collection(n){return new Col(this.db,this.path+"/"+n);}async get(){return snap(this.db.docs.get(this.path));}}
class Col{constructor(db,path){this.db=db;this.path=path;}doc(id){return new Doc(this.db,this.path+"/"+id);}}
const snap=v=>({exists:v!==undefined,data:()=>v===undefined?undefined:structuredClone(v)});
class DB{constructor(seed){this.docs=new Map(Object.entries(seed));}collection(n){return new Col(this,n);}async runTransaction(fn){
 const writes=[],tx={get:async r=>snap(this.docs.get(r.path)),create:(r,v)=>writes.push({k:"c",p:r.path,v:structuredClone(v)}),update:(r,v)=>writes.push({k:"u",p:r.path,v:structuredClone(v)})};
 const result=await fn(tx);for(const w of writes){if(w.k==="c"){if(this.docs.has(w.p))throw Error("already_exists");this.docs.set(w.p,w.v);}else{if(!this.docs.has(w.p))throw Error("not_found");this.docs.set(w.p,{...this.docs.get(w.p),...w.v});}}return result;}}
function receipt(overrides={}){const p={tenantId,deviceId,commandId,sequenceId:1,intentId,paymentId:"pay_001",amountMinor:150000,
 currency:"INR",folioId:"folio_001",ledgerEntryHash:"a".repeat(64),issuedAt:"2026-11-14T11:59:00.000Z",...overrides};
 return {...p,signature:crypto.sign("sha256",accountingReceiptSigningBytes(p),keys.privateKey).toString("base64url")};}
function fixture(r){const id=accountingReceiptId(r),dev=`paymentDevices/${tenantId}/devices/${deviceId}`,
 cmd=dev+"/commands/1",lock="paymentFolioLocks/"+hash(tenantId+":"+r.folioId),folio="paymentFolios/"+hash(tenantId+":"+r.folioId),inbox="paymentWebhookInbox/webhook_001";
 const db=new DB({[dev]:{tenantId,deviceId,status:"ACTIVE",publicKeySpkiBase64,lastAckedSequence:1},
 [cmd]:{tenantId,deviceId,commandId,sequenceId:1,transactionId:intentId,provider:"razorpay",providerAccountId:"merchant_001",
 providerPaymentId:"pay_001",amountMinor:150000,currency:"INR",folioId:"folio_001",status:"DEVICE_ACKNOWLEDGED_PENDING_VERIFICATION",
 deviceReceiptId:id,payloadHash:"b".repeat(64),webhookInboxId:"webhook_001"},
 [`paymentIntents/${intentId}`]:{intentId,tenantId,deviceId,provider:"razorpay",environment:"test",providerAccountId:"merchant_001",
 providerOrderId:"order_001",providerPaymentId:"pay_001",amountMinor:150000,currency:"INR",folioId:"folio_001",
 state:"CAPTURED",providerVerifiedStatus:"CAPTURED",accountingStatus:"PENDING"},
 [lock]:{tenantId,folioId:r.folioId,intentId,active:true,state:"CAPTURED_PENDING_ACCOUNTING"},
 [folio]:{tenantId,folioId:r.folioId,currency:"INR",status:"open",balanceMinor:200000,revision:0},
 [inbox]:{tenantId,accountingStatus:"PENDING",processingStatus:"CAPTURED_VERIFIED_PENDING_ACCOUNTING"}});
 return {db,cmd,lock,folio,inbox};}
const check=(o={})=>async()=>({captured:true,provider:"razorpay",environment:"test",providerAccountId:"merchant_001",
 orderId:"order_001",paymentId:"pay_001",amountMinor:150000,currency:"INR",observedAt:now.toISOString(),...o});
const accept=(r,db,verifyProviderStatus=check())=>verifyAndAcceptAccountingReceipt({db,tenantId,deviceId,commandId,receipt:r,verifyProviderStatus,now:()=>now});
test("signed receipt plus exact provider capture posts once",async()=>{const r=receipt(),{db,cmd,lock,folio,inbox}=fixture(r);
 const x=await accept(r,db);assert.equal(x.accepted,true);assert.equal(x.duplicate,false);assert.equal(x.localLedgerPosted,true);assert.equal(x.settlementPosted,false);
 assert.equal(db.docs.get(cmd).status,"RECEIPT_ACCEPTED");assert.equal(db.docs.get(`paymentIntents/${intentId}`).accountingStatus,"POSTED_TO_LOCAL_FOLIO");
 assert.equal(db.docs.get(lock).active,false);assert.equal(db.docs.get(folio).balanceMinor,200000);
 assert.equal(db.docs.has(folio+`/journalEntries/${intentId}`),false);
 assert.equal(db.docs.get(inbox).accountingStatus,"POSTED");});
test("identical receipt replay is idempotent without creating a backend ledger",async()=>{const r=receipt(),{db,folio}=fixture(r);
 const first=await accept(r,db),second=await accept(r,db);
 assert.equal(first.localLedgerPosted,true);assert.equal(first.settlementPosted,false);
 assert.equal(second.duplicate,true);assert.equal(second.localLedgerPosted,true);assert.equal(second.settlementPosted,false);
 assert.equal(db.docs.get(folio).balanceMinor,200000);assert.equal(db.docs.has(folio+`/journalEntries/${intentId}`),false);
});
test("receipt acceptance does not require a paymentFolios ledger or cached balance",async()=>{
 const r=receipt(),{db,folio}=fixture(r);db.docs.delete(folio);
 const result=await accept(r,db);
 assert.equal(result.accepted,true);assert.equal(result.localLedgerPosted,true);assert.equal(result.settlementPosted,false);
 assert.equal(db.docs.has(folio),false);assert.equal(db.docs.has(folio+`/journalEntries/${intentId}`),false);
});
test("forged signature is rejected",async()=>{const r=receipt(),{db}=fixture(r);await assert.rejects(accept({...r,signature:crypto.randomBytes(72).toString("base64url")},db),/accounting_receipt_signature_invalid/);});
test("receipt replayed against another command is rejected",async()=>{const r=receipt(),{db}=fixture(r);await assert.rejects(verifyAndAcceptAccountingReceipt({db,tenantId,deviceId,
 commandId:"123e4567-e89b-42d3-a456-426614174099",receipt:r,verifyProviderStatus:check(),now:()=>now}),/invalid_accounting_receipt/);});
test("wrong amount and folio are rejected even when signed",async t=>{for(const [n,o] of [["amount",{amountMinor:150001}],["folio",{folioId:"folio_002"}]])await t.test(n,async()=>{
 const r=receipt(o),{db}=fixture(r);await assert.rejects(accept(r,db),/accounting_receipt_command_binding_mismatch/);});});
test("provider status must independently confirm capture and exact bindings",async t=>{for(const [n,o] of [["not captured",{captured:false}],["payment",{paymentId:"pay_other"}],
 ["amount",{amountMinor:1}],["currency",{currency:"USD"}],["account",{providerAccountId:"merchant_other"}]])await t.test(n,async()=>{
 const r=receipt(),{db}=fixture(r);await assert.rejects(accept(r,db,check(o)),/payment_provider_status_not_captured_or_mismatched/);});});

test("folio lock must match the exact tenant and folio before accounting can post",async t=>{
 for(const [name,field,value] of [["tenant","tenantId","tenant_other"],["folio","folioId","folio_other"]])await t.test(name,async()=>{
  const r=receipt(),{db,lock,folio}=fixture(r),current=db.docs.get(lock);
  db.docs.set(lock,{...current,[field]:value});
  await assert.rejects(accept(r,db),/accounting_receipt_state_changed/);
  assert.equal(db.docs.get(folio).balanceMinor,200000);
 });
});
test("provider verification is re-bound to the current intent inside the posting transaction",async t=>{
 for(const [name,field,value] of [["environment","environment","live"],["order","providerOrderId","order_other"]])await t.test(name,async()=>{
  const r=receipt(),{db,folio}=fixture(r);
  const verify=async()=>{
   const result=await check()();
   const path=`paymentIntents/${intentId}`;
   db.docs.set(path,{...db.docs.get(path),[field]:value});
   return result;
  };
  await assert.rejects(accept(r,db,verify),/payment_provider_status_intent_mismatch/);
  assert.equal(db.docs.get(folio).balanceMinor,200000);
 });
});
