export class PrinterAdapter {
  async discover() { throw new Error('adapter_not_implemented'); }
  async verifyCapabilities() { throw new Error('adapter_not_implemented'); }
  async print() { throw new Error('adapter_not_implemented'); }
  async cancel() { throw new Error('adapter_not_implemented'); }
}

export function failedPrintResult(error, jobId) {
  return Object.freeze({ ok: false, status: 'failed', error, ...(jobId ? { jobId } : {}) });
}
