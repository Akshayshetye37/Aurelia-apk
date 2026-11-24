import { arg, fail, gh, requireSha } from './lib.mjs';
const sha = requireSha(arg('sha'));
const repo = arg('repo');
const branch = arg('branch');
if (!/^[A-Za-z0-9_.\/-]+$/.test(branch) || branch.includes('..') || branch.startsWith('/') || branch.endsWith('/')) fail('invalid branch name');
if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) fail('invalid repository name');
const encoded = branch.split('/').map(encodeURIComponent).join('/');
const ref = gh(`repos/${repo}/git/ref/heads/${encoded}`);
const head = ref.object?.sha;
if (!requireSha(head ?? '')) fail(`candidate branch ${branch} has no valid head SHA');
// A candidate is frozen by its commit SHA. It may remain valid after the branch
// advances, but must still be an ancestor of that branch (not an unrelated commit).
const comparison = gh(`repos/${repo}/compare/${sha}...${encoded}`);
const mergeBase = comparison.merge_base_commit?.sha;
if (!['ahead', 'identical'].includes(comparison.status) || mergeBase !== sha || comparison.base_commit?.sha !== sha || comparison.head_commit?.sha !== head) {
  fail(`candidate ${sha} is not an ancestor of ${branch} (branch head is ${head})`);
}
console.log(`candidate ${sha} is frozen and reachable from ${branch} (current head ${head})`);
