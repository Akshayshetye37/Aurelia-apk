/**
 * Provider adapter contract.
 *
 * An adapter is not production-ready until it implements every operation
 * required by the capability set it advertises and passes provider sandbox
 * contract tests. Never report a scaffold as connected/active.
 */
export class PaymentProviderAdapter {
  constructor({ credentials, environment, fetchImpl = fetch }) {
    if (!credentials || !environment) throw new TypeError('credentials_and_environment_required');
    this.credentials = credentials;
    this.environment = environment;
    this.fetch = fetchImpl;
  }

  async validateCredentials() {
    throw new Error('adapter_operation_not_implemented');
  }

  async createOrder(_input) {
    throw new Error('adapter_operation_not_implemented');
  }

  async getPaymentStatus(_input) {
    throw new Error('adapter_operation_not_implemented');
  }

  async verifyWebhook(_rawBody, _headers) {
    throw new Error('adapter_operation_not_implemented');
  }

  async createRefund(_input) {
    throw new Error('adapter_operation_not_implemented');
  }
}

export function assertAdapterCapabilities(adapter, required = []) {
  for (const operation of required) {
    if (typeof adapter[operation] !== 'function' ||
        adapter[operation] === PaymentProviderAdapter.prototype[operation]) {
      throw new Error('provider_capability_not_implemented:' + operation);
    }
  }
  return true;
}
