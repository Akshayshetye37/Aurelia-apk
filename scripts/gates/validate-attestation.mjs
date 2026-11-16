import fs from 'node:fs';
import crypto from 'node:crypto';
import { arg, fail, requireApprovals, requireSha, verifyBundle } from './lib.mjs';

const kind = arg('kind');
const sha = requireSha(arg('sha'));
const repo = arg('repo');
const gate3Run = arg('gate3-run');
const controlBranch = arg('control-branch');
if (!['sms', 'device'].includes(kind)) fail('kind must be sms or device');
let attestation;
try { attestation = JSON.parse(process.env.ATTESTATION ?? ''); } catch { fail('attestation is not valid JSON'); }
if (!attestation || Array.isArray(attestation) || typeof attestation !== 'object') fail('attestation must be a JSON object');
const commonKeys = ['kind', 'apkSha256', 'testedAt', 'tester', 'results'];
const kindKeys = kind === 'sms'
  ? ['country', 'carrier', 'stagingProjectId']
  : ['deviceModel', 'androidVersion', 'verifiedBoot', 'bootloaderLocked', 'dataChecksumBefore', 'dataChecksumAfter'];
const unknownKeys = Object.keys(attestation).filter((key) => !commonKeys.concat(kindKeys).includes(key));
if (unknownKeys.length) fail(`unexpected attestation field(s): ${unknownKeys.join(', ')}`);
if (!attestation.results || Array.isArray(attestation.results) || typeof attestation.results !== 'object') fail('results must be a JSON object');
const raw = JSON.stringify(attestation);
if (Buffer.byteLength(raw, 'utf8') > 4000) fail('attestation too large');
if (/\b\d{6}\b/.test(raw)) fail('attestation contains a 6-digit sequence; never record OTPs');
if (/\+?\d{10,}/.test(raw)) fail('attestation contains a phone-number-like value');
const gate3 = verifyBundle({ repo, runId: gate3Run, gate: '3', workflowFile: 'gate-3-real-sms-staging.yml', controlBranch, dir: 'g3' });
if (gate3.candidateSha !== sha) fail('Gate 3 belongs to a different candidate');
if (attestation.kind !== kind) fail('kind mismatch');
if (attestation.apkSha256 !== gate3.details.apkSha256) fail('attested APK is not the Gate 3 APK');
const testedAt = Date.parse(attestation.testedAt);
if (!Number.isFinite(testedAt) || Date.now() - testedAt > 7 * 864e5 || testedAt > Date.now() + 3e5) fail('testedAt missing, future, or older than 7 days');
if (typeof attestation.tester !== 'string' || !/^[A-Za-z0-9_.@ -]{2,80}$/.test(attestation.tester)) fail('tester identifier required');
const expected = kind === 'sms'
  ? { validOtp: 'VERIFIED', wrongOtp: 'REJECTED', expiredOtp: 'REJECTED', replayedOtp: 'REJECTED',
      resendRateLimit: 'REJECTED', otpDoesNotAccessDek: 'CONFIRMED', passkeyAckEnrollAndAssert: 'VERIFIED' }
  : { pinAFailsAfterRecovery: true, pinBOpensOriginalData: true, forceStopSurvived: true, rebootSurvived: true,
      replayRejected: true, lockScreenChangeFailsClosed: true, ownerCancelDuringHold: true,
      offlineNormalUse: true, logScanClean: true };
const unknownResults = Object.keys(attestation.results).filter((key) => !Object.hasOwn(expected, key));
if (unknownResults.length) fail(`unexpected result field(s): ${unknownResults.join(', ')}`);
for (const [key, value] of Object.entries(expected)) if (attestation.results[key] !== value) fail(`result ${key} must be ${value}`);
if (kind === 'sms') {
  if (!/^[A-Z]{2}$/.test(attestation.country ?? '') || typeof attestation.carrier !== 'string' || !attestation.carrier.trim() || attestation.carrier.length > 80) fail('carrier and ISO country required');
  if (attestation.stagingProjectId !== gate3.details.stagingProjectId) fail('staging project mismatch');
} else {
  if (typeof attestation.deviceModel !== 'string' || !attestation.deviceModel || attestation.deviceModel.length > 80 || typeof attestation.androidVersion !== 'string' || !attestation.androidVersion || attestation.androidVersion.length > 40) fail('device model and Android version required');
  if (attestation.verifiedBoot !== 'green' || attestation.bootloaderLocked !== true) fail('device must have verified boot green and a locked bootloader');
  if (!/^[0-9a-f]{64}$/.test(attestation.dataChecksumBefore ?? '') || attestation.dataChecksumBefore !== attestation.dataChecksumAfter) fail('data checksums must be valid and match');
}
requireApprovals(repo, process.env.GITHUB_RUN_ID, 1, process.env.ACTOR);
fs.mkdirSync('evidence', { recursive: true });
fs.writeFileSync('evidence/attestation.json', raw);
fs.writeFileSync('evidence/details.json', JSON.stringify({
  kind, apkSha256: attestation.apkSha256,
  attestationSha256: crypto.createHash('sha256').update(raw).digest('hex'),
}, null, 2));
console.log(`${kind} attestation accepted`);
