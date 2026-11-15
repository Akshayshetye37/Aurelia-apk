package com.aurelia.pms;

import android.Manifest;
import android.bluetooth.BluetoothAdapter;
import android.bluetooth.BluetoothDevice;
import android.bluetooth.BluetoothManager;
import android.bluetooth.BluetoothSocket;
import android.content.Context;
import android.content.Intent;
import android.os.Build;
import android.util.Base64;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

import java.io.OutputStream;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.net.Socket;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.ScheduledFuture;
import java.util.concurrent.TimeUnit;

@CapacitorPlugin(
  name = "AureliaPrinter",
  permissions = {
    @Permission(alias = "bluetooth", strings = { Manifest.permission.BLUETOOTH_CONNECT })
  }
)
public final class BluetoothPrinterPlugin extends Plugin {
  private static final UUID SPP = UUID.fromString("00001101-0000-1000-8000-00805F9B34FB");
  private static final int MAX_BYTES = 262144;
  private final ExecutorService io = Executors.newFixedThreadPool(2);
  private final ScheduledExecutorService watchdog = Executors.newSingleThreadScheduledExecutor();

  private BluetoothAdapter adapter() {
    BluetoothManager manager = (BluetoothManager) getContext().getSystemService(Context.BLUETOOTH_SERVICE);
    return manager == null ? null : manager.getAdapter();
  }

  private boolean hasBluetoothPermission() {
    return Build.VERSION.SDK_INT < 31 || getPermissionState("bluetooth") == PermissionState.GRANTED;
  }

  @PluginMethod public void listPaired(PluginCall call) {
    if (!hasBluetoothPermission()) {
      requestPermissionForAlias("bluetooth", call, "bluetoothPermissionCallback");
      return;
    }
    listPairedGranted(call);
  }

  @PermissionCallback private void bluetoothPermissionCallback(PluginCall call) {
    if (!hasBluetoothPermission()) {
      call.reject("Nearby devices permission is required to list paired printers", "BLUETOOTH_PERMISSION_DENIED");
      return;
    }
    listPairedGranted(call);
  }

  private void listPairedGranted(PluginCall call) {
    try {
      BluetoothAdapter adapter = adapter();
      if (adapter == null || !adapter.isEnabled()) {
        call.reject("Bluetooth is unavailable or switched off", "BLUETOOTH_UNAVAILABLE");
        return;
      }
      JSArray devices = new JSArray();
      Set<BluetoothDevice> bonded = adapter.getBondedDevices();
      for (BluetoothDevice device : bonded) {
        JSObject row = new JSObject();
        row.put("name", device.getName() == null ? "Paired device" : device.getName());
        row.put("address", device.getAddress());
        row.put("bonded", true);
        devices.put(row);
      }
      JSObject result = new JSObject();
      result.put("devices", devices);
      call.resolve(result);
    } catch (SecurityException error) {
      call.reject("Nearby devices permission is required", "BLUETOOTH_PERMISSION_DENIED");
    } catch (Exception error) {
      call.reject("Could not read paired Bluetooth devices", "BLUETOOTH_LIST_FAILED");
    }
  }

  @PluginMethod public void openBluetoothSettings(PluginCall call) {
    try {
      Intent intent = new Intent(android.provider.Settings.ACTION_BLUETOOTH_SETTINGS);
      intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
      getContext().startActivity(intent);
      call.resolve();
    } catch (Exception error) {
      call.reject("Could not open Android Bluetooth settings", "BLUETOOTH_SETTINGS_FAILED");
    }
  }

  @PluginMethod public void printBluetooth(PluginCall call) {
    if (!hasBluetoothPermission()) {
      requestPermissionForAlias("bluetooth", call, "bluetoothPrintPermissionCallback");
      return;
    }
    printBluetoothGranted(call);
  }

  @PermissionCallback private void bluetoothPrintPermissionCallback(PluginCall call) {
    if (!hasBluetoothPermission()) {
      call.reject("Nearby devices permission is required to print", "BLUETOOTH_PERMISSION_DENIED");
      return;
    }
    printBluetoothGranted(call);
  }

  private void printBluetoothGranted(PluginCall call) {
    String address = call.getString("address");
    byte[] data = decodeData(call);
    if (address == null || !address.matches("(?i)^[0-9a-f]{2}(:[0-9a-f]{2}){5}$") || data == null) {
      call.reject("Invalid Bluetooth printer address or print payload", "PRINT_REQUEST_INVALID");
      return;
    }
    io.execute(() -> {
      BluetoothSocket socket = null;
      int written = 0;
      try {
        BluetoothAdapter adapter = adapter();
        if (adapter == null || !adapter.isEnabled()) throw new IllegalStateException("BLUETOOTH_UNAVAILABLE");
        BluetoothDevice device = adapter.getRemoteDevice(address);
        if (device.getBondState() != BluetoothDevice.BOND_BONDED) throw new IllegalStateException("PRINTER_NOT_PAIRED");
        adapter.cancelDiscovery();
        socket = device.createRfcommSocketToServiceRecord(SPP);
        BluetoothSocket connectingSocket = socket;
        ScheduledFuture<?> connectTimeout = watchdog.schedule(() -> {
          try { connectingSocket.close(); } catch (Exception ignored) { }
        }, 15, TimeUnit.SECONDS);
        try {
          socket.connect();
        } finally {
          connectTimeout.cancel(false);
        }
        try (OutputStream output = socket.getOutputStream()) {
          for (int offset = 0; offset < data.length; offset += 512) {
            int count = Math.min(512, data.length - offset);
            output.write(data, offset, count);
            written += count;
            output.flush();
          }
        }
        call.resolve(printResult(true, written, "PRINT_OK"));
      } catch (Exception error) {
        call.resolve(printResult(false, written, written > 0 ? "PRINT_PARTIAL_WRITE" : safeErrorCode(error)));
      } finally {
        if (socket != null) try { socket.close(); } catch (Exception ignored) { }
        java.util.Arrays.fill(data, (byte) 0);
      }
    });
  }

  @PluginMethod public void printTcp(PluginCall call) {
    String host = call.getString("host");
    Integer requestedPort = call.getInt("port");
    int port = requestedPort == null ? 9100 : requestedPort;
    byte[] data = decodeData(call);
    if (host == null || host.length() > 253 || port != 9100 || data == null) {
      call.reject("Invalid LAN printer address or print payload", "PRINT_REQUEST_INVALID");
      return;
    }
    io.execute(() -> {
      int written = 0;
      try (Socket socket = new Socket()) {
        InetAddress address = InetAddress.getByName(host);
        if (!(address.isSiteLocalAddress() || address.isLinkLocalAddress() || address.isLoopbackAddress())) {
          throw new IllegalArgumentException("PRINTER_ADDRESS_NOT_PRIVATE");
        }
        socket.connect(new InetSocketAddress(address, port), 5000);
        socket.setSoTimeout(5000);
        try (OutputStream output = socket.getOutputStream()) {
          for (int offset = 0; offset < data.length; offset += 512) {
            int count = Math.min(512, data.length - offset);
            output.write(data, offset, count);
            written += count;
            output.flush();
          }
        }
        call.resolve(printResult(true, written, "PRINT_OK"));
      } catch (Exception error) {
        call.resolve(printResult(false, written, written > 0 ? "PRINT_PARTIAL_WRITE" : safeErrorCode(error)));
      } finally {
        java.util.Arrays.fill(data, (byte) 0);
      }
    });
  }

  private byte[] decodeData(PluginCall call) {
    String encoded = call.getString("data");
    if (encoded == null || encoded.length() > (MAX_BYTES * 4 / 3) + 8) return null;
    try {
      byte[] data = Base64.decode(encoded, Base64.NO_WRAP);
      return data.length > 0 && data.length <= MAX_BYTES ? data : null;
    } catch (IllegalArgumentException error) {
      return null;
    }
  }

  private JSObject printResult(boolean success, int bytesWritten, String code) {
    JSObject result = new JSObject();
    result.put("success", success);
    result.put("bytesWritten", bytesWritten);
    result.put("code", code);
    return result;
  }

  private String safeErrorCode(Exception error) {
    String message = error.getMessage();
    if (message != null && message.matches("[A-Z0-9_]{3,64}")) return message;
    return "PRINT_CONNECT_FAILED";
  }

  @Override protected void handleOnDestroy() {
    io.shutdownNow();
    watchdog.shutdownNow();
    super.handleOnDestroy();
  }
}
