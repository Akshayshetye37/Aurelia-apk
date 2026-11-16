import fs from 'node:fs';
import { fail, gh, requireApprovals, requireSha, verifyBundle } from './lib.mjs';

const sha = requireSha(process.env.CANDIDATE_SHA);
const controlSha = requireSha(process.env.GITHUB_SHA);
const repo = process.env.REPO;
const controlBranch = process.env.CONTROL_BRANCH;
if (!repo || repo.split('/').length !== 2 || repo.split('/').some((part) => !/^[A-Za-z0-9_.-]+$/.test(part)) || !controlBranch || controlBranch.split('/').some((part) => !/^[A-Za-z0-9_.-]+$/.test(part) || part === '..')) fail('repository or control branch is invalid');
let runIds;
try { runIds = JSON.parse(process.env.RUN_IDS ?? ''); } catch { fail('RUN_IDS is not valid JSON'); }
if (!runIds || typeof runIds !== 'object' || Array.isArray(runIds)) fail('RUN_IDS must be a JSON object');
const candidateBranch = process.env.CANDIDATE_BRANCH;
if (!candidateBranch || candidateBranch.split('/').some((part) => !/^[A-Za-z0-9_.-]+$/.test(part) || part === '..')) fail('CANDIDATE_BRANCH is invalid');
const encodedBranch = candidateBranch.split('/').map(encodeURIComponent).join('/');
const head = gh(`repos/${repo}/git/ref/heads/${encodedBranch}`).object?.sha;
if (head !== sha) fail('candidate is no longer the current branch head; all qualification evidence is invalidated');
const encodedControlBranch = controlBranch.split('/').map(encodeURIComponent).join('/');
const currentControlHead = gh(`repos/${repo}/git/ref/heads/${encodedControlBranch}`).object?.sha;
if (currentControlHead !== controlSha) fail('control branch moved; all gate evidence must be regenerated');
const pinnedCandidateSha = fs.readFileSync('gates/qualification-candidate-sha.txt', 'utf8').trim();
if (pinnedCandidateSha !== sha) fail('candidate SHA does not match the trusted control-branch qualification pin');
const workflows = {
  '1': 'gate-1-encrypted-storage.yml', '2': 'gate-2-recovery-runtime.yml',
  '3': 'gate-3-real-sms-staging.yml', '4': 'gate-4-physical-device.yml',
  '5': 'gate-5-production-security.yml', sms: 'gate-manual-attestation.yml',
  device: 'gate-manual-attestation.yml',
};
if ((process.env.RUN_IDS ?? '').length > 2000) fail('RUN_IDS exceeds 2000 characters');
const expectedRunKeys = Object.keys(workflows).sort();
if (JSON.stringify(Object.keys(runIds).sort()) !== JSON.stringify(expectedRunKeys)) fail('RUN_IDS must contain exactly 1, 2, 3, 4, 5, sms and device');
for (const key of expectedRunKeys) {
  const value = String(runIds[key]);
  if (!value.length || ![...value].every((digit) => digit >= '0' && digit <= '9')) fail(`invalid run ID for ${key}`);
}
const records = {};
for (const [gate, workflowFile] of Object.entries(workflows)) {
  if (!runIds[gate]) fail(`missing run ID for gate ${gate}`);
  const record = verifyBundle({ repo, runId: runIds[gate], gate, workflowFile, controlBranch, dir: `qualification-${gate}` });
  if (record.candidateSha !== sha) fail(`gate ${gate} is for a different candidate`);
  if (record.controlSha !== controlSha) fail(`gate ${gate} was produced by a different control-branch revision`);
  const completed = Date.parse(record.completedAt);
  if (!Number.isFinite(completed) || Date.now() - completed > 14 * 864e5 || completed > Date.now() + 3e5) fail(`gate ${gate} evidence is stale or has an invalid timestamp`);
  records[gate] = record;
}
function readEvidence(gate, filename) {
  const file = `qualification-${gate}/evidence/${filename}`;
  if (!fs.existsSync(file)) fail(`gate ${gate}: ${filename} is missing from the attested bundle`);
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { fail(`gate ${gate}: ${filename} is invalid JSON`); }
}
const gate1Runs = readEvidence('1', 'gate1-runs.json');
const gate2Runs = readEvidence('2', 'gate2-runs.json');
const requiredRuns = JSON.parse(fs.readFileSync('gates/required-runs.json', 'utf8'));
for (const [gate, runs] of [['1', gate1Runs], ['2', gate2Runs]]) {
  const expected = requiredRuns[`gate${gate}`];
  const actualNames = Array.isArray(runs) ? runs.map((item) => item.workflow).sort() : [];
  if (!Array.isArray(expected) || JSON.stringify(actualNames) !== JSON.stringify([...expected].sort()) || !Array.isArray(runs) || runs.length !== 3 || runs.some((item) => item.conclusion !== 'success' || item.headSha !== sha || item.headBranch !== candidateBranch || !Number.isInteger(item.testCount) || item.testCount < 1)) {
    fail(`gate ${gate}: required workflow runs lack exact-SHA positive test-count evidence`);
  }
}
const flags = readEvidence('2', 'flags.json');
if (!Number.isInteger(flags.scanned) || flags.scanned < 1 || !Array.isArray(flags.hits) || flags.hits.length) fail('Gate 2 protected flags/App Check source tripwire did not pass');
const gate2LogScan = readEvidence('2', 'log-scan.json');
if (!Array.isArray(gate2LogScan.findings) || gate2LogScan.findings.length) fail('Gate 2 redacted emulator log scan did not pass');
const apkHash = records['3'].details.apkSha256;
const testApkHash = records['3'].details.testApkSha256;
if (!/^[0-9a-f]{64}$/.test(apkHash ?? '') || !/^[0-9a-f]{64}$/.test(testApkHash ?? '')) fail('Gate 3 APK hashes are invalid');
if (!/^[0-9a-f]{64}$/.test(records['3'].details.signerSha256 ?? '')) fail('Gate 3 APK signer fingerprint is invalid');
const probes = readEvidence('3', 'probes.json');
const probeNames = new Set(Array.isArray(probes) ? probes.map((probe) => probe.callable) : []);
const expectedProbeCases = new Set(['no App Check token', 'invalid App Check token']);
if (!Array.isArray(probes) || !probes.length || probes.length !== probeNames.size * 2 || probes.some((probe) => ![401, 403].includes(probe.status) || !expectedProbeCases.has(probe.case)) || [...probeNames].some((name) => new Set(probes.filter((probe) => probe.callable === name).map((probe) => probe.case)).size !== 2)) fail('Gate 3 App Check negative probes did not cover every callable twice');
if (!records['3'].details.stagingProjectId || records['3'].details.stagingProjectId === records['5'].details.productionProjectId) fail('Gate 3 staging project is missing or matches production');
if (!records['4'].details.deviceLabel || !records['4'].details.deviceModel || records['4'].details.apkSha256 !== apkHash || records['4'].details.testApkSha256 !== testApkHash) fail('Gate 4 device record or APK hash does not match Gate 3');
if (records['4'].details.verifiedBoot !== 'green' || records['4'].details.bootloaderLocked !== true) fail('Gate 4 physical device boot state is not locked and verified');
const gate4LogScan = readEvidence('4', 'log-scan.json');
if (!Array.isArray(gate4LogScan.findings) || gate4LogScan.findings.length) fail('Gate 4 device log scan did not pass');
if (records['5'].details.productionRecoveryEnabled !== false || !records['5'].details.productionProjectId) fail('Gate 5 did not attest production recovery OFF');
const productionAudit = readEvidence('5', 'production-audit.json');
if (productionAudit.project !== records['5'].details.productionProjectId || !Array.isArray(productionAudit.problems) || productionAudit.problems.length || !productionAudit.auditedResources?.functions) {
  fail('Gate 5 production audit evidence is incomplete or reports problems');
}
for (const kind of ['sms', 'device']) {
  if (records[kind].details.kind !== kind || !/^[0-9a-f]{64}$/.test(records[kind].details.attestationSha256 ?? '') || records[kind].details.apkSha256 !== apkHash) fail(`${kind} attestation is invalid or for a different Gate 3 APK`);
}
const approvers = requireApprovals(repo, process.env.GITHUB_RUN_ID, 2, process.env.ACTOR);
const smsAttestation = readEvidence('sms', 'attestation.json');
const deviceAttestation = readEvidence('device', 'attestation.json');
const testers = [smsAttestation.tester, deviceAttestation.tester].map((login) => String(login).toLowerCase());
if (testers.some((tester) => approvers.some((approver) => approver.toLowerCase() === tester))) fail('an attestation tester cannot approve the final release qualification');
fs.mkdirSync('evidence', { recursive: true });
fs.writeFileSync('evidence/qualification-result.json', JSON.stringify({
  candidateSha: sha, controlSha, status: 'QUALIFIED_FOR_RELEASE_REVIEW', apkSha256: apkHash, testApkSha256: testApkHash,
  gates: Object.fromEntries(Object.entries(records).map(([gate, record]) => [gate, { runId: record.runId, completedAt: record.completedAt }])),
  approvers, productionRecoveryEnabled: false, verifiedAt: new Date().toISOString(),
}, null, 2));
console.log('QUALIFIED FOR RELEASE REVIEW. Production recovery remains OFF.');
