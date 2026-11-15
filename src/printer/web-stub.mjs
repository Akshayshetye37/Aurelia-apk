const unavailable = async () => {
  throw new Error('native_printer_plugin_unavailable');
};

export class AureliaPrinterWeb {
  discoverLan = unavailable;
  trustLanPrinter = unavailable;
  verifyLanCapabilities = unavailable;
  printLan = unavailable;
  cancelJob = unavailable;
  listUsb = unavailable;
  requestUsbPermission = unavailable;
  discoverBluetooth = unavailable;
  printBluetooth = unavailable;
  discoverBle = unavailable;
  printBle = unavailable;
}
