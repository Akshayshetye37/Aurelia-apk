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
export function isAttestationFresh(completedAt, now = Date.now()) {
  const timestamp = Date.parse(completedAt ?? '');
  return Number.isFinite(timestamp) && timestamp <= now + 5 * 60 * 1000 && now - timestamp < 7 * 864e5;
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

export function validateEnvironmentApprovals(history, requiredEnvironments, minimum, actor) {
  const reject = (message) => { throw new Error(message); };
  if (!Array.isArray(history) || !Array.isArray(requiredEnvironments) ||
      !Number.isInteger(minimum) || minimum < 1 || typeof actor !== 'string' || !actor) {
    reject('approval history, required environments, threshold or triggering actor is invalid');
  }
  if (history.some((item) => ['rejected', 'changes_requested'].includes(item.state))) {
    reject('approval history contains a rejected review');
  }
  const approved = history.filter((item) => item.state === 'approved' && typeof item.user?.login === 'string');
  const scoped = requiredEnvironments.length
    ? approved.filter((item) => (item.environments ?? []).some((environment) => requiredEnvironments.includes(environment.name)))
    : approved;
  const approvers = [...new Set(scoped.map((item) => item.user.login))];
  if (approvers.some((login) => login.toLowerCase() === actor.toLowerCase())) {
    reject('the person who triggered the run cannot approve it');
  }
  for (const environment of requiredEnvironments) {
    const reviewers = new Set(approved
      .filter((item) => (item.environments ?? []).some((entry) => entry.name === environment))
      .map((item) => item.user.login));
    if (!reviewers.size) reject(`protected environment ${environment} has no approved reviewer record`);
  }
  if (approvers.length < minimum) reject(`need ${minimum} independent approver(s), found ${approvers.length}`);
  return approvers;
}

export function requireApprovals(repo, runId, minimum, actor, requiredEnvironments = []) {
  if (!/^[0-9]+$/.test(String(runId)) || !Number.isInteger(minimum) || minimum < 1 ||
      typeof actor !== 'string' || !actor || !Array.isArray(requiredEnvironments)) {
    fail('approval threshold, run ID, required environments or triggering actor is invalid');
  }
  const history = gh(`repos/${repo}/actions/runs/${runId}/approvals`);
  try {
    return validateEnvironmentApprovals(history, requiredEnvironments, minimum, actor);
  } catch (error) {
    fail(error.message);
  }
}/** Verify a run and its provenance-attested evidence bundle before trusting its JSON record. */
export function verifyBundle({ repo, runId, gate, workflowFile, controlBranch, dir }) {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) fail('invalid repository name');
  if (!/^\d+$/.test(String(runId))) fail(`bad run ID for gate ${gate}`);
  if (!controlBranch || controlBranch.split('/').some((part) => !/^[A-Za-z0-9_.-]+$/.test(part) || part === '..')) fail('invalid control branch');
  if (!/^[A-Za-z0-9_.-]+\.ya?ml$/.test(workflowFile)) fail('invalid workflow filename');
  const run = gh(`repos/${repo}/actions/runs/${runId}`);
  if (run.status !== 'completed' || run.conclusion !== 'success') fail(`gate ${gate}: run ${runId} did not succeed`);
  if (!isAttestationFresh(run.completed_at)) fail(`gate ${gate}: attestation run is older than the 7-day freshness window or has an invalid completion time`);
  const triggerAllowed = run.event === 'workflow_dispatch' || (['1', '2'].includes(String(gate)) && run.event === 'push');
  if (!triggerAllowed) fail(`gate ${gate}: evidence run used an unsupported trigger ${run.event}`);
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
  const repositoryId = String(gh(`repos/${repo}`).id ?? '');
  if (!repositoryId) fail(`gate ${gate}: repository numeric ID could not be resolved`);
  const expectedTrigger = run.event;
  const expectedInvocation = `https://github.com/${repo}/actions/runs/${runId}/attempts/${run.run_attempt}`;
  const expectedRepository = `https://github.com/${repo}`;
  const expectedRef = `refs/heads/${controlBranch}`;
  const expectedSigner = `https://github.com/${repo}/.github/workflows/${workflowFile}@${expectedRef}`;
  const bound = attestations.some((entry) => {
    const certificate = entry.verificationResult?.signature?.certificate;
    if (!certificate) return false;
    return certificate.issuer === 'https://token.actions.githubusercontent.com' &&
      certificate.sourceRepositoryURI === expectedRepository &&
      String(certificate.sourceRepositoryIdentifier) === repositoryId &&
      certificate.sourceRepositoryDigest === run.head_sha &&
      certificate.sourceRepositoryRef === expectedRef &&
      certificate.buildSignerURI === expectedSigner &&
      certificate.buildSignerDigest === run.head_sha &&
      certificate.runInvocationURI === expectedInvocation &&
      certificate.runnerEnvironment === 'github-hosted' &&
      certificate.buildTrigger === expectedTrigger;
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

export function requireIndependentTester(approvers, tester) {
  if (!Array.isArray(approvers) || typeof tester !== 'string' || !tester) fail('tester or approver list is invalid');
  if (approvers.some((login) => typeof login === 'string' && login.toLowerCase() === tester.toLowerCase())) {
    fail('the tester cannot approve their own SMS/device attestation');
  }
}
