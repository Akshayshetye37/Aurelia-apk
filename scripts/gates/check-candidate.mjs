// Fails closed unless the candidate SHA is the pinned, frozen candidate.
import fs from 'node:fs';
import { arg, fail, gh, requireSha, requireRepo, requireBranch } from './lib.mjs';

const sha = requireSha(arg('sha'));
const repo = requireRepo(process.env.REPO);
const branch = requireBranch(process.env.CANDIDATE_BRANCH);
requireSha(process.env.GITHUB_SHA); // control SHA (workflow code), recorded separately

const pin = requireSha(fs.readFileSync('gates/qualification-candidate-sha.txt', 'utf8').trim());
if (pin !== sha) fail('Candidate SHA differs from qualification pin');

const encoded = branch.split('/').map(encodeURIComponent).join('/');
const ref = await gh(`repos/${repo}/git/ref/heads/${encoded}`);
if (ref?.object?.sha !== sha) fail('Frozen branch HEAD differs from candidate SHA');

const commit = await gh(`repos/${repo}/commits/${sha}`);
if (commit.sha !== sha) fail('Commit lookup mismatch');
if (process.env.REQUIRE_SIGNED === '1' && commit.commit?.verification?.verified !== true)
  fail('Candidate commit is not signature-verified');

console.log(`Candidate verified: ${sha} (control ${process.env.GITHUB_SHA})`);
