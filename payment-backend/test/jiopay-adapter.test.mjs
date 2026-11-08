import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { JioPayAdapter, generateJioPaySecureHash, verifyJioPaySecureHash } from '../src/providers/jiopay-adapter.mjs';

function mockFetch(handler) {
  const calls=[];
  const fetchImpl=async (url,options)=>{calls.push({url,options});const result=await handler(url,options);
    return {ok:result.status>=200&&result.status<300,status:result.status,json:async()=>result.body};};
  return {fetchImpl,calls};
}
const credentials={merchantId:'merchant-123',saltOrHashKey:'unit-test-secret'};

test('JioPay HMAC uses alphabetically sorted parameter values without delimiters',()=>{
  const fields={requestType:'UPIQR',amount:'100',currency:'356',merchantId:'merchant-123'};
  const message='100356merchant-123UPIQR';
  const expected=crypto.createHmac('sha256',credentials.saltOrHashKey).update(message).digest('hex');
  assert.equal(generateJioPaySecureHash(fields,credentials.saltOrHashKey),expected);
  const signed={...fields,secureHash:expected};
  assert.equal(verifyJioPaySecureHash(signed,credentials.saltOrHashKey),true);
  assert.equal(verifyJioPaySecureHash({...signed,amount:'101'},credentials.saltOrHashKey),false);
});

test('JioPay hosted checkout signs the request and binds the authenticated redirect response',async()=>{
  const mock=mockFetch(async(url,options)=>{
    assert.equal(url,'https://uat.jiopay.co.in/tsp/pg/api/v2/initiateSale');
    const request=JSON.parse(options.body);
    assert.equal(verifyJioPaySecureHash(request,credentials.saltOrHashKey),true);
    assert.equal(request.amount,'125.00');
    assert.equal(request.currencyCode,'356');
    assert.equal(request.merchantTxnNo,'order_123');
    const response={responseCode:'R1000',merchantId:credentials.merchantId,merchantTxnNo:'order_123',
      redirectURI:'https://checkout.jiopay.co.in/pay',tranCtx:'context-123'};
    return {status:200,body:{...response,secureHash:generateJioPaySecureHash(response,credentials.saltOrHashKey)}};
  });
  const adapter=new JioPayAdapter({credentials,environment:'uat',fetchImpl:mock.fetchImpl});
  const result=await adapter.createOrder({orderId:'order_123',amountMinor:12500,currency:'INR',
    customer:{email:'guest@example.com'},returnUrl:'https://pms.example/return'});
  assert.equal(result.checkoutUrl,'https://checkout.jiopay.co.in/pay');
  assert.equal(result.transactionContext,'context-123');
  assert.equal(result.amountMinor,12500);
});

test('JioPay rejects an unsigned or identity-mismatched checkout response',async()=>{
  const mock=mockFetch(async()=>({status:200,body:{responseCode:'R1000',merchantId:'other',
    merchantTxnNo:'order_123',redirectURI:'https://checkout.example/pay',tranCtx:'ctx',secureHash:'0'.repeat(64)}}));
  const adapter=new JioPayAdapter({credentials,environment:'uat',fetchImpl:mock.fetchImpl});
  await assert.rejects(adapter.createOrder({orderId:'order_123',amountMinor:1000,currency:'INR',
    returnUrl:'https://pms.example/return'}),/jiopay_checkout_response_binding_mismatch/);
});

test('JioPay webhook verifies exact parsed payload signature and merchant binding',async()=>{
  const adapter=new JioPayAdapter({credentials,environment:'uat'});
  const fields={merchantId:credentials.merchantId,merchantTxnNo:'order_123',responseCode:'R1000'};
  const event={...fields,secureHash:generateJioPaySecureHash(fields,credentials.saltOrHashKey)};
  const raw=Buffer.from(JSON.stringify(event));
  assert.equal((await adapter.verifyWebhook(raw,{'content-type':'application/json'})).valid,true);
  assert.deepEqual(await adapter.verifyWebhook(Buffer.from(raw.toString().replace('R1000','R1001')),
    {'content-type':'application/json'}),{valid:false});
});

test('JioPay status command uses authenticated form request and binds transaction identity',async()=>{
  const mock=mockFetch(async(url,options)=>{
    assert.equal(url,'https://uat.jiopay.co.in/tsp/pg/api/command');
    assert.equal(options.headers['Content-Type'],'application/x-www-form-urlencoded');
    const request=Object.fromEntries(new URLSearchParams(options.body));
    assert.equal(verifyJioPaySecureHash(request,credentials.saltOrHashKey),true);
    const response={merchantId:credentials.merchantId,merchantTxnNo:'order_123',
      transactionStatus:'SUCCESS',amount:'125.00',currencyCode:'356',pgTransactionId:'pg-123'};
    return {status:200,body:{...response,secureHash:generateJioPaySecureHash(response,credentials.saltOrHashKey)}};
  });
  const adapter=new JioPayAdapter({credentials,environment:'uat',fetchImpl:mock.fetchImpl});
  const result=await adapter.getPaymentStatus({orderId:'order_123'});
  assert.equal(result.captured,true);
  assert.equal(result.amountMinor,12500);
  assert.equal(result.paymentId,'pg-123');
});


test('JioPay creates a refund and reconciles it by the merchant refund reference',async()=>{
  const mock=mockFetch(async(url,options)=>{
    const request=Object.fromEntries(new URLSearchParams(options.body));
    assert.equal(verifyJioPaySecureHash(request,credentials.saltOrHashKey),true);
    const response=request.transactionType==='REFUND'
      ? {merchantId:credentials.merchantId,merchantTxnNo:'refund_123',originalTxnNo:'order_123',
          transactionStatus:'PENDING',amount:'25.00',pgTransactionId:'pg-refund-txn'}
      : {merchantId:credentials.merchantId,merchantTxnNo:'refund_123',originalTxnNo:'refund_123',
          transactionStatus:'SUCCESS',amount:'25.00',pgTransactionId:'pg-refund-txn'};
    return {status:200,body:{...response,secureHash:generateJioPaySecureHash(response,credentials.saltOrHashKey)}};
  });
  const adapter=new JioPayAdapter({credentials,environment:'uat',fetchImpl:mock.fetchImpl});
  const created=await adapter.createRefund({orderId:'order_123',refundId:'refund_123',amountMinor:2500});
  assert.equal(created.refundId,'refund_123');
  assert.equal(created.amountMinor,2500);
  assert.equal(created.status,'PENDING');
  const status=await adapter.getRefundStatus({orderId:'order_123',refundId:'refund_123'});
  assert.equal(status.refundId,'refund_123');
  assert.equal(status.amountMinor,2500);
  assert.equal(status.status,'SUCCESS');
});
