import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { lstatSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { processIdentity } from '../dist/processes/identity.js';

// workflow prune refuses a bare call, previews by status and by missing cwd without changing
// anything, removes the selected runs through workflow rm, keeps a locked run in skipped and never
// lists a suspended one. Local sleeps only: no harness calls.
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
  console.log('prune CLI smoke passed');
} finally {
  rmSync(root, { recursive: true, force: true });
}
