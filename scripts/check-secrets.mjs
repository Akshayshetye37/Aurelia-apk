import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SKIP = new Set([".git", "node_modules", "dist", "build", ".gradle", ".idea"]);
const RULES = [
  ["PEM private key", /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/],
  ["AWS access key", /\bAKIA[0-9A-Z]{16}\b/],
  ["GitHub personal access token", /\bgh[pousr]_[A-Za-z0-9]{36,}\b/],
  ["Slack token", /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/],
  ["Stripe live secret", /\bsk_live_[A-Za-z0-9]{16,}\b/],
  ["Google API key", /\bAIza[0-9A-Za-z_-]{35}\b/]
];

function walk(root) {
  if (!fs.existsSync(root)) return [];
  return fs.readdirSync(root, { withFileTypes: true }).flatMap(entry => {
    if (entry.isDirectory() && SKIP.has(entry.name)) return [];
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) return walk(full);
    if (entry.isSymbolicLink()) return [];
    return [full];
  });
}

export function scanSecrets(root) {
  const findings = [];
  for (const file of walk(root)) {
    let content;
    try {
      const stat = fs.statSync(file);
      if (!stat.isFile() || stat.size > 2 * 1024 * 1024) continue;
      content = fs.readFileSync(file, "utf8");
    } catch { continue; }
    if (content.includes("\u0000")) continue;
    const lines = content.split(/\r?\n/);
    lines.forEach((line, index) => {
      for (const [rule, pattern] of RULES) {
        if (pattern.test(line)) findings.push({ file: path.relative(root, file), line: index + 1, rule });
      }
    });
  }
  return findings;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = path.resolve(process.argv[2] || process.cwd());
  const findings = scanSecrets(root);
  if (findings.length) {
    for (const finding of findings) {
      console.error("::error file=" + finding.file + ",line=" + finding.line + "::Potential " + finding.rule + " detected");
    }
    process.exitCode = 1;
  } else {
    console.log("Secret scan passed: no supported credential patterns detected.");
  }
}
