import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const script = new URL('./check-callable-inventory.mjs', import.meta.url);
function run(inventory, deployed) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gate3-inventory-'));
  try {
    const inv = path.join(dir, 'inventory.json'), dep = path.join(dir, 'deployed.json');
    fs.writeFileSync(inv, JSON.stringify({ callables: inventory }));
    fs.writeFileSync(dep, JSON.stringify(deployed.map(name => ({ name: `projects/p/locations/r/functions/${name}` }))));
    return execFileSync(process.execPath, [script.pathname, inv, dep], { encoding: 'utf8' });
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}
test('accepts exact deployed inventory', () => assert.match(run(['a', 'b'], ['a', 'b']), /reconciled/));
test('fails deployed callable missing from probe inventory', () => assert.throws(() => run(['a'], ['a', 'b'])));
test('fails probe callable not deployed', () => assert.throws(() => run(['a', 'b'], ['a'])));
test('fails empty inventory', () => assert.throws(() => run([], [])));
