import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const SHA_RE = /^[0-9a-f]{40}$/;
export const fail = (message) => {
  console.error(`GATE FAILED: ${String(message).replace(/[\r\n]+/g, ' ')}`);
  process.exit(1);
};

export function arg(name, required = true) {
  const index = process.argv.indexOf(`--${name}`);
  const value = index >= 0 ? process.argv[index + 1] : undefined;
  if (required && (!value || value.startsWith('--'))) fail(`missing --${name}`);
  return value;
}
export function requireSha(value) {
  if (!SHA_RE.test(value ?? '')) fail('candidate SHA must be 40 lowercase hex');
  return value;
}
export const sha256File = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
export function gh(apiPath) {
  if (typeof apiPath !== 'string' || apiPath.startsWith('/') || apiPath.includes('..') || /[\r\n]/.test(apiPath)) fail('invalid GitHub API path');
  try {
    return JSON.parse(execFileSync('gh', ['api', apiPath], {
      encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'],
    }));
  } catch (error) {
    fail(`GitHub API request failed: ${error.stderr?.toString().slice(0, 500) || error.message}`);
  }
}

export function requireApprovals(repo, runId, minimum, actor) {
  if (!/^[0-9]+$/.test(String(runId)) || !Number.isInteger(minimum) || minimum < 1 || typeof actor !== 'string' || !actor) fail('approval threshold, run ID or triggering actor is invalid');
  const history = gh(`repos/${repo}/actions/runs/${runId}/approvals`);
  if (!Array.isArray(history)) fail('workflow approval history response was not an array');
  if (history.some((item) => ['rejected', 'changes_requested'].includes(item.state))) fail('approval history contains a rejected review');
  const approved = [...new Set(history
    .filter((item) => item.state === 'approved' && typeof item.user?.login === 'string')
    .map((item) => item.user.login))];
  if (approved.some((login) => login.toLowerCase() === actor.toLowerCase())) fail('the person who triggered the run cannot approve it');
  if (approved.length < minimum) fail(`need ${minimum} independent approver(s), found ${approved.length}`);
  return approved;
}

/** Verify a run and its provenance-attested evidence bundle before trusting its JSON record. */
export function verifyBundle({ repo, runId, gate, workflowFile, controlBranch, dir }) {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) fail('invalid repository name');
  if (!/^\d+$/.test(String(runId))) fail(`bad run ID for gate ${gate}`);
  if (!controlBranch || controlBranch.split('/').some((part) => !/^[A-Za-z0-9_.-]+$/.test(part) || part === '..')) fail('invalid control branch');
  if (!/^[A-Za-z0-9_.-]+\.ya?ml$/.test(workflowFile)) fail('invalid workflow filename');
  const run = gh(`repos/${repo}/actions/runs/${runId}`);
  if (run.status !== 'completed' || run.conclusion !== 'success') fail(`gate ${gate}: run ${runId} did not succeed`);
  if (run.event !== 'workflow_dispatch') fail(`gate ${gate}: evidence run was not workflow_dispatch`);
  if (run.head_branch !== controlBranch) fail(`gate ${gate}: run was not on control branch ${controlBranch}`);
  if (String(run.path ?? '').split('@')[0] !== `.github/workflows/${workflowFile}`) fail(`gate ${gate}: unexpected workflow path ${run.path}`);
  fs.mkdirSync(dir, { recursive: true });
  execFileSync('gh', ['run', 'download', String(runId), '-R', repo, '-n', `gate-${gate}-evidence`, '-D', dir], { stdio: 'inherit' });
  const bundle = path.join(dir, 'bundle.tar');
  if (!fs.existsSync(bundle) || fs.statSync(bundle).size === 0) fail(`gate ${gate}: evidence bundle missing or empty`);
  let verified;
  try {
    const output = execFileSync('gh', [
      'attestation', 'verify', bundle,
      '--repo', repo,
      '--signer-workflow', `${repo}/.github/workflows/${workflowFile}`,
      '--source-digest', run.head_sha,
      '--source-ref', `refs/heads/${controlBranch}`,
      '--deny-self-hosted-runners',
      '--format', 'json',
    ], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
    verified = JSON.parse(output);
  } catch (error) {
    fail(`gate ${gate}: attestation verification failed: ${error.stderr?.toString().slice(0, 500) || error.message}`);
  }
  const attestations = Array.isArray(verified) ? verified : (verified?.verificationResult ? [verified] : (Array.isArray(verified?.verificationResults) ? verified.verificationResults : []));
  if (!attestations.length) fail(`gate ${gate}: no verified attestation returned`);
  const expectedRunPath = `/actions/runs/${runId}`;
  const bound = attestations.some((entry) => {
    let statement = entry.verificationResult?.statement ?? entry.statement;
    if (typeof statement === 'string') { try { statement = JSON.parse(statement); } catch { return false; } }
    const invocation = statement?.predicate?.runDetails?.metadata?.invocationId;
    if (typeof invocation !== 'string') return false;
    const runPathIndex = invocation.indexOf(expectedRunPath);
    if (runPathIndex < 0) return false;
    const suffix = invocation.slice(runPathIndex + expectedRunPath.length);
    if (suffix && !suffix.startsWith('/attempts/')) return false;
    const attemptMarker = '/attempts/';
    if (!invocation.includes(attemptMarker)) return true;
    return invocation.split(attemptMarker).at(-1) === String(run.run_attempt);
  });
  if (!bound) fail(`gate ${gate}: attestation is not bound to run ${runId} attempt ${run.run_attempt}`);
  const archiveEntries = execFileSync('tar', ['-tf', bundle], { encoding: 'utf8' }).split('\n').filter(Boolean);
  const archiveTypes = execFileSync('tar', ['-tvf', bundle], { encoding: 'utf8' }).split('\n').filter(Boolean).map((line) => line[0]);
  if (!archiveEntries.length || archiveEntries.some((entry) => entry.startsWith('/') || entry.split('/').some((part) => part === '..') || !entry.startsWith('evidence/')) || archiveTypes.some((type) => !['-', 'd'].includes(type))) fail(`gate ${gate}: unsafe or unexpected evidence archive entry`);
  execFileSync('tar', ['-xf', bundle, '-C', dir, '--no-same-owner', '--no-same-permissions'], { stdio: 'inherit' });
  const recordPath = path.join(dir, 'evidence', 'record.json');
  if (!fs.existsSync(recordPath)) fail(`gate ${gate}: evidence record missing`);
  let record;
  try { record = JSON.parse(fs.readFileSync(recordPath, 'utf8')); } catch { fail(`gate ${gate}: evidence record is invalid JSON`); }
  if (record.gate !== String(gate) || record.status !== 'PASS' ||
      record.runId !== Number(runId) || record.repository !== repo || record.controlSha !== run.head_sha ||
      !SHA_RE.test(record.candidateSha ?? '')) fail(`gate ${gate}: record does not match its run`);
  if (record.runAttempt !== Number(run.run_attempt)) fail(`gate ${gate}: run attempt mismatch`);
  return record;
}
