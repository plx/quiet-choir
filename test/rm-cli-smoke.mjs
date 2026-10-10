import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// workflow rm removes a finished run, refuses a suspended one without --force, and its dry run
// changes nothing; workflow list reports each run's bytes. A run whose run.json is damaged is
// refused with the --unreadable command, which removes it. What a removal of a flat run left after
// its commit point (a lock-only directory and a backup) is finished, also in the legacy
// in-workspace container without --state-dir. Local sleeps only: no harness calls.
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
  assert.equal(preview.interrupted, false);
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
  assert.equal(swept.interrupted, false);
  assert.equal(swept.warnings.length, 1);
  assert.deepEqual(readdirSync(stateDir), ['.gitignore']);

  // An empty lock directory left by a crashed flat-run removal, plus its backup (ADR 0061).
  mkdirSync(join(stateDir, 'ghost', 'lock'), { recursive: true });
  writeFileSync(join(stateDir, 'ghost.json.v1'), '{}');
  const ghostBefore = snapshot();
  const unfinished = document(0, 'rm', 'ghost', '--dry-run');
  assert.equal(unfinished.interrupted, true);
  assert.equal(unfinished.verdict.code, 'run.locked', JSON.stringify(unfinished.verdict));
  assert.deepEqual(snapshot(), ghostBefore);
  rmSync(join(stateDir, 'ghost', 'lock'), { recursive: true });
  const ready = document(0, 'rm', 'ghost', '--dry-run');
  assert.equal(ready.verdict, 'remove');
  assert.deepEqual(ready.paths, [join(stateDir, 'ghost'), join(stateDir, 'ghost.json.v1')]);
  const finished = command(['rm', 'ghost']);
  assert.equal(finished.status, 0, finished.stderr);
  assert.match(finished.stdout, /^Finished the interrupted removal of ghost \(/u);
  assert.deepEqual(readdirSync(stateDir), ['.gitignore']);

  // The same leftover in an unmigrated project's .quiet-choir/runs, with no --state-dir: legacy
  // discovery has no record to key on, so rm looks for the leftover there itself.
  const project = join(realpathSync(root), 'project');
  const legacy = join(project, '.quiet-choir', 'runs');
  mkdirSync(join(legacy, 'ghost'), { recursive: true });
  writeFileSync(join(legacy, 'ghost.json.v1'), '{}');
  const env = { ...process.env, XDG_STATE_HOME: join(root, 'xdg') };
  delete env.QUIET_CHOIR_STATE_DIR;
  const inProject = (args) =>
    spawnSync(process.execPath, [cliPath, 'workflow', 'rm', 'ghost', ...args], {
      cwd: project,
      env,
      encoding: 'utf8',
      timeout: 60_000,
    });
  const legacyPreview = inProject(['--dry-run', '--json']);
  assert.equal(legacyPreview.status, 0, legacyPreview.stderr || legacyPreview.stdout);
  assert.match(legacyPreview.stderr, /Warning: legacy state directory /u);
  const legacyPlan = JSON.parse(legacyPreview.stdout);
  assert.equal(legacyPlan.interrupted, true);
  assert.equal(legacyPlan.verdict, 'remove');
  assert.deepEqual(legacyPlan.paths, [join(legacy, 'ghost'), join(legacy, 'ghost.json.v1')]);
  const legacyFinished = inProject([]);
  assert.equal(legacyFinished.status, 0, legacyFinished.stderr);
  assert.match(legacyFinished.stdout, /^Finished the interrupted removal of ghost \(/u);
  assert.deepEqual(readdirSync(legacy), ['.gitignore']);
  console.log('rm CLI smoke passed');
} finally {
  rmSync(root, { recursive: true, force: true });
}
