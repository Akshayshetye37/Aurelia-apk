import { PaymentProviderAdapter } from './adapter-contract.mjs';
import { UnimplementedMerchantError } from './unimplemented-merchant-error.mjs';

class MerchantScaffold extends PaymentProviderAdapter {
  constructor(provider, options) {
    super(options);
    this.provider = provider;
  }
  unavailable() {
    throw new UnimplementedMerchantError(this.provider, 'cryptographic_verification_keys_and_merchant_kit');
  }
  async validateCredentials() { return this.unavailable(); }
  async createOrder() { return this.unavailable(); }
  async findOrderByReference() { return this.unavailable(); }
  async getPaymentStatus() { return this.unavailable(); }
  async verifyWebhook() { return this.unavailable(); }
  async createRefund() { return this.unavailable(); }
  async getRefundStatus() { return this.unavailable(); }
}

export class JioPayScaffold extends MerchantScaffold {
  constructor(options) { super('jiopay', options); }
}
export class CCAvenueScaffold extends MerchantScaffold {
  constructor(options) { super('ccavenue', options); }
}
