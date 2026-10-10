import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { lstatSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// workflow rm removes a finished run, refuses a suspended one without --force, and its dry run
// changes nothing; workflow list reports each run's bytes. A run whose run.json is damaged is
// refused with the --unreadable command, which removes it. Local sleeps only: no harness calls.
const repository = fileURLToPath(new URL('..', import.meta.url));
const root = mkdtempSync(join(tmpdir(), 'choir-rm-cli-'));
const stateDir = join(root, 'state');
const cliPath = join(repository, 'bin/run.js');
const dist = JSON.stringify(join(repository, 'dist/index.js'));

function command(args) {
  const result = spawnSync(
    process.execPath,
    [cliPath, 'workflow', ...args, '--state-dir', stateDir],
    { cwd: root, encoding: 'utf8', timeout: 60_000 },
  );
  assert.equal(result.error, undefined);
  return result;
}
function document(expected, ...args) {
  const result = command([...args, '--json']);
  assert.equal(result.status, expected, result.stderr || result.stdout);
  return JSON.parse(result.stdout);
}
/** Every path below the state directory with its size and modification time. */
function snapshot() {
  return readdirSync(stateDir, { recursive: true })
    .map(String)
    .sort()
    .map((name) => {
      const stat = lstatSync(join(stateDir, name));
      return `${name} ${String(stat.size)} ${String(stat.mtimeMs)}`;
    });
}

const workflow = join(root, 'nap.mts');
writeFileSync(
  workflow,
  `import { defineWorkflow, z } from ${dist};
export default defineWorkflow({ name: 'nap', version: '1', input: z.object({ nap: z.number() }),
  output: z.string(),
  async run(ctx, input) {
    await ctx.sleep('nap', input.nap);
    return 'done';
  } });`,
);

try {
  const done = document(0, 'execute', workflow, '--run-id', 'done', '--input', '{"nap":0}');
  assert.equal(done.status, 'completed');

  const listed = document(0, 'list');
  const [row] = listed.runs;
  assert.equal(row.id, 'done');
  assert.equal(typeof row.bytes, 'number');
  assert.ok(row.bytes > 0, `bytes ${String(row.bytes)}`);

  const before = snapshot();
  const preview = document(0, 'rm', 'done', '--dry-run');
  assert.equal(preview.kind, 'workflow.rm.result');
  assert.equal(preview.verdict, 'remove');
  assert.equal(preview.removed, false);
  assert.equal(preview.bytes, row.bytes);
  assert.deepEqual(preview.paths, [join(stateDir, 'done')]);
  assert.deepEqual(snapshot(), before);

  const suspended = document(
    75,
    'execute',
    workflow,
    '--run-id',
    'asleep',
    '--input',
    '{"nap":600000}',
  );
  assert.equal(suspended.kind, 'workflow.run.suspended');
  const active = document(3, 'rm', 'asleep');
  assert.equal(active.error.code, 'run.active', active.error.message);
  assert.equal(active.exitCode, 3);
  const forced = document(0, 'rm', 'asleep', '--force');
  assert.equal(forced.removed, true);

  const text = command(['rm', 'done']);
  assert.equal(text.status, 0, text.stderr);
  assert.match(text.stdout, /^Removed done \(\d+(\.\d)? (B|KiB|MiB)\), 0 worktree caches/u);
  assert.deepEqual(readdirSync(stateDir), ['.gitignore']);
  assert.deepEqual(document(0, 'list').runs, []);
  assert.equal(document(3, 'inspect', 'done').error.code, 'run.not_found');

  const broken = document(0, 'execute', workflow, '--run-id', 'broken', '--input', '{"nap":0}');
  assert.equal(broken.status, 'completed');
  writeFileSync(join(stateDir, 'broken', 'run.json'), 'not json');
  const damaged = document(3, 'rm', 'broken');
  assert.equal(damaged.error.code, 'run.unreadable', damaged.error.message);
  assert.equal(damaged.exitCode, 3);
  assert.equal(damaged.next.length, 1);
  const [hint] = damaged.next;
  assert.deepEqual(hint.argv.slice(-6), [
    'workflow',
    'rm',
    'broken',
    '--state-dir',
    damaged.error.details.stateDir,
    '--unreadable',
  ]);
  assert.match(damaged.error.message, /--unreadable/u);
  assert.deepEqual(damaged.error.details.next, damaged.next);
  const damagedBefore = snapshot();
  const plan = document(0, 'rm', 'broken', '--unreadable', '--dry-run');
  assert.equal(plan.unreadable, true);
  assert.equal(plan.verdict, 'remove');
  assert.equal(plan.removed, false);
  assert.deepEqual(plan.paths, [join(stateDir, 'broken')]);
  assert.deepEqual(snapshot(), damagedBefore);
  const swept = document(0, 'rm', 'broken', '--unreadable');
  assert.equal(swept.removed, true);
  assert.equal(swept.unreadable, true);
  assert.equal(swept.launchOnly, false);
  assert.equal(swept.warnings.length, 1);
  assert.deepEqual(readdirSync(stateDir), ['.gitignore']);
  console.log('rm CLI smoke passed');
} finally {
  rmSync(root, { recursive: true, force: true });
}
