import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read = (path) => readFile(new URL(path, import.meta.url), 'utf8');
const [manifest, service, activity, approval, gradle] = await Promise.all([
  read('../gateway-app/src/main/AndroidManifest.xml'),
  read('../gateway-app/src/main/java/com/aurelia/paybridge/ipc/PayBridgeService.java'),
  read('../gateway-app/src/main/java/com/aurelia/paybridge/GatewayHomeActivity.java'),
  read('../gateway-app/src/main/java/com/aurelia/paybridge/GatewayApprovalStore.java'),
  read('../gateway-app/build.gradle.kts')
]);

test('Gateway companion is branded Aurelia Gateway with the agreed package and protected service', () => {
  assert.match(manifest, /android:label="Aurelia Gateway"/);
  assert.match(gradle, /applicationId = "com\.aurelia\.paybridge"/);
  assert.match(manifest, /android:protectionLevel="signature"/);
  assert.match(manifest, /android:permission="com\.aurelia\.paybridge\.permission\.BIND_PAY_BRIDGE"/);
});

test('Gateway requires local user approval and verifies the PMS caller', () => {
  assert.match(activity, /Approve Aurelia PMS connection/);
  assert.match(activity, /Revoke connection approval/);
  assert.match(approval, /isPmsConnectionApproved/);
  assert.match(service, /approvals\.isPmsConnectionApproved\(\)/);
  assert.match(service, /checkSignatures\(GATEWAY_PACKAGE, PMS_PACKAGE\)/);
  assert.match(service, /PMS_PACKAGE\.equals\(claimedPackage\)/);
  assert.match(service, /message\.sendingUid/);
});

test('Gateway service advertises handshake only; payment operations remain disabled', () => {
  assert.match(service, /capabilitiesJson/);
  assert.match(service, /handshake/);
  assert.doesNotMatch(service, /payment\.create|refund\.create|provider\.management/);
});
