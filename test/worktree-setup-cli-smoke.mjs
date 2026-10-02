// Definition-level worktree policy under the CLI: setup runs for a per-call agent attempt and for a
// handle (create and prepare), setup's node_modules link stays out of capture and out of the merged
// branch, --worktree-root/--worktree-keep reach the run and stick across resume, an agent symlink
// pointing outside the repository warns, and invalid flag values are usage errors. The agent is
// the repository's fake claude behind a wrapper that edits its cwd; nothing is paid for.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const project = fileURLToPath(new URL('..', import.meta.url));
const root = realpathSync(mkdtempSync(join(tmpdir(), 'choir-worktree-setup-')));
const repo = join(root, 'repo');
const stateDir = join(root, 'state');
const caches = join(root, 'caches');
const deps = join(root, 'deps');
const marker = join(root, 'setup.log');
const workflow = join(root, 'setup.mts');
const agent = join(root, 'agent.mjs');
const harnessConfig = JSON.stringify({ claudeBinary: agent });

function git(...args) {
  const result = spawnSync(
    'git',
    ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgSign=false', ...args],
    { cwd: repo, encoding: 'utf8', timeout: 30000 },
  );
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}
function cli(status, ...args) {
  const result = spawnSync(
    process.execPath,
    [join(project, 'bin/run.js'), 'workflow', ...args, '--state-dir', stateDir, '--json'],
    {
      cwd: repo,
      encoding: 'utf8',
      timeout: 60000,
      env: {
        ...process.env,
        XDG_STATE_HOME: join(root, 'xdg'),
        QUIET_CHOIR_FAKE_SCENARIO: 'claude-text-success',
      },
    },
  );
  assert.equal(result.error, undefined);
  assert.equal(result.status, status, result.stderr || result.stdout);
  return JSON.parse(result.stdout);
}

try {
  mkdirSync(repo);
  mkdirSync(deps);
  git('init', '-q');
  writeFileSync(join(repo, 'file.txt'), 'base\n');
  writeFileSync(join(repo, '.gitignore'), 'node_modules/\n');
  git('add', '.');
  git('-c', 'user.name=fixture', '-c', 'user.email=fixture@localhost', 'commit', '-qm', 'base');
  const base = git('rev-parse', 'HEAD');
  // The "agent": edit the isolated cwd, link outside the repository, then replay a captured reply.
  writeFileSync(
    agent,
    `#!/usr/bin/env node
import { symlinkSync, writeFileSync } from 'node:fs';
if (!process.argv.includes('--version')) {
  writeFileSync('agent.txt', 'agent\\n');
  symlinkSync('/tmp/elsewhere', 'outside-link');
}
await import(${JSON.stringify(join(project, 'test/bin/fake-claude.mjs'))});
`,
  );
  chmodSync(agent, 0o755);
  writeFileSync(
    workflow,
    `import { appendFileSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { defineWorkflow, z } from ${JSON.stringify(join(project, 'dist/index.js'))};
export default defineWorkflow({ name: 'worktree-setup', version: '1', input: z.object({}), output: z.string(),
  worktrees: { setup: ({ path, stepId }) => {
    appendFileSync(${JSON.stringify(marker)}, stepId + ' ' + path + '\\n');
    symlinkSync(${JSON.stringify(deps)}, join(path, 'node_modules'));
  } },
  async run(ctx) {
    const call = await ctx.claude.text('agent', { prompt: 'edit', isolation: 'worktree' });
    if (!call.worktree) throw new Error('missing change');
    const tree = await ctx.worktree('cache');
    await ctx.exec('edit', [${JSON.stringify(process.execPath)}, '-e', "require('node:fs').writeFileSync('handle.txt', 'handle')"], { worktree: tree });
    await ctx.step('gate', { input: null, schema: z.null(), run: ({ attempt }) => { if (attempt === 1) throw new Error('gate'); return null; } });
    return (await ctx.merge('integrate', [call.worktree, tree], { target: { branch: 'ticket-42' }, strategy: 'squash' })).commit;
  } });
`,
  );

  // Invalid values are usage errors before any run work.
  for (const flags of [
    ['--worktree-keep', 'bogus'],
    ['--worktree-root', ''],
  ]) {
    const refused = cli(2, 'execute', workflow, '--run-id', 'refused', ...flags);
    assert.equal(refused.error.code, 'usage.flag', JSON.stringify(refused));
  }
  assert.equal(existsSync(join(stateDir, 'refused')), false);
  // workflow start shares the execute flag table, so it forwards both flags to its runner.
  const startHelp = spawnSync(
    process.execPath,
    [join(project, 'bin/run.js'), 'workflow', 'start', '--help'],
    {
      encoding: 'utf8',
      timeout: 30000,
    },
  );
  assert.match(startHelp.stdout, /--worktree-keep/u);
  assert.match(startHelp.stdout, /--worktree-root/u);

  const failed = cli(
    1,
    'execute',
    workflow,
    '--run-id',
    'setup',
    // Relative to the invocation's cwd (the repository).
    '--worktree-root',
    '../caches',
    '--worktree-keep',
    'all',
    '--harness-config',
    harnessConfig,
    '--full',
  );
  const steps = failed.run.steps;
  assert.equal(steps.gate.status, 'failed');
  assert.deepEqual(
    steps.agent.worktree.files.map(({ path }) => path),
    ['agent.txt', 'outside-link'],
  );
  assert.deepEqual(
    steps.edit.worktree.files.map(({ path }) => path),
    ['handle.txt'],
  );
  // Setup ran for the per-call attempt, and for the handle at creation and before the exec.
  const setups = readFileSync(marker, 'utf8').trim().split('\n');
  assert.deepEqual(setups, [
    `agent ${steps.agent.worktree.path}`,
    `cache ${steps.edit.worktree.path}`,
    `edit ${steps.edit.worktree.path}`,
  ]);
  // The caches live under --worktree-root and stay with --worktree-keep all.
  assert.equal(failed.run.worktrees.root, caches);
  for (const cache of Object.values(failed.run.worktrees.caches)) {
    assert(cache.path.startsWith(`${caches}/`), cache.path);
    assert.deepEqual(cache.setupPaths, ['node_modules']);
  }
  assert.deepEqual(failed.run.launch.policy.worktrees, { keep: 'all', root: caches });

  // resume with --worktree-keep none: the root is inherited and the caches go after completion.
  const resumed = cli(
    0,
    'resume',
    'setup',
    '--worktree-keep',
    'none',
    '--harness-config',
    harnessConfig,
  );
  assert.equal(resumed.status, 'completed');
  assert.equal(git('rev-parse', 'refs/heads/ticket-42'), resumed.output);
  assert.deepEqual(git('diff', '--name-only', base, 'ticket-42').split('\n'), [
    'agent.txt',
    'handle.txt',
    'outside-link',
  ]);
  assert(
    resumed.warnings.some((warning) =>
      warning.startsWith('Step agent captured symlink outside-link -> /tmp/elsewhere'),
    ),
    JSON.stringify(resumed.warnings),
  );
  for (const path of [steps.agent.worktree.path, steps.edit.worktree.path])
    assert.equal(existsSync(path), false, path);
  console.log('Definition-level worktree setup, capture exclusion and worktree flags passed.');
} finally {
  rmSync(root, { recursive: true, force: true });
}
