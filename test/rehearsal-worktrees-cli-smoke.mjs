// Dry-run synthesis of worktree isolation and merges (#148): the shipped worktrees pattern rehearses
// to completion from a Git repository without creating refs, worktrees or cache directories, and a
// ctx.worktree rehearsal still fails with the documented configuration error, a configuration error
// kind and no resume advice.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const project = dirname(dirname(fileURLToPath(import.meta.url)));
const root = realpathSync(mkdtempSync(join(tmpdir(), 'choir-rehearsal-worktrees-')));
const repo = join(root, 'repo');
const xdg = join(root, 'xdg');
const env = Object.fromEntries(
  Object.entries({ ...process.env, XDG_STATE_HOME: xdg }).filter(
    ([name]) => !name.toUpperCase().startsWith('GIT_'),
  ),
);

function git(...args) {
  const result = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@localhost', ...args], {
    cwd: repo,
    encoding: 'utf8',
    env,
  });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}
function execute(...args) {
  const result = spawnSync(
    process.execPath,
    [join(project, 'bin/run.js'), 'workflow', 'execute', ...args, '--dry-run', '--json'],
    { cwd: repo, encoding: 'utf8', timeout: 60_000, env },
  );
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.signal, null, result.stderr);
  return { ...result, value: JSON.parse(result.stdout) };
}

try {
  mkdirSync(repo);
  git('init', '-q');
  writeFileSync(join(repo, 'file.txt'), 'base\n');
  git('add', '--all');
  git('commit', '-qm', 'baseline');
  const head = git('rev-parse', 'HEAD').trim();
  const refs = git('for-each-ref');
  const worktrees = git('worktree', 'list', '--porcelain');

  const pattern = execute(
    join(project, 'examples/patterns/worktrees.workflow.ts'),
    '--input',
    '{"items":["a","b"]}',
    '--grant',
    'editor',
  );
  assert.equal(pattern.status, 0, pattern.stderr);
  const report = pattern.value;
  assert.equal(report.kind, 'workflow.rehearsal');
  assert.equal(report.ok, true);
  assert.equal(report.calls.length, 2, JSON.stringify(report.calls));
  for (const call of report.calls) {
    assert.ok(Array.isArray(call.plan?.argv), JSON.stringify(call));
    assert.deepEqual(call.worktree, { synthesized: true, base: head, baseSource: 'resolved' });
    assert.ok(!existsSync(call.cwd), `placeholder ${call.cwd} was created`);
  }
  assert.equal(report.merges.length, 1, JSON.stringify(report.merges));
  assert.equal(report.merges[0].synthesized, true);
  assert.equal(report.merges[0].commit, head);
  assert.equal(report.run.output.commit, head);
  assert.match(
    pattern.stderr,
    /Rehearsal: 2 calls;.*2 synthesized isolated calls; 1 synthesized merges/u,
  );
  assert.equal(git('for-each-ref'), refs);
  assert.equal(git('worktree', 'list', '--porcelain'), worktrees);
  // Neither the default worktree cache root nor any other default state exists under XDG.
  assert.ok(!existsSync(xdg), 'dry-run created default state or a worktree cache');

  writeFileSync(
    join(repo, 'handle.workflow.ts'),
    `import { defineWorkflow, z } from ${JSON.stringify(join(project, 'src/index.js'))};
export default defineWorkflow({ name: 'handle', version: '1', input: z.null(), output: z.string(),
  async run(ctx) {
    await ctx.codex.text('plan', { prompt: 'plan' });
    return (await ctx.worktree('cache')).path;
  },
});
`,
  );
  const refused = execute(join(repo, 'handle.workflow.ts'), '--input', 'null');
  assert.equal(refused.status, 1, refused.stderr);
  const failure = refused.value;
  assert.equal(failure.error.code, 'workflow.failed');
  // Refused before any attempt, so the failure is a configuration kind, never retryable (#311).
  assert.deepEqual(failure.error.details, { errorKind: 'configuration', retryable: false });
  assert.match(failure.error.message, /Dry-run does not simulate this Git worktree effect/u);
  assert.match(failure.error.message, /fixture harness in a temporary repository/u);
  assert.doesNotMatch(failure.error.message, /--resume|--accept-code-change/u);
  assert.ok(Array.isArray(failure.rehearsal?.calls), JSON.stringify(failure));
  assert.equal(failure.rehearsal.calls.length, 1);
  assert.match(refused.stderr, /Rehearsal: 1 calls;/u);
  assert.equal(git('for-each-ref'), refs);
  assert.ok(!existsSync(xdg), 'failed dry-run created default state');
} finally {
  rmSync(root, { recursive: true, force: true });
}
