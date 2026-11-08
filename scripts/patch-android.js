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
// Cashfree UPI Intent discovery on Android 11+ requires explicit package visibility.
if (!manifest.includes('<data android:scheme="upi"')) {
  const upiQueries = [
    '        <intent><action android:name="android.intent.action.VIEW" /><data android:scheme="upi" /></intent>',
    '        <intent><action android:name="android.intent.action.VIEW" /><data android:scheme="tez" /></intent>',
    '        <intent><action android:name="android.intent.action.VIEW" /><data android:scheme="gpay" /></intent>',
    '        <intent><action android:name="android.intent.action.VIEW" /><data android:scheme="phonepe" /></intent>',
    '        <intent><action android:name="android.intent.action.VIEW" /><data android:scheme="paytmmp" /></intent>',
    '        <intent><action android:name="android.intent.action.VIEW" /><data android:scheme="credpay" /></intent>'
  ].join('\n');
  manifest = manifest.replace('</queries>', upiQueries + '\n    </queries>');
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
  'android.permission.ACCESS_NETWORK_STATE',
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
  // Remove direct and SDK-scoped declarations contributed by transitive AAR manifests.
  // The PMS has no dangerous runtime-permission use case; network access needs INTERNET only.
  for (const tag of ['uses-permission', 'uses-permission-sdk-23', 'uses-permission-sdk-m']) {
    const marker = '<' + tag + ' android:name="' + permission + '" tools:node="remove" />';
    if (!manifest.includes(marker)) manifest = manifest.replace('</manifest>', '    ' + marker + '\n</manifest>');
  }
}

// Native PIN gate is the only exported launcher. MainActivity remains internal,
// so ordinary launcher starts cannot instantiate the PMS WebView before PIN auth.
if (!manifest.includes('com.aurelia.pms.security.LockGateActivity')) {
  const mainActivityPattern = /<activity\b(?=[^>]*android:name="(?:\.MainActivity|com\.aurelia\.pms\.MainActivity)")([^>]*)>([\s\S]*?)<\/activity>/;
  const mainMatch = manifest.match(mainActivityPattern);
  if (!mainMatch) throw new Error('Capacitor MainActivity manifest declaration was not found; native PIN gate cannot be installed.');
  let mainAttrs = mainMatch[1].replace(/android:exported="[^"]*"/, '').trim();
  mainAttrs += ' android:exported="false"';
  let mainBody = mainMatch[2].replace(/<intent-filter>[\s\S]*?<\/intent-filter>/g, block =>
    /android\.intent\.action\.MAIN/.test(block) && /android\.intent\.category\.LAUNCHER/.test(block) ? '' : block
  );
  const internalMain = '<activity ' + mainAttrs + '>' + mainBody + '</activity>';
  const gateActivity = '<activity android:name="com.aurelia.pms.security.LockGateActivity" android:exported="true" android:excludeFromRecents="true" android:theme="@android:style/Theme.Material.Light.NoActionBar"><intent-filter><action android:name="android.intent.action.MAIN" /><category android:name="android.intent.category.LAUNCHER" /></intent-filter></activity>';
  manifest = manifest.replace(mainMatch[0], internalMain + '\n        ' + gateActivity);
}
// Enforce HTTPS at the Android application boundary. User-installed CAs are
// included so an owner-installed private LAN CA (for example, Caddy's CA) can
// authenticate the appliance. Cleartext remains denied for WebView and native APIs.
manifest = manifest.replace(/<application([^>]*)>/, (match, attrs) => {
  attrs = attrs.replace(/\s+android:usesCleartextTraffic="[^"]*"/, '')
    .replace(/\s+android:networkSecurityConfig="[^"]*"/, '');
  return '<application' + attrs +
    ' android:usesCleartextTraffic="false" android:networkSecurityConfig="@xml/aurelia_network_security_config">';
});
const xmlDir = path.join(appDir, 'res', 'xml');
fs.mkdirSync(xmlDir, { recursive: true });
fs.writeFileSync(path.join(xmlDir, 'aurelia_network_security_config.xml'),
  '<?xml version="1.0" encoding="utf-8"?>' +
  '<network-security-config>' +
    '<base-config cleartextTrafficPermitted="false">' +
      '<trust-anchors>' +
        '<certificates src="system" />' +
        '<certificates src="user" />' +
      '</trust-anchors>' +
    '</base-config>' +
  '</network-security-config>');

// Keep the future Pay Bridge discovery narrowly scoped; never request QUERY_ALL_PACKAGES.
fs.writeFileSync(manifestPath, manifest);


const { execFileSync } = require('child_process');
const iconPng = path.join(__dirname, '..', 'assets', 'aurelia-icon.png');
const iconJpg = path.join(__dirname, '..', 'assets', 'aurelia-icon.jpg');
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

if (fs.existsSync(iconPng) && !fs.existsSync(iconJpg)) {
  // A single 512px PNG is stored in mipmap-nodpi: Android scales it without
  // density-specific resampling. This also avoids requiring Sharp on Termux.
  const dir = path.join(resDir, 'mipmap-nodpi');
  fs.mkdirSync(dir, { recursive: true });
  for (const name of ['ic_launcher', 'ic_launcher_round', 'ic_launcher_foreground']) {
    fs.copyFileSync(iconPng, path.join(dir, name + '.png'));
  }
  const adaptiveDir = path.join(resDir, 'mipmap-anydpi-v26');
  fs.mkdirSync(adaptiveDir, { recursive: true });
  const adaptive = '<?xml version="1.0" encoding="utf-8"?><adaptive-icon xmlns:android="http://schemas.android.com/apk/res/android"><background android:drawable="@color/aurelia_icon_background"/><foreground android:drawable="@mipmap/ic_launcher_foreground"/></adaptive-icon>';
  fs.writeFileSync(path.join(adaptiveDir, 'ic_launcher.xml'), adaptive);
  fs.writeFileSync(path.join(adaptiveDir, 'ic_launcher_round.xml'), adaptive);
  const valuesDir = path.join(resDir, 'values');
  fs.mkdirSync(valuesDir, { recursive: true });
  fs.writeFileSync(path.join(valuesDir, 'aurelia_icon_colors.xml'), '<?xml version="1.0" encoding="utf-8"?><resources><color name="aurelia_icon_background">#082419</color></resources>');
  console.log('Installed Aurelia PMS launcher artwork from assets/aurelia-icon.png.');
} else if (fs.existsSync(iconJpg)) {
  // Prefer the approved branded JPEG over the legacy placeholder PNG/SVG.
  // Replace generated Capacitor launcher assets at every density to avoid stale icons.
  const densities = ['mdpi', 'hdpi', 'xhdpi', 'xxhdpi', 'xxxhdpi', 'nodpi'];
  for (const density of densities) {
    const dir = path.join(resDir, 'mipmap-' + density);
    fs.mkdirSync(dir, { recursive: true });
    for (const name of ['ic_launcher', 'ic_launcher_round', 'ic_launcher_foreground']) {
      for (const ext of ['png', 'webp', 'jpg']) {
        const old = path.join(dir, name + '.' + ext);
        if (fs.existsSync(old)) fs.unlinkSync(old);
      }
    }
    fs.copyFileSync(iconJpg, path.join(dir, 'ic_launcher.jpg'));
    fs.copyFileSync(iconJpg, path.join(dir, 'ic_launcher_round.jpg'));
    if (density === 'nodpi') fs.copyFileSync(iconJpg, path.join(dir, 'ic_launcher_foreground.jpg'));
  }
  const adaptiveDir = path.join(resDir, 'mipmap-anydpi-v26');
  fs.mkdirSync(adaptiveDir, { recursive: true });
  const adaptive = '<?xml version="1.0" encoding="utf-8"?><adaptive-icon xmlns:android="http://schemas.android.com/apk/res/android"><background android:drawable="@color/aurelia_icon_background"/><foreground android:drawable="@mipmap/ic_launcher_foreground"/></adaptive-icon>';
  fs.writeFileSync(path.join(adaptiveDir, 'ic_launcher.xml'), adaptive);
  fs.writeFileSync(path.join(adaptiveDir, 'ic_launcher_round.xml'), adaptive);
  const valuesDir = path.join(resDir, 'values');
  fs.mkdirSync(valuesDir, { recursive: true });
  fs.writeFileSync(path.join(valuesDir, 'aurelia_icon_colors.xml'), '<?xml version="1.0" encoding="utf-8"?><resources><color name="aurelia_icon_background">#082419</color></resources>');
  let launcherManifest = fs.readFileSync(manifestPath, 'utf8');
  launcherManifest = launcherManifest.replace(/<application\\b([^>]*)>/, (match, attrs) => {
    attrs = attrs.replace(/\\s+android:icon="[^"]*"/, '').replace(/\\s+android:roundIcon="[^"]*"/, '');
    return '<application' + attrs + ' android:icon="@mipmap/ic_launcher" android:roundIcon="@mipmap/ic_launcher_round">';
  });
  fs.writeFileSync(manifestPath, launcherManifest);
  console.log('Installed branded Aurelia PMS icon across all launcher densities and adaptive resources.');
} else if (fs.existsSync(iconSvg)) {
  // Backward-compatible fallback for older checkouts that do not yet have the PNG.
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
  fs.writeFileSync(path.join(valuesDir, 'aurelia_icon_colors.xml'), '<?xml version="1.0" encoding="utf-8"?><resources><color name="aurelia_icon_background">#082419</color></resources>');
  console.log('Generated fallback Aurelia PMS launcher icons for all Android densities.');
}

const javaDir = path.join(appDir, 'java', 'com', 'aurelia', 'pms');
fs.mkdirSync(javaDir, { recursive: true });

const appModuleDir = path.join(androidDir, 'app');
const appGradleGroovy = path.join(appModuleDir, 'build.gradle');
const appGradleKts = path.join(appModuleDir, 'build.gradle.kts');

// The security boundary is implemented in Kotlin, while Capacitor's generated
// MainActivity is Java. Explicitly enable Kotlin compilation in the app module;
// without this plugin javac cannot resolve AureliaSecurityRuntime or LockGateActivity.
function ensureKotlinAndroidPlugin(contents, kotlinDsl) {
  const pluginId = 'org.jetbrains.kotlin.android';
  if (contents.includes(pluginId)) return contents;
  const statement = kotlinDsl
    ? '    id("org.jetbrains.kotlin.android") version "2.0.21"'
    : "    id 'org.jetbrains.kotlin.android' version '2.0.21'";
  if (/plugins\s*\{/.test(contents)) {
    return contents.replace(/plugins\s*\{/, match => match + '\n' + statement);
  }
  // Capacitor 7's generated app module uses the plugins DSL. If a future
  // template switches to legacy apply-plugin syntax, add a valid top-level
  // plugins block before the remaining app configuration.
  return 'plugins {\n' + statement + '\n}\n\n' + contents;
}

function ensureJavaResourcePackaging(contents, kotlinDsl) {
  // These are duplicate metadata files from transitive JAR dependencies. The
  // runtime classes remain packaged; only the duplicate multi-release manifest
  // metadata is excluded from the Android APK.
  const block = kotlinDsl
    ? '\nandroid {\n    packaging {\n        resources {\n            excludes += "META-INF/versions/9/OSGI-INF/MANIFEST.MF"\n        }\n    }\n}\n'
    : '\nandroid {\n    packaging {\n        resources {\n            excludes += "META-INF/versions/9/OSGI-INF/MANIFEST.MF"\n        }\n    }\n}\n';
  if (contents.includes("META-INF/versions/9/OSGI-INF/MANIFEST.MF")) return contents;
  return contents + block;
}

if (fs.existsSync(appGradleGroovy)) {
  let gradle = ensureKotlinAndroidPlugin(fs.readFileSync(appGradleGroovy, 'utf8'), false);
  if (!gradle.includes('com.google.mlkit:text-recognition:')) {
    gradle = gradle.replace(/dependencies\s*\{/, match => match + "\n    implementation 'com.google.mlkit:text-recognition:16.0.1'");
  }
  gradle = ensureJavaResourcePackaging(gradle, false);
  fs.writeFileSync(appGradleGroovy, gradle);
} else if (fs.existsSync(appGradleKts)) {
  let gradle = ensureKotlinAndroidPlugin(fs.readFileSync(appGradleKts, 'utf8'), true);
  if (!gradle.includes('com.google.mlkit:text-recognition:')) {
    gradle = gradle.replace(/dependencies\s*\{/, match => match + '\n    implementation("com.google.mlkit:text-recognition:16.0.1")');
  }
  gradle = ensureJavaResourcePackaging(gradle, true);
  fs.writeFileSync(appGradleKts, gradle);
}


// Firebase Phone Auth native integration. Firebase's native BoM and plugin
// versions are owned by the generated Capacitor project's plugin DSL/catalog.
// Inject Firebase Auth into the app module without rewriting root Gradle plugin
// management. The Google Services plugin is applied only for a supplied config.
const firebaseTemplate = path.join(androidDir, 'templates', 'FirebasePhoneIdentity.kt');
if (!fs.existsSync(firebaseTemplate)) throw new Error('FirebasePhoneIdentity.kt template is missing.');
const identityDir = path.join(appDir, 'java', 'com', 'aurelia', 'pms', 'identity');
fs.mkdirSync(identityDir, { recursive: true });
fs.copyFileSync(firebaseTemplate, path.join(identityDir, 'FirebasePhoneIdentity.kt'));

const firebaseBootstrapTemplate = path.join(androidDir, 'templates', 'RecoveryFirebaseAuthFactory.kt');
if (!fs.existsSync(firebaseBootstrapTemplate)) throw new Error('RecoveryFirebaseAuthFactory.kt template is missing.');
fs.copyFileSync(firebaseBootstrapTemplate, path.join(identityDir, 'RecoveryFirebaseAuthFactory.kt'));



/**
 * Native App Manager security sources are maintained as templates and copied
 * into the generated Capacitor project on every rebuild.
 */
const securityTemplateDir = path.join(androidDir, 'templates', 'security');
const securitySourceDir = path.join(appDir, 'java', 'com', 'aurelia', 'pms', 'security');
fs.mkdirSync(securitySourceDir, { recursive: true });
for (const file of [
  'AureliaCryptoEngine.kt',
  'AppLockManager.kt',
  'BiometricVaultManager.kt',
  'AureliaAppManager.kt',
  'AureliaSecurityRuntime.kt',
  'AureliaEnvelopeStore.kt',
  'PaymentDeviceKeyStore.kt',
  'PaymentDeviceClient.kt',
  'SettlementEnvelopeVerifier.kt',
  'PaymentReleaseSafeguards.kt',
  'AureliaPlayIntegrityClient.kt',
  'CloudPaymentDeviceEnrollmentClient.kt',
  'LockGateActivity.kt'
]) {
  const source = path.join(securityTemplateDir, file);
  if (!fs.existsSync(source)) throw new Error('Native security template is missing: ' + file);
  fs.copyFileSync(source, path.join(securitySourceDir, file));
}

function addNativeSecurityDependencies(contents, kotlinDsl) {
  if (!/dependencies\s*\{/.test(contents)) {
    throw new Error('App Gradle file has no dependencies block; native security dependencies were not added.');
  }
  const dependencies = [
    ['org.bouncycastle:bcprov-jdk18on:1.80', 'org.bouncycastle:bcprov-jdk18on'],
    ['androidx.biometric:biometric:1.2.0-alpha05', 'androidx.biometric:biometric'],
    ['com.google.android.play:integrity:1.5.0', 'com.google.android.play:integrity']
  ];
  for (const [coordinate, marker] of dependencies) {
    if (contents.includes(marker)) continue;
    const line = kotlinDsl
      ? `\n    implementation("${coordinate}")`
      : `\n    implementation "${coordinate}"`;
    contents = contents.replace(/dependencies\s*\{/, match => match + line);
  }
  return contents;
}
if (fs.existsSync(appGradleGroovy)) {
  const gradle = addNativeSecurityDependencies(fs.readFileSync(appGradleGroovy, 'utf8'), false);
  fs.writeFileSync(appGradleGroovy, gradle);
} else if (fs.existsSync(appGradleKts)) {
  const gradle = addNativeSecurityDependencies(fs.readFileSync(appGradleKts, 'utf8'), true);
  fs.writeFileSync(appGradleKts, gradle);
} else {
  throw new Error('Generated Android app Gradle file was not found; native security dependencies cannot be wired.');
}

// Install narrowly scoped R8 rules for SDK reflection/serialization entry points.
// These rules are inert unless the generated release build enables minification.
const proguardTemplate = path.join(securityTemplateDir, 'proguard-rules.pro');
if (!fs.existsSync(proguardTemplate)) throw new Error('Payment SDK ProGuard template is missing.');
const proguardTarget = path.join(appModuleDir, 'proguard-rules.pro');
const proguardRules = fs.readFileSync(proguardTemplate, 'utf8');
if (!fs.existsSync(proguardTarget) || !fs.readFileSync(proguardTarget, 'utf8').includes('AURELIA_PAYMENT_SDK_KEEP_RULES')) {
  const existingRules = fs.existsSync(proguardTarget) ? fs.readFileSync(proguardTarget, 'utf8') : '';
  fs.writeFileSync(proguardTarget, existingRules + '\n' + proguardRules);
}
function wireReleaseProguard(contents, kotlinDsl) {
  if (/proguardFiles[^\n]*proguard-rules\.pro/.test(contents)) return contents;
  const releaseBlock = /(release\s*\{)/;
  if (!releaseBlock.test(contents)) throw new Error('Generated Gradle release build type is missing; cannot wire payment SDK R8 rules.');
  const statement = kotlinDsl
    ? '$1\n            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")'
    : '$1\n            proguardFiles getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro"';
  return contents.replace(releaseBlock, statement);
}
if (fs.existsSync(appGradleGroovy)) {
  const gradle = wireReleaseProguard(fs.readFileSync(appGradleGroovy, 'utf8'), false);
  fs.writeFileSync(appGradleGroovy, gradle);
} else if (fs.existsSync(appGradleKts)) {
  const gradle = wireReleaseProguard(fs.readFileSync(appGradleKts, 'utf8'), true);
  fs.writeFileSync(appGradleKts, gradle);
}

const hasGoogleServicesConfig = fs.existsSync(path.join(appModuleDir, 'google-services.json'));

function addFirebaseDependencies(contents, kotlinDsl) {
  const bom = 'com.google.firebase:firebase-bom:33.5.0';
  const auth = 'com.google.firebase:firebase-auth';
  const paymentDependencies = [
    'com.razorpay:checkout:1.6.41',
    'com.cashfree.pg:api:2.6.1',
    'com.paytmpayments.appinvokesdk:appinvokesdk:1.0.3'
  ];
  if (!/dependencies\s*\{/.test(contents)) {
    throw new Error('App Gradle file has no dependencies block; refusing an incomplete native payment integration.');
  }
  let updated = contents;
  const missing = [auth, ...paymentDependencies].filter(dependency => !updated.includes(dependency));
  if (missing.length) {
    const lines = kotlinDsl
      ? '\n' + missing.map(dependency => '    implementation("' + dependency + '")').join('\n')
      : '\n' + missing.map(dependency => '    implementation "' + dependency + '"').join('\n');
    updated = updated.replace(/dependencies\s*\{/, match => match + lines);
  }
  if (!updated.includes(bom)) {
    updated = updated.replace(/dependencies\s*\{/, match =>
      match + (kotlinDsl
        ? '\n    implementation(platform("' + bom + '"))'
        : '\n    implementation platform("' + bom + '")'));
  }
  return updated;
}

function applyGoogleServices(contents, kotlinDsl) {
  if (!hasGoogleServicesConfig || contents.includes('com.google.gms.google-services')) return contents;
  if (!/plugins\s*\{/.test(contents)) {
    throw new Error('App Gradle file has no plugins block for Google Services; refusing to append an unmanaged plugin.');
  }
  const statement = kotlinDsl
    ? '\n    id("com.google.gms.google-services")'
    : "\n    id 'com.google.gms.google-services'";
  return contents.replace(/plugins\s*\{/, match => match + statement);
}

if (fs.existsSync(appGradleGroovy)) {
  let appGradle = fs.readFileSync(appGradleGroovy, 'utf8');
  appGradle = addFirebaseDependencies(appGradle, false);
  appGradle = applyGoogleServices(appGradle, false);
  fs.writeFileSync(appGradleGroovy, appGradle);
} else if (fs.existsSync(appGradleKts)) {
  let appGradle = fs.readFileSync(appGradleKts, 'utf8');
  appGradle = addFirebaseDependencies(appGradle, true);
  appGradle = applyGoogleServices(appGradle, true);
  fs.writeFileSync(appGradleKts, appGradle);
} else {
  throw new Error('Generated Android app Gradle file was not found; Firebase integration cannot be wired.');
}

if (hasGoogleServicesConfig) {
  let config;
  try {
    config = JSON.parse(fs.readFileSync(path.join(appModuleDir, 'google-services.json'), 'utf8'));
  } catch (error) {
    throw new Error('google-services.json is invalid JSON; refusing Firebase build.', { cause: error });
  }
  const clients = Array.isArray(config.client) ? config.client : [];
  const matchingClient = clients.some(client =>
    client.client_info &&
    client.client_info.android_client_info &&
    client.client_info.android_client_info.package_name === 'com.aurelia.pms' &&
    typeof client.client_info.mobilesdk_app_id === 'string' &&
    /^1:[0-9]+:android:[0-9a-f]+$/i.test(client.client_info.mobilesdk_app_id) &&
    Array.isArray(client.api_key) &&
    client.api_key.some(key => typeof key.current_key === 'string' && /^AIza[0-9A-Za-z_-]{30,}$/.test(key.current_key))
  );
  if (!matchingClient || !config.project_info || typeof config.project_info.project_id !== 'string' || !config.project_info.project_id) {
    throw new Error('google-services.json failed structural validation for package com.aurelia.pms; refusing Firebase build.');
  }
} else {
  console.log('Firebase config not supplied: Firebase SDK is compile-integrated, but Phone Auth is not configured and must remain unavailable at runtime.');
}

// Release signing must use the same controlled keystore as Aurelia Pay Bridge.
// Debug builds remain development-only and cannot authenticate to a release-signed bridge.
if (fs.existsSync(appGradleGroovy)) {
  let gradle = fs.readFileSync(appGradleGroovy, 'utf8');
  if (!gradle.includes('AURELIA_RELEASE_KEYSTORE_PATH')) {
    const envBlock = [
      'def releaseStorePath = System.getenv("AURELIA_RELEASE_KEYSTORE_PATH")',
      'def releaseStorePassword = System.getenv("AURELIA_RELEASE_KEYSTORE_PASSWORD")',
      'def releaseKeyAlias = System.getenv("AURELIA_RELEASE_KEY_ALIAS")',
      'def releaseKeyPassword = System.getenv("AURELIA_RELEASE_KEY_PASSWORD")',
      'def releaseSigningReady = [releaseStorePath, releaseStorePassword, releaseKeyAlias, releaseKeyPassword].every { it != null && !it.trim().isEmpty() }'
    ].join('\n');
    const signingBlock = [
      '    signingConfigs {',
      '        if (releaseSigningReady) {',
      '            aureliaRelease {',
      '                storeFile file(releaseStorePath)',
      '                storePassword releaseStorePassword',
      '                keyAlias releaseKeyAlias',
      '                keyPassword releaseKeyPassword',
      '            }',
      '        }',
      '    }',
      '    buildTypes {',
      '        release {',
      '            if (releaseSigningReady) { signingConfig signingConfigs.aureliaRelease }',
      '        }',
      '    }'
    ].join('\n');
    if (!/android\s*\{/.test(gradle)) throw new Error('Generated Gradle file has no android block; cannot configure release signing.');
    gradle = gradle.replace(/android\s*\{/, match => match + '\n' + envBlock);
    const start = gradle.indexOf('android {');
    let depth = 0, end = -1;
    for (let i = gradle.indexOf('{', start); i < gradle.length; i++) {
      if (gradle[i] === '{') depth++;
      else if (gradle[i] === '}' && --depth === 0) { end = i; break; }
    }
    if (end < 0) throw new Error('Could not locate generated android block boundary.');
    gradle = gradle.slice(0, end) + signingBlock + '\n' + gradle.slice(end);
    fs.writeFileSync(appGradleGroovy, gradle);
  }
} else {
  throw new Error('Expected generated Groovy app/build.gradle; release signing configuration was not applied.');
}

const payBridgeTemplate = path.join(androidDir, 'templates', 'PayBridgeClient.java');
if (!fs.existsSync(payBridgeTemplate)) throw new Error('PayBridgeClient.java template is missing.');
fs.copyFileSync(payBridgeTemplate, path.join(javaDir, 'PayBridgeClient.java'));
const payBridgeProtocolTemplate = path.join(androidDir, 'templates', 'PayBridgeProtocol.java');
if (!fs.existsSync(payBridgeProtocolTemplate)) throw new Error('PayBridgeProtocol.java template is missing.');
fs.copyFileSync(payBridgeProtocolTemplate, path.join(javaDir, 'PayBridgeProtocol.java'));
const localGatewayVaultTemplate = path.join(androidDir, 'templates', 'LocalGatewayVault.java');
if (!fs.existsSync(localGatewayVaultTemplate)) throw new Error('LocalGatewayVault.java template is missing.');
fs.copyFileSync(localGatewayVaultTemplate, path.join(javaDir, 'LocalGatewayVault.java'));
const localPaymentLedgerTemplate = path.join(androidDir, 'templates', 'LocalPaymentLedger.java');
if (!fs.existsSync(localPaymentLedgerTemplate)) throw new Error('LocalPaymentLedger.java template is missing.');
fs.copyFileSync(localPaymentLedgerTemplate, path.join(javaDir, 'LocalPaymentLedger.java'));
const localPmsRepositoryTemplate = path.join(androidDir, 'templates', 'LocalPmsRepository.java');
if (!fs.existsSync(localPmsRepositoryTemplate)) throw new Error('LocalPmsRepository.java template is missing.');
fs.copyFileSync(localPmsRepositoryTemplate, path.join(javaDir, 'LocalPmsRepository.java'));
const pmsStoragePluginTemplate = path.join(androidDir, 'templates', 'CapacitorPmsStoragePlugin.java');
if (!fs.existsSync(pmsStoragePluginTemplate)) throw new Error('CapacitorPmsStoragePlugin.java template is missing.');
fs.copyFileSync(pmsStoragePluginTemplate, path.join(javaDir, 'CapacitorPmsStoragePlugin.java'));

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
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.webkit.WebResourceRequest;
import android.webkit.SslErrorHandler;
import android.net.http.SslError;
import android.app.Dialog;
import android.view.ViewGroup;
import org.json.JSONObject;
import com.getcapacitor.BridgeActivity;
import com.aurelia.pms.security.PaymentDeviceKeyStore;
import com.aurelia.pms.security.PaymentDeviceClient;
import com.google.firebase.auth.FirebaseAuth;
import com.google.android.gms.tasks.Tasks;
import com.razorpay.Checkout;
import com.razorpay.PaymentData;
import com.razorpay.PaymentResultWithDataListener;
import com.cashfree.pg.api.CFPaymentGatewayService;
import com.paytm.pgsdk.PaytmOrder;
import com.paytm.pgsdk.PaytmPaymentTransactionCallback;
import com.paytm.pgsdk.TransactionManager;
import com.cashfree.pg.core.api.CFSession;
import com.cashfree.pg.core.api.callback.CFCheckoutResponseCallback;
import com.cashfree.pg.core.api.exception.CFException;
import com.cashfree.pg.core.api.utils.CFErrorResponse;
import com.cashfree.pg.core.api.webcheckout.CFWebCheckoutPayment;
import com.cashfree.pg.core.api.webcheckout.CFWebCheckoutTheme;
import androidx.activity.OnBackPressedCallback;
import java.io.OutputStream;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

public class MainActivity extends BridgeActivity implements PaymentResultWithDataListener, CFCheckoutResponseCallback {
  private static final int PICK_BACKUP_FOLDER = 7101;
  private static final int CREATE_BACKUP_FILE = 7102;
  private static final int PICK_IMAGE_FILE = 7103;
  private static final int PAYTM_REQUEST_CODE = 7104;
  private String folderRequestId = "";
  private String folderPurpose = "drive";
  private String pendingFileRequestId = "";
  private String pendingImageRequestId = "";
  private TextRecognizer ocrRecognizer;
  private byte[] pendingBytes = new byte[0];
  private boolean pendingIsBackup = false;
  private SharedPreferences prefs;
  private PayBridgeClient payBridgeClient;
  private LocalGatewayVault localGatewayVault;
  private LocalPaymentLedger localPaymentLedger;
  private PaymentDeviceKeyStore paymentDeviceKeyStore;
  private PaymentDeviceClient paymentDeviceClient;
  private final java.util.concurrent.ConcurrentHashMap<String, PaymentDeviceClient.Lease> paymentDeviceLeases = new java.util.concurrent.ConcurrentHashMap<>();
  private String pendingCheckoutTransactionId = "";
  private String pendingCheckoutProvider = "";
  private boolean hostedCheckoutBackgrounded = false;
  private final ExecutorService backupExecutor = Executors.newSingleThreadExecutor();

  @Override public void onCreate(Bundle savedInstanceState) {
    // Explicit registration is required: the custom plugin is not discovered by package scanning.
    registerPlugin(CapacitorPmsStoragePlugin.class);
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
    localGatewayVault = new LocalGatewayVault(this);
    localPaymentLedger = new LocalPaymentLedger(this);
    paymentDeviceKeyStore = new PaymentDeviceKeyStore();
    initializePaymentDeviceClient();
    try { CFPaymentGatewayService.getInstance().setCheckoutCallback(this); }
    catch (CFException ignored) { }
    Checkout.preload(getApplicationContext());
    getWindow().setStatusBarColor(Color.rgb(5, 17, 13));
    getWindow().setNavigationBarColor(Color.rgb(5, 17, 13));
    getWindow().getDecorView().setSystemUiVisibility(0);
    getWindow().setSoftInputMode(WindowManager.LayoutParams.SOFT_INPUT_ADJUST_RESIZE);
    if (Build.VERSION.SDK_INT >= 29) getWindow().setNavigationBarContrastEnforced(false);
    payBridgeClient = new PayBridgeClient(this, status -> js("window.aureliaPayBridgeStatusChanged && window.aureliaPayBridgeStatusChanged(" + q(status) + ")"));
    bridge.getWebView().addJavascriptInterface(new AureliaBridge(), "AureliaNative");
    payBridgeClient.connect();
  }

  private String freshFirebaseIdToken() throws Exception {
    com.google.firebase.auth.FirebaseUser user = FirebaseAuth.getInstance().getCurrentUser();
    if (user == null) throw new IllegalStateException("A signed-in Firebase identity is required.");
    String token = Tasks.await(user.getIdToken(false)).getToken();
    if (token == null || token.length() < 20) throw new IllegalStateException("Firebase did not return a valid identity token.");
    return token;
  }

  private void emitNativePaymentEvent(String status, String providerPaymentId) {
    String transactionId = pendingCheckoutTransactionId;
    String provider = pendingCheckoutProvider;
    if (transactionId.isEmpty()) return;
    js("window.aureliaNativePaymentEvent && window.aureliaNativePaymentEvent(" +
        q(transactionId) + "," + q(provider) + "," + q(status) + "," + q(providerPaymentId == null ? "" : providerPaymentId) + ")");
  }

  @Override public void onPaymentSuccess(String paymentId, PaymentData paymentData) {
    emitNativePaymentEvent("RAZORPAY_CALLBACK", paymentId);
    pendingCheckoutTransactionId = "";
    pendingCheckoutProvider = "";
  }

  @Override public void onPaymentError(int code, String response, PaymentData paymentData) {
    emitNativePaymentEvent("RAZORPAY_ERROR_CALLBACK", "");
    pendingCheckoutTransactionId = "";
    pendingCheckoutProvider = "";
  }

  @Override public void onPaymentVerify(String orderID) {
    emitNativePaymentEvent("CASHFREE_CALLBACK", "");
    pendingCheckoutTransactionId = "";
    pendingCheckoutProvider = "";
  }

  @Override public void onPaymentFailure(CFErrorResponse error, String orderID) {
    emitNativePaymentEvent("CASHFREE_ERROR_CALLBACK", "");
    pendingCheckoutTransactionId = "";
    pendingCheckoutProvider = "";
  }

  private void startPayUCheckout(String transactionId, String orderId, JSONObject checkoutData) throws Exception {
    JSONObject data = checkoutData.optJSONObject("checkout");
    JSONObject fields = data == null ? null : data.optJSONObject("fields");
    String action = data == null ? "" : data.optString("action", "");
    Uri actionUri = Uri.parse(action);
    if (fields == null || !"POST".equals(data.optString("method", "")) ||
        !"https".equalsIgnoreCase(actionUri.getScheme()) ||
        !"test.payu.in".equalsIgnoreCase(actionUri.getHost()) ||
        (actionUri.getPort() != -1 && actionUri.getPort() != 443) ||
        !"/_payment".equals(actionUri.getPath()) || actionUri.getUserInfo() != null) {
      throw new IllegalArgumentException("PayU sandbox checkout payload is invalid.");
    }
    String successUrl = fields.optString("surl", "");
    String failureUrl = fields.optString("furl", "");
    Uri successUri = Uri.parse(successUrl);
    Uri failureUri = Uri.parse(failureUrl);
    if (!"https".equalsIgnoreCase(successUri.getScheme()) ||
        !"https".equalsIgnoreCase(failureUri.getScheme()) ||
        successUri.getHost() == null || failureUri.getHost() == null ||
        successUri.getUserInfo() != null || failureUri.getUserInfo() != null) {
      throw new IllegalArgumentException("PayU return URLs must be HTTPS.");
    }
    StringBuilder form = new StringBuilder();
    java.util.Iterator<String> keys = fields.keys();
    while (keys.hasNext()) {
      String key = keys.next();
      String value = fields.optString(key, "");
      if (key.isEmpty() || value.length() > 4096 ||
          key.matches(".*[\\r\\n].*") || value.matches(".*[\\r\\n].*")) {
        throw new IllegalArgumentException("PayU checkout form contains an invalid field.");
      }
      if (form.length() > 0) form.append('&');
      form.append(java.net.URLEncoder.encode(key, "UTF-8"));
      form.append('=').append(java.net.URLEncoder.encode(value, "UTF-8"));
    }
    Dialog dialog = new Dialog(MainActivity.this);
    WebView webView = new WebView(MainActivity.this);
    WebView.setWebContentsDebuggingEnabled(false);
    android.webkit.WebSettings settings = webView.getSettings();
    settings.setJavaScriptEnabled(true);
    settings.setDomStorageEnabled(true);
    settings.setAllowFileAccess(false);
    settings.setAllowContentAccess(false);
    settings.setMixedContentMode(android.webkit.WebSettings.MIXED_CONTENT_NEVER_ALLOW);
    webView.setWebViewClient(new WebViewClient() {
      private boolean isReturn(Uri target) {
        return "https".equalsIgnoreCase(target.getScheme()) &&
            ((successUri.getHost().equalsIgnoreCase(target.getHost()) &&
              java.util.Objects.equals(successUri.getPath(), target.getPath())) ||
             (failureUri.getHost().equalsIgnoreCase(target.getHost()) &&
              java.util.Objects.equals(failureUri.getPath(), target.getPath())));
      }
      @Override public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
        Uri target = request.getUrl();
        if (isReturn(target)) {
          emitNativePaymentEvent("PAYU_CALLBACK", "");
          pendingCheckoutTransactionId = "";
          pendingCheckoutProvider = "";
          dialog.dismiss();
          return true;
        }
        String scheme = target.getScheme() == null ? "" : target.getScheme().toLowerCase(java.util.Locale.ROOT);
        if ("upi".equals(scheme) || "intent".equals(scheme) ||
            "phonepe".equals(scheme) || "paytmmp".equals(scheme) || "tez".equals(scheme)) {
          try {
            Intent external = "intent".equals(scheme)
                ? Intent.parseUri(target.toString(), Intent.URI_INTENT_SCHEME)
                : new Intent(Intent.ACTION_VIEW, target);
            Uri externalData = external.getData();
            String externalPackage = external.getPackage();
            boolean allowedUpiPackage = externalPackage == null ||
                java.util.Arrays.asList("com.phonepe.app", "net.one97.paytm",
                    "com.google.android.apps.nbu.paisa.user", "in.org.npci.upiapp")
                    .contains(externalPackage);
            String externalScheme = externalData == null ? "" : externalData.getScheme();
            boolean allowedPaymentScheme = "upi".equalsIgnoreCase(externalScheme) ||
                "phonepe".equalsIgnoreCase(externalScheme) ||
                "paytmmp".equalsIgnoreCase(externalScheme) ||
                "tez".equalsIgnoreCase(externalScheme);
            if (allowedPaymentScheme && allowedUpiPackage &&
                external.resolveActivity(getPackageManager()) != null) {
              startActivity(external);
            }
          } catch (Exception ignored) { }
          return true;
        }
        return !"https".equalsIgnoreCase(scheme);
      }
      @Override public void onReceivedSslError(WebView view, SslErrorHandler handler, SslError error) {
        handler.cancel();
      }
      @Override public void onReceivedError(WebView view, WebResourceRequest request,
          android.webkit.WebResourceError error) {
        if (request.isForMainFrame() && transactionId.equals(pendingCheckoutTransactionId)) {
          emitNativePaymentEvent("PAYU_NETWORK_UNKNOWN", "");
        }
      }
    });
    dialog.setContentView(webView, new ViewGroup.LayoutParams(
        ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
    dialog.setOnDismissListener(ignored -> {
      if (transactionId.equals(pendingCheckoutTransactionId) && "payu".equals(pendingCheckoutProvider)) {
        emitNativePaymentEvent("PAYU_CANCEL_HINT", "");
        pendingCheckoutTransactionId = "";
        pendingCheckoutProvider = "";
      }
    });
    dialog.show();
    if (dialog.getWindow() != null) dialog.getWindow().setLayout(
        ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT);
    webView.postUrl(action, form.toString().getBytes(StandardCharsets.UTF_8));
  }

  private void startPaytmCheckout(String orderId, long amountMinor, JSONObject checkoutData) throws Exception {
    JSONObject data = checkoutData.optJSONObject("checkout");
    if (data == null) throw new IllegalArgumentException("Paytm checkout payload is missing.");
    String mid = data.optString("mid", "");
    String token = data.optString("txnToken", "");
    String host = data.optString("checkoutHost", "");
    String callbackUrl = data.optString("callbackUrl", "");
    if (mid.isEmpty() || token.isEmpty() || !callbackUrl.startsWith("https://") ||
        !"https://securestage.paytmpayments.com".equals(host)) {
      throw new IllegalArgumentException("Paytm staging checkout binding is invalid.");
    }
    String amount = String.format(java.util.Locale.US, "%.2f", amountMinor / 100.0d);
    PaytmOrder order = new PaytmOrder(orderId, mid, token, amount, callbackUrl);
    TransactionManager manager = new TransactionManager(order, new PaytmPaymentTransactionCallback() {
      @Override public void onTransactionResponse(Bundle response) {
        String paymentId = response == null ? "" : response.getString("TXNID", "");
        emitNativePaymentEvent("PAYTM_CALLBACK", paymentId);
        pendingCheckoutTransactionId = "";
        pendingCheckoutProvider = "";
      }
      @Override public void networkNotAvailable() {
        emitNativePaymentEvent("PAYTM_NETWORK_UNKNOWN", "");
        pendingCheckoutTransactionId = "";
        pendingCheckoutProvider = "";
      }
      @Override public void onErrorProceed(String error) {
        emitNativePaymentEvent("PAYTM_ERROR_CALLBACK", "");
        pendingCheckoutTransactionId = "";
        pendingCheckoutProvider = "";
      }
      @Override public void clientAuthenticationFailed(String error) {
        emitNativePaymentEvent("PAYTM_ERROR_CALLBACK", "");
        pendingCheckoutTransactionId = "";
        pendingCheckoutProvider = "";
      }
      @Override public void someUIErrorOccurred(String error) {
        emitNativePaymentEvent("PAYTM_ERROR_CALLBACK", "");
        pendingCheckoutTransactionId = "";
        pendingCheckoutProvider = "";
      }
      @Override public void onErrorLoadingWebPage(int code, String message, String url) {
        emitNativePaymentEvent("PAYTM_NETWORK_UNKNOWN", "");
        pendingCheckoutTransactionId = "";
        pendingCheckoutProvider = "";
      }
      @Override public void onTransactionCancel(String message, Bundle response) {
        emitNativePaymentEvent("PAYTM_CANCEL_HINT", "");
        pendingCheckoutTransactionId = "";
        pendingCheckoutProvider = "";
      }
    });
    manager.setShowPaymentUrl(host + "/theia/api/v1/showPaymentPage");
    manager.startTransaction(MainActivity.this, PAYTM_REQUEST_CODE);
  }

  private void initializePaymentDeviceClient() {
    paymentDeviceClient = null;
    paymentDeviceLeases.clear();
    if (prefs == null || paymentDeviceKeyStore == null || !paymentDeviceKeyStore.hasAttestedIdentity()) return;
    String applianceUrl = prefs.getString("payment_device_appliance_url", "");
    String deviceId = prefs.getString("payment_device_id", "");
    if (applianceUrl.isEmpty() || deviceId.isEmpty()) return;
    try { paymentDeviceClient = new PaymentDeviceClient(applianceUrl, deviceId, paymentDeviceKeyStore); }
    catch (Exception ignored) { paymentDeviceClient = null; }
  }

  @Override public void onResume() {
    // Check authorization before resuming WebView execution. A fresh process
    // starts locked; the native launcher must authenticate first.
    if (!com.aurelia.pms.security.AureliaSecurityRuntime.INSTANCE.manager(this).onForeground()) {
      startActivity(new Intent(this, com.aurelia.pms.security.LockGateActivity.class));
      finish();
      return;
    }
    super.onResume();
    if (hostedCheckoutBackgrounded && !pendingCheckoutTransactionId.isEmpty()) {
      hostedCheckoutBackgrounded = false;
      emitNativePaymentEvent("HOSTED_CHECKOUT_RETURNED", "");
      pendingCheckoutTransactionId = "";
      pendingCheckoutProvider = "";
    }
    if (payBridgeClient != null) payBridgeClient.connect();
  }

  @Override public void onPause() {
    if (!pendingCheckoutTransactionId.isEmpty() &&
        ("phonepe".equals(pendingCheckoutProvider) || "jiopay".equals(pendingCheckoutProvider))) {
      hostedCheckoutBackgrounded = true;
    }
    com.aurelia.pms.security.AureliaSecurityRuntime.INSTANCE.manager(this).onBackground();
    super.onPause();
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
    // Prefer the Android Photo Picker. Do not add CATEGORY_OPENABLE to ACTION_PICK_IMAGES:
    // several Android 13/14 picker implementations do not resolve that combination.
    Intent picker = null;
    if (Build.VERSION.SDK_INT >= 33) {
      try {
        picker = new Intent(MediaStore.ACTION_PICK_IMAGES);
        picker.setType("image/*");
        picker.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
        if (picker.resolveActivity(getPackageManager()) == null) picker = null;
      } catch (Exception ignored) { picker = null; }
    }
    // Reliable system document-picker fallback for OEMs without a resolvable Photo Picker.
    if (picker == null) {
      picker = new Intent(Intent.ACTION_OPEN_DOCUMENT);
      picker.setType("image/*");
      picker.addCategory(Intent.CATEGORY_OPENABLE);
      picker.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION);
    }
    try {
      startActivityForResult(picker, PICK_IMAGE_FILE);
    } catch (android.content.ActivityNotFoundException firstFailure) {
      try {
        Intent fallback = new Intent(Intent.ACTION_GET_CONTENT);
        fallback.setType("image/*");
        fallback.addCategory(Intent.CATEGORY_OPENABLE);
        fallback.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
        startActivityForResult(fallback, PICK_IMAGE_FILE);
      } catch (Exception secondFailure) {
        pendingImageRequestId = "";
        imageResult(requestId, false, "No compatible Android photo or file picker is available.");
      }
    } catch (Exception e) {
      pendingImageRequestId = "";
      imageResult(requestId, false, "Could not open the Android photo or file picker.");
    }
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
    js("window.aureliaNativeBackupFolderResult && window.aureliaNativeBackupFolderResult(" + q(id) + "," + ok + "," + q(message) + "," + q(folderPurpose) + ")");
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
  private JSONObject readLatestBackupFromFolder(String saved, String excludedJson) throws Exception {
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
    if (!"https".equalsIgnoreCase(parsed.getScheme()) || parsed.getHost()==null || parsed.getUserInfo()!=null || parsed.getQuery()!=null || parsed.getFragment()!=null)
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
      if ("AURELIA-PMS-ENCRYPTED-BACKUP".equals(backup.optString("format", ""))) {
        return backup.optInt("v", -1) == 1
            && "com.aurelia.pms".equals(backup.optString("application", ""))
            && "AES-256-GCM".equals(backup.optString("cipher", ""))
            && "PBKDF2-HMAC-SHA256".equals(backup.optString("kdf", ""))
            && backup.optInt("iterations", -1) == 600000
            && backup.optString("name", "").matches("^aurelia-backup-[A-Za-z0-9._-]+\\.json$")
            && backup.optString("salt", "").matches("^[A-Za-z0-9+/]{22}==$")
            && backup.optString("iv", "").matches("^[A-Za-z0-9+/]{16}$")
            && backup.optString("wrapIv", "").matches("^[A-Za-z0-9+/]{16}$")
            && backup.optString("wrappedKey", "").matches("^[A-Za-z0-9+/]{64}$")
            && backup.optString("ciphertext", "").matches("^[A-Za-z0-9+/=]+$");
      }
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

  private String writeToSelectedFolder(String name, String payload, String requestId) { return writeToTreeFolder(prefs.getString("backup_tree_uri",""),name,payload,requestId); }
  private String writeToSharedFolder(String name, String payload, String requestId) { return writeToTreeFolder(prefs.getString("shared_tree_uri",""),name,payload,requestId); }
  private String writeToTreeFolder(String saved, String name, String payload, String requestId) {
    if (saved == null || saved.isEmpty()) return "No folder permission is saved.";
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
        } else if ("paymentEngineStatus".equals(type)) {
          boolean ready = paymentDeviceClient != null && paymentDeviceKeyStore != null &&
              paymentDeviceKeyStore.hasAttestedIdentity();
          JSONObject result = new JSONObject().put("ready", ready)
              .put("livePaymentsEnabled", false)
              .put("environment", "test")
              .put("deviceId", prefs.getString("payment_device_id", ""))
              .put("applianceBaseUrl", prefs.getString("payment_device_appliance_url", ""));
          js("window.aureliaNativePaymentDeviceResult && window.aureliaNativePaymentDeviceResult(" + q(requestId) + ",true," + q(result.toString()) + ")");
        } else if ("paymentEngineStartCheckout".equals(type)) {
          String transactionId = obj.optString("transactionId", "");
          boolean checkoutClaimed = false;
          try {
            if (!pendingCheckoutTransactionId.isEmpty()) {
              throw new IllegalStateException("A provider checkout is already active on this device.");
            }
            if (paymentDeviceClient == null || !paymentDeviceKeyStore.hasAttestedIdentity()) {
              throw new IllegalStateException("An attested payment device is required.");
            }
            String provider = obj.optString("provider", "");
            String environment = obj.optString("environment", "");
            com.aurelia.pms.security.PaymentReleaseSafeguards.assertSandboxCheckoutAllowed(provider, environment);
            String orderId = obj.optString("providerOrderId", "");
            long amountMinor = obj.optLong("amountMinor", -1L);
            String currency = obj.optString("currency", "");
            JSONObject checkoutData = obj.optJSONObject("checkoutData");
            boolean supportedEnvironment =
                (("razorpay".equals(provider) || "cashfree".equals(provider) ||
                  "payu".equals(provider) || "phonepe".equals(provider)) && "test".equals(environment)) ||
                ("jiopay".equals(provider) && "uat".equals(environment)) ||
                ("paytm".equals(provider) && "staging".equals(environment));
            if (!transactionId.matches("[0-9a-fA-F-]{36}") || !supportedEnvironment ||
                orderId.isEmpty() || amountMinor <= 0 || !"INR".equals(currency) || checkoutData == null) {
              throw new IllegalArgumentException("Native checkout request is invalid or outside the provider test environment.");
            }
            pendingCheckoutTransactionId = transactionId;
            pendingCheckoutProvider = provider;
            checkoutClaimed = true;
            if ("razorpay".equals(provider)) {
              String keyId = checkoutData.optString("keyId", "");
              if (keyId.isEmpty()) throw new IllegalArgumentException("Razorpay public checkout key is missing.");
              JSONObject options = new JSONObject()
                  .put("name", "Aurelia PMS")
                  .put("description", "Property booking payment")
                  .put("currency", currency)
                  .put("amount", amountMinor)
                  .put("order_id", orderId);
              options.put("prefill", new JSONObject()
                  .put("name", obj.optJSONObject("customer") == null ? "Guest" : obj.getJSONObject("customer").optString("name", "Guest"))
                  .put("email", obj.optJSONObject("customer") == null ? "" : obj.getJSONObject("customer").optString("email", ""))
                  .put("contact", obj.optJSONObject("customer") == null ? "" : obj.getJSONObject("customer").optString("phone", "")));
              Checkout checkout = new Checkout();
              checkout.setKeyID(keyId);
              checkout.open(MainActivity.this, options);
            } else if ("cashfree".equals(provider)) {
              String paymentSessionId = checkoutData.optString("paymentSessionId", "");
              if (paymentSessionId.isEmpty()) throw new IllegalArgumentException("Cashfree payment session is missing.");
              CFSession session = new CFSession.CFSessionBuilder()
                  .setEnvironment(CFSession.Environment.SANDBOX)
                  .setPaymentSessionID(paymentSessionId)
                  .setOrderId(orderId)
                  .build();
              CFWebCheckoutTheme theme = new CFWebCheckoutTheme.CFWebCheckoutThemeBuilder()
                  .setNavigationBarBackgroundColor("#000000")
                  .setNavigationBarTextColor("#FFFFFF")
                  .build();
              CFWebCheckoutPayment payment = new CFWebCheckoutPayment.CFWebCheckoutPaymentBuilder()
                  .setSession(session)
                  .setCFWebCheckoutUITheme(theme)
                  .build();
              CFPaymentGatewayService.getInstance().doPayment(MainActivity.this, payment);
            } else if ("payu".equals(provider)) {
              startPayUCheckout(transactionId, orderId, checkoutData);
            } else if ("paytm".equals(provider)) {
              startPaytmCheckout(orderId, amountMinor, checkoutData);
            } else if ("phonepe".equals(provider) || "jiopay".equals(provider)) {
              String checkoutUrl = checkoutData.optString("checkoutUrl", "");
              Uri checkoutUri = Uri.parse(checkoutUrl);
              if (!"https".equalsIgnoreCase(checkoutUri.getScheme()) ||
                  checkoutUri.getHost() == null || checkoutUri.getUserInfo() != null ||
                  checkoutUrl.length() > 4096) {
                throw new IllegalArgumentException("Provider checkout URL is invalid.");
              }
              Intent checkoutIntent = new Intent(Intent.ACTION_VIEW, checkoutUri);
              if (checkoutIntent.resolveActivity(getPackageManager()) == null) {
                throw new IllegalStateException("No secure browser is available for provider checkout.");
              }
              startActivity(checkoutIntent);
            } else {
              throw new IllegalArgumentException("This provider's native checkout contract is not yet qualified.");
            }
            JSONObject result = new JSONObject().put("opened", true).put("status", "PENDING")
                .put("providerOrderId", orderId);
            js("window.aureliaNativePaymentDeviceResult && window.aureliaNativePaymentDeviceResult(" + q(requestId) + ",true," + q(result.toString()) + ")");
          } catch (Exception error) {
            if (checkoutClaimed && transactionId.equals(pendingCheckoutTransactionId)) {
              pendingCheckoutTransactionId = "";
              pendingCheckoutProvider = "";
            }
            JSONObject result = new JSONObject().put("error", "native_provider_checkout_failed");
            js("window.aureliaNativePaymentDeviceResult && window.aureliaNativePaymentDeviceResult(" + q(requestId) + ",false," + q(result.toString()) + ")");
          }
        } else if ("paymentDeviceGetIdToken".equals(type)) {
          backupExecutor.execute(() -> {
            try {
              JSONObject result = new JSONObject().put("idToken", freshFirebaseIdToken());
              js("window.aureliaNativePaymentDeviceResult && window.aureliaNativePaymentDeviceResult(" + q(requestId) + ",true," + q(result.toString()) + ")");
            } catch (Exception error) {
              String result = "{\"error\":\"firebase_identity_unavailable\"}";
              js("window.aureliaNativePaymentDeviceResult && window.aureliaNativePaymentDeviceResult(" + q(requestId) + ",false," + q(result.toString()) + ")");
            }
          });
        } else if ("paymentDeviceCreateAttestedIdentity".equals(type)) {
          String challenge = obj.optString("challengeBase64", "");
          if (challenge.isEmpty() || challenge.length() > 256) throw new IllegalArgumentException("Invalid attestation challenge.");
          final String rid = requestId;
          backupExecutor.execute(() -> {
            try {
              byte[] challengeBytes = android.util.Base64.decode(challenge,
                  android.util.Base64.URL_SAFE | android.util.Base64.NO_WRAP | android.util.Base64.NO_PADDING);
              PaymentDeviceKeyStore.AttestedIdentity identity = paymentDeviceKeyStore.createAttestedIdentity(challengeBytes);
              JSONObject result = new JSONObject()
                  .put("keyAlias", identity.getKeyAlias())
                  .put("publicKeyPem", identity.getPublicKeyPem())
                  .put("certificateChainBase64", new org.json.JSONArray(identity.getCertificateChainBase64()))
                  .put("securityLevel", identity.getSecurityLevel());
              js("window.aureliaNativePaymentDeviceResult && window.aureliaNativePaymentDeviceResult(" + q(rid) + ",true," + q(result.toString()) + ")");
            } catch (Exception error) {
              String result = "{\"error\":\"attested_key_creation_failed\"}";
              js("window.aureliaNativePaymentDeviceResult && window.aureliaNativePaymentDeviceResult(" + q(rid) + ",false," + q(result.toString()) + ")");
            }
          });
        } else if ("paymentDeviceConfigure".equals(type)) {
          String applianceUrl = obj.optString("applianceBaseUrl", "");
          String deviceId = obj.optString("deviceId", "");
          if (!applianceUrl.startsWith("https://") || applianceUrl.length() > 512 ||
              !deviceId.matches("[A-Za-z0-9_-]{8,64}") || !paymentDeviceKeyStore.hasAttestedIdentity()) {
            throw new IllegalArgumentException("Trusted attested payment device configuration is invalid.");
          }
          prefs.edit().putString("payment_device_appliance_url", applianceUrl)
              .putString("payment_device_id", deviceId).apply();
          initializePaymentDeviceClient();
          if (paymentDeviceClient == null) throw new IllegalStateException("Trusted payment device client could not be initialized.");
          JSONObject result = new JSONObject().put("configured", true).put("deviceId", deviceId);
          js("window.aureliaNativePaymentDeviceResult && window.aureliaNativePaymentDeviceResult(" + q(requestId) + ",true," + q(result.toString()) + ")");
        } else if ("paymentDeviceLeaseNext".equals(type)) {
          final String rid = requestId;
          backupExecutor.execute(() -> {
            try {
              if (paymentDeviceClient == null) throw new IllegalStateException("Trusted payment device is not configured.");
              String idToken = obj.optString("idToken", "");
              if (idToken.length() < 20) throw new IllegalArgumentException("Fresh Firebase identity is required.");
              PaymentDeviceClient.Lease lease = paymentDeviceClient.leaseNext(idToken);
              if (lease == null) {
                js("window.aureliaNativePaymentDeviceResult && window.aureliaNativePaymentDeviceResult(" + q(rid) + ",true," + q("{\"available\":false}") + ")");
                return;
              }
              String commandId = lease.getCommand().getString("commandId");
              paymentDeviceLeases.put(commandId, lease);
              JSONObject result = new JSONObject()
                  .put("available", true).put("command", lease.getCommand())
                  .put("settlement", lease.getSettlement()).put("policyLease", lease.getPolicyLease())
                  .put("authorization", lease.getAuthorization() == null ? JSONObject.NULL : lease.getAuthorization())
                  .put("settlementAuthorized", lease.getSettlementAuthorized())
                  .put("leaseToken", lease.getLeaseToken()).put("cursor", lease.getCursor())
                  .put("leaseExpiresAt", lease.getLeaseExpiresAt());
              js("window.aureliaNativePaymentDeviceResult && window.aureliaNativePaymentDeviceResult(" + q(rid) + ",true," + q(result.toString()) + ")");
            } catch (Exception error) {
              String result = "{\"error\":\"payment_device_lease_failed\"}";
              js("window.aureliaNativePaymentDeviceResult && window.aureliaNativePaymentDeviceResult(" + q(rid) + ",false," + q(result.toString()) + ")");
            }
          });
        } else if ("paymentDeviceAcknowledge".equals(type)) {
          final String rid = requestId;
          final String commandId = obj.optString("commandId", "");
          final String ledgerAckId = obj.optString("ledgerAckId", "");
          backupExecutor.execute(() -> {
            try {
              PaymentDeviceClient.Lease lease = paymentDeviceLeases.get(commandId);
              if (paymentDeviceClient == null || lease == null || !lease.getSettlementAuthorized()) {
                throw new IllegalStateException("No verified, unexpired settlement lease is available.");
              }
              String idToken = obj.optString("idToken", "");
              if (idToken.length() < 20) throw new IllegalArgumentException("Fresh Firebase identity is required.");
              JSONObject result = paymentDeviceClient.acknowledge(lease, ledgerAckId, idToken);
              paymentDeviceLeases.remove(commandId);
              js("window.aureliaNativePaymentDeviceResult && window.aureliaNativePaymentDeviceResult(" + q(rid) + ",true," + q(result.toString()) + ")");
            } catch (Exception error) {
              String result = "{\"error\":\"payment_device_acknowledgement_failed\"}";
              js("window.aureliaNativePaymentDeviceResult && window.aureliaNativePaymentDeviceResult(" + q(rid) + ",false," + q(result.toString()) + ")");
            }
          });
        } else if ("paymentLedgerCreate".equals(type)) {
          JSONObject result = localPaymentLedger.create(obj.optJSONObject("entry"));
          js("window.aureliaNativeLedgerResult && window.aureliaNativeLedgerResult(" + q(requestId) + ",true," + q(result.toString()) + ")");
        } else if ("paymentLedgerListPending".equals(type)) {
          org.json.JSONArray result = localPaymentLedger.listPending(obj.optInt("limit", 50));
          js("window.aureliaNativeLedgerResult && window.aureliaNativeLedgerResult(" + q(requestId) + ",true," + q(result.toString()) + ")");
        } else if ("paymentLedgerUpdateLocalStatus".equals(type)) {
          JSONObject result = localPaymentLedger.updateLocalStatus(obj.optString("transactionId", ""), obj.optString("status", ""));
          js("window.aureliaNativeLedgerResult && window.aureliaNativeLedgerResult(" + q(requestId) + ",true," + q(result.toString()) + ")");
        } else if ("gatewayVaultStatus".equals(type)) {
          JSONObject result = localGatewayVault.status(obj.optString("provider", ""), obj.optString("environment", "test"));
          js("window.aureliaNativeGatewayResult && window.aureliaNativeGatewayResult(" + q(requestId) + ",true," + q(result.toString()) + ")");
        } else if ("gatewayVaultSave".equals(type)) {
          JSONObject result = localGatewayVault.save(obj.optString("provider", ""), obj.optString("environment", "test"), obj.optJSONObject("credentials"));
          js("window.aureliaNativeGatewayResult && window.aureliaNativeGatewayResult(" + q(requestId) + ",true," + q(result.toString()) + ")");
        } else if ("gatewayVaultRemove".equals(type)) {
          JSONObject result = localGatewayVault.remove(obj.optString("provider", ""), obj.optString("environment", "test"));
          js("window.aureliaNativeGatewayResult && window.aureliaNativeGatewayResult(" + q(requestId) + ",true," + q(result.toString()) + ")");
        } else if ("gatewayVaultActivate".equals(type)) {
          JSONObject result = localGatewayVault.setActive(obj.optString("provider", ""), obj.optString("environment", "test"), obj.optBoolean("active", false));
          js("window.aureliaNativeGatewayResult && window.aureliaNativeGatewayResult(" + q(requestId) + ",true," + q(result.toString()) + ")");
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
            folderPurpose = "shared".equals(obj.optString("purpose","drive")) ? "shared" : "drive";
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
          boolean localReady = false, driveSelected = false, sharedSelected = false, matchingBackupExists = false;
          try {
            privateBackupDir(); localReady = true;
            driveSelected = !prefs.getString("backup_tree_uri", "").isEmpty();
            sharedSelected = !prefs.getString("shared_tree_uri", "").isEmpty();
            matchingBackupExists = hasPrivateBackup(obj.optString("hash", ""));
          } catch (Exception backupStatusError) { localReady = false; }
          final boolean localAvailable = localReady, driveFolder = driveSelected, sharedFolder = sharedSelected, localMatch = matchingBackupExists;
          js("window.aureliaNativeDeviceBackupStatusResult && window.aureliaNativeDeviceBackupStatusResult(" + q(requestId) + "," + localAvailable + "," + driveFolder + "," + sharedFolder + "," + localMatch + ")");
        } else if ("recoverLatestBackup".equals(type)) {
          final String excluded = obj.optJSONArray("exclude") == null ? "[]" : obj.optJSONArray("exclude").toString();
          backupExecutor.execute(() -> {
            try {
              JSONObject result;
              try { result = readLatestPrivateBackup(excluded); }
              catch (Exception localError) {
                try { result = readLatestBackupFromFolder(prefs.getString("backup_tree_uri",""),excluded); }
                catch (Exception driveError) { result = readLatestBackupFromFolder(prefs.getString("shared_tree_uri",""),excluded); }
              }
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
              String driveUri=prefs.getString("backup_tree_uri","");
              if(!driveUri.isEmpty()) {
                String folderError=writeToSelectedFolder(name,payload,requestId);
                if(folderError!=null) warnings.add("Google Drive / selected SAF copy failed: "+folderError);
              }
              String sharedUri=prefs.getString("shared_tree_uri","");
              if(!sharedUri.isEmpty()) {
                String sharedError=writeToSharedFolder(name,payload,requestId);
                if(sharedError!=null) warnings.add("Shared-folder export copy failed: "+sharedError);
              }
              String serverError=uploadBackupToServer(name,payload);
              if(serverError!=null) warnings.add(serverError);
              backupResult(requestId,true,warnings.isEmpty()?"":"WARN:Private local backup verified. "+android.text.TextUtils.join(" ",warnings));
            } catch(Exception e) {
              backupResult(requestId,false,e.getMessage()==null?"Private local backup failed.":e.getMessage());
            }
          });
        } else if ("clearBackupFolder".equals(type)) {
          String purpose="shared".equals(obj.optString("purpose","drive"))?"shared":"drive";
          String preferenceKey="shared".equals(purpose)?"shared_tree_uri":"backup_tree_uri";
          String savedFolder=prefs.getString(preferenceKey,"");
          if(!savedFolder.isEmpty()) { try { getContentResolver().releasePersistableUriPermission(Uri.parse(savedFolder),Intent.FLAG_GRANT_READ_URI_PERMISSION|Intent.FLAG_GRANT_WRITE_URI_PERMISSION); } catch(Exception ignored) {} }
          prefs.edit().remove(preferenceKey).apply();
          folderPurpose=purpose;
          folderResult(requestId,true,"Optional "+purpose+" folder disconnected; private local backups remain enabled.");
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
        if ("gatewayVaultStatus".equals(operationType) || "gatewayVaultSave".equals(operationType) || "gatewayVaultRemove".equals(operationType) || "gatewayVaultActivate".equals(operationType)) js("window.aureliaNativeGatewayResult && window.aureliaNativeGatewayResult(" + q(operationRequestId) + ",false," + q(message) + ")");
        else if ("paymentLedgerCreate".equals(operationType) || "paymentLedgerListPending".equals(operationType) || "paymentLedgerUpdateLocalStatus".equals(operationType)) js("window.aureliaNativeLedgerResult && window.aureliaNativeLedgerResult(" + q(operationRequestId) + ",false," + q(message) + ")");
        else if ("photoStore".equals(operationType) || "photoLoad".equals(operationType) || "photoArchive".equals(operationType) || "photoRestore".equals(operationType)) photoResult(operationRequestId, false, message);
        else if ("backupDeviceNow".equals(operationType)) backupResult(operationRequestId, false, message);
        else if ("recoverLatestBackup".equals(operationType)) recoveryResult(operationRequestId, false, message, "");
        else if ("deviceBackupStatus".equals(operationType)) js("window.aureliaNativeDeviceBackupStatusResult && window.aureliaNativeDeviceBackupStatusResult(" + q(operationRequestId) + ",false,false,false,false)");
        else if ("restoreLatestServerBackup".equals(operationType)) js("window.aureliaNativeServerRestoreResult && window.aureliaNativeServerRestoreResult(" + q(operationRequestId) + ",false," + q(message) + ")");
        else if ("saveBackupServerConfig".equals(operationType) || "clearBackupServerConfig".equals(operationType) || "testBackupServer".equals(operationType)) js("window.aureliaNativeBackupServerResult && window.aureliaNativeBackupServerResult(" + q(operationRequestId) + ",false," + q(message) + ")");
      }
    }
  }

  @Override protected void onActivityResult(int requestCode, int resultCode, Intent data) {
    super.onActivityResult(requestCode, resultCode, data);
    if (requestCode == PAYTM_REQUEST_CODE && !pendingCheckoutTransactionId.isEmpty() &&
        "paytm".equals(pendingCheckoutProvider)) {
      emitNativePaymentEvent("PAYTM_CALLBACK", "");
      pendingCheckoutTransactionId = "";
      pendingCheckoutProvider = "";
      return;
    }
    if (requestCode == PICK_BACKUP_FOLDER) {
      if (resultCode == RESULT_OK && data != null && data.getData() != null) {
        Uri uri = data.getData();
        try {
          getContentResolver().takePersistableUriPermission(uri, data.getFlags() &
            (Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_GRANT_WRITE_URI_PERMISSION));
          String preferenceKey="shared".equals(folderPurpose)?"shared_tree_uri":"backup_tree_uri";
          prefs.edit().putString(preferenceKey, uri.toString()).apply();
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
