// Verifies downloaded upstream evidence against GitHub run metadata; optionally two distinct approvers.
import fs from 'node:fs';
import { arg, fail, gh, requireSha, requireRepo, canonical } from './lib.mjs';
import crypto from 'node:crypto';

const sha = requireSha(arg('sha'));
const repo = requireRepo(process.env.REPO);
const dir = arg('dir');
const required = arg('require').split(',').map(Number);
const runIdStr = arg('run-ids');
if (!/^([1-6]:\d+)(,[1-6]:\d+)*$/.test(runIdStr)) fail('Bad run-ids');
const runIds = Object.fromEntries(runIdStr.split(',').map((p) => p.split(':')).map(([g, id]) => [Number(g), Number(id)]));
const WF = { 1: 'gate-1-encrypted-storage.yml', 2: 'gate-2-recovery-runtime.yml', 3: 'gate-3-real-sms-staging.yml',
             4: 'gate-4-physical-device.yml', 5: 'gate-5-production-security.yml' };

for (const g of required) {
  if (!runIds[g]) fail(`Missing run id for gate ${g}`);
  const rec = JSON.parse(fs.readFileSync(`${dir}/gate-${g}/gate-${g}.json`, 'utf8'));
  const { recordSha256, ...body } = rec;
  if (crypto.createHash('sha256').update(canonical(body)).digest('hex') !== recordSha256) fail(`Gate ${g} record hash mismatch`);
  if (rec.gate !== g || rec.status !== 'PASS' || rec.candidateSha !== sha || rec.repository !== repo ||
      rec.runId !== runIds[g] || rec.recoveryEnabled !== false) fail(`Gate ${g} record inconsistent`);
  const run = await gh(`repos/${repo}/actions/runs/${runIds[g]}`);
  if (run.status !== 'completed' || run.conclusion !== 'success' || run.event !== 'workflow_dispatch' ||
      run.head_sha !== rec.controlSha || run.path !== `.github/workflows/${WF[g]}`) fail(`Gate ${g} run metadata mismatch`);
}

if (process.argv.includes('--approvals')) {
  const a = await gh(`repos/${repo}/actions/runs/${process.env.GITHUB_RUN_ID}/approvals`);
  const actor = (process.env.GITHUB_TRIGGERING_ACTOR ?? '').toLowerCase();
  const by = (env) => new Set(a.filter((x) => x.state === 'approved' && x.environments?.some((e) => e.name === env))
                               .map((x) => x.user.login.toLowerCase()));
  const r1 = by('recovery-release-review-1'), r2 = by('recovery-release-review-2');
  const all = [...r1, ...r2];
  if (!r1.size || !r2.size) fail('Both review environments need an approval');
  if (new Set(all).size !== all.length) fail('Approvers must be two different people');
  if (all.includes(actor)) fail('Triggering actor cannot approve');
}
console.log('Upstream evidence verified');
