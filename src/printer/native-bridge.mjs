import { registerPlugin } from '@capacitor/core';

const AureliaPrinter = registerPlugin('AureliaPrinter', {
  web: () => import('./web-stub.mjs').then(module => new module.AureliaPrinterWeb())
});

export const PrinterNative = Object.freeze({
  discoverLan: () => AureliaPrinter.discoverLan(),
  trustLanPrinter: input => AureliaPrinter.trustLanPrinter(input),
  getTrustedLanDevices: () => AureliaPrinter.getTrustedLanDevices(),
  revokeLanTrust: input => AureliaPrinter.revokeLanTrust(input),
  verifyLanCapabilities: input => AureliaPrinter.verifyLanCapabilities(input),
  printLan: input => AureliaPrinter.printLan(input),
  cancelJob: input => AureliaPrinter.cancelJob(input),
  listUsb: () => AureliaPrinter.listUsb(),
  requestUsbPermission: input => AureliaPrinter.requestUsbPermission(input),
  discoverBluetooth: input => AureliaPrinter.discoverBluetooth(input),
  printBluetooth: input => AureliaPrinter.printBluetooth(input),
  discoverBle: input => AureliaPrinter.discoverBle(input),
  printBle: input => AureliaPrinter.printBle(input)
});
