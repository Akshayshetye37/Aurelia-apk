import fs from 'node:fs';
import { arg, fail, gh, requireSha } from './lib.mjs';

const sha = requireSha(arg('sha'));
const repo = arg('repo');
const group = arg('group');
if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) fail('invalid repository name');
const config = JSON.parse(fs.readFileSync('gates/required-runs.json', 'utf8'));
const workflows = config[group];
if (!Array.isArray(workflows) || workflows.length === 0) fail(`no required runs configured for ${group}`);
const evidence = [];
for (const workflow of workflows) {
  if (!/^[A-Za-z0-9_.-]+\.ya?ml$/.test(workflow)) fail(`invalid workflow filename in ${group}`);
  const encoded = encodeURIComponent(workflow);
  let runs = [];
  for (let page = 1; page <= 5; page++) {
    const response = gh(`repos/${repo}/actions/workflows/${encoded}/runs?head_sha=${sha}&status=completed&per_page=100&page=${page}`);
    if (!Array.isArray(response.workflow_runs)) fail(`${workflow}: malformed workflow-runs response`);
    runs.push(...response.workflow_runs.filter((run) => run.head_sha === sha));
    if (response.workflow_runs.length < 100) break;
  }
  runs.sort((a, b) => Date.parse(b.run_started_at ?? b.updated_at) - Date.parse(a.run_started_at ?? a.updated_at));
  if (!runs.length) fail(`${workflow}: no completed run on exact SHA ${sha}`);
  if (runs[0].status !== 'completed' || runs[0].conclusion !== 'success') {
    fail(`${workflow}: latest completed run ${runs[0].html_url} is ${runs[0].conclusion}`);
  }
  evidence.push({ workflow, runId: runs[0].id, url: runs[0].html_url, headSha: runs[0].head_sha, conclusion: runs[0].conclusion });
}
fs.mkdirSync('evidence', { recursive: true });
fs.writeFileSync(`evidence/${group}-runs.json`, JSON.stringify(evidence, null, 2));
console.log(`${evidence.length} required workflow(s) green on exact SHA ${sha}`);
