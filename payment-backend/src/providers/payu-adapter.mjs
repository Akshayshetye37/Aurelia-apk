import crypto from 'node:crypto';
import { PaymentProviderAdapter } from './adapter-contract.mjs';
import { generatePayUPaymentHash, generatePayUCommandHash, verifyPayUResponseHash } from './payu-crypto.mjs';

const HOSTS=Object.freeze({test:'https://test.payu.in',live:'https://secure.payu.in'});
const INFO_HOSTS=Object.freeze({test:'https://test.payu.in',live:'https://info.payu.in'});
const id=v=>typeof v==='string'&&/^[A-Za-z0-9_-]{6,50}$/.test(v);
const refundToken=v=>typeof v==='string'&&/^[A-Za-z0-9_-]{6,23}$/.test(v);
const minor=v=>Number.isSafeInteger(v)&&v>0;
const toMinor=v=>{
  if(typeof v!=='string'&&typeof v!=='number')return null;
  const s=String(v).trim();if(!/^\d+(?:\.\d{1,2})?$/.test(s))return null;
  const [w,f='']=s.split('.');const n=Number(w)*100+Number((f+'00').slice(0,2));
  return Number.isSafeInteger(n)?n:null;
};
const money=n=>(n/100).toFixed(2);

export class PayUAdapter extends PaymentProviderAdapter {
  constructor(options) {
    super(options);
    if(!['test','live'].includes(this.environment)||!this.credentials.merchantKey||!this.credentials.salt)
      throw new TypeError('payu_credentials_incomplete');
    this.key=this.credentials.merchantKey;
    this.salt=this.credentials.salt;
    this.baseUrl=HOSTS[this.environment];
    this.infoUrl=INFO_HOSTS[this.environment];
  }
  async command(command,var1,extra={}) {
    if(typeof var1!=='string'||!var1)throw new TypeError('payu_command_reference_required');
    const hash=generatePayUCommandHash({key:this.key,command,var1},this.salt);
    const body=new URLSearchParams({key:this.key,command,var1,...extra,hash});
    const response=await this.fetch(this.infoUrl+'/merchant/postservice.php?form=2',{
      method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded',Accept:'application/json'},
      body,signal:AbortSignal.timeout(15000)});
    const data=await response.json().catch(()=>({}));
    if(!response.ok)throw Object.assign(new Error('payu_request_failed'),{providerStatus:response.status});
    return data;
  }
  async validateCredentials() {
    if(this.key.length<4||this.key.length>50||this.salt.length<8)throw new Error('payu_credentials_invalid');
    // PayU's classic verify_payment API returns an explicit "Not Found" row
    // for an unknown transaction when the merchant key + command hash are valid.
    // A unique probe avoids creating a payment or mutating merchant state.
    const probe='AURCRED'+crypto.randomUUID().replace(/-/g,'').slice(0,24);
    const data=await this.command('verify_payment',probe);
    const row=data?.transaction_details?.[probe];
    if(row?.status==='Not Found'&&row?.mihpayid==='Not Found') {
      return {valid:true,validation:'authenticated_verify_payment_api'};
    }
    throw Object.assign(new Error('payu_credentials_not_authenticated'),{
      providerCode:String(data?.error_code||data?.status||'unexpected_probe_response')
    });
  }
  async createOrder(input) {
    const customer=input?.customer||{};
    if(!id(input?.orderId)||!minor(input?.amountMinor)||input.currency!=='INR'||
      typeof customer.firstName!=='string'||!customer.firstName.trim()||
      !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(customer.email||'')||
      (customer.phone!=null&&!/^\+?[0-9]{8,15}$/.test(customer.phone))||
      typeof input.returnUrl!=='string'||!input.returnUrl.startsWith('https://'))
      throw new TypeError('invalid_payu_order');
    const fields={key:this.key,txnid:input.orderId,amount:money(input.amountMinor),
      productinfo:'Aurelia PMS folio payment',firstname:customer.firstName.trim(),email:customer.email,
      phone:customer.phone||'',surl:input.returnUrl,furl:input.returnUrl,curl:input.returnUrl};
    const hash=generatePayUPaymentHash(fields,this.salt);
    return {provider:'payu',orderId:input.orderId,amountMinor:input.amountMinor,currency:'INR',status:'CREATED',
      checkout:{action:this.baseUrl+'/_payment',method:'POST',fields:{...fields,hash}}};
  }
  async getPaymentStatus(input) {
    if(!id(input?.orderId))throw new TypeError('invalid_payu_txn_id');
    const data=await this.command('verify_payment',input.orderId);
    const row=data?.transaction_details?.[input.orderId];
    if(!row)return {provider:'payu',orderId:input.orderId,paymentId:null,paymentStatus:'NOT_FOUND',
      amountMinor:null,currency:'INR',captured:false,found:false};
    const amountMinor=toMinor(row.amt??row.amount);
    const status=String(row.status||'').toLowerCase();
    const unmapped=String(row.unmappedstatus||row.unmappedStatus||'').toLowerCase();
    return {provider:'payu',orderId:input.orderId,paymentId:row.mihpayid==null?null:String(row.mihpayid),
      paymentStatus:status,amountMinor,currency:'INR',captured:status==='success'&&unmapped==='captured'&&minor(amountMinor),found:true};
  }
  async findOrderByReference(input) {
    const status=await this.getPaymentStatus({orderId:input?.reference});
    return status.found?{found:true,orderId:status.orderId,amountMinor:status.amountMinor,
      currency:status.currency,status:status.paymentStatus,paymentId:status.paymentId}:{found:false};
  }
  async verifyWebhook(rawBody,headers={}) {
    if(!Buffer.isBuffer(rawBody)||!rawBody.length)return {valid:false};
    try {
      const type=String(headers['content-type']||headers['Content-Type']||'').toLowerCase();
      const event=type.includes('application/json')?JSON.parse(rawBody.toString('utf8')):
        Object.fromEntries(new URLSearchParams(rawBody.toString('utf8')).entries());
      const valid=verifyPayUResponseHash(event,this.salt)&&event.key===this.key&&id(event.txnid);
      return {valid,event:valid?event:undefined};
    }catch{return {valid:false};}
  }
  async createRefund(input) {
    if(!id(input?.orderId)||!id(input?.paymentId)||!refundToken(input?.refundId)||!minor(input?.amountMinor))
      throw new TypeError('invalid_payu_refund');
    const data=await this.command('cancel_refund_transaction',input.paymentId,{
      var2:input.refundId,var3:money(input.amountMinor)});
    if(Number(data.status)!==1)throw Object.assign(new Error('payu_refund_failed'),{providerCode:data.error_code||null});
    return {provider:'payu',refundId:input.refundId,paymentId:input.paymentId,orderId:input.orderId,
      status:'PENDING',amountMinor:input.amountMinor,currency:'INR',
      providerRequestId:data.request_id==null?null:String(data.request_id)};
  }
  async getRefundStatus(input) {
    if(!refundToken(input?.refundId)&&!/^\d{5,30}$/.test(String(input?.requestId||'')))
      throw new TypeError('invalid_payu_refund_lookup');
    let data,requestId=input.requestId||null;
    if(requestId)data=await this.command('check_action_status_txnid',String(requestId));
    else if(id(input?.paymentId))data=await this.command('check_action_status',input.paymentId,{var2:'payuid'});
    else throw new TypeError('payu_refund_payment_or_request_id_required');
    const details=data?.transaction_details||{};
    let rows=[];
    for(const value of Object.values(details)) {
      if(value&&typeof value==='object') {
        if(Array.isArray(value))rows.push(...value);
        else if(value.request_id||value.token||value.action)rows.push(value);
        else rows.push(...Object.values(value).filter(x=>x&&typeof x==='object'));
      }
    }
    const row=rows.find(x=>(requestId&&String(x.request_id)===String(requestId))||
      (input.refundId&&String(x.token)===String(input.refundId)&&String(x.action||'').toLowerCase()==='refund'));
    if(!row)return {provider:'payu',refundId:input.refundId||null,status:'NOT_FOUND',amountMinor:null,currency:'INR'};
    const state=String(row.status||'').toLowerCase();
    const status=state==='success'?'SUCCESS':state==='failure'?'FAILED':
      ['queued','in progress','requested','od_hit','pending'].includes(state)?'PENDING':'UNKNOWN';
    return {provider:'payu',refundId:input.refundId||row.token||null,paymentId:row.mihpayid==null?input.paymentId:String(row.mihpayid),
      providerRequestId:row.request_id==null?requestId:String(row.request_id),status,
      amountMinor:toMinor(row.amt??row.amount),currency:'INR'};
  }
}
