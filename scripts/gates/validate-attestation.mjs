// Validates a human-signed physical-test attestation (real SMS or physical device).
import fs from 'node:fs';
import { arg, fail, requireSha, requireSha256, safeInside } from './lib.mjs';

const kind = arg('kind');
const file = safeInside('gates/attestations', arg('file'));
const sha = requireSha(arg('sha'));
const matchApk = arg('match-apk', { required: false });

let a;
try { a = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { fail('Attestation is not valid JSON'); }

if (a.candidateSha !== sha) fail('Attestation candidate SHA mismatch');
requireSha256(a.apkSha256);
if (typeof a.attestedBy !== 'string' || a.attestedBy.length < 2) fail('attestedBy missing');
if (Number.isNaN(Date.parse(a.attestedAt))) fail('attestedAt invalid');
for (const who of [process.env.GITHUB_ACTOR, process.env.GITHUB_TRIGGERING_ACTOR])
  if (who && a.attestedBy.toLowerCase() === who.toLowerCase()) fail('Attester must be independent of the workflow actor');

const required = {
  sms: ['sms_delivered', 'otp_verified_grant_issued', 'wrong_code_rejected', 'expired_code_rejected',
        'replayed_code_rejected', 'rate_limit_enforced', 'otp_alone_cannot_touch_dek'],
  device: ['install_release_signed', 'force_stop_recovery', 'reboot_recovery', 'reinstall_recovery',
           'airplane_mode_midflow', 'dek_only_via_wrap_path']
}[kind] ?? fail('Unknown kind');

for (const k of required) if (a.results?.[k] !== 'pass') fail(`Required result not pass: ${k}`);

if (kind === 'sms') {
  if (a.testNumbersUsed !== false) fail('Firebase test numbers are not allowed');
  if (!a.carrier || !a.firebaseProject || !a.handset?.model) fail('Handset/carrier/project details missing');
  if (/prod/i.test(a.firebaseProject)) fail('Gate 3 must use a staging Firebase project');
} else {
  const d = a.device ?? {};
  if (!d.model || !d.androidVersion) fail('Device details missing');
  if (d.verifiedBootState !== 'green' || d.flashLocked !== true || d.hardwareBackedKeystore !== true)
    fail('Device must be locked, verified-boot green, hardware-backed keystore');
}

if (matchApk) {
  const other = JSON.parse(fs.readFileSync(safeInside('gates/attestations', matchApk), 'utf8'));
  if (other.apkSha256 !== a.apkSha256) fail('APK SHA-256 differs between gates');
}
console.log(`${kind} attestation valid`);
