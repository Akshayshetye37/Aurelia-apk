export const PAYMENT_STATES = Object.freeze(['created','pending','authorized','captured','failed','refund_pending','partially_refunded','refunded','unknown']);
const TRANSITIONS = Object.freeze({
 created:['pending','authorized','captured','failed','unknown'],
 pending:['authorized','captured','failed','unknown'],
 authorized:['captured','failed','unknown'],
 captured:['refund_pending','partially_refunded','refunded'],
 failed:[], refund_pending:['partially_refunded','refunded','captured','unknown'],
 partially_refunded:['refund_pending','refunded'], refunded:[],
 unknown:['pending','authorized','captured','failed','refund_pending']
});
export function assertMoney(amountMinor,currency='INR') {
 if(!Number.isSafeInteger(amountMinor)||amountMinor<=0||currency!=='INR') throw new TypeError('invalid_payment_amount_or_currency');
 return {amountMinor,currency};
}
export function assertPaymentBinding(expected,observed) {
 const keys=['tenantId','provider','environment','providerOrderId','amountMinor','currency'];
 if(!expected||!observed||keys.some(k=>expected[k]!==observed[k])) throw new Error('payment_binding_mismatch');
 assertMoney(observed.amountMinor,observed.currency); return true;
}
export function transitionPayment(current,next) {
 if(!PAYMENT_STATES.includes(current)||!PAYMENT_STATES.includes(next)) throw new TypeError('invalid_payment_state');
 if(current===next)return next;
 if(!TRANSITIONS[current].includes(next))throw new Error('invalid_payment_state_transition');
 return next;
}
export function normalizeProviderState(provider,status) {
 const value=String(status||'').toLowerCase();
 if(provider==='razorpay') return ({created:'pending',attempted:'pending',authorized:'authorized',captured:'captured',failed:'failed',refunded:'refunded'})[value]||'unknown';
 if(provider==='cashfree') return ({active:'pending',paid:'captured',success:'captured',failed:'failed',user_dropped:'failed',refunded:'refunded'})[value]||'unknown';
 return 'unknown';
}
