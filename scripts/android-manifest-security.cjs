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

function hardenGroovyReleaseBuild(gradle) {
  if (typeof gradle !== 'string') throw new TypeError('Gradle configuration must be a string');
  const release = /(release\\s*\\{)([\\s\\S]*?)(\\n\\s*\\})/m;
  const match = gradle.match(release);
  if (!match) throw new Error('Android release buildType block was not found; refusing to ship an unhardened release configuration.');

  let body = match[2];
  const setBoolean = (source, key) => {
    const pattern = new RegExp('(^\\\\s*' + key + '\\\\s+)\\\\w+', 'm');
    return pattern.test(source) ? source.replace(pattern, '$1true') : source + '\\n        ' + key + ' true';
  };
  body = setBoolean(body, 'minifyEnabled');
  body = setBoolean(body, 'shrinkResources');
  body = body.replace(/getDefaultProguardFile\\s*\\(\\s*['"]proguard-android(?:-optimize)?\\.txt['"]\\s*\\)/,
    "getDefaultProguardFile('proguard-android-optimize.txt')");
  if (!body.includes('proguard-rules.pro')) body += "\\n        proguardFiles getDefaultProguardFile('proguard-android-optimize.txt'), 'proguard-rules.pro'";
  return gradle.replace(release, match[1] + body + match[3]);
}

module.exports = { FORBIDDEN_PERMISSIONS, stripForbiddenPermissions, hardenGroovyReleaseBuild };
