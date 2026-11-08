import crypto from 'node:crypto';
import { PaymentProviderAdapter } from './adapter-contract.mjs';

const BASE = Object.freeze({ uat: 'https://uat.jiopay.co.in', production: 'https://jiopay.co.in' });
const validId = v => typeof v === 'string' && /^[A-Za-z0-9_-]{6,50}$/.test(v);
const validMinor = v => Number.isSafeInteger(v) && v > 0;
const toMinor = v => {
  if (typeof v !== 'string' && typeof v !== 'number') return null;
  const s = String(v).trim();
  if (!/^\d+(?:\.\d{1,2})?$/.test(s)) return null;
  const [a,b=''] = s.split('.');
  const n = Number(a)*100 + Number((b+'00').slice(0,2));
  return Number.isSafeInteger(n) ? n : null;
};
const money = n => (n/100).toFixed(2);
const dateStamp = () => {
  const d = new Date();
  return [d.getUTCFullYear(),d.getUTCMonth()+1,d.getUTCDate(),d.getUTCHours(),d.getUTCMinutes(),d.getUTCSeconds()]
    .map((v,i)=>String(v).padStart(i===0?4:2,'0')).join('');
};
function hashMessage(fields) {
  if (!fields || typeof fields !== 'object' || Array.isArray(fields)) throw new TypeError('jiopay_hash_fields_invalid');
  return Object.keys(fields).filter(k=>k!=='secureHash').sort().map(k=>{
    const v=fields[k];
    if (v==null) return '';
    if (['string','number','boolean'].includes(typeof v)) return String(v);
    throw new TypeError('jiopay_hash_value_invalid');
  }).join('');
}
export function generateJioPaySecureHash(fields, secret) {
  if (typeof secret!=='string' || !secret) throw new TypeError('jiopay_secret_required');
  return crypto.createHmac('sha256',secret).update(hashMessage(fields),'utf8').digest('hex');
}
export function verifyJioPaySecureHash(fields, secret) {
  if (typeof fields?.secureHash!=='string' || !/^[a-f0-9]{64}$/i.test(fields.secureHash)) return false;
  try {
    const expected=Buffer.from(generateJioPaySecureHash(fields,secret),'hex');
    const actual=Buffer.from(fields.secureHash,'hex');
    return actual.length===expected.length && crypto.timingSafeEqual(actual,expected);
  } catch { return false; }
}
const statusOf = d => String(d?.transactionStatus||d?.txnStatus||d?.paymentStatus||d?.status||d?.respDescription||'').trim().toUpperCase();

export class JioPayAdapter extends PaymentProviderAdapter {
  constructor(options) {
    super(options);
    if (!['uat','production'].includes(this.environment) || !this.credentials.merchantId || !this.credentials.saltOrHashKey)
      throw new TypeError('jiopay_credentials_incomplete');
    this.baseUrl=BASE[this.environment];
  }
  async post(path, body, form=false) {
    let r;
    try {
      r=await this.fetch(this.baseUrl+path,{method:'POST',
        headers:{'Content-Type':form?'application/x-www-form-urlencoded':'application/json',Accept:'application/json'},
        body:form?new URLSearchParams(body):JSON.stringify(body),signal:AbortSignal.timeout(15000)});
    } catch (cause) {
      const mutating = path.includes('initiateSale') ||
        (body && body.transactionType === 'REFUND');
      throw Object.assign(new Error('jiopay_network_error'), { outcomeUnknown: mutating, cause });
    }
    const d=await r.json().catch(()=>({}));
    if(!r.ok) throw Object.assign(new Error('jiopay_request_failed'),{
      providerStatus:r.status,
      outcomeUnknown:r.status>=500 && (path.includes('initiateSale') || body?.transactionType==='REFUND')
    });
    return d;
  }
  async command(fields) {
    const body={...fields,secureHash:generateJioPaySecureHash(fields,this.credentials.saltOrHashKey)};
    const d=await this.post(this.environment==='uat'?'/tsp/pg/api/command':'/pg/api/command',body,true);
    if(!verifyJioPaySecureHash(d,this.credentials.saltOrHashKey)) throw new Error('jiopay_response_signature_invalid');
    return d;
  }
  async validateCredentials() {
    const ref='AURCRED'+crypto.randomBytes(6).toString('hex');
    await this.command({merchantId:this.credentials.merchantId,merchantTxnNo:ref,originalTxnNo:ref,
      amount:'0.00',transactionType:'STATUS',addlParam1:'',addlParam2:''});
    return {valid:true,validation:'authenticated_status_command'};
  }
  async createOrder(input) {
    let returnUrl;
    try { returnUrl = new URL(input?.returnUrl); } catch { returnUrl = null; }
    if(!validId(input?.orderId)||input.orderId.length>20||!validMinor(input?.amountMinor)||input.currency!=='INR'||
      !returnUrl||returnUrl.protocol!=='https:'||input.returnUrl.length>64||
      (input.customer?.email!=null&&!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(input.customer.email)))
      throw new TypeError('invalid_jiopay_order');
    const fields={amount:money(input.amountMinor),currencyCode:'356',customerEmailID:input.customer?.email||'guest@jiopay.in',
      merchantId:this.credentials.merchantId,aggregatorID:this.credentials.aggregatorId||'',
      merchantTxnNo:input.orderId,payType:'0',returnURL:input.returnUrl,transactionType:'SALE',txnDate:dateStamp()};
    const path=this.environment==='uat'?'/tsp/pg/api/v2/initiateSale':'/pg/api/v2/initiateSale';
    const d=await this.post(path,{...fields,secureHash:generateJioPaySecureHash(fields,this.credentials.saltOrHashKey)});
    if(!verifyJioPaySecureHash(d,this.credentials.saltOrHashKey)||d.responseCode!=='R1000'||
      d.merchantId!==this.credentials.merchantId||d.merchantTxnNo!==input.orderId||
      typeof d.redirectURI!=='string'||!d.redirectURI.startsWith('https://')||typeof d.tranCtx!=='string')
      throw new Error('jiopay_checkout_response_binding_mismatch');
    return {provider:'jiopay',orderId:input.orderId,amountMinor:input.amountMinor,currency:'INR',
      status:'PENDING',checkoutUrl:d.redirectURI,transactionContext:d.tranCtx};
  }
  async getPaymentStatus(input) {
    if(!validId(input?.orderId)||input.orderId.length>20) throw new TypeError('invalid_jiopay_order_id');
    const d=await this.command({merchantId:this.credentials.merchantId,aggregatorID:this.credentials.aggregatorId||'',
      merchantTxnNo:input.orderId,originalTxnNo:input.orderId,amount:'0.00',transactionType:'STATUS',addlParam1:'',addlParam2:''});
    if(d.merchantId!==this.credentials.merchantId||d.merchantTxnNo!==input.orderId)
      throw new Error('jiopay_status_identity_mismatch');
    const state=statusOf(d), amountMinor=toMinor(d.amount??d.txnAmount??d.transactionAmount);
    const inr=d.currencyCode==='356'||d.currency==='INR';
    return {provider:'jiopay',orderId:input.orderId,paymentId:d.pgTransactionId==null?null:String(d.pgTransactionId),
      paymentStatus:state||'UNKNOWN',amountMinor,currency:inr?'INR':null,
      captured:['SUCCESS','SUCCESSFUL','COMPLETED','CAPTURED','S0000','SUC'].includes(state)&&validMinor(amountMinor)&&inr,
      found:!['NOT_FOUND','NO_RECORD','R4040'].includes(state)};
  }
  async findOrderByReference(input) {
    if(!validId(input?.reference)) throw new TypeError('invalid_jiopay_reference');
    const s=await this.getPaymentStatus({orderId:input.reference});
    return s.found?{found:true,orderId:s.orderId,amountMinor:s.amountMinor,currency:s.currency,status:s.paymentStatus}:{found:false};
  }
  async verifyWebhook(rawBody,headers={}) {
    if(!Buffer.isBuffer(rawBody)||!rawBody.length) return {valid:false};
    try {
      const ct=String(headers['content-type']||headers['Content-Type']||'').toLowerCase();
      const event=ct.includes('application/json')?JSON.parse(rawBody.toString('utf8')):
        Object.fromEntries(new URLSearchParams(rawBody.toString('utf8')).entries());
      if(!verifyJioPaySecureHash(event,this.credentials.saltOrHashKey)||
        event.merchantId!==this.credentials.merchantId||!validId(event.merchantTxnNo)||event.merchantTxnNo.length>20) return {valid:false};
      return {valid:true,event};
    } catch { return {valid:false}; }
  }
  async createRefund(input) {
    if(!validId(input?.orderId)||input.orderId.length>20||!validId(input?.refundId)||input.refundId.length>20||!validMinor(input?.amountMinor))
      throw new TypeError('invalid_jiopay_refund');
    const d=await this.command({merchantId:this.credentials.merchantId,aggregatorID:this.credentials.aggregatorId||'',
      merchantTxnNo:input.refundId,originalTxnNo:input.orderId,amount:money(input.amountMinor),
      transactionType:'REFUND',addlParam1:'',addlParam2:''});
    const refundAmount=toMinor(d.amount??d.refundAmount);
    if(d.merchantId!==this.credentials.merchantId||d.merchantTxnNo!==input.refundId||
      d.originalTxnNo!==input.orderId||refundAmount!==input.amountMinor)
      throw new Error('jiopay_refund_identity_mismatch');
    const refundStatus=statusOf(d);
    if(!refundStatus) throw new Error('jiopay_refund_status_missing');
    return {provider:'jiopay',refundId:input.refundId,paymentId:d.pgTransactionId==null?null:String(d.pgTransactionId),
      status:refundStatus,amountMinor:refundAmount,currency:'INR'};
  }
  async getRefundStatus(input) {
    if(!validId(input?.refundId)||!validId(input?.orderId))
      throw new TypeError('invalid_jiopay_refund_id');
    const d=await this.command({merchantId:this.credentials.merchantId,merchantTxnNo:input.refundId,
      originalTxnNo:input.refundId,amount:'0.00',transactionType:'STATUS',addlParam1:'',addlParam2:''});
    if(d.merchantId!==this.credentials.merchantId||d.merchantTxnNo!==input.refundId||
      (d.originalTxnNo!=null&&d.originalTxnNo!==input.orderId))
      throw new Error('jiopay_refund_status_identity_mismatch');
    const state=statusOf(d);
    const amountMinor=toMinor(d.amount??d.refundAmount);
    if(!state) throw new Error('jiopay_refund_status_missing');
    return {provider:'jiopay',refundId:input.refundId,paymentId:d.pgTransactionId==null?null:String(d.pgTransactionId),
      status:state,amountMinor,currency:'INR'};
  }
}
