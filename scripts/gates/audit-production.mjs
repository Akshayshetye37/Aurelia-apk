import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { fail } from './lib.mjs';

const project = process.env.GCP_PROJECT_ID;
const region = process.env.GCP_REGION;
if (!project || project !== process.env.PRODUCTION_GCP_PROJECT_ID) fail('project is not the declared production project');
const list = (name) => (process.env[name] ?? '').split(',').map((value) => value.trim()).filter(Boolean);
const run = (args) => {
  try { return JSON.parse(execFileSync('gcloud', [...args, '--format=json'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })); }
  catch (error) { fail(`gcloud ${args.slice(0, 3).join(' ')} failed: ${error.stderr?.toString().slice(0, 400) || error.message}`); }
};
const problems = [];
const disabled = (value) => value === undefined || value === null || String(value).toLowerCase() === 'false';

for (const fn of run(['functions', 'list', '--project', project])) {
  const variables = fn.serviceConfig?.environmentVariables ?? fn.environmentVariables ?? {};
  if (!disabled(variables.RECOVERY_ENABLED)) problems.push(`function ${fn.name}: RECOVERY_ENABLED is not false/unset`);
}
for (const service of run(['run', 'services', 'list', '--project', project])) {
  for (const container of service.spec?.template?.spec?.containers ?? []) {
    for (const variable of container.env ?? []) {
      if (variable.name === 'RECOVERY_ENABLED' && !disabled(variable.value)) problems.push(`run service ${service.metadata?.name}: RECOVERY_ENABLED is not false/unset`);
    }
  }
}
const verifier = process.env.ATTESTATION_VERIFIER_SERVICE;
if (!verifier || !region) problems.push('ATTESTATION_VERIFIER_SERVICE and GCP_REGION must be configured');
else {
  const policy = run(['run', 'services', 'get-iam-policy', verifier, '--region', region, '--project', project]);
  for (const binding of policy.bindings ?? []) for (const member of binding.members ?? []) {
    if (member === 'allUsers' || member === 'allAuthenticatedUsers') problems.push(`attestation verifier is public (${binding.role})`);
  }
}
const requiredSecrets = list('REQUIRED_SECRETS');
if (!requiredSecrets.length) problems.push('REQUIRED_SECRETS not configured');
for (const secret of requiredSecrets) {
  const versions = run(['secrets', 'versions', 'list', secret, '--project', project, '--filter=state=ENABLED']);
  if (!Array.isArray(versions) || versions.length === 0) problems.push(`secret ${secret}: no enabled version`);
  const policy = run(['secrets', 'get-iam-policy', secret, '--project', project]);
  for (const binding of policy.bindings ?? []) for (const member of binding.members ?? []) {
    if (!member.startsWith('serviceAccount:')) problems.push(`secret ${secret}: non-service-account member`);
  }
}
const runtimeAccounts = list('RUNTIME_SERVICE_ACCOUNTS');
const auditServiceAccount = process.env.AUDIT_SERVICE_ACCOUNT ?? '';
if (!runtimeAccounts.length) problems.push('RUNTIME_SERVICE_ACCOUNTS not configured');
if (!auditServiceAccount) problems.push('AUDIT_SERVICE_ACCOUNT not configured');
if (auditServiceAccount && runtimeAccounts.includes(auditServiceAccount)) problems.push('audit identity must be distinct from every production runtime identity');
for (const account of runtimeAccounts) {
  const keys = run(['iam', 'service-accounts', 'keys', 'list', '--iam-account', account, '--managed-by=user', '--project', project]);
  if (keys.length) problems.push(`${account}: user-managed keys exist`);
  const policy = run(['iam', 'service-accounts', 'get-iam-policy', account, '--project', project]);
  for (const binding of policy.bindings ?? []) {
    if (['roles/owner', 'roles/editor'].includes(binding.role) && (binding.members ?? []).includes(`serviceAccount:${account}`)) {
      problems.push(`${account}: holds ${binding.role}`);
    }
  }
}
const projectPolicy = run(['projects', 'get-iam-policy', project]);
for (const account of runtimeAccounts) {
  for (const binding of projectPolicy.bindings ?? []) {
    if (['roles/owner', 'roles/editor'].includes(binding.role) && (binding.members ?? []).includes(`serviceAccount:${account}`)) {
      problems.push(`${account}: project-level ${binding.role}`);
    }
  }
}
const token = execFileSync('gcloud', ['auth', 'print-access-token'], { encoding: 'utf8' }).trim();
const appCheck = await fetch(`https://firebaseappcheck.googleapis.com/v1/projects/${encodeURIComponent(project)}/services`, {
  headers: { Authorization: `Bearer ${token}`, 'X-Goog-User-Project': project },
  signal: AbortSignal.timeout(15_000),
});
if (!appCheck.ok) problems.push(`App Check API returned ${appCheck.status}`);
else {
  const payload = await appCheck.json();
  const modes = Object.fromEntries((payload.services ?? []).map((service) => [service.name.split('/').pop(), service.enforcementMode]));
  for (const service of list('APPCHECK_REQUIRED_SERVICES')) if (modes[service] !== 'ENFORCED') problems.push(`App Check not ENFORCED for ${service}`);
}
fs.mkdirSync('evidence', { recursive: true });
fs.writeFileSync('evidence/production-audit.json', JSON.stringify({ project, checkedAt: new Date().toISOString(), problems }, null, 2));
if (problems.length) fail(problems.join('; '));
console.log('production audit clean: recovery OFF everywhere');
