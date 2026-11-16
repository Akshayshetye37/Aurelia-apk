// Writes a PASS record only when invoked with real proof files. No --status flag exists.
import fs from 'node:fs';
import path from 'node:path';
import { arg, argAll, fail, requireSha, requireRepo, sha256File, canonical, safeInside } from './lib.mjs';
import crypto from 'node:crypto';

const gate = arg('gate');
if (!/^[1-6]$/.test(gate)) fail('Gate must be 1-6');
const candidateSha = requireSha(arg('sha'));
const controlSha = requireSha(process.env.GITHUB_SHA);
const repository = requireRepo(process.env.GITHUB_REPOSITORY);
const runId = process.env.GITHUB_RUN_ID ?? '';
const runAttempt = process.env.GITHUB_RUN_ATTEMPT ?? '';
if (!/^\d+$/.test(runId) || !/^\d+$/.test(runAttempt)) fail('GitHub run identity unavailable');
if ((process.env.RECOVERY_ENABLED ?? 'false') !== 'false') fail('RECOVERY_ENABLED must be false');

const proofs = argAll('proof');
if (proofs.length === 0) fail('At least one --proof file is required');

fs.mkdirSync('evidence/proofs', { recursive: true });
const proofRecords = proofs.map((p) => {
  const real = safeInside('.', p);
  if (!fs.statSync(real).isFile() || fs.statSync(real).size === 0) fail(`Empty or non-file proof: ${p}`);
  const name = path.basename(real);
  fs.copyFileSync(real, path.join('evidence/proofs', name), fs.constants.COPYFILE_EXCL);
  return { name, sha256: sha256File(real) };
});

const body = {
  schema: 1,
  gate: Number(gate),
  status: 'PASS',
  candidateSha,
  controlSha,
  repository,
  runId: Number(runId),
  runAttempt: Number(runAttempt),
  workflowRef: process.env.GITHUB_WORKFLOW_REF ?? '',
  actor: process.env.GITHUB_ACTOR ?? '',
  recoveryEnabled: false,
  proofs: proofRecords,
  completedAt: new Date().toISOString()
};
const recordSha256 = crypto.createHash('sha256').update(canonical(body)).digest('hex');
fs.writeFileSync(`evidence/gate-${gate}.json`, JSON.stringify({ ...body, recordSha256 }, null, 2), { flag: 'wx' });
console.log(`Evidence written for gate ${gate}`);
