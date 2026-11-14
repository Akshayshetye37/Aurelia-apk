import crypto from "node:crypto";
import { canonicalBytes } from "../shared/canonical.mjs";
import { paymentDeviceRef } from "./firestore-device-service.mjs";
const TYPE="AURELIA_ACCOUNTING_RECEIPT_V1";
const FIELDS=["tenantId","deviceId","commandId","sequenceId","intentId","paymentId","amountMinor","currency","folioId","ledgerEntryHash","issuedAt"];
const ID=/^[A-Za-z0-9_-]{6,64}$/, UUID=/^[0-9a-f-]{36}$/i, HASH=/^[a-f0-9]{64}$/;
const sha=value=>crypto.createHash("sha256").update(value).digest("hex");
const fail=code=>{throw new Error(code);};
const unsigned=r=>Object.fromEntries(FIELDS.map(k=>[k,r[k]]));
export const accountingReceiptSigningBytes=r=>canonicalBytes({type:TYPE,receipt:unsigned(r)});
export const accountingReceiptId=r=>sha(accountingReceiptSigningBytes(r));
function validate({tenantId,deviceId,commandId,receipt,currentTime}){
 if(!receipt||typeof receipt!=="object"||Array.isArray(receipt)||
 Object.keys(receipt).sort().join(",")!==[...FIELDS,"signature"].sort().join(",")||
 !ID.test(tenantId||"")||!ID.test(deviceId||"")||!UUID.test(commandId||"")||
 receipt.tenantId!==tenantId||receipt.deviceId!==deviceId||receipt.commandId!==commandId||
 !Number.isSafeInteger(receipt.sequenceId)||receipt.sequenceId<1||!UUID.test(receipt.intentId||"")||
 typeof receipt.paymentId!=="string"||!/^[A-Za-z0-9._:-]{1,128}$/.test(receipt.paymentId)||
 !Number.isSafeInteger(receipt.amountMinor)||receipt.amountMinor<=0||receipt.currency!=="INR"||
 !ID.test(receipt.folioId||"")||!HASH.test(receipt.ledgerEntryHash||"")||
 typeof receipt.issuedAt!=="string"||!Number.isFinite(Date.parse(receipt.issuedAt))||
 typeof receipt.signature!=="string"||!/^[A-Za-z0-9_-]{80,128}$/.test(receipt.signature))
 throw new TypeError("invalid_accounting_receipt");
 if(Date.parse(receipt.issuedAt)>currentTime.getTime()+300000)fail("accounting_receipt_issued_in_future");
 return unsigned(receipt);
}
function matches(r,c,i,tenant,device,command){
 return c.commandId===command&&c.deviceId===device&&c.sequenceId===r.sequenceId&&
 c.transactionId===r.intentId&&c.providerPaymentId===r.paymentId&&c.amountMinor===r.amountMinor&&
 c.currency===r.currency&&c.folioId===r.folioId&&i.intentId===r.intentId&&i.tenantId===tenant&&
 i.deviceId===device&&i.providerPaymentId===r.paymentId&&i.amountMinor===r.amountMinor&&
 i.currency===r.currency&&i.folioId===r.folioId&&i.state==="CAPTURED"&&
 i.providerVerifiedStatus==="CAPTURED"&&c.provider===i.provider&&c.providerAccountId===i.providerAccountId;
}
export async function verifyAndAcceptAccountingReceipt({db,tenantId,deviceId,commandId,receipt,verifyProviderStatus,now=()=>new Date()}){
 if(!db||typeof verifyProviderStatus!=="function")throw new TypeError("accounting_receipt_dependencies_required");
 const currentTime=now();
 const payload=validate({tenantId,deviceId,commandId,receipt,currentTime}),bytes=canonicalBytes({type:TYPE,receipt:payload});
 const receiptId=sha(bytes),signature=Buffer.from(receipt.signature,"base64url");
 if(signature.length<64||signature.length>80)fail("accounting_receipt_signature_invalid");
 const deviceRef=paymentDeviceRef(db,tenantId,deviceId);
 const commandRef=deviceRef.collection("commands").doc(String(receipt.sequenceId));
 const intentRef=db.collection("paymentIntents").doc(receipt.intentId);
 const [ds,cs,is]=await Promise.all([deviceRef.get(),commandRef.get(),intentRef.get()]);
 if(!ds.exists||!cs.exists||!is.exists)fail("accounting_receipt_binding_not_found");
 const device=ds.data(),command=cs.data(),intent=is.data();
 if(device.status!=="ACTIVE"||device.tenantId!==tenantId||device.deviceId!==deviceId||!device.publicKeySpkiBase64)fail("payment_device_not_active");
 if(!matches(payload,command,intent,tenantId,deviceId,commandId)||
 !["DEVICE_ACKNOWLEDGED_PENDING_VERIFICATION","RECEIPT_ACCEPTED"].includes(command.status)||
 command.deviceReceiptId!==receiptId)fail("accounting_receipt_command_binding_mismatch");
 const publicKey=crypto.createPublicKey({key:Buffer.from(device.publicKeySpkiBase64,"base64"),type:"spki",format:"der"});
 if(!crypto.verify("sha256",bytes,publicKey,signature))fail("accounting_receipt_signature_invalid");
 const provider=await verifyProviderStatus(intent,payload);
 if(!provider||provider.captured!==true||provider.provider!==intent.provider||
 provider.environment!==intent.environment||provider.providerAccountId!==intent.providerAccountId||
 provider.orderId!==intent.providerOrderId||provider.paymentId!==payload.paymentId||
 provider.amountMinor!==payload.amountMinor||provider.currency!==payload.currency)
 fail("payment_provider_status_not_captured_or_mismatched");

 const receiptDocumentId=sha(tenantId+":"+commandId+":"+receiptId);
 const receiptRef=db.collection("paymentAccountingReceipts").doc(receiptDocumentId);
 const folioLockId=sha(tenantId+":"+payload.folioId);
 const lockRef=db.collection("paymentFolioLocks").doc(folioLockId);
 const inboxRef=command.webhookInboxId?db.collection("paymentWebhookInbox").doc(command.webhookInboxId):null;
 const acceptedAt=currentTime;
 return db.runTransaction(async tx=>{
  const reads=[tx.get(deviceRef),tx.get(commandRef),tx.get(intentRef),tx.get(receiptRef),
   tx.get(lockRef)];
  if(inboxRef)reads.push(tx.get(inboxRef));
  const [cd,cc,ci,prior,lock,inbox]=await Promise.all(reads);
  const currentIntent=ci.exists?ci.data():{};
  const lockData=lock.exists?lock.data():null;

  if(prior.exists){
   const priorData=prior.data();
   if(priorData.status==="ACCEPTED"&&priorData.receiptId===receiptId&&priorData.payloadHash===receiptId&&
    priorData.signature===receipt.signature&&
    currentIntent.accountingStatus==="POSTED_TO_LOCAL_FOLIO"&&
    currentIntent.accountingReceiptDocumentId===receiptDocumentId){
    return {accepted:true,duplicate:true,localLedgerPosted:true,settlementPosted:false,
     accountingStatus:"POSTED_TO_LOCAL_FOLIO",receiptId,folioId:payload.folioId};
   }
   fail("accounting_receipt_replay_or_conflict");
  }
  if(provider.provider!==currentIntent.provider||provider.environment!==currentIntent.environment||
   provider.providerAccountId!==currentIntent.providerAccountId||provider.orderId!==currentIntent.providerOrderId||
   provider.paymentId!==currentIntent.providerPaymentId||provider.amountMinor!==currentIntent.amountMinor||
   provider.currency!==currentIntent.currency)
   fail("payment_provider_status_intent_mismatch");
  if(!cd.exists||cd.data().status!=="ACTIVE"||cd.data().publicKeySpkiBase64!==device.publicKeySpkiBase64||
   !cc.exists||!ci.exists||!matches(payload,cc.data(),currentIntent,tenantId,deviceId,commandId)||
   cc.data().status!=="DEVICE_ACKNOWLEDGED_PENDING_VERIFICATION"||cc.data().deviceReceiptId!==receiptId||
   currentIntent.accountingStatus==="POSTED_TO_LOCAL_FOLIO"||
   !lock.exists||lockData.tenantId!==tenantId||lockData.folioId!==payload.folioId||
   lockData.active!==true||lockData.intentId!==payload.intentId||
   (inboxRef&&(!inbox?.exists||inbox.data().tenantId!==tenantId)))
   fail("accounting_receipt_state_changed");

  const providerVerification={
   provider:provider.provider,environment:provider.environment,providerAccountId:provider.providerAccountId,
   orderId:provider.orderId,paymentId:provider.paymentId,amountMinor:provider.amountMinor,
   currency:provider.currency,observedAt:provider.observedAt||acceptedAt.toISOString()
  };
  const eventId=command.webhookInboxId||receiptId;
  tx.create(receiptRef,{...payload,signature:receipt.signature,receiptId,payloadHash:receiptId,
   status:"ACCEPTED",providerVerification,acceptedAt,commandId,deviceId,eventId});
  tx.update(commandRef,{status:"RECEIPT_ACCEPTED",accountingVerificationStatus:"VERIFIED",
   accountingReceiptId:receiptId,accountingReceiptHash:payload.ledgerEntryHash,accountingReceiptAcceptedAt:acceptedAt});
  tx.update(intentRef,{accountingStatus:"POSTED_TO_LOCAL_FOLIO",accountingPostedAt:acceptedAt,
   localLedgerPostedAt:acceptedAt,
   accountingReceiptId:receiptId,accountingReceiptCommandId:commandId,
   accountingReceiptDocumentId:receiptDocumentId,accountingReceiptHash:payload.ledgerEntryHash,
   accountingReceiptAcceptedAt:acceptedAt,localLedgerReceiptId:receiptId,
   localLedgerEntryHash:payload.ledgerEntryHash,accountingBlockReason:null});
  tx.update(lockRef,{active:false,state:"POSTED_TO_LOCAL_FOLIO",postedAt:acceptedAt,receiptId});
  if(inboxRef&&inbox?.exists)tx.update(inboxRef,{accountingStatus:"POSTED_TO_LOCAL_FOLIO",
   processingStatus:"LOCAL_LEDGER_RECEIPT_ACCEPTED",accountingReceiptId:receiptId,
   accountingReceiptHash:payload.ledgerEntryHash,accountingReceiptAcceptedAt:acceptedAt});
  return {accepted:true,duplicate:false,localLedgerPosted:true,settlementPosted:false,
   accountingStatus:"POSTED_TO_LOCAL_FOLIO",receiptId,folioId:payload.folioId};
 });
}
