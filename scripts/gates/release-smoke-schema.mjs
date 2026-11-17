const fail = message => { throw new Error(message); };

export function validateReleaseSmokeInputs({ repo, controlBranch, candidateBranch, candidateSha, gate6RunId, releaseTag }) {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo ?? '')) fail('repository is invalid');
  if (!/^[A-Za-z0-9_.\/-]+$/.test(controlBranch ?? '') || controlBranch.split('/').some(part => part === '..')) fail('control branch is invalid');
  if (!/^[A-Za-z0-9_.\/-]+$/.test(candidateBranch ?? '') || candidateBranch.split('/').some(part => part === '..')) fail('candidate branch is invalid');
  if (!/^[0-9a-f]{40}$/.test(candidateSha ?? '')) fail('candidate SHA is invalid');
  if (!/^[1-9][0-9]{0,15}$/.test(String(gate6RunId ?? ''))) fail('Gate 6 run ID is invalid');
  if (!/^[A-Za-z0-9._-]{1,128}$/.test(releaseTag ?? '')) fail('release tag is invalid');
  return true;
}

export function validateProductionSmokeBinding({
  metadata, attestedRelease, qualification, currentAudit, candidateSha,
  candidateBranch, releaseCommitSha, deviceLabel, now = Date.now(),
}) {
  if (!metadata || !attestedRelease || !qualification || !currentAudit) fail('release evidence is incomplete');
  if (qualification.status !== 'QUALIFIED_FOR_RELEASE_REVIEW' ||
      qualification.candidateSha !== candidateSha || qualification.productionRecoveryEnabled !== false) {
    fail('Gate 6 result is not qualified or does not prove production recovery OFF');
  }
  const fields = ['productionProjectId', 'activeKid', 'packageLockSha256', 'assetLinksVerificationSha256', 'apkSha256', 'testApkSha256', 'signerSha256'];
  if (!qualification.productionRelease || fields.some(field =>
      qualification.productionRelease[field] !== attestedRelease[field] || metadata[field] !== attestedRelease[field])) {
    fail('production release metadata differs from the attested Gate 6 release record');
  }
  if (metadata.candidateSha !== candidateSha || metadata.candidateBranch !== candidateBranch ||
      releaseCommitSha !== candidateSha) fail('published release tag or artifact is not bound to the exact candidate SHA');
  if (!deviceLabel || qualification.device?.deviceLabel !== deviceLabel ||
      typeof qualification.device.deviceModel !== 'string' || !qualification.device.deviceModel ||
      typeof qualification.device.androidVersion !== 'string' || !qualification.device.androidVersion ||
      !['StrongBox', 'TEE'].includes(qualification.device.hardwareSecurityLevel)) {
    fail('post-release smoke handset does not match the single Gate 4 approved device');
  }
  if (!/^[0-9a-f]{64}$/.test(metadata.packageLockSha256 ?? '') ||
      !/^[0-9a-f]{64}$/.test(metadata.assetLinksVerificationSha256 ?? '') ||
      !/^[0-9a-f]{64}$/.test(metadata.apkSha256 ?? '') ||
      !/^[0-9a-f]{64}$/.test(metadata.testApkSha256 ?? '') ||
      !/^[0-9a-f]{64}$/.test(metadata.signerSha256 ?? '') ||
      !/^[A-Za-z0-9._-]{1,64}$/.test(metadata.activeKid ?? '')) fail('production release hashes or active key ID are invalid');
  if (currentAudit.project !== metadata.productionProjectId ||
      currentAudit.productionRecoveryEnabled !== false ||
      currentAudit.recoverySigningKeyId !== metadata.activeKid ||
      !Array.isArray(currentAudit.problems) || currentAudit.problems.length !== 0) {
    fail('fresh production audit does not confirm recovery OFF and the matching signing key ID');
  }
  const auditTime = Date.parse(currentAudit.checkedAt ?? '');
  if (!Number.isFinite(auditTime) || auditTime > now + 300000 || now - auditTime > 60 * 60 * 1000) {
    fail('production audit is missing, future-dated or older than one hour');
  }
  return true;
}
