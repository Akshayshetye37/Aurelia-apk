import { resolvePrinterSupport } from './printer-catalog.mjs';
import { layoutReceipt } from './receipt-layout.mjs';
import { encodeEscPos } from './escpos.mjs';
import { encodeZplLabel } from './zpl.mjs';

export const DEFAULT_PRINT_FLAGS = Object.freeze({ BT_PRINTING_ENABLED: false });
const REPRINT_ROLES = new Set(['admin', 'manager', 'front_desk_supervisor', 'supervisor']);

function makeId() {
  if (!globalThis.crypto?.randomUUID) throw new Error('Secure print job ID generation is unavailable');
  return 'print_' + globalThis.crypto.randomUUID();
}

function encodeJob(job) {
  if (job.protocol === 'zpl') {
    if (!job.label) throw new TypeError('Label content is required for a ZPL printer');
    return encodeZplLabel(job.label);
  }
  return encodeEscPos(layoutReceipt(job.receipt, job.paper), { cut: job.cut !== false });
}

export function createPrintService({ repository, transports = {}, flags = DEFAULT_PRINT_FLAGS, now = () => new Date().toISOString() } = {}) {
  if (!repository || typeof repository.enqueue !== 'function' || typeof repository.getJob !== 'function' ||
      typeof repository.updateJob !== 'function' || typeof repository.appendPrintLog !== 'function') {
    throw new TypeError('Durable print queue repository is required');
  }

  async function dispatch(jobId) {
    let job = await repository.getJob(jobId);
    if (!job) throw new Error('PRINT_JOB_NOT_FOUND');
    if (!['QUEUED', 'RETRY_REQUIRED'].includes(job.status)) return job;
    const transport = transports[job.transport];
    if (typeof transport !== 'function') throw new Error('PRINTER_TRANSPORT_UNAVAILABLE');

    job = await repository.updateJob(jobId, { status: 'PRINTING', attempts: job.attempts + 1 }, 'printing.job_started');
    const bytes = encodeJob(job);
    let result;
    try {
      result = await transport({ printer: job.printer, bytes });
    } catch (error) {
      result = { success: false, bytesWritten: Number.isSafeInteger(error?.bytesWritten) ? error.bytesWritten : 0, code: 'PRINT_TRANSPORT_FAILED' };
    }

    if (result?.success === true && result.bytesWritten === bytes.length) {
      job = await repository.updateJob(jobId, { status: 'PRINTED', completedAt: now(), resultCode: 'PRINT_OK' }, 'printing.job_completed');
      await repository.appendPrintLog({
        jobId, billNo: job.billNo, staffId: job.staffId, copyNumber: job.copyNumber,
        printedAt: job.completedAt, result: 'PRINTED'
      });
      return job;
    }

    const bytesWritten = Number.isSafeInteger(result?.bytesWritten) && result.bytesWritten >= 0 ? result.bytesWritten : 0;
    if (bytesWritten > 0) {
      return repository.updateJob(jobId, {
        status: 'UNKNOWN',
        resultCode: 'PRINT_RESULT_UNKNOWN',
        bytesWritten,
        updatedAt: now()
      }, 'printing.job_result_unknown');
    }

    if (job.attempts < 2) {
      job = await repository.updateJob(jobId, {
        status: 'QUEUED',
        resultCode: result?.code || 'PRINTER_NOT_REACHED',
        updatedAt: now()
      }, 'printing.job_retry_queued');
      return dispatch(jobId);
    }
    return repository.updateJob(jobId, {
      status: 'RETRY_REQUIRED',
      resultCode: result?.code || 'PRINT_RETRY_EXHAUSTED',
      updatedAt: now()
    }, 'printing.job_retry_exhausted');
  }

  async function submit({ printer, transport, jobKind, receipt, label, paper = '58mm', staff, cut = true } = {}) {
    if (flags.BT_PRINTING_ENABLED !== true) throw new Error('PRINTER_FEATURE_DISABLED');
    if (!staff?.id || !staff?.role) throw new TypeError('Authenticated staff identity is required');
    const support = resolvePrinterSupport(printer?.modelId, transport, jobKind);
    if (!support.supported) throw new Error(support.reason);
    if (support.protocol === 'escpos' && !receipt) throw new TypeError('Receipt model is required');
    if (support.protocol === 'zpl' && !label) throw new TypeError('Label model is required');

    const job = {
      jobId: makeId(),
      billNo: receipt?.billNo || label?.reference || 'LABEL',
      staffId: String(staff.id),
      staffRole: String(staff.role),
      printer: {
        id: String(printer.id),
        modelId: support.model.id,
        name: support.model.name,
        address: printer.address ? String(printer.address) : '',
        host: printer.host ? String(printer.host) : '',
        port: Number.isSafeInteger(printer.port) ? printer.port : 9100
      },
      transport,
      protocol: support.protocol,
      jobKind,
      paper,
      cut: cut === true,
      receipt: receipt ?? null,
      label: label ?? null,
      copyNumber: 0,
      attempts: 0,
      status: 'QUEUED',
      createdAt: now(),
      updatedAt: now()
    };
    await repository.enqueue(job);
    return dispatch(job.jobId);
  }

  async function reprint(jobId, staff) {
    if (!staff?.id || !REPRINT_ROLES.has(staff.role)) throw new Error('PRINTER_REPRINT_ROLE_REQUIRED');
    const original = await repository.getJob(jobId);
    if (!original || original.status !== 'PRINTED') throw new Error('ONLY_CONFIRMED_PRINTS_CAN_BE_REPRINTED');
    const duplicate = {
      ...original,
      jobId: makeId(),
      staffId: String(staff.id),
      staffRole: String(staff.role),
      copyNumber: original.copyNumber + 1,
      attempts: 0,
      status: 'QUEUED',
      createdAt: now(),
      updatedAt: now(),
      receipt: original.receipt ? { ...original.receipt, reprint: original.copyNumber + 1 } : null
    };
    await repository.enqueue(duplicate);
    return dispatch(duplicate.jobId);
  }

  async function resumeQueuedJobs() {
    const queued = await repository.listQueued();
    const results = [];
    for (const job of queued) {
      if (job.status === 'RETRY_REQUIRED') {
        await repository.updateJob(job.jobId, { status: 'QUEUED', attempts: 0 }, 'printing.job_manually_resumed');
      }
      results.push(await dispatch(job.jobId));
    }
    return results;
  }

  return Object.freeze({ submit, reprint, resumeQueuedJobs, dispatch });
}
