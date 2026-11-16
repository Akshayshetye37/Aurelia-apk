import fs from 'node:fs';
import path from 'node:path';
import { fail } from './lib.mjs';

const root = path.resolve(process.argv[2] ?? '.');
if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) fail('candidate root does not exist');
const SKIP_DIRS = new Set(['.git', 'node_modules', 'build', 'dist', 'coverage', '.gradle', '.idea', 'test', 'tests', '__tests__', 'fixtures', 'staging', 'instrumentation']);
const EXT = /\.(?:ts|tsx|js|jsx|mjs|cjs|json|ya?ml|kt|java|xml|env|properties|gradle)$/i;
const FLAGS = [
  ['RECOVERY_ENABLED', /\bRECOVERY_ENABLED\b["']?\s*[:=]\s*["']?(?:true|1)\b/i],
  ['LIVE_COLLECTION', /\bLIVE_COLLECTION(?:_ENABLED)?\b["']?\s*[:=]\s*["']?(?:true|1)\b/i],
  ['AUTOMATIC_SETTLEMENT', /\bAUTOMATIC_SETTLEMENT(?:_ENABLED)?\b["']?\s*[:=]\s*["']?(?:true|1)\b/i],
  ['AUTOMATIC_REFUNDS', /\bAUTOMATIC_REFUNDS?(?:_ENABLED)?\b["']?\s*[:=]\s*["']?(?:true|1)\b/i],
  ['CLOUD_SYNC', /\bCLOUD_SYNC(?:_ENABLED)?\b["']?\s*[:=]\s*["']?(?:true|1)\b/i],
  ['BT_PRINTING_ENABLED', /\bBT_PRINTING_ENABLED\b["']?\s*[:=]\s*["']?(?:true|1)\b/i],
  ['uiCutover', /\buiCutover\b["']?\s*[:=]\s*true\b/i],
];
const hits = [];
let scanned = 0, onCall = 0, enforced = 0;
function walk(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) fail(`candidate source contains a symbolic link: ${file}`);
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) walk(file);
      continue;
    }
    if (!EXT.test(entry.name) || /(?:\.test|\.spec|InstrumentedTest)\./.test(entry.name)) continue;
    const relative = path.relative(root, file).split(path.sep).join('/');
    if (relative === '.github/workflows/recovery-staging-deploy.yml') continue;
    const text = fs.readFileSync(file, 'utf8');
    scanned++;
    for (const [name, regex] of FLAGS) {
      for (const [index, line] of text.split('\n').entries()) {
        const candidate = line.trim();
        if (candidate.startsWith('//') || candidate.startsWith('*') || candidate.startsWith('#') || candidate.startsWith('<!--')) continue;
        if (regex.test(line)) hits.push(`${file}:${index + 1}: ${name} enabled`);
      }
    }
    if (file.split(path.sep).includes('src') && file.split(path.sep).includes('functions') && /\.(?:ts|js)$/.test(file)) {
      onCall += (text.match(/\bonCall\s*\(/g) ?? []).length;
      enforced += (text.match(/enforceAppCheck\s*:\s*true/g) ?? []).length;
    }
  }
}
walk(root);
if (scanned === 0) fail('scanned zero files; wrong candidate root');
if (onCall > enforced) hits.push(`functions App Check tripwire: ${onCall} onCall declarations and ${enforced} enforceAppCheck:true occurrences; review manually`);
fs.mkdirSync('evidence', { recursive: true });
fs.writeFileSync('evidence/flags.json', JSON.stringify({ scanned, onCall, enforced, hits }, null, 2));
if (hits.length) fail(hits.join('; '));
console.log(`source flag tripwire clean; App Check tripwire ${enforced}/${onCall} (${scanned} files)`);
