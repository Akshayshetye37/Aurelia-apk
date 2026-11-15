import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve, relative, isAbsolute, sep } from 'node:path';

export function verifyLockManifest(root, manifest) {
  if (!manifest || manifest.schema_version !== 1 || !Array.isArray(manifest.locks)) {
    throw new Error('Invalid locked-hashes.json schema');
  }
  const checked = [];
  for (const lock of manifest.locks) {
    if (!lock || typeof lock.id !== 'string' || typeof lock.tag !== 'string' ||
        typeof lock.commit_sha !== 'string' || !/^[0-9a-f]{40}$/i.test(lock.commit_sha) ||
        !Array.isArray(lock.files) || lock.files.length === 0) {
      throw new Error('Invalid lock entry');
    }
    for (const file of lock.files) {
      if (!file || typeof file.path !== 'string' || typeof file.sha256 !== 'string' ||
          !/^[0-9a-f]{64}$/i.test(file.sha256)) throw new Error(`Invalid file hash in lock ${lock.id}`);
      const target = resolve(root, file.path);
      const rel = relative(resolve(root), target);
      if (!rel || rel.startsWith('..' + sep) || rel === '..' || isAbsolute(rel)) {
        throw new Error(`Unsafe locked path: ${file.path}`);
      }
      const actual = createHash('sha256').update(readFileSync(target)).digest('hex');
      if (actual !== file.sha256.toLowerCase()) {
        throw new Error(`Locked file changed: ${file.path} (expected ${file.sha256}, got ${actual})`);
      }
      checked.push(file.path);
    }
  }
  return { locks: manifest.locks.length, files: checked.length, checked };
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname)) {
  try {
    const manifest = JSON.parse(readFileSync(resolve('locked-hashes.json'), 'utf8'));
    const result = verifyLockManifest(process.cwd(), manifest);
    console.log(`Feature lock check passed: ${result.locks} locks, ${result.files} files.`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
