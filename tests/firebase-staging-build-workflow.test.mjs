import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const workflow = fs.readFileSync(path.join(process.cwd(), '.github/workflows/build-pms-debug-apk.yml'), 'utf8');
const gitignore = fs.readFileSync(path.join(process.cwd(), '.gitignore'), 'utf8');

test('staging Android build requires Firebase config from a GitHub Actions secret', () => {
  assert.match(workflow, /FIREBASE_GOOGLE_SERVICES_JSON:\s*\$\{\{\s*secrets\.FIREBASE_GOOGLE_SERVICES_JSON\s*\}\}/);
  assert.match(workflow, /aurelia-staging-992db/);
  assert.match(workflow, /1:761295649001:android:065c781ce7176b3dedd878/);
  assert.match(workflow, /com\.aurelia\.pms/);
  assert.match(workflow, /refusing to write Firebase config/);
});

test('staging Firebase config is written only to the ephemeral generated Android app directory', () => {
  assert.match(workflow, /android\/app\/google-services\.json/);
  assert.match(workflow, /mode:\s*0o600/);
  assert.match(workflow, /Do not print or upload google-services\.json/);
  assert.match(gitignore, /\*\*\/google-services\.json/);
});

test('debug APK build exports its exact signing certificate fingerprints for Firebase setup', () => {
  // The executable is quoted as an absolute Android SDK path in the workflow.
  assert.match(workflow, /apksigner["'] verify --print-certs/);
  assert.match(workflow, /Signer #1 certificate SHA-1 digest/);
  assert.match(workflow, /Signer #1 certificate SHA-256 digest/);
  assert.match(workflow, /GITHUB_STEP_SUMMARY/);
});
