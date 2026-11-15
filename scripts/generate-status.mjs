import fs from "node:fs";

const registry = JSON.parse(fs.readFileSync("feature-registry.json", "utf8"));
if (!Array.isArray(registry.features) || !registry.baseline || !registry.totals || !registry.rules) {
  throw new Error("feature-registry.json is missing required registry data");
}
const minimum = registry.test_baseline?.minimum_tests;
if (!Number.isSafeInteger(minimum) || minimum < 1) {
  throw new Error("feature-registry.json must define a positive test_baseline.minimum_tests");
}

const counts = { VERIFIED: 0, LOCKED: 0, UNVERIFIED: 0 };
const groups = new Map();
for (const feature of registry.features) {
  if (!Object.hasOwn(counts, feature.status)) {
    throw new Error(`Unknown registry status for ${feature.id}: ${feature.status}`);
  }
  counts[feature.status] += 1;
  const key = feature.feature || "uncategorized";
  const row = groups.get(key) || { entries: 0, VERIFIED: 0, LOCKED: 0, UNVERIFIED: 0 };
  row.entries += 1;
  row[feature.status] += 1;
  groups.set(key, row);
}
if (registry.totals.implementation_entries !== registry.features.length ||
    registry.totals.verified !== counts.VERIFIED ||
    registry.totals.locked !== counts.LOCKED ||
    registry.totals.unverified !== counts.UNVERIFIED) {
  throw new Error("feature-registry.json aggregate totals do not match its feature entries");
}

const rows = [...groups.entries()].sort(([a], [b]) => a.localeCompare(b))
  .map(([name, row]) => `| ${name} | ${row.entries} | ${row.VERIFIED} | ${row.LOCKED} | ${row.UNVERIFIED} |`)
  .join("\n");

const body = `# Aurelia R1 status

**Release:** R1 — local-only PMS  
**Status:** **NOT RELEASE READY**  
**Generated from:** \`feature-registry.json\`

## Feature registry (source of truth)

- Baseline branch: \`${registry.baseline.branch}\`
- Baseline SHA: \`${registry.baseline.sha}\`
- Implementation entries: ${registry.features.length}
- VERIFIED: ${counts.VERIFIED}
- LOCKED: ${counts.LOCKED}
- UNVERIFIED: ${counts.UNVERIFIED}

| Feature area | Entries | Verified | Locked | Unverified |
|---|---:|---:|---:|---:|
${rows}

## Unified test policy

- Test file scope: ${(registry.test_baseline.scope || []).join(", ")}
- Minimum executed tests: ${minimum}
- Acceptance: exact candidate SHA; non-zero tests; zero failures; zero skipped; executed count at or above registry minimum.

## Release defaults (must remain OFF)

- \`RECOVERY_ENABLED=false\`
- \`uiCutover=false\`; cloud sync OFF; Pay Bridge OFF.
- Live collection OFF.
- Automatic settlement and refund posting OFF.
- R1 release publishing NOT AUTHORIZED.

## External qualification still required

- Repository owner/admin: branch protection, required code-owner review, required reviewers for \`aurelia-release-approval\`.
- Staging Firebase project, HTTPS hostname, asset links and real certificate pin rotation evidence.
- Authorized redacted accounting backup and accounting-owner written mapping approval.
- Provider sandbox credentials stored only in Secret Manager/GitHub secrets.
- Physical Android device and test SIM; Pay Bridge repository and paired-device validation.
- Owner-controlled signing key and written release signoff.

**Completion rule:** documentation and aggregate CI success do not promote individual features. Each registry entry requires exact-SHA evidence and its own matching test evidence before VERIFIED; immutable hash/tag and code-owner controls before LOCKED.
`;

fs.writeFileSync("STATUS.md", body);
console.log(`Generated deterministic registry-backed STATUS.md (${registry.features.length} entries; ${minimum}-test floor).`);
