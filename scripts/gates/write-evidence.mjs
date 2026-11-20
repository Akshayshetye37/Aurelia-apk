import fs from 'node:fs';
import { arg, fail, requireSha } from './lib.mjs';

const gate = arg('gate');
const sha = requireSha(arg('sha'));
const controlSha = requireSha(process.env.GITHUB_SHA);
if (arg('status') !== 'PASS') fail('evidence is written only for PASS');
if (!process.env.GITHUB_REPOSITORY || !/^\d+$/.test(process.env.GITHUB_RUN_ID ?? '') ||
    !/^\d+$/.test(process.env.GITHUB_RUN_ATTEMPT ?? '')) fail('GitHub run identity is unavailable');
fs.mkdirSync('evidence', { recursive: true });
const detailsPath = 'evidence/details.json';
let details = {};
if (fs.existsSync(detailsPath)) {
  try { details = JSON.parse(fs.readFileSync(detailsPath, 'utf8')); } catch { fail('details.json is invalid JSON'); }
}
if (gate === '3' && fs.existsSync('evidence/statuses.json')) {
  try { details.statuses = JSON.parse(fs.readFileSync('evidence/statuses.json', 'utf8')); }
  catch { fail('statuses.json is invalid JSON'); }
}
const recordStatus = gate === '3' ? details.statuses?.GATE_3_OVERALL : 'PASS';
if (gate === '3' && !['QUALIFIED', 'NOT QUALIFIED'].includes(recordStatus)) fail('Gate 3 overall qualification status is missing or invalid');
fs.writeFileSync('evidence/record.json', JSON.stringify({
  gate, status: recordStatus, candidateSha: sha, controlSha, repository: process.env.GITHUB_REPOSITORY,
  runId: Number(process.env.GITHUB_RUN_ID), runAttempt: Number(process.env.GITHUB_RUN_ATTEMPT),
  completedAt: new Date().toISOString(), details,
}, null, 2));
