import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// workflow unlock --worktree-admin PATH clears a repository's abandoned worktree administration
// lock and refuses a foreign holder without --force-remote (worktree.locked, exit 3); plain
// workflow inspect shows the lock of a run's repository (#243). No workflow runs here.
const repository = fileURLToPath(new URL('..', import.meta.url));
const root = realpathSync(mkdtempSync(join(tmpdir(), 'choir-admin-cli-')));
const cliPath = join(repository, 'bin/run.js');
const launcher = [process.execPath, realpathSync(cliPath)];
const repo = join(root, 'repo');
const stateDir = join(root, 'state');

function command(...args) {
  const result = spawnSync(process.execPath, [cliPath, 'workflow', ...args], {
    cwd: root,
    encoding: 'utf8',
    timeout: 60_000,
  });
  assert.equal(result.error, undefined);
  return result;
}
function document(expected, ...args) {
  const result = command(...args, '--json');
  assert.equal(result.status, expected, result.stderr || result.stdout);
  return JSON.parse(result.stdout);
}
function usage(...args) {
  const failure = document(2, ...args);
  assert.equal(failure.error.code, 'usage.flag', failure.error.message);
  return failure.error.message;
}

try {
  mkdirSync(repo);
  mkdirSync(stateDir);
  execFileSync('git', ['-C', repo, 'init', '--quiet']);
  const common = realpathSync(join(repo, '.git'));
  const lockPath = join(common, 'quiet-choir', 'worktree-admin.lock');
  const plant = (owner) => {
    mkdirSync(lockPath, { recursive: true });
    writeFileSync(
      join(lockPath, 'owner.json'),
      JSON.stringify({ host: hostname(), token: 'tok', osStartTime: null, ...owner }),
    );
  };
  const dead = spawnSync(process.execPath, ['-e', '']).pid;

  // A free lock: exit 0, lock null, and plain text.
  assert.deepEqual(document(0, 'unlock', '--worktree-admin', repo), {
    kind: 'workflow.unlock.worktree-admin.result',
    ok: true,
    forceRemote: false,
    commonGitDir: common,
    lockPath,
    lock: null,
  });
  const free = command('unlock', '--worktree-admin', repo);
  assert.equal(free.status, 0, free.stderr);
  assert.equal(free.stdout.trim(), `Worktree administration lock ${lockPath} is not held.`);

  // A dead holder is removed.
  plant({ pid: dead });
  const removed = command('unlock', '--worktree-admin', repo);
  assert.equal(removed.status, 0, removed.stderr);
  assert.equal(
    removed.stdout.trim(),
    `Removed worktree administration lock ${lockPath} (owner PID ${String(dead)} on ${hostname()}, dead).`,
  );
  assert.equal(existsSync(lockPath), false);

  // Plain inspect of a run whose ledger names the repository shows a held lock and its unlock.
  const time = '2026-01-01T00:00:00.000Z';
  writeFileSync(
    join(stateDir, 'run.json'),
    JSON.stringify({
      formatVersion: 1,
      id: 'run',
      workflow: { name: 'example', version: '1', fingerprint: null },
      status: 'completed',
      cwd: root,
      input: null,
      output: null,
      error: null,
      steps: {},
      createdAt: time,
      updatedAt: time,
      worktrees: {
        namespace: '00000000-0000-4000-8000-000000000000',
        repo,
        root: join(root, 'caches'),
        caches: {},
        handles: {},
        refs: {},
      },
    }),
  );
  plant({ pid: 4242, host: 'elsewhere.invalid' });
  const inspected = document(0, 'inspect', 'run', '--state-dir', stateDir);
  assert.equal(inspected.worktreeAdminLock.path, lockPath);
  assert.equal(inspected.worktreeAdminLock.owner.token, 'tok');
  assert.equal(inspected.worktreeAdminLock.owner.state, 'remote');
  const summary = document(0, 'inspect', 'run', '--state-dir', stateDir, '--summary');
  assert.equal(summary.worktreeAdminLock, undefined);
  const inspectText = command('inspect', 'run', '--state-dir', stateDir);
  assert.equal(inspectText.status, 0, inspectText.stderr);
  assert.match(
    inspectText.stdout,
    new RegExp(`Worktree admin lock .*: owner pid 4242 \\(remote\\) on elsewhere\\.invalid`, 'u'),
  );
  assert.match(
    inspectText.stdout,
    /Unlock: .* unlock --worktree-admin .* --force-remote \(only if/u,
  );

  // A foreign holder is refused without --force-remote; next carries this checkout's launcher.
  const refused = document(3, 'unlock', '--worktree-admin', common);
  assert.equal(refused.error.code, 'worktree.locked');
  assert.equal(refused.runId, null);
  const unlock = [...launcher, 'workflow', 'unlock', '--worktree-admin', common, '--force-remote'];
  assert.deepEqual(refused.error.details.next[0].argv, unlock);
  assert.deepEqual(refused.next[0].argv, unlock);
  assert.equal(existsSync(join(lockPath, 'owner.json')), true);
  const forced = document(0, 'unlock', '--worktree-admin', repo, '--force-remote');
  assert.equal(forced.lock.action, 'removed');
  assert.equal(existsSync(lockPath), false);

  // Argument combinations and a path outside any repository are usage errors.
  assert.match(usage('unlock', 'run', '--worktree-admin', repo), /either RUN or --worktree-admin/u);
  assert.match(usage('unlock'), /RUN whose lock to clear, or --worktree-admin PATH/u);
  assert.match(
    usage('unlock', '--worktree-admin', repo, '--state-dir', stateDir),
    /--state-dir selects runs/u,
  );
  assert.match(usage('unlock', '--worktree-admin', stateDir), /is not inside a Git repository/u);
  console.log(
    'Worktree admin lock CLI: inspect shows it, unlock clears a dead holder, refuses a foreign one without --force-remote, and rejects bad arguments.',
  );
} finally {
  rmSync(root, { recursive: true, force: true });
}
