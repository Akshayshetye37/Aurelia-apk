import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

function attributes(tag) {
  const values = {};
  for (const match of tag.matchAll(/([A-Za-z_:][\w:.-]*)\s*=\s*["']([^"']*)["']/g)) {
    values[match[1]] = Number.isFinite(Number(match[2])) ? Number(match[2]) : match[2];
  }
  return values;
}

export function summarizeJUnitXml(xmlFiles) {
  if (!Array.isArray(xmlFiles) || xmlFiles.length === 0) {
    return { files: 0, tests: 0, failures: 0, errors: 0, skipped: 0 };
  }
  const totals = { files: xmlFiles.length, tests: 0, failures: 0, errors: 0, skipped: 0 };
  for (const xml of xmlFiles) {
    const tags = [...xml.matchAll(/<(testsuites|testsuite)\b[^>]*>/g)].map(m => ({
      name: m[1], attrs: attributes(m[0])
    }));
    if (tags.length === 0) throw new Error("JUnit XML has no testsuite element.");
    const aggregate = tags.find(t => t.name === "testsuites");
    const suites = tags.filter(t => t.name === "testsuite");
    const selected = aggregate && ["tests", "failures", "errors", "skipped"].every(k => k in aggregate.attrs)
      ? [aggregate] : suites;
    for (const suite of selected) {
      for (const key of ["tests", "failures", "errors", "skipped"]) {
        totals[key] += Number(suite.attrs[key] ?? 0);
      }
    }
  }
  return totals;
}

function walk(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const full = path.join(dir, entry.name);
    return entry.isDirectory() ? walk(full) : [full];
  });
}

export function findIgnoredTests(root) {
  return walk(root).filter(file => /\.(?:java|kt)$/.test(file))
    .filter(file => /@\s*Ignore\b/.test(fs.readFileSync(file, "utf8")));
}

export function verifyInstrumentationResults(resultsDir, templateDir) {
  const files = walk(resultsDir).filter(file => file.endsWith(".xml"));
  const totals = summarizeJUnitXml(files.map(file => fs.readFileSync(file, "utf8")));
  const ignored = findIgnoredTests(templateDir);
  const problems = [];
  if (totals.tests === 0) problems.push("tests == 0");
  if (totals.failures + totals.errors > 0) problems.push("failures + errors > 0");
  if (totals.skipped > 0) problems.push("skipped > 0");
  if (ignored.length > 0) problems.push("JUnit @Ignore is prohibited: " + ignored.join(", "));
  return { ...totals, ignored, problems };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const resultsDir = process.argv[2] || "android/app/build/outputs/androidTest-results/connected";
  const templateDir = process.argv[3] || "android/templates";
  try {
    const result = verifyInstrumentationResults(resultsDir, templateDir);
    console.log(JSON.stringify(result, null, 2));
    if (result.problems.length) {
      for (const problem of result.problems) console.error("::error::" + problem);
      process.exitCode = 1;
    }
  } catch (error) {
    console.error("::error::" + (error?.message || String(error)));
    process.exitCode = 1;
  }
}
