import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fail } from './lib.mjs';

export function normalizeCondition(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}
export function stagingRoles(policy, serviceAccount) {
  const member = \`serviceAccount:\${serviceAccount}\`;
  return [...new Set((policy.bindings ?? []).filter(binding => (binding.members ?? []).includes(member)).map(binding => binding.role))].sort();
}
export function validateStagingRoles(actual, allowed) {
  if (!Array.isArray(allowed) || !allowed.length || allowed.includes('UNCONFIGURED')) throw new Error('staging deploy role allowlist is not reviewed/configured');
  const extra = actual.filter(role => !allowed.includes(role));
  const missing = allowed.filter(role => !actual.includes(role));
  if (extra.length || missing.length) throw new Error(\`staging deploy IAM roles differ from reviewed allowlist; extra=\${extra.join(',') || 'none'}; missing=\${missing.join(',') || 'none'}\`);
}
function gcloud(args) {
  try { return JSON.parse(execFileSync('gcloud', [...args, '--format=json'], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 })); }
  catch (error) { fail(\`Google Cloud policy verification failed: \${error.stderr?.toString().slice(0, 400) || error.message}\`); }
}
function main() {
  const configPath = process.argv[2] ?? 'scripts/gates/staging-iam.json';
  let config;
  try { config = JSON.parse(fs.readFileSync(configPath, 'utf8')); } catch { fail('reviewed staging IAM configuration is missing or invalid'); }
  const provider = process.env.WIF_PROVIDER ?? '';
  const deployServiceAccount = process.env.DEPLOY_SERVICE_ACCOUNT ?? '';
  const stagingProject = process.env.STAGING_PROJECT_ID ?? '';
  const productionProject = process.env.PRODUCTION_PROJECT_ID ?? '';
  if (!provider || !deployServiceAccount || !stagingProject || !productionProject || stagingProject === productionProject) fail('staging IAM verification inputs are incomplete or staging equals production');
  const match = provider.match(/^projects\/(\d+)\/locations\/global\/workloadIdentityPools\/([A-Za-z0-9_-]+)\/providers\/([A-Za-z0-9_-]+)$/);
  if (!match) fail('WIF provider resource name is invalid');
  const [, providerProjectNumber, poolId, providerId] = match;
  const expectedCondition = \`assertion.repository == '\${config.expectedRepository}' && assertion.ref == '\${config.expectedRef}'\`;
  const providerConfig = gcloud(['iam', 'workload-identity-pools', 'providers', 'describe', providerId, '--location=global', '--workload-identity-pool', poolId, '--project', provider.split('/')[1]]);
  if (normalizeCondition(providerConfig.attributeCondition) !== normalizeCondition(expectedCondition)) fail('WIF provider condition does not exactly restrict repository and branch');
  const saPolicy = gcloud(['iam', 'service-accounts', 'get-iam-policy', deployServiceAccount, '--project', stagingProject]);
  const expectedMember = \`principalSet://iam.googleapis.com/projects/\${providerProjectNumber}/locations/global/workloadIdentityPools/\${poolId}/attribute.repository/\${config.expectedRepository}\`;
  const wifBindings = (saPolicy.bindings ?? []).filter(binding => binding.role === 'roles/iam.workloadIdentityUser' && (binding.members ?? []).includes(expectedMember));
  if (wifBindings.length !== 1) fail('staging deploy service account lacks the exact repository-bound WIF principal');
  const stagingPolicy = gcloud(['projects', 'get-iam-policy', stagingProject]);
  validateStagingRoles(stagingRoles(stagingPolicy, deployServiceAccount), config.allowedStagingDeployRoles);
  const productionPolicy = gcloud(['projects', 'get-iam-policy', productionProject]);
  if (stagingRoles(productionPolicy, deployServiceAccount).length) fail('staging deploy service account has direct production project IAM bindings');
  try {
    execFileSync('gcloud', ['functions', 'list', '--project', productionProject, '--format=json'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    fail('staging deploy identity can list production Functions; expected permission denied');
  } catch (error) {
    if (error.status === undefined) fail('production access denial could not be verified');
    const stderr = String(error.stderr ?? '');
    if (!/PERMISSION_DENIED|permission denied|403/i.test(stderr)) fail('production Functions probe failed for a reason other than permission denial');
  }
  console.log('PASS: WIF trust, staging IAM allowlist, and production Functions access denial verified.');
}
if (process.argv[1] && process.argv[1].endsWith('check-staging-iam.mjs')) main();
