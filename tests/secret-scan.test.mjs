import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { scanSecrets } from "../scripts/check-secrets.mjs";

test("secret scanner detects private keys and credential tokens without printing values", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "aurelia-secret-scan-"));
  try {
    fs.writeFileSync(path.join(root, "safe.txt"), "example credential placeholder only");
    fs.writeFileSync(path.join(root, "leak.txt"),
      "-----BEGIN PRIVATE KEY-----\n" + "gh" + "p_" + "A".repeat(40) + "\n");
    const findings = scanSecrets(root);
    assert.equal(findings.length, 2);
    assert.deepEqual(findings.map(x => x.rule), ["PEM private key", "GitHub personal access token"]);
    assert.equal(JSON.stringify(findings).includes("A".repeat(20)), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
