import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { PayUAdapter } from '../src/providers/payu-adapter.mjs';
import { generatePayUPaymentHash, generatePayUCommandHash } from '../src/providers/payu-crypto.mjs';

const credentials={merchantKey:'merchant-key',salt:'payu-salt-value'};
function mockFetch(handler){
  const calls=[];
  const fetchImpl=async(url,options)=>{calls.push({url,options});const result=await handler(url,options);
    return {ok:result.status>=200&&result.status<300,status:result.status,json:async()=>result.body};};
  return {fetchImpl,calls};
}

test('PayU credential validation authenticates through verify_payment without creating an order',async()=>{
  const mock=mockFetch(async(url,options)=>{
    const form=Object.fromEntries(new URLSearchParams(options.body));
    assert.equal(form.command,'verify_payment');
    assert.match(form.var1,/^AURCRED[A-Fa-f0-9]{12}$/);
    assert.equal(form.hash,generatePayUCommandHash({key:credentials.merchantKey,command:'verify_payment',var1:form.var1},credentials.salt));
    return {status:200,body:{status:0,msg:'0 out of 1 Transactions Fetched Successfully',
      transaction_details:{[form.var1]:{mihpayid:'Not Found',status:'Not Found'}}}};
  });
  const adapter=new PayUAdapter({credentials,environment:'test',fetchImpl:mock.fetchImpl});
  const result=await adapter.validateCredentials();
  assert.deepEqual(result,{valid:true,validation:'authenticated_verify_payment_api'});
  assert.equal(mock.calls.length,1);
});

test('PayU credential validation rejects a response that does not prove merchant authentication',async()=>{
  const mock=mockFetch(async()=>({status:200,body:{status:0,msg:'Merchant key is empty'}}));
  const adapter=new PayUAdapter({credentials,environment:'test',fetchImpl:mock.fetchImpl});
  await assert.rejects(adapter.validateCredentials(),/payu_credentials_not_authenticated/);
});

test('PayU prepares classic hosted checkout with server-generated hash and no salt leakage',async()=>{
  const adapter=new PayUAdapter({credentials,environment:'test'});
  const result=await adapter.createOrder({orderId:'order_123',amountMinor:12500,currency:'INR',
    customer:{firstName:'Guest',email:'guest@example.com',phone:'9876543210'},
    returnUrl:'https://pms.example/payu/return'});
  assert.equal(result.checkout.action,'https://test.payu.in/_payment');
  assert.equal(result.checkout.fields.amount,'125.00');
  assert.equal(result.checkout.fields.key,credentials.merchantKey);
  assert.equal(result.checkout.fields.hash,generatePayUPaymentHash(result.checkout.fields,credentials.salt));
  assert.equal(JSON.stringify(result).includes(credentials.salt),false);
});

test('PayU payment verification uses command hash and only captured success maps to captured',async()=>{
  const mock=mockFetch(async(url,options)=>{
    assert.equal(url,'https://test.payu.in/merchant/postservice.php?form=2');
    const form=Object.fromEntries(new URLSearchParams(options.body));
    assert.equal(form.command,'verify_payment');
    assert.equal(form.hash,generatePayUCommandHash({key:credentials.merchantKey,command:'verify_payment',var1:'order_123'},credentials.salt));
    return {status:200,body:{status:1,transaction_details:{order_123:{
      mihpayid:'123456789012345678',amt:'125.00',status:'success',unmappedstatus:'captured'}}}};
  });
  const adapter=new PayUAdapter({credentials,environment:'test',fetchImpl:mock.fetchImpl});
  const status=await adapter.getPaymentStatus({orderId:'order_123'});
  assert.equal(status.captured,true);
  assert.equal(status.amountMinor,12500);
  assert.equal(status.paymentId,'123456789012345678');
});

test('PayU refund request uses merchant refund token and amount in documented var2/var3 order',async()=>{
  const mock=mockFetch(async(url,options)=>{
    const form=Object.fromEntries(new URLSearchParams(options.body));
    assert.equal(form.command,'cancel_refund_transaction');
    assert.equal(form.var1,'123456789012345678');
    assert.equal(form.var2,'refund_123');
    assert.equal(form.var3,'25.00');
    assert.equal(form.hash,generatePayUCommandHash({key:credentials.merchantKey,
      command:'cancel_refund_transaction',var1:'123456789012345678'},credentials.salt));
    return {status:200,body:{status:1,request_id:'123456789'}};
  });
  const adapter=new PayUAdapter({credentials,environment:'test',fetchImpl:mock.fetchImpl});
  const result=await adapter.createRefund({orderId:'order_123',paymentId:'123456789012345678',
    refundId:'refund_123',amountMinor:2500});
  assert.equal(result.status,'PENDING');
  assert.equal(result.providerRequestId,'123456789');
});

test('PayU refund status is read by request ID and maps queued versus success correctly',async()=>{
  const mock=mockFetch(async(url,options)=>{
    const form=Object.fromEntries(new URLSearchParams(options.body));
    assert.equal(form.command,'check_action_status_txnid');
    assert.equal(form.var1,'123456789');
    return {status:200,body:{status:1,transaction_details:{'123456789':{'123456789':{
      mihpayid:'123456789012345678',request_id:'123456789',token:'refund_123',amt:'25.00',
      action:'refund',status:'success'}}}}};
  });
  const adapter=new PayUAdapter({credentials,environment:'test',fetchImpl:mock.fetchImpl});
  const result=await adapter.getRefundStatus({requestId:'123456789',refundId:'refund_123'});
  assert.equal(result.status,'SUCCESS');
  assert.equal(result.amountMinor,2500);
});

test('PayU verifies the reverse SHA-512 webhook hash over raw form data',async()=>{
  const event={status:'success',udf5:'',udf4:'',udf3:'',udf2:'',udf1:'',email:'guest@example.com',
    firstname:'Guest',productinfo:'Aurelia PMS folio payment',amount:'125.00',txnid:'order_123',key:credentials.merchantKey};
  const reverse=[credentials.salt,event.status,'','','','','','', '', '', '', '',event.email,event.firstname,
    event.productinfo,event.amount,event.txnid,event.key].join('|');
  event.hash=crypto.createHash('sha512').update(reverse).digest('hex');
  const adapter=new PayUAdapter({credentials,environment:'test'});
  const result=await adapter.verifyWebhook(Buffer.from(new URLSearchParams(event).toString()),
    {'content-type':'application/x-www-form-urlencoded'});
  assert.equal(result.valid,true);
  const altered={...event,amount:'126.00'};
  assert.equal((await adapter.verifyWebhook(Buffer.from(new URLSearchParams(altered).toString()),
    {'content-type':'application/x-www-form-urlencoded'})).valid,false);
});
