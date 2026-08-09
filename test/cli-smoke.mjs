import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Config } from '@oclif/core';

const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const expectedCommands = [
  'configuration:doctor',
  'configuration:get',
  'configuration:set',
  'info:version',
  'workflow:execute',
  'workflow:typecheck',
  'workflow:validate',
];

const config = await Config.load({ root: projectRoot });
assert.deepEqual([...config.commandIDs].sort(), expectedCommands);

const help = spawnSync(process.execPath, ['./bin/run.js', '--help'], {
  cwd: projectRoot,
  encoding: 'utf8',
});
assert.equal(help.status, 0, help.stderr);
assert.match(help.stdout, /quiet-choir\/0\.0\.0/);
assert.match(help.stdout, /workflow\s+Execute and inspect workflows/);

const stub = spawnSync(process.execPath, ['./bin/run.js', 'workflow', 'execute'], {
  cwd: projectRoot,
  encoding: 'utf8',
});
assert.equal(stub.status, 2, stub.stderr);
assert.match(stub.stdout, /workflow execute is not implemented yet\./);

const fixtureRoot = mkdtempSync(join(tmpdir(), 'quiet-choir-smoke-'));
try {
  const validEntrypoint = join(fixtureRoot, 'valid.ts');
  const invalidEntrypoint = join(fixtureRoot, 'invalid.ts');
  writeFileSync(validEntrypoint, 'export const value: number = 1;\n', 'utf8');
  writeFileSync(invalidEntrypoint, "export const value: number = 'wrong';\n", 'utf8');

  const valid = spawnSync(
    process.execPath,
    ['./bin/run.js', 'workflow', 'typecheck', validEntrypoint],
    { cwd: projectRoot, encoding: 'utf8' },
  );
  assert.equal(valid.status, 0, valid.stderr);
  assert.match(valid.stdout, /Type check passed/);

  const invalid = spawnSync(
    process.execPath,
    ['./bin/run.js', 'workflow', 'typecheck', invalidEntrypoint],
    { cwd: projectRoot, encoding: 'utf8' },
  );
  assert.equal(invalid.status, 1, invalid.stdout);
  assert.match(invalid.stderr, /error TS2322/);
} finally {
  rmSync(fixtureRoot, { force: true, recursive: true });
}
