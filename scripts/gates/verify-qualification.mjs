import fs from 'node:fs';
import { fail, gh, requireApprovals, requireSha, verifyBundle } from './lib.mjs';

const sha = requireSha(process.env.CANDIDATE_SHA);
const controlSha = requireSha(process.env.GITHUB_SHA);
const repo = process.env.REPO;
const controlBranch = process.env.CONTROL_BRANCH;
let runIds;
try { runIds = JSON.parse(process.env.RUN_IDS ?? ''); } catch { fail('RUN_IDS is not valid JSON'); }
if (!runIds || typeof runIds !== 'object' || Array.isArray(runIds)) fail('RUN_IDS must be a JSON object');
const candidateBranch = process.env.CANDIDATE_BRANCH;
if (!candidateBranch) fail('CANDIDATE_BRANCH is not configured');
const encodedBranch = candidateBranch.split('/').map(encodeURIComponent).join('/');
const head = gh(`repos/${repo}/git/ref/heads/${encodedBranch}`).object?.sha;
if (head !== sha) fail('candidate is no longer the current branch head; all qualification evidence is invalidated');
const workflows = {
  '1': 'gate-1-encrypted-storage.yml', '2': 'gate-2-recovery-runtime.yml',
  '3': 'gate-3-real-sms-staging.yml', '4': 'gate-4-physical-device.yml',
  '5': 'gate-5-production-security.yml', sms: 'gate-manual-attestation.yml',
  device: 'gate-manual-attestation.yml',
};
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
const apkHash = records['3'].details.apkSha256;
if (!/^[0-9a-f]{64}$/.test(apkHash ?? '')) fail('Gate 3 APK hash is invalid');
if (!records['4'].details.deviceModel) fail('Gate 4 has no physical device record');
if (records['5'].details.productionRecoveryEnabled !== false) fail('Gate 5 did not attest production recovery OFF');
for (const kind of ['sms', 'device']) if (records[kind].details.apkSha256 !== apkHash) fail(`${kind} attestation is for a different Gate 3 APK`);
const approvers = requireApprovals(repo, process.env.GITHUB_RUN_ID, 2, process.env.ACTOR);
fs.mkdirSync('evidence', { recursive: true });
fs.writeFileSync('evidence/qualification-result.json', JSON.stringify({
  candidateSha: sha, controlSha, status: 'QUALIFIED_FOR_RELEASE_REVIEW', apkSha256: apkHash,
  gates: Object.fromEntries(Object.entries(records).map(([gate, record]) => [gate, { runId: record.runId, completedAt: record.completedAt }])),
  approvers, productionRecoveryEnabled: false, verifiedAt: new Date().toISOString(),
}, null, 2));
console.log('QUALIFIED FOR RELEASE REVIEW. Production recovery remains OFF.');
