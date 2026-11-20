import fs from 'node:fs';
import { fail } from './lib.mjs';

const file = process.argv[2] ?? 'scripts/gates/production-project.json';
let pinned;
try { pinned = JSON.parse(fs.readFileSync(file, 'utf8')).projectId; } catch { fail('reviewed production project constant is missing or invalid'); }
if (typeof pinned !== 'string' || !/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(pinned) || pinned === 'UNCONFIGURED') fail('production project constant must be set to the authoritative project ID in a reviewed commit');
const configured = process.env.PRODUCTION_PROJECT_ID ?? '';
if (configured !== pinned) fail('GitHub Environment production project ID differs from reviewed repository constant');
if ((process.env.STAGING_PROJECT_ID ?? '') === pinned) fail('staging project ID matches the reviewed production project ID');
console.log('Production project identity matches reviewed constant; staging is distinct.');
