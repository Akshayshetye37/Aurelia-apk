export class UnimplementedMerchantError extends Error {
  constructor(provider, missingRequirement = 'merchant integration specification') {
    super(`${provider}_awaiting_${missingRequirement.replace(/[^a-z0-9]+/gi, '_').toLowerCase()}`);
    this.name = 'UnimplementedMerchantError';
    this.code = 'PROVIDER_MERCHANT_IMPLEMENTATION_PENDING';
    this.provider = provider;
    this.retryable = false;
  }
}
