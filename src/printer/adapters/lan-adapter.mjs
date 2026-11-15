import {
  validatePrintRequest,
  validatePrinterProfile
} from '../printer-security.mjs';
import { PrinterAdapter, failedPrintResult } from '../printer-adapter.mjs';

const safeError = error => {
  const code = typeof error?.code === 'string' ? error.code : '';
  return /^[a-z0-9_]{1,64}$/.test(code) ? code : 'lan_printer_operation_failed';
};

export class LanPrinterAdapter extends PrinterAdapter {
  constructor({ native } = {}) {
    super();
    if (!native || typeof native.discoverLan !== 'function' ||
        typeof native.trustLanPrinter !== 'function' ||
        typeof native.verifyLanCapabilities !== 'function' ||
        typeof native.printLan !== 'function' ||
        typeof native.cancelJob !== 'function') {
      throw new TypeError('native_lan_printer_plugin_required');
    }
    this.native = native;
  }

  async discover() {
    try {
      const result = await this.native.discoverLan();
      if (!Array.isArray(result?.candidates)) return [];
      return result.candidates.filter(candidate =>
        candidate && typeof candidate.deviceId === 'string' &&
        /^[A-Za-z0-9_-]{8,128}$/.test(candidate.deviceId) &&
        typeof candidate.name === 'string' && candidate.name.length <= 120
      ).map(candidate => Object.freeze({
        deviceId: candidate.deviceId,
        name: candidate.name,
        transport: 'tcp',
        trusted: false
      }));
    } catch {
      return [];
    }
  }

  async trust(deviceId, { host, port = 9100, userConfirmed = false } = {}) {
    if (typeof deviceId !== 'string' || !/^[A-Za-z0-9_-]{8,128}$/.test(deviceId) ||
        typeof host !== 'string' || port !== 9100 || userConfirmed !== true) {
      return { ok: false, error: 'explicit_printer_trust_required' };
    }
    try {
      const result = await this.native.trustLanPrinter({ deviceId, host, port, userConfirmed: true });
      return result?.ok === true && result.trusted === true
        ? { ok: true, deviceId, trusted: true }
        : { ok: false, error: safeError(result) };
    } catch (error) {
      return { ok: false, error: safeError(error) };
    }
  }

  async verifyCapabilities(device) {
    if (!device || device.transport !== 'tcp' || device.trusted !== true ||
        typeof device.deviceId !== 'string' || !/^[A-Za-z0-9_-]{8,128}$/.test(device.deviceId)) {
      return { ok: false, error: 'trusted_lan_device_required' };
    }
    try {
      const result = await this.native.verifyLanCapabilities({ deviceId: device.deviceId });
      if (result?.ok !== true) return { ok: false, error: safeError(result) };
      const profile = validatePrinterProfile(result.profile);
      if (!profile.ok || profile.value.transport !== 'tcp') {
        return { ok: false, error: profile.error || 'invalid_lan_printer_profile' };
      }
      return { ok: true, profile: profile.value };
    } catch (error) {
      return { ok: false, error: safeError(error) };
    }
  }

  async print(rawRequest, device) {
    const request = validatePrintRequest(rawRequest);
    if (!request.ok) return failedPrintResult(request.error, rawRequest?.requestId);
    if (!device || device.transport !== 'tcp' || device.trusted !== true ||
        typeof device.deviceId !== 'string' || !/^[A-Za-z0-9_-]{8,128}$/.test(device.deviceId)) {
      return failedPrintResult('trusted_lan_device_required', request.value.requestId);
    }
    const profile = validatePrinterProfile(device.profile);
    if (!profile.ok || profile.value.transport !== 'tcp') {
      return failedPrintResult(profile.error || 'invalid_lan_printer_profile', request.value.requestId);
    }
    try {
      const result = await this.native.printLan({
        deviceId: device.deviceId,
        request: request.value
      });
      const status = ['accepted', 'printed', 'uncertain', 'failed'].includes(result?.status)
        ? result.status : 'uncertain';
      return Object.freeze({
        ok: result?.ok === true && status !== 'failed',
        status,
        jobId: request.value.requestId,
        ...(result?.ok === true ? {} : { error: safeError(result) })
      });
    } catch (error) {
      return failedPrintResult(safeError(error), request.value.requestId);
    }
  }

  async cancel(jobId) {
    if (typeof jobId !== 'string' || !/^job_[A-Za-z0-9_-]{8,64}$/.test(jobId)) {
      return { ok: false, error: 'invalid_job_id' };
    }
    try {
      const result = await this.native.cancelJob({ jobId });
      return { ok: result?.ok === true, ...(result?.ok === true ? {} : { error: safeError(result) }) };
    } catch (error) {
      return { ok: false, error: safeError(error) };
    }
  }
}
