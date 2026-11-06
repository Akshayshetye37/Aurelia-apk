import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { PhonePeAdapter } from '../src/providers/phonepe-adapter.mjs';

const credentials={clientId:'client-id',clientSecret:'client-secret',clientVersion:'1',
  webhookUsername:'aurelia-hook',webhookPassword:'webhook-password'};
function mockFetch(handler){
  const calls=[];
  const fetchImpl=async(url,options)=>{calls.push({url,options});const result=await handler(url,options);
    return {ok:result.status>=200&&result.status<300,status:result.status,json:async()=>result.body};};
  return {fetchImpl,calls};
}
const tokenBody=()=>({access_token:'phonepe-token',expires_at:Math.floor(Date.now()/1000)+3600,token_type:'O-Bearer'});

test('PhonePe obtains OAuth token and creates a Standard Checkout V2 payment',async()=>{
  const mock=mockFetch(async(url,options)=>{
    if(url.endsWith('/v1/oauth/token')){
      assert.match(url,/api-preprod\.phonepe\.com\/apis\/pg-sandbox/);
      assert.equal(options.headers['Content-Type'],'application/x-www-form-urlencoded');
      return {status:200,body:tokenBody()};
    }
    assert.equal(url,'https://api-preprod.phonepe.com/apis/pg-sandbox/checkout/v2/pay');
    assert.equal(options.headers.Authorization,'O-Bearer phonepe-token');
    const body=JSON.parse(options.body);
    assert.equal(body.merchantOrderId,'order_123');
    assert.equal(body.amount,12500);
    return {status:200,body:{orderId:'pg_order_123',state:'PENDING',redirectUrl:'https://mercury-uat.phonepe.com/checkout'}};
  });
  const adapter=new PhonePeAdapter({credentials,environment:'test',fetchImpl:mock.fetchImpl});
  const result=await adapter.createOrder({orderId:'order_123',amountMinor:12500,currency:'INR',
    returnUrl:'https://pms.example/return'});
  assert.equal(result.checkoutUrl,'https://mercury-uat.phonepe.com/checkout');
  assert.equal(result.status,'PENDING');
  assert.equal(mock.calls.length,2);
});

test('PhonePe uses production identity-manager OAuth endpoint and honors expires_at',async()=>{
  const mock=mockFetch(async(url)=>({status:200,body:tokenBody()}));
  const adapter=new PhonePeAdapter({credentials,environment:'live',fetchImpl:mock.fetchImpl});
  await adapter.accessToken();
  await adapter.accessToken();
  assert.equal(mock.calls.length,1);
  assert.equal(mock.calls[0].url,'https://api.phonepe.com/apis/identity-manager/v1/oauth/token');
});

test('PhonePe confirms payment only from authoritative completed status with amount evidence',async()=>{
  const mock=mockFetch(async(url)=>url.endsWith('/v1/oauth/token')
    ?{status:200,body:tokenBody()}
    :{status:200,body:{orderId:'pg_order_123',state:'COMPLETED',amount:12500,
      paymentDetails:[{transactionId:'txn_123',state:'COMPLETED',amount:12500}]}});
  const adapter=new PhonePeAdapter({credentials,environment:'test',fetchImpl:mock.fetchImpl});
  const result=await adapter.getPaymentStatus({orderId:'order_123'});
  assert.equal(result.captured,true);
  assert.equal(result.amountMinor,12500);
  assert.equal(result.paymentId,'txn_123');
});

test('PhonePe webhook verifies documented SHA256(username:password) authorization',async()=>{
  const adapter=new PhonePeAdapter({credentials,environment:'test'});
  const digest=crypto.createHash('sha256').update(credentials.webhookUsername+':'+credentials.webhookPassword).digest('hex');
  const raw=Buffer.from(JSON.stringify({event:'checkout.order.completed',payload:{merchantOrderId:'order_123',state:'COMPLETED'}}));
  assert.equal((await adapter.verifyWebhook(raw,{authorization:'SHA256('+digest+')'})).valid,true);
  assert.deepEqual(await adapter.verifyWebhook(raw,{authorization:'Basic invalid'}),{valid:false});
});

test('PhonePe creates and checks refunds using V2 refund endpoints',async()=>{
  const mock=mockFetch(async(url,options)=>{
    if(url.endsWith('/v1/oauth/token'))return {status:200,body:tokenBody()};
    if(url.endsWith('/payments/v2/refund')&&options.method==='POST'){
      const body=JSON.parse(options.body);
      assert.deepEqual(body,{merchantRefundId:'refund_123',originalMerchantOrderId:'order_123',amount:2500});
      return {status:200,body:{refundId:'pg_refund_123',state:'PENDING',amount:2500}};
    }
    return {status:200,body:{originalMerchantOrderId:'order_123',refundId:'pg_refund_123',state:'COMPLETED',amount:2500}};
  });
  const adapter=new PhonePeAdapter({credentials,environment:'test',fetchImpl:mock.fetchImpl});
  const created=await adapter.createRefund({refundId:'refund_123',orderId:'order_123',amountMinor:2500});
  assert.equal(created.status,'PENDING');
  const status=await adapter.getRefundStatus({refundId:'refund_123',orderId:'order_123'});
  assert.equal(status.status,'COMPLETED');
  assert.equal(status.amountMinor,2500);
});

test('PhonePe rejects sub-rupee refund requests before network dispatch',async()=>{
  const mock=mockFetch(async()=>({status:200,body:tokenBody()}));
  const adapter=new PhonePeAdapter({credentials,environment:'test',fetchImpl:mock.fetchImpl});
  await assert.rejects(adapter.createRefund({refundId:'refund_123',orderId:'order_123',amountMinor:99}),/invalid_phonepe_refund/);
  assert.equal(mock.calls.length,0);
});
