'use strict';

const FORBIDDEN_PERMISSIONS = Object.freeze([
  'android.permission.CAMERA',
  'android.permission.READ_EXTERNAL_STORAGE',
  'android.permission.WRITE_EXTERNAL_STORAGE',
  'android.permission.MANAGE_EXTERNAL_STORAGE'
]);

function stripForbiddenPermissions(manifest) {
  if (typeof manifest !== 'string') {
    throw new TypeError('Android manifest must be a string');
  }
  const newline = manifest.includes('\r\n') ? '\r\n' : '\n';
  const lines = manifest.split(/\r?\n/);
  const filtered = lines.filter(line => {
    if (!line.includes('<uses-permission')) return true;
    return !FORBIDDEN_PERMISSIONS.some(permission =>
      line.includes('android:name="' + permission + '"') ||
      line.includes("android:name='" + permission + "'"));
  });
  return filtered.join(newline);
}

module.exports = { FORBIDDEN_PERMISSIONS, stripForbiddenPermissions };
