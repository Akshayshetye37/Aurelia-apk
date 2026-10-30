const fs = require('fs');
const path = require('path');

const androidDir = path.join(__dirname, '..', 'android');
const appDir = path.join(androidDir, 'app', 'src', 'main');
const manifestPath = path.join(appDir, 'AndroidManifest.xml');
if (!fs.existsSync(manifestPath)) throw new Error('AndroidManifest.xml not found; run npx cap add android first.');

let manifest = fs.readFileSync(manifestPath, 'utf8');

// Pay Bridge package visibility and signature-protected IPC permission.
// This is intentionally only discovery/permission groundwork: the PMS does not
// report a connection until a future native client completes a real handshake.
if (!manifest.includes('<queries>')) {
  manifest = manifest.replace(/<manifest[^>]*>/, match => match + '\n    <queries>\n        <package android:name="com.aurelia.paybridge" />\n    </queries>');
} else if (!manifest.includes('com.aurelia.paybridge')) {
  manifest = manifest.replace('</queries>', '        <package android:name="com.aurelia.paybridge" />\n    </queries>');
}
if (!manifest.includes('com.aurelia.paybridge.permission.BIND_PAY_BRIDGE')) {
  manifest = manifest.replace(/<application\b/, '    <uses-permission android:name="com.aurelia.paybridge.permission.BIND_PAY_BRIDGE" />\n    <application');
}
if (!manifest.includes('android.permission.INTERNET')) {
  manifest = manifest.replace(/<application\b/, '    <uses-permission android:name="android.permission.INTERNET" />\n    <application');
}
// Use app-private storage and Android's Storage Access Framework. The WebView file picker
// delegates camera capture to the selected camera app, so Aurelia itself needs no CAMERA
// or broad/legacy storage permission. Remove these even if a transitive manifest adds them.
if (!manifest.includes('xmlns:tools=')) {
  manifest = manifest.replace('<manifest', '<manifest xmlns:tools="http://schemas.android.com/tools"');
}
// Aurelia PMS deliberately avoids dangerous and special permissions. Features use
// Android's Photo Picker, Storage Access Framework and explicit system intents instead.
// The narrow Pay Bridge package query and signature permission are not broad app inventory access.
const permissionsToRemove = [
  'android.permission.PACKAGE_USAGE_STATS',
  'android.permission.WRITE_SECURE_SETTINGS',
  'android.permission.READ_BASIC_PHONE_STATE',
  'android.permission.READ_CELL_BROADCASTS',
  'android.permission.BIND_NOTIFICATION_LISTENER_SERVICE',
  'android.permission.BIND_ACCESSIBILITY_SERVICE',
  'android.permission.BIND_VPN_SERVICE',
  'android.permission.ACCESS_MEDIA_LOCATION',
  'android.permission.READ_CALENDAR',
  'android.permission.WRITE_CALENDAR',
  'android.permission.READ_VOICEMAIL',
  'android.permission.WRITE_VOICEMAIL',
  'android.permission.ACCEPT_HANDOVER',
  'android.permission.UWB_RANGING',
  'android.permission.READ_HEALTH_DATA_IN_BACKGROUND',
  'android.permission.READ_HEALTH_DATA',
  'android.permission.WRITE_HEALTH_DATA',
  'android.permission.FOREGROUND_SERVICE',
  'android.permission.FOREGROUND_SERVICE_DATA_SYNC',
  'android.permission.FOREGROUND_SERVICE_CONNECTED_DEVICE',
  'android.permission.FOREGROUND_SERVICE_HEALTH',
  'android.permission.FOREGROUND_SERVICE_REMOTE_MESSAGING',
  'android.permission.FOREGROUND_SERVICE_SYSTEM_EXEMPTED',
  'android.permission.FOREGROUND_SERVICE_PHONE_CALL',
  'android.permission.USE_FULL_SCREEN_INTENT',
  'android.permission.REQUEST_COMPANION_RUN_IN_BACKGROUND',
  'android.permission.REQUEST_COMPANION_USE_DATA_IN_BACKGROUND',
  'android.permission.REQUEST_COMPANION_START_FOREGROUND_SERVICES_FROM_BACKGROUND',
  'com.google.android.gms.permission.AD_ID',
  'android.permission.CAMERA',
  'android.permission.READ_EXTERNAL_STORAGE',
  'android.permission.WRITE_EXTERNAL_STORAGE',
  'android.permission.READ_MEDIA_IMAGES',
  'android.permission.READ_MEDIA_VIDEO',
  'android.permission.READ_MEDIA_AUDIO',
  'android.permission.READ_MEDIA_VISUAL_USER_SELECTED',
  'android.permission.MANAGE_EXTERNAL_STORAGE',
  'android.permission.READ_SMS',
  'android.permission.RECEIVE_SMS',
  'android.permission.SEND_SMS',
  'android.permission.RECEIVE_MMS',
  'android.permission.RECEIVE_WAP_PUSH',
  'android.permission.READ_CALL_LOG',
  'android.permission.WRITE_CALL_LOG',
  'android.permission.PROCESS_OUTGOING_CALLS',
  'android.permission.READ_PHONE_STATE',
  'android.permission.READ_PHONE_NUMBERS',
  'android.permission.CALL_PHONE',
  'android.permission.ANSWER_PHONE_CALLS',
  'android.permission.ADD_VOICEMAIL',
  'android.permission.USE_SIP',
  'android.permission.READ_CONTACTS',
  'android.permission.WRITE_CONTACTS',
  'android.permission.GET_ACCOUNTS',
  'android.permission.ACCESS_FINE_LOCATION',
  'android.permission.ACCESS_COARSE_LOCATION',
  'android.permission.ACCESS_BACKGROUND_LOCATION',
  'android.permission.RECORD_AUDIO',
  'android.permission.BODY_SENSORS',
  'android.permission.BODY_SENSORS_BACKGROUND',
  'android.permission.ACTIVITY_RECOGNITION',
  'android.permission.POST_NOTIFICATIONS',
  'android.permission.BLUETOOTH',
  'android.permission.BLUETOOTH_ADMIN',
  'android.permission.BLUETOOTH_SCAN',
  'android.permission.BLUETOOTH_CONNECT',
  'android.permission.BLUETOOTH_ADVERTISE',
  'android.permission.NEARBY_WIFI_DEVICES',
  'android.permission.NFC',
  'android.permission.QUERY_ALL_PACKAGES',
  'android.permission.SYSTEM_ALERT_WINDOW',
  'android.permission.WRITE_SETTINGS',
  'android.permission.ACCESS_NOTIFICATION_POLICY',
  'android.permission.SCHEDULE_EXACT_ALARM',
  'android.permission.USE_EXACT_ALARM',
  'android.permission.REQUEST_IGNORE_BATTERY_OPTIMIZATIONS',
  'android.permission.USE_BIOMETRIC',
  'android.permission.USE_FINGERPRINT',
  'android.permission.FOREGROUND_SERVICE_CAMERA',
  'android.permission.FOREGROUND_SERVICE_MICROPHONE',
  'android.permission.FOREGROUND_SERVICE_LOCATION',
  'android.permission.FOREGROUND_SERVICE_MEDIA_PROJECTION',
  'android.permission.FOREGROUND_SERVICE_SPECIAL_USE',
  'android.permission.REQUEST_INSTALL_PACKAGES',
  'android.permission.REQUEST_DELETE_PACKAGES'
];
for (const permission of permissionsToRemove) {
  const marker = '<uses-permission android:name="' + permission + '" tools:node="remove" />';
  if (!manifest.includes(marker)) manifest = manifest.replace('</manifest>', '    ' + marker + '\n</manifest>');
}
// Keep the future Pay Bridge discovery narrowly scoped; never request QUERY_ALL_PACKAGES.
fs.writeFileSync(manifestPath, manifest);


const { execFileSync } = require('child_process');
const iconSvg = path.join(__dirname, '..', 'assets', 'aurelia-icon.svg');
const foregroundSvg = path.join(__dirname, '..', 'assets', 'aurelia-icon-foreground.svg');
const resDir = path.join(appDir, 'res');
const providerBlock = `if (!manifest.includes('androidx.core.content.FileProvider')) {
  manifest = manifest.replace('</application>', '    <provider android:name="androidx.core.content.FileProvider" android:authorities="\${applicationId}.fileprovider" android:exported="false" android:grantUriPermissions="true"><meta-data android:name="android.support.FILE_PROVIDER_PATHS" android:resource="@xml/aurelia_file_paths" /></provider></application>');
}
fs.mkdirSync(path.join(resDir, 'xml'), { recursive: true });
fs.writeFileSync(path.join(resDir, 'xml', 'aurelia_file_paths.xml'), '<?xml version="1.0" encoding="utf-8"?><paths xmlns:android="http://schemas.android.com/apk/res/android"><cache-path name="shared" path="shared/" /></paths>');
`;
eval(providerBlock);

if (fs.existsSync(iconSvg)) {
  const densities = { 'mdpi':48, 'hdpi':72, 'xhdpi':96, 'xxhdpi':144, 'xxxhdpi':192 };
  for (const [density, size] of Object.entries(densities)) {
    const dir = path.join(resDir, 'mipmap-' + density);
    fs.mkdirSync(dir, { recursive: true });
    for (const name of ['ic_launcher', 'ic_launcher_round']) {
      execFileSync(process.execPath, ['-e', 'const sharp=require("sharp"); sharp(process.argv[1]).resize(+process.argv[3],+process.argv[3]).png().toFile(process.argv[2]).then(()=>{}).catch(e=>{console.error(e);process.exit(1)})', iconSvg, path.join(dir, name + '.png'), String(size)]);
    }
    const foregroundSource = fs.existsSync(foregroundSvg) ? foregroundSvg : iconSvg;
    const foregroundSize = Math.round(size * 2.25);
    execFileSync(process.execPath, ['-e', 'const sharp=require("sharp"); sharp(process.argv[1]).resize(+process.argv[3],+process.argv[3],{fit:"contain"}).png().toFile(process.argv[2]).then(()=>{}).catch(e=>{console.error(e);process.exit(1)})', foregroundSource, path.join(dir, 'ic_launcher_foreground.png'), String(foregroundSize)]);
  }
  const adaptiveDir = path.join(resDir, 'mipmap-anydpi-v26');
  fs.mkdirSync(adaptiveDir, { recursive: true });
  const adaptive = '<?xml version="1.0" encoding="utf-8"?><adaptive-icon xmlns:android="http://schemas.android.com/apk/res/android"><background android:drawable="@color/aurelia_icon_background"/><foreground android:drawable="@mipmap/ic_launcher_foreground"/></adaptive-icon>';
  fs.writeFileSync(path.join(adaptiveDir, 'ic_launcher.xml'), adaptive);
  fs.writeFileSync(path.join(adaptiveDir, 'ic_launcher_round.xml'), adaptive);
  const valuesDir = path.join(resDir, 'values');
  fs.mkdirSync(valuesDir, { recursive: true });
  const colorsPath = path.join(valuesDir, 'aurelia_icon_colors.xml');
  fs.writeFileSync(colorsPath, '<?xml version="1.0" encoding="utf-8"?><resources><color name="aurelia_icon_background">#082419</color></resources>');
  console.log('Generated adaptive-safe Aurelia PMS launcher icons for all Android densities.');
}

const javaDir = path.join(appDir, 'java', 'com', 'aurelia', 'pms');
fs.mkdirSync(javaDir, { recursive: true });

const appModuleDir = path.join(androidDir, 'app');
const appGradleGroovy = path.join(appModuleDir, 'build.gradle');
const appGradleKts = path.join(appModuleDir, 'build.gradle.kts');
if (fs.existsSync(appGradleGroovy)) {
  let gradle = fs.readFileSync(appGradleGroovy, 'utf8');
  if (!gradle.includes('com.google.mlkit:text-recognition:')) {
    gradle = gradle.replace(/dependencies\s*\{/, match => match + "\n    implementation 'com.google.mlkit:text-recognition:16.0.1'");
    fs.writeFileSync(appGradleGroovy, gradle);
  }
} else if (fs.existsSync(appGradleKts)) {
  let gradle = fs.readFileSync(appGradleKts, 'utf8');
  if (!gradle.includes('com.google.mlkit:text-recognition:')) {
    gradle = gradle.replace(/dependencies\s*\{/, match => match + '\n    implementation("com.google.mlkit:text-recognition:16.0.1")');
    fs.writeFileSync(appGradleKts, gradle);
  }
}

const payBridgeTemplate = path.join(androidDir, 'templates', 'PayBridgeClient.java');
if (!fs.existsSync(payBridgeTemplate)) throw new Error('PayBridgeClient.java template is missing.');
fs.copyFileSync(payBridgeTemplate, path.join(javaDir, 'PayBridgeClient.java'));
const payBridgeProtocolTemplate = path.join(androidDir, 'templates', 'PayBridgeProtocol.java');
if (!fs.existsSync(payBridgeProtocolTemplate)) throw new Error('PayBridgeProtocol.java template is missing.');
fs.copyFileSync(payBridgeProtocolTemplate, path.join(javaDir, 'PayBridgeProtocol.java'));

const javaPath = path.join(javaDir, 'MainActivity.java');
const java = String.raw`
package com.aurelia.pms;

import android.content.Intent;
import android.content.SharedPreferences;
import android.net.Uri;
import android.os.Bundle;
import android.provider.DocumentsContract;
import android.provider.MediaStore;
import android.provider.OpenableColumns;
import android.os.Build;
import android.graphics.Color;
import android.view.WindowManager;
import android.database.Cursor;
import android.util.Base64;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import com.google.mlkit.vision.common.InputImage;
import com.google.mlkit.vision.text.TextRecognition;
import com.google.mlkit.vision.text.TextRecognizer;
import com.google.mlkit.vision.text.latin.TextRecognizerOptions;
import android.webkit.JavascriptInterface;
import org.json.JSONObject;
import com.getcapacitor.BridgeActivity;
import androidx.activity.OnBackPressedCallback;
import java.io.OutputStream;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

public class MainActivity extends BridgeActivity {
  private static final int PICK_BACKUP_FOLDER = 7101;
  private static final int CREATE_BACKUP_FILE = 7102;
  private static final int PICK_IMAGE_FILE = 7103;
  private String folderRequestId = "";
  private String pendingFileRequestId = "";
  private String pendingImageRequestId = "";
  private TextRecognizer ocrRecognizer;
  private byte[] pendingBytes = new byte[0];
  private boolean pendingIsBackup = false;
  private SharedPreferences prefs;
  private PayBridgeClient payBridgeClient;
  private final ExecutorService backupExecutor = Executors.newSingleThreadExecutor();

  @Override public void onCreate(Bundle savedInstanceState) {
    super.onCreate(savedInstanceState);
    getOnBackPressedDispatcher().addCallback(this, new OnBackPressedCallback(true) {
      @Override public void handleOnBackPressed() {
        if (bridge == null || bridge.getWebView() == null) {
          setEnabled(false);
          getOnBackPressedDispatcher().onBackPressed();
          setEnabled(true);
          return;
        }
        bridge.getWebView().evaluateJavascript(
          "(function(){return !!(window.aureliaHandleAndroidBack && window.aureliaHandleAndroidBack())})()",
          value -> {
            if (!"true".equals(value)) {
              setEnabled(false);
              getOnBackPressedDispatcher().onBackPressed();
              setEnabled(true);
            }
          }
        );
      }
    });
    prefs = getSharedPreferences("aurelia_storage", MODE_PRIVATE);
    getWindow().setStatusBarColor(Color.rgb(5, 17, 13));
    getWindow().setNavigationBarColor(Color.rgb(5, 17, 13));
    getWindow().getDecorView().setSystemUiVisibility(0);
    getWindow().setSoftInputMode(WindowManager.LayoutParams.SOFT_INPUT_ADJUST_RESIZE);
    if (Build.VERSION.SDK_INT >= 29) getWindow().setNavigationBarContrastEnforced(false);
    payBridgeClient = new PayBridgeClient(this, status -> js("window.aureliaPayBridgeStatusChanged && window.aureliaPayBridgeStatusChanged(" + q(status) + ")"));
    bridge.getWebView().addJavascriptInterface(new AureliaBridge(), "AureliaNative");
    payBridgeClient.connect();
  }

  @Override public void onResume() {
    super.onResume();
    if (payBridgeClient != null) payBridgeClient.connect();
  }

  @Override public void onDestroy() {
    if (payBridgeClient != null) payBridgeClient.disconnect();
    backupExecutor.shutdown();
    if (ocrRecognizer != null) { ocrRecognizer.close(); ocrRecognizer = null; }
    super.onDestroy();
  }

  private TextRecognizer getOcrRecognizer() {
    if (ocrRecognizer == null) ocrRecognizer = TextRecognition.getClient(TextRecognizerOptions.DEFAULT_OPTIONS);
    return ocrRecognizer;
  }

  private void launchImagePicker(String requestId) {
    pendingImageRequestId = requestId;
    Intent intent = Build.VERSION.SDK_INT >= 33 ? new Intent(MediaStore.ACTION_PICK_IMAGES) : new Intent(Intent.ACTION_OPEN_DOCUMENT);
    intent.setType("image/*"); intent.addCategory(Intent.CATEGORY_OPENABLE);
    intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
    try { startActivityForResult(intent, PICK_IMAGE_FILE); }
    catch (Exception e) { pendingImageRequestId = ""; imageResult(requestId, false, "The Android photo picker could not be opened."); }
  }
  private void imageResult(String id, boolean ok, String payload) {
    js("window.aureliaNativeImagePicked && window.aureliaNativeImagePicked(" + q(id) + "," + q(payload) + "," + ok + ")");
  }
  private JSONObject readPickedImage(Uri uri) throws Exception {
    String mime = getContentResolver().getType(uri), name = "selected-image";
    try (Cursor cursor = getContentResolver().query(uri, new String[]{OpenableColumns.DISPLAY_NAME}, null, null, null)) {
      if (cursor != null && cursor.moveToFirst()) { int index = cursor.getColumnIndex(OpenableColumns.DISPLAY_NAME); if (index >= 0 && cursor.getString(index) != null) name = cursor.getString(index); }
    }
    try (InputStream input = getContentResolver().openInputStream(uri); java.io.ByteArrayOutputStream output = new java.io.ByteArrayOutputStream()) {
      if (input == null) throw new IllegalStateException("Could not read the selected image.");
      byte[] buffer = new byte[16384]; int count; long total = 0;
      while ((count = input.read(buffer)) != -1) { total += count; if (total > 20L * 1024L * 1024L) throw new IllegalArgumentException("Choose an image smaller than 20 MB."); output.write(buffer, 0, count); }
      JSONObject result = new JSONObject(); result.put("name", name); result.put("mime", mime == null ? "image/jpeg" : mime); result.put("data", Base64.encodeToString(output.toByteArray(), Base64.NO_WRAP)); return result;
    }
  }

  private void js(String script) {
    runOnUiThread(() -> {
      if (bridge != null && bridge.getWebView() != null) bridge.getWebView().evaluateJavascript(script, null);
    });
  }
  private static String q(String value) { return JSONObject.quote(value == null ? "" : value); }
  private void folderResult(String id, boolean ok, String message) {
    js("window.aureliaNativeBackupFolderResult && window.aureliaNativeBackupFolderResult(" + q(id) + "," + ok + "," + q(message) + ")");
  }
  private void backupResult(String id, boolean ok, String error) {
    js("window.aureliaNativeDeviceBackupResult && window.aureliaNativeDeviceBackupResult(" + q(id) + "," + ok + "," + q(error) + ")");
  }
  private void recoveryResult(String id, boolean ok, String payload, String fileName) {
    js("window.aureliaNativeRecoveryBackupResult && window.aureliaNativeRecoveryBackupResult(" + q(id) + "," + ok + "," + q(payload) + "," + q(fileName) + ")");
  }
  private boolean hasBackupForHash(String dataHash) throws Exception {
    String saved = prefs.getString("backup_tree_uri", "");
    if (saved.isEmpty()) return false;
    Uri tree = Uri.parse(saved);
    Uri children = DocumentsContract.buildChildDocumentsUriUsingTree(tree, DocumentsContract.getTreeDocumentId(tree));
    String[] projection = { DocumentsContract.Document.COLUMN_DISPLAY_NAME };
    try (Cursor cursor = getContentResolver().query(children, projection, null, null, null)) {
      if (cursor == null) throw new IllegalStateException("The selected backup folder cannot be read.");
      int nameCol = cursor.getColumnIndexOrThrow(DocumentsContract.Document.COLUMN_DISPLAY_NAME);
      while (cursor.moveToNext()) {
        String name = cursor.getString(nameCol);
        if (name != null && name.startsWith("aurelia-backup-") && name.endsWith("-" + dataHash + ".json")) return true;
      }
    }
    return false;
  }
  private JSONObject readLatestBackupFromSelectedFolder(String excludedJson) throws Exception {
    String saved = prefs.getString("backup_tree_uri", "");
    if (saved.isEmpty()) throw new IllegalStateException("No backup folder is selected.");
    java.util.HashSet<String> excluded = new java.util.HashSet<>();
    try { org.json.JSONArray values = new org.json.JSONArray(excludedJson == null ? "[]" : excludedJson); for (int i = 0; i < values.length(); i++) excluded.add(values.optString(i)); } catch (Exception ignored) { }
    Uri tree = Uri.parse(saved);
    Uri children = DocumentsContract.buildChildDocumentsUriUsingTree(tree, DocumentsContract.getTreeDocumentId(tree));
    String[] projection = { DocumentsContract.Document.COLUMN_DOCUMENT_ID, DocumentsContract.Document.COLUMN_DISPLAY_NAME, DocumentsContract.Document.COLUMN_LAST_MODIFIED };
    Uri latest = null; String latestName = null; long latestModified = Long.MIN_VALUE;
    try (Cursor cursor = getContentResolver().query(children, projection, null, null, null)) {
      if (cursor == null) throw new IllegalStateException("The selected backup folder cannot be read.");
      int idCol = cursor.getColumnIndexOrThrow(DocumentsContract.Document.COLUMN_DOCUMENT_ID);
      int nameCol = cursor.getColumnIndexOrThrow(DocumentsContract.Document.COLUMN_DISPLAY_NAME);
      int modifiedCol = cursor.getColumnIndex(DocumentsContract.Document.COLUMN_LAST_MODIFIED);
      while (cursor.moveToNext()) {
        String name = cursor.getString(nameCol);
        if (name == null || !name.startsWith("aurelia-backup-") || !name.endsWith(".json") || excluded.contains(name)) continue;
        long modified = modifiedCol >= 0 && !cursor.isNull(modifiedCol) ? cursor.getLong(modifiedCol) : 0L;
        if (latest == null || modified > latestModified) {
          latestModified = modified; latestName = name;
          latest = DocumentsContract.buildDocumentUriUsingTree(tree, cursor.getString(idCol));
        }
      }
    }
    if (latest == null) throw new IllegalStateException("No additional Aurelia backup file was found in the selected folder.");
    JSONObject result = new JSONObject();
    result.put("name", latestName);
    result.put("payload", new String(readDocument(latest), StandardCharsets.UTF_8));
    return result;
  }


  // Local-first PMS backups live in private app storage. No storage permission or
  // SAF grant is required for the primary copy. SAF destinations are secondary exports.
  private java.io.File privateBackupDir() {
    java.io.File dir = new java.io.File(getFilesDir(), "backups/pms");
    if (!dir.exists() && !dir.mkdirs()) throw new IllegalStateException("Could not create private PMS backup directory.");
    return dir;
  }
  private void writePrivateBackup(String name, String payload) throws Exception {
    if (name == null || !name.matches("^aurelia-backup-[A-Za-z0-9._-]+\\.json$")) throw new IllegalArgumentException("Invalid PMS backup filename.");
    byte[] bytes = payload.getBytes(StandardCharsets.UTF_8);
    java.io.File dir = privateBackupDir();
    java.io.File stage = new java.io.File(dir, "." + name + ".staging");
    java.io.File target = new java.io.File(dir, name);
    try (java.io.FileOutputStream out = new java.io.FileOutputStream(stage)) {
      out.write(bytes); out.flush(); out.getFD().sync();
    }
    if (!sha256(bytes).equals(sha256(readFileBytes(stage)))) {
      stage.delete(); throw new IllegalStateException("Private local backup failed SHA-256 verification.");
    }
    if (target.exists() && !target.delete()) { stage.delete(); throw new IllegalStateException("Could not replace previous local backup."); }
    if (!stage.renameTo(target)) { stage.delete(); throw new IllegalStateException("Could not publish the verified local backup."); }
    java.io.File[] files = dir.listFiles((d, n) -> n.matches("^aurelia-backup-[A-Za-z0-9._-]+\\.json$"));
    if (files != null) {
      java.util.Arrays.sort(files, (a,b) -> Long.compare(b.lastModified(), a.lastModified()));
      for (int i=7;i<files.length;i++) if (!files[i].delete()) android.util.Log.w("AureliaBackup","Could not prune old local backup "+files[i].getName());
    }
  }
  private byte[] readFileBytes(java.io.File file) throws Exception {
    try (java.io.FileInputStream in = new java.io.FileInputStream(file);
         java.io.ByteArrayOutputStream out = new java.io.ByteArrayOutputStream()) {
      byte[] buffer = new byte[16384]; int count;
      while ((count=in.read(buffer))!=-1) out.write(buffer,0,count);
      return out.toByteArray();
    }
  }
  private boolean hasPrivateBackup(String hash) {
    if (hash == null || hash.isEmpty()) return false;
    java.io.File[] files = privateBackupDir().listFiles((d,n) -> n.startsWith("aurelia-backup-") && n.endsWith("-"+hash+".json"));
    return files != null && files.length > 0;
  }
  private JSONObject readLatestPrivateBackup(String excludedJson) throws Exception {
    java.util.HashSet<String> excluded = new java.util.HashSet<>();
    try { org.json.JSONArray a = new org.json.JSONArray(excludedJson == null ? "[]" : excludedJson); for(int i=0;i<a.length();i++) excluded.add(a.optString(i)); } catch(Exception ignored) {}
    java.io.File[] files = privateBackupDir().listFiles((d,n) -> n.matches("^aurelia-backup-[A-Za-z0-9._-]+\\.json$") && !excluded.contains(n));
    if (files == null || files.length == 0) throw new IllegalStateException("No private local PMS backup exists yet.");
    java.util.Arrays.sort(files,(a,b)->Long.compare(b.lastModified(),a.lastModified()));
    for (java.io.File file : files) {
      byte[] bytes=readFileBytes(file);
      if (!isStructurallyValidBackup(bytes)) continue;
      JSONObject result=new JSONObject();
      result.put("name",file.getName());
      result.put("payload",new String(bytes,StandardCharsets.UTF_8));
      return result;
    }
    throw new IllegalStateException("No structurally valid private local PMS backup was found.");
  }
  private javax.crypto.SecretKey backupServerKey() throws Exception {
    java.security.KeyStore store=java.security.KeyStore.getInstance("AndroidKeyStore"); store.load(null);
    String alias="aurelia.pms.backup.server.v1";
    java.security.Key existing=store.getKey(alias,null);
    if(existing instanceof javax.crypto.SecretKey) return (javax.crypto.SecretKey)existing;
    javax.crypto.KeyGenerator generator=javax.crypto.KeyGenerator.getInstance(android.security.keystore.KeyProperties.KEY_ALGORITHM_AES,"AndroidKeyStore");
    generator.init(new android.security.keystore.KeyGenParameterSpec.Builder(alias,
      android.security.keystore.KeyProperties.PURPOSE_ENCRYPT | android.security.keystore.KeyProperties.PURPOSE_DECRYPT)
      .setBlockModes(android.security.keystore.KeyProperties.BLOCK_MODE_GCM)
      .setEncryptionPaddings(android.security.keystore.KeyProperties.ENCRYPTION_PADDING_NONE).setRandomizedEncryptionRequired(true).build());
    return generator.generateKey();
  }
  private String encryptBackupSecret(String secret) throws Exception {
    javax.crypto.Cipher cipher=javax.crypto.Cipher.getInstance("AES/GCM/NoPadding");
    cipher.init(javax.crypto.Cipher.ENCRYPT_MODE,backupServerKey());
    byte[] iv=cipher.getIV(), encrypted=cipher.doFinal(secret.getBytes(StandardCharsets.UTF_8));
    byte[] joined=new byte[iv.length+encrypted.length]; System.arraycopy(iv,0,joined,0,iv.length); System.arraycopy(encrypted,0,joined,iv.length,encrypted.length);
    return Base64.encodeToString(joined,Base64.NO_WRAP);
  }
  private String decryptBackupSecret(String encoded) throws Exception {
    byte[] joined=Base64.decode(encoded,Base64.NO_WRAP); if(joined.length<29) throw new IllegalStateException("Saved server credential is invalid.");
    byte[] iv=java.util.Arrays.copyOfRange(joined,0,12), encrypted=java.util.Arrays.copyOfRange(joined,12,joined.length);
    javax.crypto.Cipher cipher=javax.crypto.Cipher.getInstance("AES/GCM/NoPadding");
    cipher.init(javax.crypto.Cipher.DECRYPT_MODE,backupServerKey(),new javax.crypto.spec.GCMParameterSpec(128,iv));
    return new String(cipher.doFinal(encrypted),StandardCharsets.UTF_8);
  }
  private void saveBackupServerConfig(String endpoint,String token) throws Exception {
    android.net.Uri parsed=android.net.Uri.parse(endpoint == null ? "" : endpoint.trim());
    if (!"https".equalsIgnoreCase(parsed.getScheme()) || parsed.getHost()==null || parsed.getUserInfo()!=null)
      throw new IllegalArgumentException("Use an HTTPS server URL without embedded username or password.");
    if (token==null || token.trim().length()<12 || token.length()>4096)
      throw new IllegalArgumentException("Enter a server bearer token of at least 12 characters.");
    prefs.edit().putString("backup_server_url",parsed.toString()).putString("backup_server_token_enc",encryptBackupSecret(token.trim())).apply();
  }
  private boolean backupServerConfigured() {
    return !prefs.getString("backup_server_url","").isEmpty() && !prefs.getString("backup_server_token_enc","").isEmpty();
  }
  private int serverRequest(String method,String name,String payload) throws Exception {
    String endpoint=prefs.getString("backup_server_url","");
    String encrypted=prefs.getString("backup_server_token_enc","");
    if(endpoint.isEmpty() || encrypted.isEmpty()) throw new IllegalStateException("Owner-configured server backup is not configured.");
    java.net.URL url=new java.net.URL(endpoint);
    if(!"https".equalsIgnoreCase(url.getProtocol())) throw new SecurityException("Server backup requires HTTPS.");
    javax.net.ssl.HttpsURLConnection connection=(javax.net.ssl.HttpsURLConnection)url.openConnection();
    connection.setRequestMethod(method); connection.setConnectTimeout(12000); connection.setReadTimeout(30000);
    connection.setInstanceFollowRedirects(false);
    connection.setRequestProperty("Authorization","Bearer "+decryptBackupSecret(encrypted));
    connection.setRequestProperty("X-Aurelia-Application","com.aurelia.pms");
    connection.setRequestProperty("X-Aurelia-Backup-Schema","4");
    if("POST".equals(method)) {
      byte[] body=payload.getBytes(StandardCharsets.UTF_8);
      connection.setDoOutput(true); connection.setRequestProperty("Content-Type","application/json; charset=utf-8");
      connection.setRequestProperty("X-Aurelia-Backup-Name",name);
      connection.setRequestProperty("X-Aurelia-Backup-SHA256",sha256(body));
      connection.setFixedLengthStreamingMode(body.length);
      try(OutputStream out=connection.getOutputStream()){out.write(body);out.flush();}
    }
    int code=connection.getResponseCode(); connection.disconnect();
    if(code<200 || code>=300) throw new IllegalStateException("Backup server returned HTTP "+code+(code>=300&&code<400?"; redirects are rejected":""));
    return code;
  }
  private String downloadLatestBackupFromServer() throws Exception {
    String endpoint=prefs.getString("backup_server_url",""),encrypted=prefs.getString("backup_server_token_enc","");
    if(endpoint.isEmpty()||encrypted.isEmpty())throw new IllegalStateException("Owner-configured server backup is not configured.");
    java.net.URL url=new java.net.URL(endpoint);
    if(!"https".equalsIgnoreCase(url.getProtocol()))throw new SecurityException("Server restore requires HTTPS.");
    javax.net.ssl.HttpsURLConnection connection=(javax.net.ssl.HttpsURLConnection)url.openConnection();
    connection.setRequestMethod("GET");connection.setConnectTimeout(12000);connection.setReadTimeout(30000);connection.setInstanceFollowRedirects(false);
    connection.setRequestProperty("Authorization","Bearer "+decryptBackupSecret(encrypted));
    connection.setRequestProperty("X-Aurelia-Application","com.aurelia.pms");
    int code=connection.getResponseCode();
    if(code<200||code>=300){connection.disconnect();throw new IllegalStateException("Backup server returned HTTP "+code);}
    try(InputStream in=connection.getInputStream();java.io.ByteArrayOutputStream out=new java.io.ByteArrayOutputStream()){
      byte[] buffer=new byte[16384];int count;long total=0;
      while((count=in.read(buffer))!=-1){total+=count;if(total>25L*1024L*1024L)throw new IllegalStateException("Server backup exceeds the 25 MB restore limit.");out.write(buffer,0,count);}
      byte[] bytes=out.toByteArray();
      if(!isStructurallyValidBackup(bytes))throw new IllegalStateException("Server returned an invalid PMS backup file.");
      return new String(bytes,StandardCharsets.UTF_8);
    } finally { connection.disconnect(); }
  }
  private String uploadBackupToServer(String name,String payload) {
    if(!backupServerConfigured()) return null;
    try { serverRequest("POST",name,payload); return null; }
    catch(Exception e) { return "Server/cloud copy failed: "+(e.getMessage()==null?"request failed":e.getMessage()); }
  }

  private static String sha256(byte[] bytes) throws Exception {
    byte[] digest = MessageDigest.getInstance("SHA-256").digest(bytes);
    StringBuilder out = new StringBuilder();
    for (byte b : digest) out.append(String.format(java.util.Locale.ROOT, "%02x", b & 0xff));
    return out.toString();
  }
  private byte[] readDocument(Uri uri) throws Exception {
    try (InputStream in = getContentResolver().openInputStream(uri);
         java.io.ByteArrayOutputStream out = new java.io.ByteArrayOutputStream()) {
      if (in == null) throw new IllegalStateException("Could not read saved backup for verification");
      byte[] buffer = new byte[16384]; int count;
      while ((count = in.read(buffer)) != -1) out.write(buffer, 0, count);
      return out.toByteArray();
    }
  }
  private void writeDocument(Uri uri, byte[] bytes) throws Exception {
    try (OutputStream out = getContentResolver().openOutputStream(uri, "wt")) {
      if (out == null) throw new IllegalStateException("Could not open backup destination");
      out.write(bytes); out.flush();
    }
  }
  private static final class BackupCandidate {
    final Uri uri;
    final long modified;
    final boolean valid;
    final boolean protectedNew;
    BackupCandidate(Uri uri, long modified, boolean valid, boolean protectedNew) {
      this.uri = uri; this.modified = modified; this.valid = valid; this.protectedNew = protectedNew;
    }
  }

  private boolean isManagedBackupName(String name) {
    return name != null && name.matches("^aurelia-backup-.*\\.json$");
  }

  private boolean isStructurallyValidBackup(byte[] bytes) {
    try {
      JSONObject backup = new JSONObject(new String(bytes, StandardCharsets.UTF_8));
      JSONObject data = backup.optJSONObject("data");
      if (backup.optInt("v", -1) != 4 || data == null
          || data.optJSONArray("rooms") == null || data.optJSONArray("b") == null
          || data.optJSONObject("set") == null) return false;
      JSONObject archive = backup.optJSONObject("photoArchive");
      if (archive != null) {
        java.util.Iterator<String> keys = archive.keys();
        while (keys.hasNext()) {
          String key = keys.next();
          String value = archive.optString(key, "");
          if (key.isEmpty() || !value.matches("(?i)^data:image/.*")) return false;
        }
      }
      JSONObject integrity = backup.optJSONObject("integrity");
      if (integrity != null) {
        if (!"SHA-256".equals(integrity.optString("algorithm", ""))
            || !integrity.optString("digest", "").matches("(?i)^[a-f0-9]{64}$")) return false;
      }
      return true;
    } catch (Exception invalid) {
      return false;
    }
  }

  /**
   * Retain the three newest structurally valid managed backups. The just-written,
   * read-back-verified backup is pinned so provider timestamp quirks cannot evict it.
   * Only Aurelia backup JSON files are eligible; unrelated files are never touched.
   */
  private void pruneBackupFilesToRetention(Uri root, Uri protectedNew, int maximum) throws Exception {
    Uri children = DocumentsContract.buildChildDocumentsUriUsingTree(
        root, DocumentsContract.getDocumentId(root));
    String[] projection = {
      DocumentsContract.Document.COLUMN_DOCUMENT_ID,
      DocumentsContract.Document.COLUMN_DISPLAY_NAME,
      DocumentsContract.Document.COLUMN_LAST_MODIFIED
    };
    java.util.ArrayList<BackupCandidate> candidates = new java.util.ArrayList<>();
    try (Cursor cursor = getContentResolver().query(children, projection, null, null, null)) {
      if (cursor == null) throw new IllegalStateException("Could not list the selected backup folder for retention.");
      int idCol = cursor.getColumnIndexOrThrow(DocumentsContract.Document.COLUMN_DOCUMENT_ID);
      int nameCol = cursor.getColumnIndexOrThrow(DocumentsContract.Document.COLUMN_DISPLAY_NAME);
      int modifiedCol = cursor.getColumnIndex(DocumentsContract.Document.COLUMN_LAST_MODIFIED);
      while (cursor.moveToNext()) {
        String name = cursor.getString(nameCol);
        if (!isManagedBackupName(name)) continue;
        Uri fileUri = DocumentsContract.buildDocumentUriUsingTree(root, cursor.getString(idCol));
        long modified = modifiedCol >= 0 && !cursor.isNull(modifiedCol) ? cursor.getLong(modifiedCol) : 0L;
        boolean protectedFile = fileUri.equals(protectedNew);
        boolean valid = isStructurallyValidBackup(readDocument(fileUri));
        candidates.add(new BackupCandidate(fileUri, modified, valid, protectedFile));
      }
    }
    candidates.sort((a, b) -> {
      if (a.protectedNew != b.protectedNew) return a.protectedNew ? -1 : 1;
      if (a.valid != b.valid) return a.valid ? -1 : 1;
      return Long.compare(b.modified, a.modified);
    });
    int retainedValid = 0;
    Exception deletionFailure = null;
    for (BackupCandidate candidate : candidates) {
      boolean keep = candidate.valid && retainedValid < maximum;
      if (keep) { retainedValid++; continue; }
      try {
        if (!DocumentsContract.deleteDocument(getContentResolver(), candidate.uri)) {
          throw new IllegalStateException("The storage provider refused to remove an obsolete backup.");
        }
      } catch (Exception e) {
        if (deletionFailure == null) deletionFailure = e;
        else deletionFailure.addSuppressed(e);
      }
    }
    if (deletionFailure != null) throw new IllegalStateException(
        "Backup was saved, but one or more obsolete backup files could not be removed.", deletionFailure);
  }

  private String writeToSelectedFolder(String name, String payload, String requestId) {
    String saved = prefs.getString("backup_tree_uri", null);
    if (saved == null || saved.isEmpty()) return "No backup folder permission is saved.";
    Uri tree = Uri.parse(saved);
    Uri root = DocumentsContract.buildDocumentUriUsingTree(tree, DocumentsContract.getTreeDocumentId(tree));
    byte[] bytes = payload.getBytes(StandardCharsets.UTF_8);
    Uri stage = null, published = null;
    String stageName = name + ".staging-" + requestId.replaceAll("[^A-Za-z0-9_-]", "") + ".tmp";
    try {
      stage = DocumentsContract.createDocument(getContentResolver(), root, "application/json", stageName);
      if (stage == null) throw new IllegalStateException("Could not create staging backup in the selected folder.");
      writeDocument(stage, bytes);
      if (!sha256(bytes).equals(sha256(readDocument(stage)))) throw new IllegalStateException("Staging backup failed SHA-256 read-back verification.");
      published = DocumentsContract.createDocument(getContentResolver(), root, "application/json", name);
      if (published == null) throw new IllegalStateException("Could not publish the verified backup.");
      writeDocument(published, bytes);
      if (!sha256(bytes).equals(sha256(readDocument(published)))) throw new IllegalStateException("Published backup failed SHA-256 read-back verification.");
      try { DocumentsContract.deleteDocument(getContentResolver(), stage); } catch (Exception ignored) { }
      try {
        pruneBackupFilesToRetention(root, published, 3);
        return null;
      } catch (Exception cleanupError) {
        android.util.Log.e("AureliaBackup", "Backup is verified, but retention cleanup failed", cleanupError);
        return "WARN:Backup saved and verified, but retention cleanup was incomplete. Check the folder; older backup files may remain.";
      }
    } catch (Exception e) {
      if (published != null) try { DocumentsContract.deleteDocument(getContentResolver(), published); } catch (Exception ignored) { }
      if (stage != null) try { DocumentsContract.deleteDocument(getContentResolver(), stage); } catch (Exception ignored) { }
      return e.getMessage() == null ? "Backup write or verification failed." : e.getMessage();
    }
  }
  private void saveDocument(String id, String name, String mime, byte[] bytes, boolean isBackup) {
    pendingFileRequestId = id == null ? "" : id;
    pendingIsBackup = isBackup;
    pendingBytes = bytes == null ? new byte[0] : bytes;
    Intent intent = new Intent(Intent.ACTION_CREATE_DOCUMENT);
    intent.addCategory(Intent.CATEGORY_OPENABLE);
    intent.setType(mime == null || mime.isEmpty() ? "application/octet-stream" : mime);
    intent.putExtra(Intent.EXTRA_TITLE, name == null || name.isEmpty() ? "backup.json" : name);
    startActivityForResult(intent, CREATE_BACKUP_FILE);
  }

  private java.io.File photoDir() {
    java.io.File dir = new java.io.File(getFilesDir(), "aurelia_photo_archive");
    if (!dir.exists() && !dir.mkdirs()) throw new IllegalStateException("Could not create private photo archive");
    return dir;
  }
  private java.io.File photoFile(String key) {
    if (key == null || !key.matches("[A-Za-z0-9_-]{1,120}")) throw new IllegalArgumentException("Invalid photo key");
    return new java.io.File(photoDir(), key + ".txt");
  }
  private void photoResult(String id, boolean ok, String payload) {
    js("window.aureliaNativePhotoResult && window.aureliaNativePhotoResult(" + q(id) + "," + ok + "," + q(payload) + ")");
  }
  private String readText(java.io.File file) throws Exception {
    try (java.io.FileInputStream in = new java.io.FileInputStream(file);
         java.io.ByteArrayOutputStream out = new java.io.ByteArrayOutputStream()) {
      byte[] buffer = new byte[8192];
      int count;
      while ((count = in.read(buffer)) != -1) out.write(buffer, 0, count);
      return new String(out.toByteArray(), StandardCharsets.UTF_8);
    }
  }
  private void writeText(java.io.File file, String value) throws Exception {
    try (java.io.FileOutputStream out = new java.io.FileOutputStream(file)) {
      out.write(value.getBytes(StandardCharsets.UTF_8));
      out.flush();
      out.getFD().sync();
    }
  }

  private void printHtmlDocument(String html, String title) {
    try {
      android.webkit.WebView printView = new android.webkit.WebView(MainActivity.this);
      printView.setWebViewClient(new android.webkit.WebViewClient() {
        @Override public void onPageFinished(android.webkit.WebView view, String url) {
          try {
            android.print.PrintManager manager = (android.print.PrintManager) getSystemService(PRINT_SERVICE);
            android.print.PrintDocumentAdapter adapter = view.createPrintDocumentAdapter(title);
            manager.print(title, adapter, new android.print.PrintAttributes.Builder().setMediaSize(android.print.PrintAttributes.MediaSize.ISO_A4).setResolution(new android.print.PrintAttributes.Resolution("aurelia", "Aurelia", 300, 300)).setMinMargins(android.print.PrintAttributes.Margins.NO_MARGINS).build());
          } catch (Exception ignored) { }
        }
      });
      printView.loadDataWithBaseURL(null, "<!doctype html><html><head><meta charset='utf-8'><meta name='viewport' content='width=device-width,initial-scale=1'><style>body{font-family:Arial,sans-serif;color:#222;margin:18px}img{max-width:100%;height:auto}table{width:100%;border-collapse:collapse}td,th{padding:7px;border-bottom:1px solid #ddd;text-align:left} .noprint,button{display:none!important}</style></head><body>" + html + "</body></html>", "text/html", "UTF-8", null);
    } catch (Exception ignored) { }
  }

  private void shareImageFile(String name, String mime, byte[] bytes, String phone) {
    try {
      java.io.File dir = new java.io.File(getCacheDir(), "shared");
      if (!dir.exists()) dir.mkdirs();
      String safeName = name == null ? "invoice.png" : name.replaceAll("[^A-Za-z0-9._-]", "_");
      java.io.File file = new java.io.File(dir, safeName);
      try (java.io.FileOutputStream out = new java.io.FileOutputStream(file)) { out.write(bytes); out.flush(); }
      Uri uri = androidx.core.content.FileProvider.getUriForFile(MainActivity.this, getPackageName() + ".fileprovider", file);
      Intent send = new Intent(Intent.ACTION_SEND);
      send.setType(mime == null ? "image/png" : mime);
      send.putExtra(Intent.EXTRA_STREAM, uri);
      send.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
      if (phone != null && !phone.isEmpty()) send.putExtra("jid", phone.replaceAll("\\D", "") + "@s.whatsapp.net");
      startActivity(Intent.createChooser(send, "Share invoice"));
    } catch (Exception e) {
      try { saveDocument("share-fallback", name, mime, bytes, false); } catch (Exception ignored) { }
    }
  }

  private class AureliaBridge {
    @JavascriptInterface public String getPayBridgeStatus() {
      return payBridgeClient == null ? "{\"authenticated\":false,\"state\":\"initializing\"}" : payBridgeClient.statusJson();
    }
    @JavascriptInterface public void postMessage(String raw) {
      String operationType = "", operationRequestId = "";
      try {
        JSONObject obj = new JSONObject(raw);
        final String type = obj.optString("type", "");
        final String requestId = obj.optString("requestId", "");
        operationType = type; operationRequestId = requestId;
        if ("payBridgeConnect".equals(type)) {
          if (payBridgeClient != null) payBridgeClient.retryNow();
        } else if ("payBridgeDisconnect".equals(type)) {
          if (payBridgeClient != null) payBridgeClient.disconnect();
        } else if ("photoStore".equals(type)) {
          String key = obj.optString("key", "");
          String data = obj.optString("data", "");
          if (!data.startsWith("data:image/")) throw new IllegalArgumentException("Invalid photo data");
          writeText(photoFile(key), data);
          photoResult(requestId, true, "stored");
        } else if ("photoLoad".equals(type)) {
          String key = obj.optString("key", "");
          java.io.File file = photoFile(key);
          if (!file.isFile()) photoResult(requestId, false, "Original photo not found on this device");
          else photoResult(requestId, true, readText(file));
        } else if ("photoArchive".equals(type)) {
          JSONObject archive = new JSONObject();
          java.io.File[] files = photoDir().listFiles((dir, name) -> name.endsWith(".txt"));
          if (files != null) for (java.io.File file : files) {
            String key = file.getName().substring(0, file.getName().length() - 4);
            archive.put(key, readText(file));
          }
          photoResult(requestId, true, archive.toString());
        } else if ("photoRestore".equals(type)) {
          JSONObject archive = obj.optJSONObject("archive");
          if (archive == null) throw new IllegalArgumentException("Invalid photo archive");
          java.util.LinkedHashMap<String, String> incoming = new java.util.LinkedHashMap<>();
          java.util.LinkedHashMap<String, String> previous = new java.util.LinkedHashMap<>();
          java.util.LinkedHashMap<String, java.io.File> staged = new java.util.LinkedHashMap<>();
          java.io.File archiveDir = photoDir();
          java.io.File[] existingPhotos = archiveDir.listFiles((dir, name) -> name.endsWith(".txt"));
          if (existingPhotos != null) for (java.io.File existing : existingPhotos) previous.put(existing.getName().substring(0, existing.getName().length() - 4), readText(existing));
          java.io.File stageDir = new java.io.File(archiveDir, ".restore-" + System.currentTimeMillis());
          if (!stageDir.mkdirs()) throw new IllegalStateException("Could not create photo restore staging area");
          try {
            java.util.Iterator<String> keys = archive.keys();
            while (keys.hasNext()) {
              String key = keys.next(), data = archive.optString(key, "");
              if (key == null || !key.matches("[A-Za-z0-9_-]{1,120}") || !data.startsWith("data:image/")) throw new IllegalArgumentException("Invalid archived image or photo key");
              incoming.put(key, data);
              java.io.File temp = new java.io.File(stageDir, key + ".txt");
              writeText(temp, data);
              if (!data.equals(readText(temp))) throw new IllegalStateException("Staged photo verification failed for " + key);
              staged.put(key, temp);
            }
            for (java.util.Map.Entry<String, java.io.File> entry : staged.entrySet()) {
              String data = readText(entry.getValue());
              writeText(photoFile(entry.getKey()), data);
              if (!data.equals(readText(photoFile(entry.getKey())))) throw new IllegalStateException("Restored photo verification failed for " + entry.getKey());
            }
            java.io.File[] currentPhotos = archiveDir.listFiles((dir, name) -> name.endsWith(".txt"));
            if (currentPhotos != null) for (java.io.File current : currentPhotos) {
              String key = current.getName().substring(0, current.getName().length() - 4);
              if (!incoming.containsKey(key) && !current.delete()) throw new IllegalStateException("Could not remove photo absent from restored archive: " + key);
            }
            java.io.File[] verifiedPhotos = archiveDir.listFiles((dir, name) -> name.endsWith(".txt"));
            int verifiedCount = verifiedPhotos == null ? 0 : verifiedPhotos.length;
            if (verifiedCount != incoming.size()) throw new IllegalStateException("Restored photo archive count does not match the backup.");
            photoResult(requestId, true, "restored");
          } catch (Exception restoreError) {
            Exception rollbackError = null;
            for (java.util.Map.Entry<String, String> entry : previous.entrySet()) {
              try { writeText(photoFile(entry.getKey()), entry.getValue()); }
              catch (Exception e) { rollbackError = e; }
            }
            for (String key : incoming.keySet()) if (!previous.containsKey(key)) {
              try { java.io.File target = photoFile(key); if (target.exists() && !target.delete()) throw new IllegalStateException("Could not remove partially restored photo " + key); }
              catch (Exception e) { rollbackError = e; }
            }
            if (rollbackError != null) throw new IllegalStateException("Photo restore failed and rollback was incomplete: " + rollbackError.getMessage(), restoreError);
            throw restoreError;
          } finally {
            java.io.File[] stagedFiles = stageDir.listFiles();
            if (stagedFiles != null) for (java.io.File stagedFile : stagedFiles) try { stagedFile.delete(); } catch (Exception ignored) { }
            try { stageDir.delete(); } catch (Exception ignored) { }
          }
        } else if ("chooseDeviceBackupFolder".equals(type)) {
          runOnUiThread(() -> {
            folderRequestId = requestId;
            Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT_TREE);
            intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_GRANT_WRITE_URI_PERMISSION | Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION);
            startActivityForResult(intent, PICK_BACKUP_FOLDER);
          });
        } else if ("pickImage".equals(type)) {
          runOnUiThread(() -> launchImagePicker(requestId));
        } else if ("recognizeId".equals(type)) {
          String imageData = obj.optString("data", "");
          byte[] imageBytes = Base64.decode(imageData, Base64.DEFAULT);
          Bitmap bitmap = BitmapFactory.decodeByteArray(imageBytes, 0, imageBytes.length);
          if (bitmap == null) throw new IllegalArgumentException("Could not decode ID image");
          InputImage image = InputImage.fromBitmap(bitmap, 0);
          TextRecognizer recognizer = getOcrRecognizer();
          recognizer.process(image)
            .addOnSuccessListener(result -> {
              JSONObject payload = new JSONObject();
              try { payload.put("status", "OK"); payload.put("text", result.getText()); payload.put("imageWidth", bitmap.getWidth()); payload.put("imageHeight", bitmap.getHeight()); org.json.JSONArray lineItems = new org.json.JSONArray(); for (com.google.mlkit.vision.text.Text.TextBlock block : result.getTextBlocks()) { for (com.google.mlkit.vision.text.Text.Line line : block.getLines()) { android.graphics.Rect box = line.getBoundingBox(); JSONObject item = new JSONObject(); item.put("text", line.getText()); if (box != null) { item.put("left", box.left); item.put("top", box.top); item.put("right", box.right); item.put("bottom", box.bottom); } item.put("confidence", line.getConfidence()); item.put("rotation", line.getAngle()); lineItems.put(item); } } payload.put("lines", lineItems); } catch (Exception ignored) { }
              js("window.aureliaNativeOcrResult && window.aureliaNativeOcrResult(" + q(requestId) + "," + q(payload.toString()) + ")");
              bitmap.recycle();
            })
            .addOnFailureListener(error -> {
              JSONObject payload = new JSONObject();
              try { payload.put("status", "ERROR"); payload.put("message", error == null ? "Text recognition failed" : String.valueOf(error.getMessage())); } catch (Exception ignored) { }
              js("window.aureliaNativeOcrResult && window.aureliaNativeOcrResult(" + q(requestId) + "," + q(payload.toString()) + ")");
              bitmap.recycle();
            });
        } else if ("deviceBackupStatus".equals(type)) {
          boolean localReady = false, folderSelected = false, matchingBackupExists = false;
          try {
            privateBackupDir(); localReady = true;
            folderSelected = !prefs.getString("backup_tree_uri", "").isEmpty();
            matchingBackupExists = hasPrivateBackup(obj.optString("hash", ""));
          } catch (Exception backupStatusError) { localReady = false; }
          final boolean localAvailable = localReady, selectedFolder = folderSelected, localMatch = matchingBackupExists;
          js("window.aureliaNativeDeviceBackupStatusResult && window.aureliaNativeDeviceBackupStatusResult(" + q(requestId) + "," + localAvailable + "," + selectedFolder + "," + localMatch + ")");
        } else if ("recoverLatestBackup".equals(type)) {
          final String excluded = obj.optJSONArray("exclude") == null ? "[]" : obj.optJSONArray("exclude").toString();
          backupExecutor.execute(() -> {
            try {
              JSONObject result;
              try { result = readLatestPrivateBackup(excluded); }
              catch (Exception localError) { result = readLatestBackupFromSelectedFolder(excluded); }
              recoveryResult(requestId, true, result.optString("payload", ""), result.optString("name", ""));
            } catch (Exception e) { recoveryResult(requestId, false, e.getMessage() == null ? "Could not read a backup from the selected folder." : e.getMessage(), ""); }
          });
        } else if ("backupDeviceNow".equals(type)) {
          final String name = obj.optString("name", "aurelia-backup.json");
          final String payload = obj.optString("payload", "");
          backupExecutor.execute(() -> {
            try {
              writePrivateBackup(name,payload);
              java.util.ArrayList<String> warnings=new java.util.ArrayList<>();
              String folderUri=prefs.getString("backup_tree_uri","");
              if(!folderUri.isEmpty()) {
                String folderError=writeToSelectedFolder(name,payload,requestId);
                if(folderError!=null) warnings.add("Selected folder copy failed: "+folderError);
              }
              String serverError=uploadBackupToServer(name,payload);
              if(serverError!=null) warnings.add(serverError);
              backupResult(requestId,true,warnings.isEmpty()?"":"WARN:Private local backup verified. "+android.text.TextUtils.join(" ",warnings));
            } catch(Exception e) {
              backupResult(requestId,false,e.getMessage()==null?"Private local backup failed.":e.getMessage());
            }
          });
        } else if ("clearBackupFolder".equals(type)) {
          String savedFolder=prefs.getString("backup_tree_uri","");
          if(!savedFolder.isEmpty()) {
            try { getContentResolver().releasePersistableUriPermission(Uri.parse(savedFolder),Intent.FLAG_GRANT_READ_URI_PERMISSION|Intent.FLAG_GRANT_WRITE_URI_PERMISSION); } catch(Exception ignored) {}
          }
          prefs.edit().remove("backup_tree_uri").apply();
          folderResult(requestId,true,"Optional folder disconnected; private local backups remain enabled.");
        } else if ("saveBackupServerConfig".equals(type)) {
          String endpoint=obj.optString("endpoint",""), token=obj.optString("token","");
          saveBackupServerConfig(endpoint,token);
          js("window.aureliaNativeBackupServerResult && window.aureliaNativeBackupServerResult("+q(requestId)+",true,"+q("Server credentials encrypted with Android Keystore.")+")");
        } else if ("clearBackupServerConfig".equals(type)) {
          prefs.edit().remove("backup_server_url").remove("backup_server_token_enc").apply();
          js("window.aureliaNativeBackupServerResult && window.aureliaNativeBackupServerResult("+q(requestId)+",true,"+q("Server backup disconnected.")+")");
        } else if ("restoreLatestServerBackup".equals(type)) {
          backupExecutor.execute(() -> {
            try { String payload=downloadLatestBackupFromServer(); js("window.aureliaNativeServerRestoreResult && window.aureliaNativeServerRestoreResult("+q(requestId)+",true,"+q(payload)+")"); }
            catch(Exception e) { js("window.aureliaNativeServerRestoreResult && window.aureliaNativeServerRestoreResult("+q(requestId)+",false,"+q(e.getMessage()==null?"Server restore failed.":e.getMessage())+")"); }
          });
        } else if ("testBackupServer".equals(type)) {
          backupExecutor.execute(() -> {
            try { serverRequest("HEAD","",""); js("window.aureliaNativeBackupServerResult && window.aureliaNativeBackupServerResult("+q(requestId)+",true,"+q("HTTPS endpoint authenticated successfully.")+")"); }
            catch(Exception e) { js("window.aureliaNativeBackupServerResult && window.aureliaNativeBackupServerResult("+q(requestId)+",false,"+q(e.getMessage()==null?"Server connection test failed.":e.getMessage())+")"); }
          });
        } else if ("getBackupServerStatus".equals(type)) {
          boolean configured=backupServerConfigured();
          js("window.aureliaNativeBackupServerStatusResult && window.aureliaNativeBackupServerStatusResult("+q(requestId)+","+configured+","+q(prefs.getString("backup_server_url",""))+")");
        } else if ("openUrl".equals(type)) {
          String url = obj.optString("url", "");
          runOnUiThread(() -> { try { Intent intent = new Intent(Intent.ACTION_VIEW, Uri.parse(url)); startActivity(intent); } catch (Exception e) { js("window.aureliaNativeActionResult && window.aureliaNativeActionResult(" + q(requestId) + ",false," + q("Could not open link") + ")"); } });
        } else if ("shareText".equals(type)) {
          String title = obj.optString("title", "Share");
          String text = obj.optString("text", "");
          runOnUiThread(() -> { try { Intent intent = new Intent(Intent.ACTION_SEND); intent.setType("text/plain"); intent.putExtra(Intent.EXTRA_TEXT, text); startActivity(Intent.createChooser(intent, title)); } catch (Exception e) { js("window.aureliaNativeActionResult && window.aureliaNativeActionResult(" + q(requestId) + ",false," + q("Sharing is unavailable") + ")"); } });
        } else if ("printInvoice".equals(type)) {
          String html = obj.optString("html", "");
          runOnUiThread(() -> printHtmlDocument(html, obj.optString("title", "Aurelia PMS invoice")));
        } else if ("shareInvoicePng".equals(type) || "shareImage".equals(type)) {
          String name = obj.optString("name", "invoice.png");
          String mime = obj.optString("mime", "image/png");
          byte[] bytes = Base64.decode(obj.optString("data", ""), Base64.DEFAULT);
          runOnUiThread(() -> shareImageFile(name, mime, bytes, obj.optString("phone", "")));
        } else if ("saveFile".equals(type)) {
          byte[] bytes = Base64.decode(obj.optString("data", ""), Base64.DEFAULT);
          String name = obj.optString("name", "backup.json");
          String mime = obj.optString("mime", "application/octet-stream");
          runOnUiThread(() -> saveDocument(requestId, name, mime, bytes, false));
        }
      } catch (Exception error) {
        String message = error.getMessage() == null ? "Native backup operation failed." : error.getMessage();
        if ("photoStore".equals(operationType) || "photoLoad".equals(operationType) || "photoArchive".equals(operationType) || "photoRestore".equals(operationType)) photoResult(operationRequestId, false, message);
        else if ("backupDeviceNow".equals(operationType)) backupResult(operationRequestId, false, message);
        else if ("recoverLatestBackup".equals(operationType)) recoveryResult(operationRequestId, false, message, "");
        else if ("deviceBackupStatus".equals(operationType)) js("window.aureliaNativeDeviceBackupStatusResult && window.aureliaNativeDeviceBackupStatusResult(" + q(operationRequestId) + ",false,false,false)");
        else if ("restoreLatestServerBackup".equals(operationType)) js("window.aureliaNativeServerRestoreResult && window.aureliaNativeServerRestoreResult(" + q(operationRequestId) + ",false," + q(message) + ")");
        else if ("saveBackupServerConfig".equals(operationType) || "clearBackupServerConfig".equals(operationType) || "testBackupServer".equals(operationType)) js("window.aureliaNativeBackupServerResult && window.aureliaNativeBackupServerResult(" + q(operationRequestId) + ",false," + q(message) + ")");
      }
    }
  }

  @Override protected void onActivityResult(int requestCode, int resultCode, Intent data) {
    super.onActivityResult(requestCode, resultCode, data);
    if (requestCode == PICK_BACKUP_FOLDER) {
      if (resultCode == RESULT_OK && data != null && data.getData() != null) {
        Uri uri = data.getData();
        try {
          getContentResolver().takePersistableUriPermission(uri, data.getFlags() &
            (Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_GRANT_WRITE_URI_PERMISSION));
          prefs.edit().putString("backup_tree_uri", uri.toString()).apply();
          String label = uri.getLastPathSegment();
          folderResult(folderRequestId, true, label == null ? "Selected folder" : label);
        } catch (Exception e) { folderResult(folderRequestId, false, "Could not retain access to selected folder"); }
      } else folderResult(folderRequestId, false, "No folder selected");
    } else if (requestCode == PICK_IMAGE_FILE) {
      final String completedId = pendingImageRequestId; pendingImageRequestId = "";
      if (resultCode == RESULT_OK && data != null && data.getData() != null) {
        try { imageResult(completedId, true, readPickedImage(data.getData()).toString()); }
        catch (Exception e) { imageResult(completedId, false, e.getMessage() == null ? "Could not read the selected image." : e.getMessage()); }
      } else imageResult(completedId, false, "Image selection cancelled.");
    } else if (requestCode == CREATE_BACKUP_FILE) {
      final String completedId = pendingFileRequestId;
      final boolean isBackup = pendingIsBackup;
      final byte[] expected = pendingBytes;
      pendingBytes = new byte[0];
      pendingIsBackup = false;
      if (resultCode == RESULT_OK && data != null && data.getData() != null) {
        final Uri destination = data.getData();
        backupExecutor.execute(() -> {
          try {
            writeDocument(destination, expected);
            if (isBackup && !sha256(expected).equals(sha256(readDocument(destination)))) throw new IllegalStateException("Saved backup failed SHA-256 read-back verification.");
            if (isBackup) backupResult(completedId, true, "");
            else js("window.aureliaNativeFileSaveResult && window.aureliaNativeFileSaveResult(" + q(completedId) + ",true,'')");
          } catch (Exception e) {
            String message = e.getMessage() == null ? "Could not save or verify the selected file." : e.getMessage();
            if (isBackup) backupResult(completedId, false, message);
            else js("window.aureliaNativeFileSaveResult && window.aureliaNativeFileSaveResult(" + q(completedId) + ",false," + q(message) + ")");
          }
        });
      } else if (isBackup) backupResult(completedId, false, "Save cancelled");
      else js("window.aureliaNativeFileSaveResult && window.aureliaNativeFileSaveResult(" + q(completedId) + ",false,'Save cancelled')");
    }
  }
}
`;
fs.writeFileSync(javaPath, java);
console.log('Installed SAF backup, Android Photo Picker, reusable Google ML Kit OCR, system-bar styling, and minimal manifest permissions.');
