import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const files = readdirSync('tests').filter(name => name.endsWith('.test.mjs'))
  .sort().map(name => 'tests/' + name);
if (files.length === 0) throw new Error('pms_test_files_missing');

const result = spawnSync(process.execPath, ['--test', '--test-reporter=tap', ...files], {
  encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe']
});
const output = (result.stdout || '') + (result.stderr || '');
process.stdout.write(output);

const count = Number(output.match(/^1\.\.(\d+)$/m)?.[1] || 0);
const failed = Number(output.match(/^# fail (\d+)$/m)?.[1] ?? -1);
const skipped = Number(output.match(/^# skipped (\d+)$/m)?.[1] ?? -1);
const passed = Number(output.match(/^# pass (\d+)$/m)?.[1] ?? -1);
const minimumExpected = 500;

if (result.status !== 0 || count < minimumExpected || failed !== 0 ||
    skipped !== 0 || passed !== count) {
  process.stderr.write(
    '\nPMS_TEST_GATE_FAILED: ' +
    JSON.stringify({ count, minimumExpected, passed, failed, skipped, exitCode: result.status }) +
    '\n'
  );
  process.exit(1);
}
process.stdout.write(
  '\nPMS_TEST_GATE_PASSED: ' + count +
  ' tests; zero failures; zero skips.\n'
);
