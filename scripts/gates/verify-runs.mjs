import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { arg, fail, gh, requireSha } from './lib.mjs';

const sha = requireSha(arg('sha'));
const repo = arg('repo');
const group = arg('group');
const candidateBranch = process.env.CANDIDATE_BRANCH ?? '';
if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) fail('invalid repository name');
if (!candidateBranch || candidateBranch.split('/').some((part) => !/^[A-Za-z0-9_.-]+$/.test(part) || part === '..')) fail('invalid candidate branch');
const config = JSON.parse(fs.readFileSync('gates/required-runs.json', 'utf8'));
const workflows = config[group];
if (!Array.isArray(workflows) || workflows.length === 0) fail(`no required runs configured for ${group}`);
fs.mkdirSync('evidence', { recursive: true });

function testCountFromLog(log) {
  const sum = (matches) => matches.reduce((total, match) => total + Number(match[1]), 0);
  const nodeCounts = [...log.matchAll(/^[^\r\n]*?(?:#|ℹ)[ \t]*tests[ \t]+(\d+)[ \t]*$/gm)];
  const gradleCounts = [...log.matchAll(/OK\s+\((\d+)\s+tests?\)/g)];
  const jsonCounts = [...log.matchAll(/"tests"\s*:\s*(\d+)/g)];
  const jestCounts = [...log.matchAll(/Tests:\s*\d+\s+passed,\s*(\d+)\s+total/gi)];
  const vitestCounts = [...log.matchAll(/Tests\s+(\d+)\s+passed\b/gi)];
  const mochaCounts = [...log.matchAll(/(?:^|\n)\s*(\d+)\s+passing\s*\(/g)];
  const instrumentationCount = (log.match(/^.*INSTRUMENTATION_STATUS_CODE: 0\s*$/gm) ?? []).length;
  return Math.max(sum(nodeCounts), sum(gradleCounts), sum(jsonCounts), sum(jestCounts), sum(vitestCounts), sum(mochaCounts), instrumentationCount);
}
function walkFiles(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(directory, entry.name);
    return entry.isDirectory() ? walkFiles(full) : [full];
  });
}
const evidence = [];
for (const workflow of workflows) {
  if (!/^[A-Za-z0-9_.-]+\.ya?ml$/.test(workflow)) fail(`invalid workflow filename in ${group}`);
  const encoded = encodeURIComponent(workflow);
  let runs = [];
  for (let page = 1; page <= 5; page++) {
    const response = gh(`repos/${repo}/actions/workflows/${encoded}/runs?head_sha=${sha}&status=completed&per_page=100&page=${page}`);
    if (!Array.isArray(response.workflow_runs)) fail(`${workflow}: malformed workflow-runs response`);
    runs.push(...response.workflow_runs.filter((run) => run.head_sha === sha && run.head_branch === candidateBranch));
    if (response.workflow_runs.length < 100) break;
  }
  runs.sort((a, b) => Date.parse(b.run_started_at ?? b.updated_at) - Date.parse(a.run_started_at ?? a.updated_at));
  if (!runs.length) fail(`${workflow}: no completed run on exact SHA ${sha}`);
  const run = runs[0];
  if (run.status !== 'completed' || run.conclusion !== 'success') {
    fail(`${workflow}: latest completed run ${run.html_url} is ${run.conclusion}`);
  }
  let log;
  try {
    log = execFileSync('gh', ['run', 'view', String(run.id), '--repo', repo, '--log'], {
      encoding: 'utf8', maxBuffer: 128 * 1024 * 1024,
    });
  } catch (error) {
    fail(`${workflow}: could not read completed test logs: ${error.stderr?.toString().slice(0, 400) || error.message}`);
  }
  const testCount = testCountFromLog(log);
  if (testCount < 1) fail(`${workflow}: successful run contains no positive test-count evidence`);
  evidence.push({ workflow, runId: run.id, runAttempt: run.run_attempt, url: run.html_url, headSha: run.head_sha, headBranch: run.head_branch, conclusion: run.conclusion, testCount });

  // The Firebase Functions workflow emits a redacted emulator-log artifact.
  // Scan it on this ephemeral runner and retain only line-number/pattern metadata.
  if (workflow === 'recovery-functions.yml') {
    const artifacts = gh(`repos/${repo}/actions/runs/${run.id}/artifacts?per_page=100`).artifacts ?? [];
    const artifact = artifacts.find((item) => item.name === 'recovery-emulator-runtime-logs' && !item.expired);
    if (!artifact) fail('recovery-functions.yml: redacted emulator-log artifact is missing');
    const downloadDir = path.join('evidence', 'runtime-log-scan-tmp');
    fs.mkdirSync(downloadDir, { recursive: true });
    execFileSync('gh', ['run', 'download', String(run.id), '--repo', repo, '--name', artifact.name, '--dir', downloadDir], { stdio: 'inherit' });
    const logFiles = walkFiles(downloadDir);
    if (!logFiles.length) fail('recovery-functions.yml: emulator-log artifact contains no files');
    execFileSync(process.execPath, ['scripts/gates/scan-logs.mjs', ...logFiles], { stdio: 'inherit' });
    fs.rmSync(downloadDir, { recursive: true, force: true });
  }
}
fs.writeFileSync(`evidence/${group}-runs.json`, JSON.stringify(evidence, null, 2));
console.log(`${evidence.length} required workflow(s) green on exact SHA with positive test-count evidence`);
