import fs from 'node:fs';
import path from 'node:path';
import { fail } from './lib.mjs';

const directory = '.github/workflows';
const errors = [];
const files = fs.readdirSync(directory).filter((file) => /^gate-.*\.ya?ml$/.test(file) || ['recovery-staging-deploy.yml', 'recovery-attestation-deploy.yml'].includes(file));
if (!files.length) fail('no gate workflow files found');
for (const file of files) {
  const lines = fs.readFileSync(path.join(directory, file), 'utf8').split('\n');
  let runIndent = null;
  lines.forEach((line, index) => {
    const action = line.match(/^\s*-?\s*uses:\s*([^\s#]+)/);
    if (action && !action[1].startsWith('./') && !/@[0-9a-f]{40}$/.test(action[1])) {
      errors.push(`${file}:${index + 1} action is not pinned to a full commit SHA: ${action[1]}`);
    }
    if (/pull_request_target/.test(line)) errors.push(`${file}:${index + 1} pull_request_target is forbidden`);
    if (/permissions:\s*write-all\b/.test(line)) errors.push(`${file}:${index + 1} write-all permissions are forbidden`);
    const indent = line.match(/^\s*/)[0].length;
    if (/^\s*run:\s*(?:\||>|\|-|>-)?\s*$/.test(line)) runIndent = indent;
    else if (runIndent !== null && line.trim() && indent <= runIndent) runIndent = null;
    if (runIndent !== null && /\$\{\{\s*(?:inputs\.|github\.event\.|github\.head_ref)/.test(line)) {
      errors.push(`${file}:${index + 1} untrusted GitHub expression inside run block; pass it through env:`);
    }
    if (/^\s*run:\s*.*\$\{\{\s*(?:inputs\.|github\.event\.|github\.head_ref)/.test(line)) {
      errors.push(`${file}:${index + 1} untrusted expression in inline run command`);
    }
  });
}
if (errors.length) fail('\n' + errors.join('\n'));
console.log(`workflow lint clean: ${files.length} gate workflow(s), immutable action pins and no untrusted run expressions`);
