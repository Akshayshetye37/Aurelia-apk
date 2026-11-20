import fs from 'node:fs';
import { fail } from './lib.mjs';

const inventoryPath = process.argv[2] ?? 'scripts/gates/callables.json';
const deployedPath = process.argv[3] ?? 'evidence/deployed-functions.json';
let inventory, deployed;
try {
  inventory = JSON.parse(fs.readFileSync(inventoryPath, 'utf8'));
  deployed = JSON.parse(fs.readFileSync(deployedPath, 'utf8'));
} catch { fail('callable inventory or deployed-functions evidence is invalid JSON'); }
if (!Array.isArray(inventory.callables) || inventory.callables.length === 0 ||
    new Set(inventory.callables).size !== inventory.callables.length ||
    inventory.callables.some(name => typeof name !== 'string' || !/^[A-Za-z0-9_-]+$/.test(name))) fail('authoritative callable inventory is invalid');
if (!Array.isArray(deployed)) fail('deployed Functions response must be an array');
const actual = deployed.map(item => typeof item.name === 'string' ? item.name.split('/').at(-1) : item.name)
  .filter(name => typeof name === 'string' && name.length);
const missingProbes = actual.filter(name => !inventory.callables.includes(name));
const staleProbes = inventory.callables.filter(name => !actual.includes(name));
if (missingProbes.length || staleProbes.length) {
  fail(`deployed callable inventory mismatch; missing probes: ${missingProbes.join(', ') || 'none'}; nonexistent probes: ${staleProbes.join(', ') || 'none'}`);
}
fs.mkdirSync('evidence', { recursive: true });
fs.writeFileSync('evidence/callable-inventory.json', JSON.stringify({ inventory: [...inventory.callables].sort(), deployed: [...actual].sort(), reconciled: true }, null, 2));
console.log(`Callable inventory reconciled: ${actual.length} deployed callable(s).`);
