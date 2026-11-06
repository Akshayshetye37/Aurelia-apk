import PaytmChecksum from 'paytmchecksum';
import { PaymentProviderAdapter } from './adapter-contract.mjs';

const HOSTS=Object.freeze({
  staging:{checkout:'https://securestage.paytmpayments.com',api:'https://securegw-stage.paytmpayments.in'},
  production:{checkout:'https://secure.paytmpayments.com',api:'https://securegw.paytmpayments.in'}
});
const id=v=>typeof v==='string'&&/^[A-Za-z0-9._@-]{6,50}$/.test(v);
const minor=v=>Number.isSafeInteger(v)&&v>0;
const toMinor=v=>{
  if(typeof v!=='string'&&typeof v!=='number')return null;
  const s=String(v).trim();if(!/^\d+(?:\.\d{1,2})?$/.test(s))return null;
  const [w,f='']=s.split('.');const n=Number(w)*100+Number((f+'00').slice(0,2));
  return Number.isSafeInteger(n)?n:null;
};
const amount=v=>(v/100).toFixed(2);
const json=async response=>{
  const data=await response.json().catch(()=>({}));
  if(!response.ok)throw Object.assign(new Error('paytm_request_failed'),{providerStatus:response.status});
  return data;
};

export class PaytmAdapter extends PaymentProviderAdapter {
  constructor(options) {
    super(options);
    if(!['staging','production'].includes(this.environment)||
      !this.credentials.mid||!this.credentials.merchantKey||!this.credentials.websiteName)
      throw new TypeError('paytm_credentials_incomplete');
    this.hosts=HOSTS[this.environment];
    this.checksum=options?.checksumImpl||PaytmChecksum;
  }
  async signedRequest(url,body) {
    const bodyText=JSON.stringify(body);
    const signature=await this.checksum.generateSignature(bodyText,this.credentials.merchantKey);
    const payload=JSON.stringify({body,head:{signature}});
    const response=await this.fetch(url,{method:'POST',headers:{'Content-Type':'application/json',Accept:'application/json'},
      body:payload,signal:AbortSignal.timeout(15000)});
    const data=await json(response);
    if(!data?.body||typeof data?.head?.signature!=='string'||
      !(await this.checksum.verifySignature(JSON.stringify(data.body),this.credentials.merchantKey,data.head.signature)))
      throw new Error('paytm_response_signature_invalid');
    return data.body;
  }
  async validateCredentials() {
    await this.signedRequest(this.hosts.api+'/v3/order/status',{mid:this.credentials.mid,orderId:'AURELIA-CREDENTIAL-CHECK'});
    return {valid:true,validation:'authenticated_status_api'};
  }
  async createOrder(input) {
    if(!id(input?.orderId)||!minor(input?.amountMinor)||input.currency!=='INR'||
      typeof input.callbackUrl!=='string'||!input.callbackUrl.startsWith('https://')||
      (input.customer?.id!=null&&!id(input.customer.id)))
      throw new TypeError('invalid_paytm_order');
    const body={requestType:'Payment',mid:this.credentials.mid,websiteName:this.credentials.websiteName,
      orderId:input.orderId,callbackUrl:input.callbackUrl,
      txnAmount:{value:amount(input.amountMinor),currency:'INR'},
      userInfo:{custId:input.customer?.id||'AURELIA_GUEST'}};
    const data=await this.signedRequest(this.hosts.checkout+
      '/theia/api/v1/initiateTransaction?mid='+encodeURIComponent(this.credentials.mid)+
      '&orderId='+encodeURIComponent(input.orderId),body);
    const token=data.txnToken;
    if(typeof token!=='string'||!token||data.orderId&&data.orderId!==input.orderId||
      (data.resultInfo?.resultStatus&& !['S','SUCCESS'].includes(String(data.resultInfo.resultStatus).toUpperCase())))
      throw new Error('paytm_transaction_token_missing_or_invalid');
    return {provider:'paytm',orderId:input.orderId,amountMinor:input.amountMinor,currency:'INR',
      status:'PENDING',checkout:{mid:this.credentials.mid,orderId:input.orderId,txnToken:token,
        checkoutHost:this.hosts.checkout}};
  }
  async getPaymentStatus(input) {
    if(!id(input?.orderId))throw new TypeError('invalid_paytm_order_id');
    const data=await this.signedRequest(this.hosts.api+'/v3/order/status',
      {mid:this.credentials.mid,orderId:input.orderId});
    if(data.mid!==this.credentials.mid||data.orderId!==input.orderId)
      throw new Error('paytm_status_identity_mismatch');
    const result=String(data.resultInfo?.resultStatus||'').toUpperCase();
    const amountMinor=toMinor(data.txnAmount);
    return {provider:'paytm',orderId:data.orderId,paymentId:data.txnId==null?null:String(data.txnId),
      paymentStatus:result||'UNKNOWN',amountMinor,currency:'INR',
      captured:result==='TXN_SUCCESS'&&minor(amountMinor),found:result!=='NO_RECORD_FOUND'};
  }
  async findOrderByReference(input) {
    if(!id(input?.reference))throw new TypeError('invalid_paytm_reference');
    const s=await this.getPaymentStatus({orderId:input.reference});
    return s.found?{found:true,orderId:s.orderId,amountMinor:s.amountMinor,currency:s.currency,status:s.paymentStatus,
      paymentId:s.paymentId}:{found:false};
  }
  async verifyWebhook(rawBody,headers={}) {
    if(!Buffer.isBuffer(rawBody)||!rawBody.length)return {valid:false};
    try {
      const type=String(headers['content-type']||headers['Content-Type']||'').toLowerCase();
      let event;
      if(type.includes('application/json'))event=JSON.parse(rawBody.toString('utf8'));
      else event=Object.fromEntries(new URLSearchParams(rawBody.toString('utf8')).entries());
      const signature=event.CHECKSUMHASH||event.checksumHash;
      if(typeof signature!=='string')return {valid:false};
      const unsigned={...event};delete unsigned.CHECKSUMHASH;delete unsigned.checksumHash;
      if(!(await this.checksum.verifySignature(unsigned,this.credentials.merchantKey,signature))||
        event.MID!==this.credentials.mid||!id(event.ORDERID))return {valid:false};
      return {valid:true,event};
    }catch{return {valid:false};}
  }
  async createRefund(input) {
    if(!id(input?.orderId)||!id(input?.paymentId)||!id(input?.refundId)||!minor(input?.amountMinor))
      throw new TypeError('invalid_paytm_refund');
    const body={mid:this.credentials.mid,orderId:input.orderId,refId:input.refundId,
      txnId:input.paymentId,txnType:'REFUND',refundAmount:amount(input.amountMinor)};
    const data=await this.signedRequest(this.hosts.api+'/refund/apply',body);
    if(data.mid!==this.credentials.mid||data.orderId!==input.orderId||data.refId!==input.refundId||
      (data.txnId&&data.txnId!==input.paymentId))throw new Error('paytm_refund_identity_mismatch');
    const status=String(data.resultInfo?.resultStatus||'').toUpperCase();
    if(status==='TXN_FAILURE')throw Object.assign(new Error('paytm_refund_rejected'),{providerCode:data.resultInfo?.resultCode});
    return {provider:'paytm',refundId:input.refundId,providerRefundId:data.refundId||null,
      paymentId:input.paymentId,orderId:input.orderId,status:'PENDING',
      amountMinor:toMinor(data.refundAmount)||input.amountMinor,currency:'INR'};
  }
  async getRefundStatus(input) {
    if(!id(input?.orderId)||!id(input?.refundId))throw new TypeError('invalid_paytm_refund_lookup');
    const data=await this.signedRequest(this.hosts.api+'/v2/refund/status',
      {mid:this.credentials.mid,orderId:input.orderId,refId:input.refundId});
    if(data.mid!==this.credentials.mid||data.orderId!==input.orderId||data.refId!==input.refundId)
      throw new Error('paytm_refund_status_identity_mismatch');
    const status=String(data.resultInfo?.resultStatus||'').toUpperCase();
    const finalStatus=status==='TXN_SUCCESS'?'SUCCESS':status==='TXN_FAILURE'?'FAILED':'PENDING';
    return {provider:'paytm',refundId:input.refundId,providerRefundId:data.refundId||null,
      paymentId:data.txnId==null?null:String(data.txnId),status:finalStatus,
      amountMinor:toMinor(data.refundAmount),currency:'INR'};
  }
}
