import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const root = process.cwd();
const registryPath = path.join(root, "feature-registry.json");
const registry = JSON.parse(fs.readFileSync(registryPath, "utf8"));
const minimum = registry.test_baseline?.minimum_tests;

if (!Number.isSafeInteger(minimum) || minimum < 1) {
  throw new Error("feature-registry.json must define test_baseline.minimum_tests as a positive integer");
}

const roots = ["tests", "payment-backend/test"];
const testPattern = /\.test\.(?:mjs|js|cjs)$/;
const files = [];

function walk(directory) {
  if (!fs.existsSync(directory)) return;
  for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) walk(absolute);
    else if (entry.isFile() && testPattern.test(entry.name)) {
      files.push(path.relative(root, absolute).split(path.sep).join("/"));
    }
  }
}

for (const directory of roots) walk(path.join(root, directory));
files.sort();

if (files.length === 0) throw new Error("No test files discovered");
console.log(`Discovered ${files.length} test files:`);
for (const file of files) console.log(`  ${file}`);

const result = spawnSync(process.execPath, ["--test", ...files], {
  cwd: root,
  encoding: "utf8",
  maxBuffer: 64 * 1024 * 1024
});

const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
process.stdout.write(output);

const readCount = (label) => {
  const match = output.match(new RegExp(`^# ${label} (\\d+)$`, "m"));
  return match ? Number(match[1]) : null;
};
const total = readCount("tests");
const passed = readCount("pass");
const failed = readCount("fail");
const skipped = readCount("skipped");

if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);
if ([total, passed, failed, skipped].some((value) => value === null)) {
  throw new Error("Node test runner summary is missing; refusing to report a pass");
}
if (failed !== 0 || skipped !== 0) {
  throw new Error(`Test policy failed: ${failed} failures, ${skipped} skipped`);
}
if (total < minimum) {
  throw new Error(`Test count regression: executed ${total}, registry minimum is ${minimum}`);
}
console.log(`Unified test gate passed: ${passed}/${total}, 0 failed, 0 skipped (registry minimum ${minimum}).`);
