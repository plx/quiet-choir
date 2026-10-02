import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// The durability lint through the built CLI: validate fails with exit 4 and rule-coded
// diagnostics, succeeds with an empty array, and execute only warns. Local steps only.
const project = fileURLToPath(new URL('..', import.meta.url));
const root = mkdtempSync(join(tmpdir(), 'choir-durability-cli-'));
const stateDir = join(root, 'state');
const hazard = 'test/fixtures/durability-lint/m06-date-now.workflow.ts';
const clean = 'test/fixtures/durability-lint/m11b-named-map.workflow.ts';

function command(...args) {
  const result = spawnSync(process.execPath, [join(project, 'bin/run.js'), 'workflow', ...args], {
    cwd: project,
    encoding: 'utf8',
    timeout: 60_000,
  });
  assert.equal(result.error, undefined);
  return result;
}

try {
  const failed = command('validate', hazard);
  assert.equal(failed.status, 4, failed.stderr || failed.stdout);
  assert.match(failed.stderr, /m06-date-now\.workflow\.ts:10:21 - error QC002: Date\.now\(\)/);

  const document = command('validate', hazard, '--json');
  assert.equal(document.status, 4, document.stderr || document.stdout);
  const failure = JSON.parse(document.stdout);
  assert.equal(failure.error.code, 'load.typecheck');
  assert.match(failure.error.message, /^Workflow durability lint failed: 1 finding\(s\)/);
  assert.deepEqual(Object.keys(failure.diagnostics[0]).sort(), [
    'category',
    'column',
    'file',
    'line',
    'message',
    'rule',
  ]);
  assert.deepEqual(
    { ...failure.diagnostics[0], message: undefined },
    {
      rule: 'QC002',
      category: 'error',
      file: join(project, hazard),
      line: 10,
      column: 21,
      message: undefined,
    },
  );

  const validated = command('validate', clean, '--json');
  assert.equal(validated.status, 0, validated.stderr || validated.stdout);
  assert.deepEqual(JSON.parse(validated.stdout).diagnostics, []);

  const executed = command(
    'execute',
    hazard,
    '--run-id',
    'durability-warning',
    '--input',
    '{}',
    '--state-dir',
    stateDir,
  );
  assert.equal(executed.status, 0, executed.stderr || executed.stdout);
  assert.match(executed.stderr, /m06-date-now\.workflow\.ts:10:21 - warning QC002: Date\.now\(\)/);
  console.log('durability lint CLI smoke passed');
} finally {
  rmSync(root, { recursive: true, force: true });
}
