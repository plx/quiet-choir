// The durable steps of the merge-down package (packages/merge-down.quiet-choir/lib, #589) run for
// real against a scratch Git repository.
import { execFileSync } from 'node:child_process';
import {
  appendFile,
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  defineWorkflow,
  NodeProcessRunner,
  runWorkflow,
  z,
  type WorkflowContext,
} from '../src/index.js';

// The package imports `quiet-choir`, which resolves to dist/, and npm run check typechecks and
// tests before it builds. So the import maps to src/ here, and the modules load by a computed
// specifier the root typecheck does not follow; the package's own typecheck covers them.
vi.mock('quiet-choir', () => import('../src/index.js'));
vi.mock('quiet-choir/github', () => import('../src/integrations/github.js'));
const lib = async <T>(name: string): Promise<T> => {
  const url = new URL(`../packages/merge-down.quiet-choir/lib/${name}.ts`, import.meta.url);
  return (await import(url.href)) as T;
};
const { runCheck } = await lib<{
  runCheck: (
    ctx: WorkflowContext,
    id: string,
    input: { workdir: string; pr: number; dir: string; label: string; command: string },
  ) => Promise<unknown>;
}>('checks');
const { ownedAgent } = await lib<{
  ownedAgent: <T>(
    ctx: WorkflowContext,
    id: string,
    input: { workdir: string; pr: number; dir: string },
    attempt: () => Promise<T>,
  ) => Promise<{ value: T } | { refused: string }>;
}>('git');
const { landMerge } = await lib<{
  landMerge: (
    ctx: WorkflowContext,
    id: string,
    input: {
      repo: string;
      pr: number;
      head: string;
      base: string;
      viewer: string;
      requiredChecks: readonly string[];
      method?: 'merge' | 'rebase';
      ignoreCi?: true;
    },
  ) => Promise<unknown>;
}>('land');
const { localCodexReview, REVIEW_SCRIPT } = await lib<{
  REVIEW_SCRIPT: string;
  localCodexReview: (
    ctx: WorkflowContext,
    input: {
      label: string;
      paths: { root: string; workdir: string; stateDir: string; dir: string };
      base: string;
      sha: string;
      model: string;
      effort: string | null;
    },
  ) => Promise<unknown>;
}>('codex');

let real: string;
beforeEach(async () => {
  real = await realpath(await mkdtemp(join(tmpdir(), 'choir-merge-down-steps-')));
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(real, { recursive: true, force: true });
});

const definition = (run: (ctx: WorkflowContext) => Promise<unknown>) =>
  defineWorkflow({
    name: 'merge-down-steps',
    version: '1',
    input: z.null(),
    output: z.unknown(),
    run,
  });
const setup = (resume = false) => ({
  cwd: real,
  stateDir: join(real, 'runs'),
  runId: 'test',
  input: null,
  processRunner: new NodeProcessRunner(),
  ...(resume ? { resume: true } : {}),
});

/** A repository with one commit on `branch` at `dir`; returns its HEAD. */
async function repository(dir: string, branch = 'main'): Promise<string> {
  await mkdir(dir, { recursive: true });
  const git = (...args: string[]) =>
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], {
      cwd: dir,
      encoding: 'utf8',
    }).trim();
  git('init', '-q', '-b', branch);
  await writeFile(join(dir, 'README.md'), 'hello\n');
  git('add', '.');
  git('commit', '-q', '-m', 'init');
  return git('rev-parse', 'HEAD');
}

describe('runCheck', () => {
  // The local branch of PR 1, which its run checks out in the worktree.
  const own = 'merge-down/package/pr-1';

  it('logs every part of a compound command, including one with a trailing comment', async () => {
    const workdir = join(real, 'worktree');
    const dir = join(real, 'state');
    await repository(workdir, own);
    const run = await runWorkflow(
      definition((ctx) =>
        runCheck(ctx, 'check', {
          workdir,
          pr: 1,
          dir,
          label: 'check-0',
          command: 'echo first part failed; false && echo second part # trailing comment',
        }),
      ),
      setup(),
    );
    expect(run.output).toMatchObject({ passed: false, exitCode: 1, error: null });
    expect(await readFile(join(dir, 'check-0.log'), 'utf8')).toBe('first part failed\n');
    expect(await readFile(join(dir, 'check-0.excerpt.txt'), 'utf8')).toBe('first part failed\n');
  });

  it('fails a suite that leaves the worktree dirty, listing the changes before the log tail', async () => {
    const workdir = join(real, 'worktree');
    const dir = join(real, 'state');
    const head = await repository(workdir, own);
    const run = await runWorkflow(
      definition((ctx) =>
        runCheck(ctx, 'check', {
          workdir,
          pr: 1,
          dir,
          label: 'check-0',
          command: 'echo suite output; echo edited >> README.md',
        }),
      ),
      setup(),
    );
    expect(run.output).toMatchObject({
      passed: false,
      head,
      failedStep: 'dirty worktree',
      exitCode: 0,
      error: null,
    });
    expect(await readFile(join(dir, 'check-0.log'), 'utf8')).toBe('suite output\n');
    const excerpt = await readFile(join(dir, 'check-0.excerpt.txt'), 'utf8');
    expect(excerpt).toContain(' M README.md');
    expect(excerpt.indexOf(' M README.md')).toBeLessThan(excerpt.indexOf('suite output'));
  });

  it('refuses, without running the suite, a worktree another PR’s run checked out', async () => {
    const workdir = join(real, 'worktree');
    const dir = join(real, 'state');
    const head = await repository(workdir, 'merge-down/package/pr-2');
    const ran = join(real, 'ran');
    const run = await runWorkflow(
      definition((ctx) =>
        runCheck(ctx, 'check', {
          workdir,
          pr: 1,
          dir,
          label: 'check-0',
          command: `echo ran > '${ran}'`,
        }),
      ),
      setup(),
    );
    expect(run.output).toMatchObject({
      passed: false,
      head,
      failedStep: 'foreign worktree',
      error:
        'worktree belongs to another run (on merge-down/package/pr-2); re-run this PR from the start',
    });
    await expect(readFile(ran, 'utf8')).rejects.toThrow();
  });
});

describe('ownedAgent', () => {
  const own = 'merge-down/package/pr-1';
  const git = (dir: string, ...args: string[]) =>
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], {
      cwd: dir,
      encoding: 'utf8',
      stdio: 'pipe',
    }).trim();

  /** A workflow whose agent (a step that logs each live attempt to `calls`) edits `workdir`. */
  const agentRun = (workdir: string, calls: string, crash: { agent: boolean; after: boolean }) =>
    definition(async (ctx) => {
      const owned = await ownedAgent(
        ctx,
        'fix/1/implement',
        { workdir, pr: 1, dir: join(real, 'state') },
        () =>
          ctx.step('fix/1/implement', {
            input: null,
            schema: z.string(),
            run: async () => {
              await appendFile(calls, 'run\n');
              if (crash.agent) throw new Error('interrupted during the agent');
              return 'fixed';
            },
          }),
      );
      if (crash.after) throw new Error('interrupted after the agent');
      return owned;
    });

  it('does not resume an unfinished agent in a worktree another PR’s run checked out', async () => {
    const workdir = join(real, 'worktree');
    const calls = join(real, 'calls');
    await repository(workdir, own);
    const crash = { agent: true, after: false };
    const workflow = agentRun(workdir, calls, crash);
    // The ownership check passed and the agent started, then the run was interrupted.
    await expect(runWorkflow(workflow, setup())).rejects.toThrow('interrupted during the agent');
    expect(await readFile(calls, 'utf8')).toBe('run\n');
    git(workdir, 'checkout', '-q', '-b', 'merge-down/package/pr-2');
    crash.agent = false;
    const resumed = await runWorkflow(workflow, setup(true));
    expect(resumed.output).toEqual({
      refused:
        'worktree belongs to another run (on merge-down/package/pr-2); re-run this PR from the start',
    });
    expect(await readFile(calls, 'utf8')).toBe('run\n');
  });

  it('replays a finished agent after the worktree changed hands', async () => {
    const workdir = join(real, 'worktree');
    const calls = join(real, 'calls');
    await repository(workdir, own);
    const crash = { agent: false, after: true };
    const workflow = agentRun(workdir, calls, crash);
    await expect(runWorkflow(workflow, setup())).rejects.toThrow('interrupted after the agent');
    // As the run's own cleanup leaves it after the merge.
    git(workdir, 'checkout', '-q', '--detach');
    crash.after = false;
    const resumed = await runWorkflow(workflow, setup(true));
    expect(resumed.output).toEqual({ value: 'fixed' });
    expect(await readFile(calls, 'utf8')).toBe('run\n');
  });

  it('owns a worktree whose rebase of this run’s branch stopped on a conflict', async () => {
    const workdir = join(real, 'worktree');
    await repository(workdir, own);
    git(workdir, 'branch', 'base');
    await writeFile(join(workdir, 'README.md'), 'ours\n');
    git(workdir, 'commit', '-q', '-am', 'ours');
    git(workdir, 'checkout', '-q', 'base');
    await writeFile(join(workdir, 'README.md'), 'theirs\n');
    git(workdir, 'commit', '-q', '-am', 'theirs');
    git(workdir, 'checkout', '-q', own);
    expect(() => git(workdir, 'rebase', 'base')).toThrow();
    const run = await runWorkflow(
      definition(async (ctx) => {
        const attempt = (pr: number) =>
          ownedAgent(ctx, `resolve-${String(pr)}`, { workdir, pr, dir: join(real, 'state') }, () =>
            Promise.resolve('resolved'),
          );
        return [await attempt(1), await attempt(2)];
      }),
      setup(),
    );
    expect(run.output).toEqual([
      { value: 'resolved' },
      {
        refused: `worktree belongs to another run (on ${own}); re-run this PR from the start`,
      },
    ]);
  });
});

describe('landMerge', () => {
  const head = '0a1b2c3d4e5f60718293a4b5c6d7e8f901234567';
  const input = {
    repo: 'acme/widgets',
    pr: 42,
    head,
    base: 'main',
    viewer: 'merge-bot',
    requiredChecks: [] as readonly string[],
  };

  /** A fake `gh` that answers the landing reads and counts merge PUTs in `<real>/puts`. */
  async function fakeGh(rollup: {
    oid: string;
    checks: readonly string[];
    failed?: readonly string[];
  }): Promise<string> {
    const bin = join(real, 'bin');
    await mkdir(bin);
    const pull = (merged: boolean) =>
      JSON.stringify({
        state: merged ? 'closed' : 'open',
        merged,
        merge_commit_sha: merged ? 'mmm' : null,
        head: { sha: head },
        base: { ref: 'main' },
      });
    const run = (name: string, conclusion = 'SUCCESS') => ({
      __typename: 'CheckRun',
      name,
      status: 'COMPLETED',
      conclusion,
      detailsUrl: null,
      checkSuite: null,
    });
    const rollupBody = JSON.stringify({
      data: {
        repository: {
          pullRequest: {
            number: 42,
            state: 'OPEN',
            headRefOid: head,
            commits: {
              nodes: [
                {
                  commit: {
                    oid: rollup.oid,
                    statusCheckRollup: {
                      state: 'SUCCESS',
                      contexts: {
                        pageInfo: { hasNextPage: false },
                        nodes: [
                          ...rollup.checks.map((name) => run(name)),
                          ...(rollup.failed ?? []).map((name) => run(name, 'FAILURE')),
                        ],
                      },
                    },
                  },
                },
              ],
            },
          },
        },
      },
    });
    const threads = JSON.stringify([
      {
        data: {
          repository: {
            pullRequest: {
              reviewThreads: {
                pageInfo: { hasNextPage: false, endCursor: null },
                nodes: [],
              },
            },
          },
        },
      },
    ]);
    const puts = join(real, 'puts');
    await writeFile(
      join(bin, 'gh'),
      [
        '#!/bin/sh',
        `case "$*" in`,
        `  *"-X PUT"*) echo put >> '${puts}'; echo "$*" >> '${puts}.args'; echo '{"merged":true,"sha":"mmm"}';;`,
        `  *"commits(last: 1)"*) echo '${rollupBody}';;`,
        `  *reviewThreads*) echo '${threads}';;`,
        `  *code-scanning*) echo '[]';;`,
        `  *) if [ -f '${puts}' ]; then echo '${pull(true)}'; else echo '${pull(false)}'; fi;;`,
        'esac',
        '',
      ].join('\n'),
    );
    await chmod(join(bin, 'gh'), 0o755);
    vi.stubEnv('PATH', `${bin}${delimiter}${process.env['PATH'] ?? ''}`);
    return puts;
  }
  const land = async (requiredChecks: readonly string[]) =>
    (
      await runWorkflow(
        definition((ctx) => landMerge(ctx, 'land', { ...input, requiredChecks })),
        setup(),
      )
    ).output;
  const puts = async (file: string): Promise<string> => readFile(file, 'utf8').catch(() => '');

  it('merges when the gated head’s rollup carries every required check', async () => {
    const file = await fakeGh({ oid: head, checks: ['Quality', 'test (22)'] });
    expect(await land(['test (22)'])).toMatchObject({ merged: true, mergeCommit: 'mmm' });
    expect(await puts(file)).toBe('put\n');
  });

  it('squash-merges by default and merges with the requested method (#737)', async () => {
    const file = await fakeGh({ oid: head, checks: [] });
    expect(await land([])).toMatchObject({ merged: true });
    expect(await puts(`${file}.args`)).toContain('merge_method=squash');
    await rm(file);
    await rm(`${file}.args`);
    const merged = await runWorkflow(
      definition((ctx) => landMerge(ctx, 'land-merge', { ...input, method: 'merge' })),
      { ...setup(), runId: 'test-merge' },
    );
    expect(merged.output).toMatchObject({ merged: true, mergeCommit: 'mmm' });
    expect(await puts(`${file}.args`)).toContain('merge_method=merge');
  });

  it('refuses red CI at landing unless CI is ignored (#738)', async () => {
    const file = await fakeGh({ oid: head, checks: [], failed: ['macos'] });
    expect(await land([])).toEqual({ merged: false, reason: 'CI is failure at landing: macos' });
    expect(await puts(file)).toBe('');
    const ignored = await runWorkflow(
      definition((ctx) => landMerge(ctx, 'land-ignore', { ...input, ignoreCi: true })),
      { ...setup(), runId: 'test-ignore' },
    );
    expect(ignored.output).toMatchObject({ merged: true, mergeCommit: 'mmm' });
    expect(await puts(file)).toBe('put\n');
  });

  it('refuses a required check that is absent at landing, without merging', async () => {
    const file = await fakeGh({ oid: head, checks: ['Quality'] });
    expect(await land(['test (22)', 'Quality'])).toEqual({
      merged: false,
      reason: 'required checks missing at landing: test (22)',
    });
    expect(await puts(file)).toBe('');
  });

  it('refuses required checks when the rollup lists none', async () => {
    const file = await fakeGh({ oid: head, checks: [] });
    expect(await land(['test (22)'])).toMatchObject({
      merged: false,
      reason: 'required checks missing at landing: test (22)',
    });
    expect(await puts(file)).toBe('');
  });

  it('refuses a CI rollup that belongs to another commit, without merging', async () => {
    const other = '9f8e7d6c5b4a39281706f5e4d3c2b1a099887766';
    const file = await fakeGh({ oid: other, checks: ['Quality'] });
    expect(await land([])).toEqual({
      merged: false,
      reason: `CI rollup is for ${other}, not the gated head ${head}`,
    });
    expect(await puts(file)).toBe('');
  });
});

describe('localCodexReview', () => {
  it('resets the review worktree to the pinned head before codex runs', async () => {
    const workdir = join(real, 'worktree');
    const dir = join(real, 'state', 'pr-1');
    await mkdir(dir, { recursive: true });
    const sha = await repository(workdir);
    // Dirties each new worktree, as the leftovers of an unfinished attempt would.
    const hook = join(workdir, '.git', 'hooks', 'post-checkout');
    const hooked = join(real, 'hooked');
    await writeFile(
      hook,
      `#!/bin/sh\necho stale >> README.md\necho junk > junk.txt\necho ran >> '${hooked}'\n`,
    );
    await chmod(hook, 0o755);
    const bin = join(real, 'bin');
    const seen = join(real, 'seen');
    await mkdir(bin);
    await writeFile(
      join(bin, 'codex'),
      `#!/bin/sh\ngit status --porcelain > '${seen}'\necho 'No issues found.'\n`,
    );
    await chmod(join(bin, 'codex'), 0o755);
    vi.stubEnv('PATH', `${bin}${delimiter}${process.env['PATH'] ?? ''}`);
    const run = await runWorkflow(
      definition((ctx) =>
        localCodexReview(ctx, {
          label: 'r0',
          paths: { root: real, workdir, stateDir: join(real, 'state'), dir },
          base: 'main',
          sha,
          model: 'gpt-test',
          effort: null,
        }),
      ),
      setup(),
    );
    expect(run.output).toMatchObject({ sha, findings: 0, error: null });
    expect(await readFile(hooked, 'utf8')).toBe('ran\n');
    expect(await readFile(seen, 'utf8')).toBe('');
  });

  const reviewWith = async (script: string) => {
    const workdir = join(real, 'worktree');
    const dir = join(real, 'state', 'pr-1');
    await mkdir(dir, { recursive: true });
    const sha = await repository(workdir);
    const bin = join(real, 'bin');
    await mkdir(bin);
    await writeFile(join(bin, 'codex'), `#!/bin/sh\n${script}\n`);
    await chmod(join(bin, 'codex'), 0o755);
    vi.stubEnv('PATH', `${bin}${delimiter}${process.env['PATH'] ?? ''}`);
    const run = await runWorkflow(
      definition((ctx) =>
        localCodexReview(ctx, {
          label: 'r0',
          paths: { root: real, workdir, stateDir: join(real, 'state'), dir },
          base: 'main',
          sha,
          model: 'gpt-test',
          effort: null,
        }),
      ),
      setup(),
    );
    return { run, file: join(dir, `codex-review-${sha.slice(0, 12)}.md`) };
  };

  it("keeps the worktree preparation's output out of the review text", async () => {
    const { run, file } = await reviewWith("echo '- [P2] Something to fix'");
    expect(run.output).toMatchObject({ findings: 1, error: null });
    expect(await readFile(file, 'utf8')).toBe('- [P2] Something to fix\n');
  });

  it('reports an error for a review whose stdout is empty', async () => {
    const { run } = await reviewWith('exit 0');
    expect(run.output).toMatchObject({ findings: 0, error: 'codex review printed no review' });
  });

  it('silences the git preparation in the exec argv', () => {
    expect(REVIEW_SCRIPT).toMatch(/git reset -q --hard "\$MERGE_DOWN_REVIEW_SHA" >&2 &&/);
    expect(REVIEW_SCRIPT).toMatch(/git clean -q -fd -e node_modules >&2 &&/);
  });

  it('resumes a finished review after teardown under a symlinked root', async () => {
    // The root is reached through a symlink, so the review worktree's path is not canonical.
    const root = join(real, 'link');
    await mkdir(join(real, 'target'));
    await symlink(join(real, 'target'), root);
    const workdir = join(root, 'worktree');
    const dir = join(root, 'state', 'pr-1');
    await mkdir(dir, { recursive: true });
    const sha = await repository(workdir);
    const bin = join(real, 'bin');
    const calls = join(real, 'codex-calls');
    await mkdir(bin);
    await writeFile(
      join(bin, 'codex'),
      `#!/bin/sh\necho run >> '${calls}'\necho 'No issues found.'\n`,
    );
    await chmod(join(bin, 'codex'), 0o755);
    vi.stubEnv('PATH', `${bin}${delimiter}${process.env['PATH'] ?? ''}`);

    let crash = true;
    const workflow = definition(async (ctx) => {
      const review = await localCodexReview(ctx, {
        label: 'r0',
        paths: { root, workdir, stateDir: join(root, 'state'), dir },
        base: 'main',
        sha,
        model: 'gpt-test',
        effort: null,
      });
      if (crash) throw new Error('crashed after the review');
      return review;
    });
    await expect(runWorkflow(workflow, setup())).rejects.toThrow('crashed after the review');
    crash = false;
    const resumed = await runWorkflow(workflow, setup(true));
    expect(resumed.status).toBe('completed');
    expect(resumed.output).toMatchObject({ sha, deps: 'none', findings: 0, error: null });
    expect(await readFile(calls, 'utf8')).toBe('run\n');
  });
});

describe('the ci: ignore gate reviewer (#738)', () => {
  it('is clean at once and reads nothing of its own, so no analysis check is awaited', async () => {
    const { CI_IGNORED_REVIEWER } = await lib<{
      CI_IGNORED_REVIEWER: {
        name: string;
        reads: readonly string[];
        observe: (activity: unknown, context: unknown) => { status: string };
      };
    }>('prepare');
    expect(CI_IGNORED_REVIEWER.reads).toEqual([]);
    expect(CI_IGNORED_REVIEWER.observe({}, {})).toEqual({ status: 'clean' });
    expect(CI_IGNORED_REVIEWER.name).not.toBe('codeql');
  });
});
