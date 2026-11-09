import fs from "node:fs";

const sha = process.env.GITHUB_SHA || "unknown";
const repository = process.env.GITHUB_REPOSITORY || "unknown/repository";
const runId = process.env.GITHUB_RUN_ID || "unknown";
const server = process.env.GITHUB_SERVER_URL || "https://github.com";
const outcomes = {
  "Application tests": process.env.TESTS_OUTCOME || "not-run",
  "Production build": process.env.BUILD_OUTCOME || "not-run",
  "Release safety flags": process.env.FLAGS_OUTCOME || "not-run",
  "Production asset boundary": process.env.BOUNDARY_OUTCOME || "not-run"
};
const passed = Object.values(outcomes).every(value => value === "success");
const lines = [
  "# Aurelia CI-generated release status",
  "",
  `**Commit SHA:** \`${sha}\``,
  `**Overall governance check:** ${passed ? "PASS" : "FAIL / INCOMPLETE"}`,
  `**Workflow run:** [${runId}](${server}/${repository}/actions/runs/${runId})`,
  "",
  "| Gate | Result |",
  "|---|---|",
  ...Object.entries(outcomes).map(([name, value]) => `| ${name} | ${value.toUpperCase()} |`),
  "",
  "This report describes only the checks executed by this workflow on the SHA above. It does not imply repository-admin branch protection, real-backup/accounting approval, physical-device qualification, or release signing.",
  "",
  "All other R1 packets remain In progress/Blocked until their packet-specific Definition of Done evidence is attached.",
  ""
];
fs.writeFileSync("STATUS.md", lines.join("\n"), "utf8");
process.stdout.write(lines.join("\n"));
