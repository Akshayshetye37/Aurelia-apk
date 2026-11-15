function makeId(prefix) {
  const cryptoImpl = globalThis.crypto;
  if (!cryptoImpl?.randomUUID) throw new Error('Secure print identifier generation is unavailable');
  return prefix + cryptoImpl.randomUUID();
}

export class PmsPrintQueueRepository {
  constructor({ bridge, isNative = () => globalThis.Capacitor?.isNativePlatform?.() === true, now = () => new Date().toISOString() } = {}) {
    if (!bridge || typeof bridge.fetchEntity !== 'function' || typeof bridge.listEntities !== 'function' ||
        typeof bridge.mutateEntity !== 'function') throw new TypeError('Canonical PMS repository bridge is required');
    this.bridge = bridge;
    this.isNative = isNative;
    this.now = now;
  }

  assertSecureStore() {
    if (!this.isNative()) throw new Error('PRINT_QUEUE_REQUIRES_ENCRYPTED_NATIVE_STORAGE');
  }

  async enqueue(job) {
    this.assertSecureStore();
    const existing = await this.bridge.fetchEntity('print_job', job.jobId);
    if (existing) throw new Error('PRINT_JOB_ALREADY_EXISTS');
    const committed = await this.bridge.mutateEntity({
      entityType: 'print_job',
      entityId: job.jobId,
      expectedVersion: 0,
      eventType: 'printing.job_queued',
      eventPayload: { jobId: job.jobId, printerId: job.printer.id, jobKind: job.jobKind },
      mutate: data => Object.assign(data, job)
    });
    return committed.entity;
  }

  async getJob(jobId) {
    this.assertSecureStore();
    const row = await this.bridge.fetchEntity('print_job', jobId);
    return row ? { ...row.data, version: row.version } : null;
  }

  async updateJob(jobId, patch, eventType = 'printing.job_updated') {
    this.assertSecureStore();
    const current = await this.bridge.fetchEntity('print_job', jobId);
    if (!current) throw new Error('PRINT_JOB_NOT_FOUND');
    const committed = await this.bridge.mutateEntity({
      entityType: 'print_job',
      entityId: jobId,
      expectedVersion: current.version,
      eventType,
      eventPayload: { jobId, status: patch.status ?? current.data.status },
      mutate: data => Object.assign(data, patch, { updatedAt: this.now() })
    });
    return { ...committed.entity.data, version: committed.entity.version };
  }

  async listQueued() {
    this.assertSecureStore();
    const rows = await this.bridge.listEntities('print_job');
    return rows.filter(row => ['QUEUED', 'RETRY_REQUIRED'].includes(row.data?.status))
      .map(row => ({ ...row.data, version: row.version }));
  }

  async appendPrintLog(entry) {
    this.assertSecureStore();
    const logId = makeId('printlog_');
    const committed = await this.bridge.mutateEntity({
      entityType: 'audit',
      entityId: logId,
      expectedVersion: 0,
      eventType: 'printing.print_log_appended',
      eventPayload: { jobId: entry.jobId, copyNumber: entry.copyNumber, result: entry.result },
      mutate: data => Object.assign(data, {
        id: logId,
        kind: 'printer',
        billNo: entry.billNo,
        jobId: entry.jobId,
        staffId: entry.staffId,
        copyNumber: entry.copyNumber,
        printedAt: entry.printedAt,
        result: entry.result
      })
    });
    return committed.entity;
  }
}
