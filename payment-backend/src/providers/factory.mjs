import { RazorpayAdapter } from './razorpay.mjs';
import { CashfreeAdapter } from './cashfree.mjs';
const FACTORIES = Object.freeze({ razorpay: o => new RazorpayAdapter(o), cashfree: o => new CashfreeAdapter(o) });
export function createProviderAdapter(providerId, options) {
 const factory=FACTORIES[providerId];
 if(!factory) throw new Error('provider_adapter_unavailable');
 return factory(options);
}
export function implementedProviderAdapters(){ return Object.keys(FACTORIES); }
