import { readFile } from 'node:fs/promises';
import { execFileSync, spawnSync } from 'node:child_process';

export function validateFeatureRegistry(registry, changedFiles = []) {
  if (!registry || registry.version !== 1 || !Array.isArray(registry.features)) {
    throw new Error('feature_lock_registry_invalid');
  }
  const ids = new Set();
  const violations = [];
  let verified = 0, locked = 0;
  for (const feature of registry.features) {
    if (!feature || typeof feature.id !== 'string' || !feature.id ||
        ids.has(feature.id) || !['unverified', 'verified', 'locked'].includes(feature.status) ||
        !Array.isArray(feature.files) || feature.files.some(path => typeof path !== 'string' || !path)) {
      throw new Error('feature_lock_entry_invalid');
    }
    ids.add(feature.id);
    if (feature.status === 'unverified') continue;
    const evidence = feature.evidence;
    if (!evidence || !/^[a-f0-9]{40}$/.test(evidence.sha || '') ||
        !Number.isSafeInteger(evidence.runId) || evidence.runId < 1 ||
        typeof evidence.runUrl !== 'string' || !evidence.runUrl.startsWith('https://github.com/') ||
        !Number.isSafeInteger(evidence.tests) || evidence.tests < 1 ||
        evidence.failures !== 0 || evidence.skips !== 0) {
      throw new Error('feature_lock_green_evidence_required:' + feature.id);
    }
    verified++;
    if (feature.status === 'locked') {
      locked++;
      if (typeof feature.lockedAt !== 'string' || !feature.lockedAt ||
          typeof feature.ownerApproval !== 'string' || !feature.ownerApproval) {
        throw new Error('feature_lock_owner_approval_required:' + feature.id);
      }
      for (const changed of changedFiles) {
        if (feature.files.some(path => changed === path || changed.startsWith(path.endsWith('/') ? path : path + '/'))) {
          violations.push({ feature: feature.id, file: changed });
        }
      }
    }
  }
  if (violations.length) {
    const error = new Error('locked_feature_files_modified');
    error.violations = violations;
    throw error;
  }
  return { features: registry.features.length, verified, locked, changedFiles: changedFiles.length };
}

export function validateEvidenceFreshness(feature, changedSinceEvidence = []) {
  if (!feature || !['verified', 'locked'].includes(feature.status)) return true;
  const stale = changedSinceEvidence.filter(changed =>
    (feature.files || []).some(path =>
      changed === path || changed.startsWith(path.endsWith('/') ? path : path + '/')
    )
  );
  if (stale.length) {
    const error = new Error('verified_feature_evidence_stale:' + feature.id);
    error.staleFiles = stale;
    throw error;
  }
  return true;
}

export function validateRegistryEvolution(baseRegistry, currentRegistry) {
  const current = new Map((currentRegistry?.features || []).map(feature => [feature.id, feature]));
  for (const prior of baseRegistry?.features || []) {
    if (prior.status !== 'locked') continue;
    const next = current.get(prior.id);
    if (!next || next.status !== 'locked' ||
        JSON.stringify([...(next.files || [])].sort()) !== JSON.stringify([...(prior.files || [])].sort())) {
      throw new Error('locked_feature_registry_mutation_requires_owner_approval:' + prior.id);
    }
  }
  return true;
}

export function changedPaths(baseSha, headSha) {
  const output = execFileSync('git', ['diff', '--name-only', baseSha + '...' + headSha], { encoding: 'utf8' });
  return output.split('\n').map(value => value.trim()).filter(Boolean);
}

async function main() {
  const registry = JSON.parse(await readFile('.github/feature-locks.json', 'utf8'));
  const headSha = process.env.HEAD_SHA || execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  let baseSha = process.env.BASE_SHA || '';
  if (!/^[a-f0-9]{40}$/.test(baseSha)) {
    baseSha = execFileSync('git', ['rev-parse', 'HEAD^'], { encoding: 'utf8' }).trim();
  }
  const changed = changedPaths(baseSha, headSha);
  const priorRaw = spawnSync('git', ['show', baseSha + ':.github/feature-locks.json'], { encoding: 'utf8' });
  const priorRegistry = priorRaw.status === 0 ? JSON.parse(priorRaw.stdout) : null;
  validateRegistryEvolution(priorRegistry, registry);
  const result = validateFeatureRegistry(registry, changed);
  for (const feature of registry.features.filter(item => item.status !== 'unverified')) {
    const ancestor = spawnSync('git', ['merge-base', '--is-ancestor', feature.evidence.sha, headSha]);
    if (ancestor.status !== 0) throw new Error('feature_evidence_not_in_candidate_history:' + feature.id);
    validateEvidenceFreshness(feature, changedPaths(feature.evidence.sha, headSha));
  }
  process.stdout.write('FEATURE_LOCK_GUARD_PASSED ' + JSON.stringify(result) + '\n');
}

if (process.argv[1] && import.meta.url === new URL('file://' + process.argv[1]).href) {
  main().catch(error => {
    process.stderr.write(String(error?.message || 'feature_lock_guard_failed') + '\n');
    if (error.violations) process.stderr.write(JSON.stringify(error.violations) + '\n');
    process.exitCode = 1;
  });
}
