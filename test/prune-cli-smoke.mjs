import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { lstatSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { processIdentity } from '../dist/processes/identity.js';
import { defaultStateDir } from '../dist/workflow/runtime/paths.js';

// workflow prune refuses a bare call, previews by status and by missing cwd without changing
// anything, removes the selected runs through workflow rm, keeps a locked run in skipped and never
// lists a suspended one. With --missing-cwd --all it previews, then removes, stale project roots in
// the smoke's own XDG_STATE_HOME. Local sleeps only: no harness calls.
const repository = fileURLToPath(new URL('..', import.meta.url));
const root = mkdtempSync(join(tmpdir(), 'choir-prune-cli-'));
const stateDir = join(root, 'state');
const cliPath = join(repository, 'bin/run.js');
const dist = JSON.stringify(join(repository, 'dist/index.js'));

function command(args, cwd = root) {
  const result = spawnSync(
    process.execPath,
    [cliPath, 'workflow', ...args, '--state-dir', stateDir],
    { cwd, encoding: 'utf8', timeout: 60_000 },
  );
  assert.equal(result.error, undefined);
  return result;
}
function document(expected, args, cwd) {
  const result = command([...args, '--json'], cwd);
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
const ids = (runs) => runs.map((run) => run.runId).sort();

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
const execute = (runId, nap, cwd) =>
  document(
    nap ? 75 : 0,
    ['execute', workflow, '--run-id', runId, '--input', `{"nap":${nap}}`],
    cwd,
  );

try {
  assert.equal(execute('done', 0).status, 'completed');
  assert.equal(execute('asleep', 600_000).kind, 'workflow.run.suspended');
  const project = join(root, 'project');
  mkdirSync(project);
  assert.equal(execute('lost', 0, project).status, 'completed');
  rmSync(project, { recursive: true });
  assert.equal(execute('held', 0).status, 'completed');
  // This smoke process is alive, so the lock holds the run.
  mkdirSync(join(stateDir, 'held', 'lock'));
  writeFileSync(
    join(stateDir, 'held', 'lock', 'owner.json'),
    JSON.stringify({
      pid: process.pid,
      host: hostname(),
      token: 'smoke',
      osStartTime: processIdentity(process.pid)?.start ?? null,
    }),
  );

  const bare = document(2, ['prune']);
  assert.equal(bare.error.code, 'usage.flag', bare.error.message);

  const before = snapshot();
  const byStatus = document(0, ['prune', '--status', 'completed', '--dry-run']);
  assert.equal(byStatus.kind, 'workflow.prune.result');
  assert.equal(byStatus.dryRun, true);
  assert.deepEqual(ids(byStatus.removed), ['done', 'lost']);
  assert.deepEqual(
    byStatus.skipped.map((run) => [run.runId, run.reason, run.code]),
    [['held', 'locked', 'run.locked']],
  );
  const missing = document(0, ['prune', '--missing-cwd', '--dry-run']);
  assert.deepEqual(ids(missing.removed), ['lost']);
  const [lost] = missing.removed;
  assert.ok(lost.bytes > 0, `bytes ${String(lost.bytes)}`);
  assert.equal(missing.bytes, lost.bytes);
  assert.deepEqual(snapshot(), before);

  const removed = document(0, ['prune', '--missing-cwd']);
  assert.deepEqual(ids(removed.removed), ['lost']);
  assert.equal(removed.bytes, lost.bytes);

  const text = command(['prune', '--older-than', '0s', '--status', 'completed']);
  assert.equal(text.status, 0, text.stderr);
  assert.match(text.stdout, /^Removed 1 run \(\d+(\.\d)? (B|KiB|MiB)\); skipped 1\./u);
  assert.match(text.stdout, /Skipped held completed .* \(locked\): /u);
  assert.deepEqual(readdirSync(stateDir).sort(), ['.gitignore', 'asleep', 'held']);

  // Stale project roots: no --state-dir, so the roots live in this block's own XDG_STATE_HOME.
  const xdgHome = join(root, 'xdg');
  const environment = { ...process.env, XDG_STATE_HOME: xdgHome };
  delete environment.QUIET_CHOIR_STATE_DIR;
  const projects = join(xdgHome, 'quiet-choir');
  const xdgDocument = (args) => {
    const result = spawnSync(process.execPath, [cliPath, 'workflow', ...args, '--json'], {
      cwd: root,
      encoding: 'utf8',
      timeout: 60_000,
      env: environment,
    });
    assert.equal(result.error, undefined);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    return JSON.parse(result.stdout);
  };
  const namespace = 'gone-00000000-0000-4000-8000-000000000000';
  const deletedCwd = join(root, 'deleted-workspace');
  process.env.XDG_STATE_HOME = xdgHome;
  const registered = dirname(defaultStateDir(deletedCwd));
  mkdirSync(join(registered, 'runs'), { recursive: true });
  writeFileSync(join(registered, 'runs', '.gitignore'), '*\n');
  writeFileSync(join(registered, 'project.json'), `${JSON.stringify({ cwd: deletedCwd })}\n`);
  mkdirSync(join(registered, 'worktrees', namespace), { recursive: true });
  const bareRoot = join(projects, 'wtrepo-9c2bdb8d4801');
  mkdirSync(join(bareRoot, 'worktrees', namespace, 'nested'), { recursive: true });
  const tree = () =>
    readdirSync(projects, { recursive: true })
      .map(String)
      .sort()
      .map((name) => `${name} ${String(lstatSync(join(projects, name)).mtimeMs)}`);
  const listedBefore = xdgDocument(['list', '--all']);
  assert.ok(
    listedBefore.warnings.some((warning) => warning.startsWith(`Skipped project ${bareRoot}`)),
  );
  const treeBefore = tree();
  const rootPreview = xdgDocument(['prune', '--missing-cwd', '--all', '--dry-run']);
  const outcomes = (result) =>
    result.roots.map((entry) => [entry.root, entry.reason, entry.removed]);
  assert.deepEqual(
    outcomes(rootPreview),
    [
      [registered, 'missing-cwd', true],
      [bareRoot, 'empty', true],
    ].sort(),
  );
  assert.deepEqual(tree(), treeBefore);
  const rootsRemoved = xdgDocument(['prune', '--missing-cwd', '--all']);
  assert.deepEqual(outcomes(rootsRemoved), outcomes(rootPreview));
  assert.deepEqual(readdirSync(projects), []);
  const listedAfter = xdgDocument(['list', '--all']);
  assert.deepEqual(listedAfter.runs, []);
  assert.deepEqual(listedAfter.warnings, []);
  console.log('prune CLI smoke passed');
} finally {
  rmSync(root, { recursive: true, force: true });
}
