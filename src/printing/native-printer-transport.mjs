function resolvePlugin() {
  const capacitor = globalThis.Capacitor;
  if (!capacitor || typeof capacitor.registerPlugin !== 'function') return null;
  return capacitor.registerPlugin('AureliaPrinter');
}

function encodeBase64(bytes) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

export function createNativePrinterTransports(plugin = resolvePlugin()) {
  if (!plugin) throw new Error('NATIVE_PRINTER_PLUGIN_UNAVAILABLE');
  return Object.freeze({
    'bluetooth-spp': async ({ printer, bytes }) => {
      if (!printer?.address) throw new TypeError('Paired Bluetooth printer address is required');
      return plugin.printBluetooth({ address: printer.address, data: encodeBase64(bytes) });
    },
    tcp: async ({ printer, bytes }) => {
      if (!printer?.host) throw new TypeError('Private LAN printer host is required');
      return plugin.printTcp({ host: printer.host, port: printer.port ?? 9100, data: encodeBase64(bytes) });
    }
  });
}

export async function listPairedBluetoothPrinters(plugin = resolvePlugin()) {
  if (!plugin) throw new Error('NATIVE_PRINTER_PLUGIN_UNAVAILABLE');
  const result = await plugin.listPaired();
  if (!Array.isArray(result?.devices)) throw new Error('INVALID_PAIRED_PRINTER_RESPONSE');
  return result.devices.filter(device => device?.bonded === true && typeof device.address === 'string')
    .map(device => Object.freeze({ name: String(device.name || 'Paired device'), address: device.address }));
}

export async function openBluetoothPairingSettings(plugin = resolvePlugin()) {
  if (!plugin) throw new Error('NATIVE_PRINTER_PLUGIN_UNAVAILABLE');
  await plugin.openBluetoothSettings();
  return true;
}
