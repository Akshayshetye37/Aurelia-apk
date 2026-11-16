import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export function fail(msg) {
  console.error(`::error::${String(msg).replace(/[\r\n]+/g, ' ').slice(0, 300)}`);
  process.exit(1);
}

export function arg(name, { required = true } = {}) {
  const i = process.argv.indexOf(`--${name}`);
  const v = i === -1 ? undefined : process.argv[i + 1];
  if (v === undefined || v.startsWith('--')) {
    if (required) fail(`Missing --${name}`);
    return undefined;
  }
  return v;
}

export function argAll(name) {
  const out = [];
  process.argv.forEach((a, i) => {
    if (a === `--${name}`) {
      const v = process.argv[i + 1];
      if (v === undefined || v.startsWith('--')) fail(`Missing value for --${name}`);
      out.push(v);
    }
  });
  return out;
}

export const requireSha = (v) =>
  /^[0-9a-f]{40}$/.test(v ?? '') ? v : fail('Invalid SHA: need 40 lowercase hex chars');
export const requireRepo = (v) =>
  /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(v ?? '') ? v : fail('Invalid repository');
export const requireBranch = (v) =>
  /^[A-Za-z0-9._\/-]{1,200}$/.test(v ?? '') && !v.includes('..') ? v : fail('Invalid branch name');
export const requireSha256 = (v) =>
  /^[0-9a-f]{64}$/.test(v ?? '') ? v : fail('Invalid SHA-256');

const API_PATH =
  /^repos\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(\/[A-Za-z0-9_.%:-]+)*(\?[A-Za-z0-9_=&.-]+)?$/;

export async function gh(apiPath) {
  const token = process.env.GITHUB_TOKEN;
  if (!token) fail('GITHUB_TOKEN missing');
  if (!API_PATH.test(apiPath) || apiPath.includes('..')) fail('Rejected API path');
  const res = await fetch(`https://api.github.com/${apiPath}`, {
    method: 'GET',
    signal: AbortSignal.timeout(15000),
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28'
    }
  });
  if (!res.ok) fail(`GitHub API ${res.status} for ${apiPath.split('?')[0]}`);
  return res.json();
}

export function sha256File(p) {
  return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
}

export function canonical(v) {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (v && typeof v === 'object')
    return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`;
  return JSON.stringify(v);
}

// Resolve a path and require it to stay inside `root` (no traversal, no symlink escape).
export function safeInside(root, p) {
  const base = fs.realpathSync(root);
  const full = fs.realpathSync(p);
  if (full !== base && !full.startsWith(base + path.sep)) fail(`Path escapes ${root}`);
  return full;
}
