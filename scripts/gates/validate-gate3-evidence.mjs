import fs from 'node:fs';
import { fail, requireSha } from './lib.mjs';

const REQUIRED_PROBE_CASES = ['no App Check token', 'invalid App Check token'];
const SHA256_RE = /^[0-9a-f]{64}$/;

export function validateGate3Evidence({ probes, details, candidateSha, physicalMatrix = null }) {
  requireSha(candidateSha);
  if (!Array.isArray(probes) || probes.length === 0) throw new Error('Gate 3 evidence must contain at least one probe');
  if (!details || typeof details !== 'object' || Array.isArray(details)) throw new Error('Gate 3 details must be an object');
  if (details.candidateSha !== candidateSha) throw new Error('candidate SHA mismatch between evidence files');
  for (const field of ['apkSha256', 'testApkSha256', 'signerSha256']) {
    if (typeof details[field] !== 'string' || !SHA256_RE.test(details[field].toLowerCase().replaceAll(':', ''))) {
      throw new Error(`missing or invalid ${field}`);
    }
  }
  const excluded = details.excluded ?? [];
  if (!Array.isArray(excluded)) throw new Error('exclusions must be an array');
  for (const item of excluded) {
    if (!item || typeof item !== 'object' || typeof item.reason !== 'string' || !item.reason.trim()) {
      throw new Error('every exclusion must include a non-empty reason');
    }
  }
  const byCallable = new Map();
  for (const probe of probes) {
    if (!probe || typeof probe.callable !== 'string' || !probe.callable.trim()) throw new Error('probe callable is missing');
    if (!REQUIRED_PROBE_CASES.includes(probe.case)) throw new Error(`unexpected probe case: ${probe.case}`);
    if (![401, 403].includes(probe.status)) throw new Error(`invalid probe result for ${probe.callable}: ${probe.status}`);
    const cases = byCallable.get(probe.callable) ?? new Set();
    if (cases.has(probe.case)) throw new Error(`duplicate probe ${probe.callable}/${probe.case}`);
    cases.add(probe.case);
    byCallable.set(probe.callable, cases);
  }
  for (const [callable, cases] of byCallable) {
    for (const required of REQUIRED_PROBE_CASES) if (!cases.has(required)) throw new Error(`callable ${callable} missing probe: ${required}`);
  }
  if (details.callables && Array.isArray(details.callables)) {
    const expected = [...details.callables].sort();
    const actual = [...byCallable.keys()].sort();
    if (JSON.stringify(expected) !== JSON.stringify(actual)) throw new Error('probe callable inventory mismatch');
  }
  const physical = physicalMatrix && physicalMatrix.candidateSha === candidateSha &&
    physicalMatrix.status === 'QUALIFIED' && physicalMatrix.signoff &&
    typeof physicalMatrix.signoff.reviewer === 'string' && physicalMatrix.signoff.reviewer.trim() &&
    typeof physicalMatrix.signoff.signedAt === 'string' && physicalMatrix.signoff.signedAt.trim() && SHA_RE.test(physicalMatrix.signoff.commit ?? '');
  return {
    STAGING_DEPLOYMENT: details.stagingDeployment === 'QUALIFIED' ? 'QUALIFIED' : 'NOT QUALIFIED',
    APPCHECK_NEGATIVE_PROBES: 'QUALIFIED',
    APK_BUILD_AND_SIGNING: details.apkBuildAndSigning === 'QUALIFIED' ? 'QUALIFIED' : 'NOT QUALIFIED',
    PHYSICAL_SMS_RECOVERY: physical ? 'QUALIFIED' : 'NOT QUALIFIED',
    GATE_3_OVERALL: physical && details.stagingDeployment === 'QUALIFIED' && details.apkBuildAndSigning === 'QUALIFIED' ? 'QUALIFIED' : 'NOT QUALIFIED',
  };
}

if (process.argv[1] && process.argv[1].endsWith('validate-gate3-evidence.mjs')) {
  const candidateSha = process.env.CANDIDATE_SHA ?? '';
  let probes, details, physicalMatrix = null;
  try {
    probes = JSON.parse(fs.readFileSync('evidence/probes.json', 'utf8'));
    details = JSON.parse(fs.readFileSync('evidence/details.json', 'utf8'));
    if (fs.existsSync('evidence/physical-device-matrix.json')) physicalMatrix = JSON.parse(fs.readFileSync('evidence/physical-device-matrix.json', 'utf8'));
  } catch { fail('Gate 3 evidence files are missing or invalid JSON'); }
  let statuses;
  try { statuses = validateGate3Evidence({ probes, details, candidateSha, physicalMatrix }); }
  catch (error) { fail(error.message); }
  fs.writeFileSync('evidence/statuses.json', JSON.stringify(statuses, null, 2));
  if (statuses.GATE_3_OVERALL !== 'QUALIFIED') console.log('Gate 3 overall remains NOT QUALIFIED: physical-device matrix/signoff or required staging evidence is incomplete.');
  else console.log('Gate 3 overall QUALIFIED.');
}
