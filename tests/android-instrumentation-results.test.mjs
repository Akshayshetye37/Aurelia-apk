import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { findIgnoredTests, summarizeJUnitXml } from "../scripts/verify-android-instrumentation-results.mjs";

test("JUnit summary aggregates suites when no aggregate root totals exist", () => {
  const result = summarizeJUnitXml([
    '<testsuites><testsuite name="a" tests="2" failures="0" errors="0" skipped="0"/><testsuite name="b" tests="3" failures="1" errors="0" skipped="0"/></testsuites>'
  ]);
  assert.deepEqual(result, { files: 1, tests: 5, failures: 1, errors: 0, skipped: 0 });
});

test("JUnit summary counts aggregate totals once", () => {
  const result = summarizeJUnitXml([
    '<testsuites tests="4" failures="0" errors="0" skipped="1"><testsuite name="a" tests="4" failures="0" errors="0" skipped="1"/></testsuites>'
  ]);
  assert.deepEqual(result, { files: 1, tests: 4, failures: 0, errors: 0, skipped: 1 });
});

test("JUnit summary rejects malformed reports and empty inputs", () => {
  assert.deepEqual(summarizeJUnitXml([]), { files: 0, tests: 0, failures: 0, errors: 0, skipped: 0 });
  assert.throws(() => summarizeJUnitXml(["<not-a-report/>"]), /no testsuite/);
});

test("ignored-test scan detects simple and fully-qualified JUnit Ignore annotations", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "aurelia-ignore-scan-"));
  try {
    fs.writeFileSync(path.join(root, "Ignored.java"), "import org.junit.Ignore;\n@Ignore public class Ignored {}\n");
    fs.writeFileSync(path.join(root, "Qualified.kt"), "@org.junit.Ignore class Qualified\n");
    assert.equal(findIgnoredTests(root).length, 2);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
