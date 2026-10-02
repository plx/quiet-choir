import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  defineWorkflow,
  NodeProcessRunner,
  readRun,
  runWorkflow,
  type MergeOptions,
  type ProcessRunner,
  type WorkflowContext,
} from '../src/index.js';
import { WorktreeGit } from '../src/worktrees/git.js';
import { parseIdent } from '../src/workflow/runtime/worktree-merge.js';
import { testInvocation } from './harness-invocation.js';

// Every test drives real Git processes, like test/worktrees.test.ts. measured: 0.4-1.0 s per case
// alone with the worktree suite in parallel (the two-input rebase is slowest), dominated by Git
// process startup; the same budget as test/worktrees.test.ts.
vi.setConfig({ testTimeout: 10_000 });

let directory: string, repo: string, stateDir: string, root: string;
const processRunner = new NodeProcessRunner();
const git = new WorktreeGit(processRunner),
  invocation = testInvocation();
async function command(...args: string[]) {
  return git.text(repo, args, invocation);
}
async function exists(ref: string): Promise<boolean> {
  const result = await git.run(repo, ['rev-parse', '--verify', '--quiet', ref], invocation, {
    codes: [0, 1],
  });
  return result.code === 0;
}
/** Author line, committer line and subject of the tip of a ref. */
async function head(ref: string): Promise<string> {
  return command('log', '-1', '--format=%an <%ae>%n%cn <%ce>%n%s', ref);
}
function options(runId: string, runner: ProcessRunner = processRunner) {
  return { runId, cwd: repo, stateDir, processRunner: runner, worktrees: { root }, input: null };
}
const commandOf = (request: Parameters<ProcessRunner['run']>[0]): readonly string[] =>
  Array.isArray(request.command) ? request.command : [];
const failed = (stderr: string) => ({
  code: 128,
  signal: null,
  stdout: '',
  stderr,
  truncated: false,
  durationMs: 1,
});

beforeEach(async () => {
  directory = await realpath(await mkdtemp(join(tmpdir(), 'choir-merge-commit-')));
  repo = join(directory, 'repo');
  stateDir = join(directory, 'runs');
  root = join(directory, 'caches');
  await mkdir(repo);
  await command('init', '-q');
  await command('config', 'user.name', 'Config User');
  await command('config', 'user.email', 'config@example.test');
  await writeFile(join(repo, 'file.txt'), 'base\n');
  await command('add', '--all');
  await command('commit', '-qm', 'baseline');
});
afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

/**
 * Edit `edits` files in one shared handle each, then merge the handles into agent/100. An empty
 * edit list merges one unchanged handle.
 */
function integration(
  merge: MergeOptions,
  edits: readonly string[] = ['one.txt'],
  after?: (ctx: WorkflowContext, commit: string) => Promise<void>,
  content: (file: string, index: number) => string = (file) => `${file}\n`,
) {
  return defineWorkflow({
    name: 'merge-commit',
    version: '1',
    input: z.null(),
    output: z.string(),
    async run(ctx) {
      const handles = [];
      for (const [index, file] of (edits.length ? edits : [null]).entries()) {
        const handle = await ctx.worktree(`cache-${String(index)}`);
        if (file !== null)
          await ctx.step(`edit-${String(index)}`, {
            worktree: handle,
            input: file,
            schema: z.null(),
            async run({ cwd }) {
              await writeFile(join(cwd, file), content(file, index));
              return null;
            },
          });
        handles.push(handle);
      }
      const result = await ctx.merge('publish', handles, {
        target: { branch: 'agent/100' },
        ...merge,
      });
      await after?.(ctx, result.commit);
      return result.commit;
    },
  });
}

describe('MergeOptions.commit', () => {
  it('squashes with the git-config identity and the requested message', async () => {
    const result = await runWorkflow(
      integration({ strategy: 'squash', commit: { message: 'Fix #42', author: 'git-config' } }),
      options('git-config'),
    );
    expect(await command('rev-parse', 'refs/heads/agent/100')).toBe(result.output);
    expect(await command('log', '-1', '--format=%an <%ae>%n%s', 'agent/100')).toBe(
      'Config User <config@example.test>\nFix #42',
    );
    expect(await head('agent/100')).toBe(
      'Config User <config@example.test>\nConfig User <config@example.test>\nFix #42',
    );
    expect(result.steps['publish']?.merge?.commit).toEqual({
      message: 'Fix #42',
      author: { name: 'Config User', email: 'config@example.test' },
      committer: { name: 'Config User', email: 'config@example.test' },
    });
  });

  it('squashes with an explicit name and email for author and committer', async () => {
    await runWorkflow(
      integration({
        strategy: 'squash',
        commit: { message: 'Fix #42', author: { name: 'Ada Lovelace', email: 'ada@example.test' } },
      }),
      options('explicit'),
    );
    expect(await head('agent/100')).toBe(
      'Ada Lovelace <ada@example.test>\nAda Lovelace <ada@example.test>\nFix #42',
    );
  });

  it('gives only the final rebase commit the message and every commit the identity', async () => {
    const result = await runWorkflow(
      integration({ strategy: 'rebase', commit: { message: 'Fix #42', author: 'git-config' } }, [
        'one.txt',
        'two.txt',
      ]),
      options('rebase'),
    );
    const merged = result.steps['publish']?.merge?.result?.merged ?? [];
    expect(merged).toHaveLength(2);
    const log = await command(
      'log',
      '--format=%an <%ae>|%cn <%ce>|%s',
      `${String(result.steps['publish']?.merge?.base)}..agent/100`,
    );
    const identity = 'Config User <config@example.test>';
    expect(log.split('\n')).toEqual([
      `${identity}|${identity}|Fix #42`,
      `${identity}|${identity}|quiet-choir integrate publish: ${String(merged[0])}`,
    ]);
    expect(await command('show', 'agent/100:two.txt')).toBe('two.txt');
    expect(await command('show', 'agent/100:one.txt')).toBe('one.txt');
  });

  it('gives a merge-strategy tip the message, two parents and the identity on its first-parent chain', async () => {
    const result = await runWorkflow(
      integration({ strategy: 'merge', commit: { message: 'Fix #42', author: 'git-config' } }, [
        'one.txt',
        'two.txt',
      ]),
      options('merge-strategy'),
    );
    const merged = result.steps['publish']?.merge?.result?.merged ?? [];
    expect(merged).toHaveLength(2);
    expect(await command('log', '-1', '--format=%s', 'agent/100')).toBe('Fix #42');
    const parents = (await command('rev-list', '--parents', '-n1', 'agent/100')).split(' ');
    expect(parents).toHaveLength(3);
    expect(parents[0]).toBe(result.output);
    expect(parents[2]).toBe(merged[1]);
    const identity = 'Config User <config@example.test>';
    const log = await command(
      'log',
      '--first-parent',
      '--format=%an <%ae>|%cn <%ce>',
      `${String(result.steps['publish']?.merge?.base)}..agent/100`,
    );
    expect(log.split('\n')).toEqual([`${identity}|${identity}`, `${identity}|${identity}`]);
  });

  it('puts the message on the last clean rebase commit when a trailing input conflicts', async () => {
    const result = await runWorkflow(
      integration(
        {
          strategy: 'rebase',
          onConflict: 'report',
          commit: { message: 'Fix #42', author: 'git-config' },
        },
        ['file.txt', 'file.txt'],
        undefined,
        (_, index) => `body ${String(index)}\n`,
      ),
      options('rebase-conflict'),
    );
    const merge = result.steps['publish']?.merge?.result;
    expect(merge?.merged).toHaveLength(1);
    expect(merge?.conflicts).toHaveLength(1);
    expect(await head('agent/100')).toBe(
      'Config User <config@example.test>\nConfig User <config@example.test>\nFix #42',
    );
    expect(await command('rev-parse', 'agent/100')).toBe(merge?.commit);
    expect(merge?.commit).toBe(result.output);
  });

  it('reproduces the recorded commit after an interruption and a changed user.name', async () => {
    let interrupt = true,
      recorded: string | undefined;
    const runner: ProcessRunner = {
      run: async (request, owner) => {
        const result = await processRunner.run(request, owner);
        if (commandOf(request).includes('commit-tree') && request.input === 'Fix #42\n') {
          recorded = result.stdout.trim();
          if (interrupt) throw new Error('interrupted after the final commit');
        }
        return result;
      },
    };
    const workflow = integration({
      strategy: 'squash',
      commit: { message: 'Fix #42', author: 'git-config' },
    });
    await expect(runWorkflow(workflow, options('resume', runner))).rejects.toThrow(
      'interrupted after the final commit',
    );
    const prepared = (await readRun({ stateDir, runId: 'resume' })).steps['publish']?.merge;
    assert(prepared?.commit && recorded);
    expect(prepared.result).toBeUndefined();
    expect(await exists('refs/heads/agent/100')).toBe(false);
    const first = recorded;
    await command('config', 'user.name', 'Renamed User');
    interrupt = false;
    const resumed = await runWorkflow(workflow, { ...options('resume', runner), resume: true });
    expect(resumed.output).toBe(first);
    expect(recorded).toBe(first);
    expect(resumed.steps['publish']?.merge?.result?.commit).toBe(first);
    expect(await command('rev-parse', 'refs/heads/agent/100')).toBe(first);
    expect(await head('agent/100')).toBe(
      'Config User <config@example.test>\nConfig User <config@example.test>\nFix #42',
    );
  });

  it('fails without publishing when git var cannot produce an identity', async () => {
    const runner: ProcessRunner = {
      run: (request, owner) =>
        commandOf(request).includes('var')
          ? Promise.resolve(failed('fatal: unable to auto-detect email address'))
          : processRunner.run(request, owner),
    };
    await expect(
      runWorkflow(
        integration({ strategy: 'squash', commit: { message: 'Fix #42', author: 'git-config' } }),
        options('no-ident', runner),
      ),
    ).rejects.toThrow(
      'Merge commit author from git config is unavailable: fatal: unable to auto-detect email address',
    );
    expect(await exists('refs/heads/agent/100')).toBe(false);
    const step = (await readRun({ stateDir, runId: 'no-ident' })).steps['publish'];
    expect(step?.status).toBe('failed');
    expect(step?.merge?.result).toBeUndefined();
  });

  it.each<[string, Record<string, unknown>, string]>([
    ['an empty message', { message: '' }, 'commit.message must contain non-whitespace text'],
    ['a blank message', { message: ' \n ' }, 'commit.message must contain non-whitespace text'],
    [
      'a newline in the name',
      { message: 'Fix', author: { name: 'Ada\nLovelace', email: 'ada@example.test' } },
      'commit.author.name must not contain newlines, NUL or angle brackets',
    ],
    [
      'an angle bracket in the email',
      { message: 'Fix', author: { name: 'Ada', email: '<ada@example.test>' } },
      'commit.author.email must not contain newlines, NUL or angle brackets',
    ],
  ])('rejects %s and publishes nothing', async (_, commit, error) => {
    await expect(
      runWorkflow(
        integration({ strategy: 'squash', commit } as unknown as MergeOptions),
        options('invalid'),
      ),
    ).rejects.toThrow(error);
    expect(await exists('refs/heads/agent/100')).toBe(false);
    expect((await readRun({ stateDir, runId: 'invalid' })).steps['publish']?.merge).toBeUndefined();
  });

  it('ignores commit when nothing merges: no git var and no new commit', async () => {
    const seen: string[] = [];
    const runner: ProcessRunner = {
      run: (request, owner) => {
        const args = commandOf(request);
        if (args.includes('var')) seen.push('var');
        if (args.includes('commit-tree')) seen.push('commit-tree');
        return args.includes('var')
          ? Promise.resolve(failed('fatal: unexpected git var'))
          : processRunner.run(request, owner);
      },
    };
    const base = await command('rev-parse', 'HEAD');
    const result = await runWorkflow(
      integration({ strategy: 'squash', commit: { message: 'Fix #42', author: 'git-config' } }, []),
      options('no-op', runner),
    );
    expect(seen).toEqual([]);
    expect(result.output).toBe(base);
    expect(result.steps['publish']?.merge?.commit).toBeUndefined();
    expect(result.steps['publish']?.merge?.result?.merged).toEqual([]);
    expect(await command('rev-parse', 'refs/heads/agent/100')).toBe(base);
  });

  it('keeps the fixed identity and generated message without commit', async () => {
    const result = await runWorkflow(integration({ strategy: 'squash' }), options('default'));
    expect(await head('agent/100')).toBe(
      'quiet-choir <quiet-choir@localhost>\nquiet-choir <quiet-choir@localhost>\nquiet-choir squash publish',
    );
    expect(result.steps['publish']?.merge).not.toHaveProperty('commit');
  });

  it('pushes result.commit with an empty-lease force push that a re-run repeats with exit 0', async () => {
    const remote = join(directory, 'remote.git');
    await git.run(directory, ['init', '-q', '--bare', remote], invocation);
    const push = (commit: string): [string, ...string[]] => [
      'git',
      'push',
      remote,
      `${commit}:refs/heads/agent/100`,
      '--force-with-lease=refs/heads/agent/100:',
    ];
    let first: number | null | undefined;
    const result = await runWorkflow(
      integration(
        { strategy: 'squash', commit: { message: 'Fix #42', author: 'git-config' } },
        ['one.txt'],
        async (ctx, commit) => {
          first = (await ctx.exec('push', push(commit))).code;
        },
      ),
      options('push'),
    );
    expect(first).toBe(0);
    const again = await git.run(repo, push(String(result.output)).slice(1), invocation);
    // The repeated push is a no-op: git prints "Everything up-to-date" and exits 0.
    expect(again.code).toBe(0);
    expect(again.stderr).toContain('Everything up-to-date');
    const remoteRef = await git.text(remote, ['rev-parse', 'refs/heads/agent/100'], invocation);
    expect(remoteRef).toBe(result.output);
  });
});

describe('parseIdent', () => {
  it.each<[string, string, { name: string; email: string } | null]>([
    [
      'a git var line',
      'plx <plx@example.test> 1790737520 -0500\n',
      { name: 'plx', email: 'plx@example.test' },
    ],
    [
      'a name with spaces',
      'Ada King Lovelace <ada@example.test> 1790737520 +0000',
      { name: 'Ada King Lovelace', email: 'ada@example.test' },
    ],
    ['a missing zone', 'plx <plx@example.test> 1790737520', null],
    ['angle brackets inside the name', 'a <b> c <plx@example.test> 1790737520 -0500', null],
    ['an empty email', 'plx <> 1790737520 -0500', null],
    ['a blank name', '  <plx@example.test> 1790737520 -0500', null],
  ])('parses %s', (_, line, expected) => {
    expect(parseIdent(line)).toEqual(expected);
  });
});
