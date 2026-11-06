import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { PaytmAdapter } from '../src/providers/paytm-adapter.mjs';

const key='merchant-secret';
const checksumImpl={
  async generateSignature(value,secret){return crypto.createHash('sha256').update(String(value)+secret).digest('hex');},
  async verifySignature(value,secret,signature){
    return signature===crypto.createHash('sha256').update(typeof value==='string'?value:JSON.stringify(value)).update(secret).digest('hex');
  }
};
const signed=body=>({body,head:{signature:crypto.createHash('sha256').update(JSON.stringify(body)+key).digest('hex')}});
function mockFetch(handler){
  const calls=[];
  const fetchImpl=async(url,options)=>{calls.push({url,options});const body=await handler(url,options);
    return {ok:true,status:200,json:async()=>body};};
  return {fetchImpl,calls};
}
const creds={mid:'merchant123',merchantKey:key,websiteName:'WEBSTAGING'};

test('Paytm initiates hosted JS checkout with signed body and returns txn token',async()=>{
  const mock=mockFetch(async(url,options)=>{
    assert.match(url,/securestage\.paytmpayments\.com\/theia\/api\/v1\/initiateTransaction/);
    const request=JSON.parse(options.body);
    assert.equal(request.body.txnAmount.value,'125.00');
    assert.equal(request.body.txnAmount.currency,'INR');
    assert.equal(request.head.signature,await checksumImpl.generateSignature(JSON.stringify(request.body),key));
    return signed({txnToken:'txn-token-123',resultInfo:{resultStatus:'S'}});
  });
  const adapter=new PaytmAdapter({credentials:creds,environment:'staging',fetchImpl:mock.fetchImpl,checksumImpl});
  const result=await adapter.createOrder({orderId:'order_123',amountMinor:12500,currency:'INR',
    callbackUrl:'https://pms.example/paytm/callback',customer:{id:'guest_123'}});
  assert.equal(result.checkout.txnToken,'txn-token-123');
  assert.equal(result.amountMinor,12500);
});

test('Paytm queries authoritative payment status and binds MID and order ID',async()=>{
  const mock=mockFetch(async(url,options)=>{
    assert.equal(url,'https://securegw-stage.paytmpayments.in/v3/order/status');
    const request=JSON.parse(options.body);
    assert.equal(request.body.orderId,'order_123');
    return signed({mid:creds.mid,orderId:'order_123',txnId:'txn_123',txnAmount:'125.00',
      resultInfo:{resultStatus:'TXN_SUCCESS'}});
  });
  const adapter=new PaytmAdapter({credentials:creds,environment:'staging',fetchImpl:mock.fetchImpl,checksumImpl});
  const status=await adapter.getPaymentStatus({orderId:'order_123'});
  assert.equal(status.captured,true);
  assert.equal(status.amountMinor,12500);
  assert.equal(status.paymentId,'txn_123');
});

test('Paytm verifies callback checksum and rejects altered callback data',async()=>{
  const adapter=new PaytmAdapter({credentials:creds,environment:'staging',checksumImpl});
  const event={MID:creds.mid,ORDERID:'order_123',STATUS:'TXN_SUCCESS'};
  event.CHECKSUMHASH=await checksumImpl.generateSignature(event,key);
  const raw=Buffer.from(new URLSearchParams(event).toString());
  assert.equal((await adapter.verifyWebhook(raw,{'content-type':'application/x-www-form-urlencoded'})).valid,true);
  const altered=Buffer.from(raw.toString().replace('TXN_SUCCESS','TXN_FAILURE'));
  assert.deepEqual(await adapter.verifyWebhook(altered,{'content-type':'application/x-www-form-urlencoded'}),{valid:false});
});

test('Paytm submits refund with official body fields and keeps accepted refunds pending',async()=>{
  const mock=mockFetch(async(url,options)=>{
    assert.equal(url,'https://securegw-stage.paytmpayments.in/refund/apply');
    const request=JSON.parse(options.body);
    assert.deepEqual(request.body,{mid:creds.mid,orderId:'order_123',refId:'refund_123',
      txnId:'txn_123',txnType:'REFUND',refundAmount:'25.00'});
    return signed({mid:creds.mid,orderId:'order_123',refId:'refund_123',txnId:'txn_123',
      refundAmount:'25.00',resultInfo:{resultStatus:'PENDING',resultCode:'601'}});
  });
  const adapter=new PaytmAdapter({credentials:creds,environment:'staging',fetchImpl:mock.fetchImpl,checksumImpl});
  const result=await adapter.createRefund({orderId:'order_123',paymentId:'txn_123',refundId:'refund_123',amountMinor:2500});
  assert.equal(result.status,'PENDING');
  assert.equal(result.amountMinor,2500);
});

test('Paytm fetches refund status and rejects mismatched refund identity',async()=>{
  const mock=mockFetch(async()=>{
    return signed({mid:creds.mid,orderId:'order_123',refId:'refund_123',refundId:'provider_refund',
      txnId:'txn_123',refundAmount:'25.00',userCreditInitiateStatus:'SUCCESS',
      resultInfo:{resultStatus:'TXN_SUCCESS'}});
  });
  const adapter=new PaytmAdapter({credentials:creds,environment:'staging',fetchImpl:mock.fetchImpl,checksumImpl});
  const result=await adapter.getRefundStatus({orderId:'order_123',refundId:'refund_123'});
  assert.equal(result.status,'SUCCESS');
  assert.equal(result.amountMinor,2500);
  await assert.rejects(adapter.getRefundStatus({orderId:'order_other',refundId:'refund_123'}),/paytm_refund_status_identity_mismatch/);
});
