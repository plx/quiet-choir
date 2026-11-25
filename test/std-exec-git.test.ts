// quiet-choir/std exec additions (std.exec): check, head, status, assertClean, diff, diffStat,
// changedFiles, commits and log against a real temporary Git repository and real processes, with an
// inert harness (none of these workflows calls an agent). A recording process runner shows the
// exact argv each helper records and that a resume replays saved results instead of running
// commands again. Every range helper refuses a range Git would read as an option.
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  ExecError,
  NodeProcessRunner,
  defineWorkflow,
  runWorkflow,
  z,
  type Command,
  type ExecOptions,
  type ExecResult,
  type Harness,
  type HarnessInvocation,
  type ProcessRunRequest,
  type ProcessRunner,
  type WorkflowContext,
  type WorkflowDefinition,
} from '../src/index.js';
import * as exec from '../src/std/exec.js';
import { CheckOutcome, Commit } from '../src/std/types.js';

const execute = promisify(execFile);
let root: string;
let repo: string;
let base: string;
let runner: RecordingRunner;

const inert: Harness = {
  kind: 'std-exec-git-inert',
  invoke() {
    throw new Error('These workflows call no agent.');
  },
};

/** A real process runner that records each command it is asked to run. */
class RecordingRunner implements ProcessRunner {
  public readonly commands: Command[] = [];
  private readonly inner = new NodeProcessRunner();

  public run(request: ProcessRunRequest, invocation: HarnessInvocation): Promise<ExecResult> {
    this.commands.push(request.command);
    return this.inner.run(request, invocation);
  }
}

async function git(...args: string[]): Promise<string> {
  const identity = ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid'];
  const { stdout } = await execute('git', [...identity, '-c', 'commit.gpgSign=false', ...args], {
    cwd: repo,
  });
  return stdout;
}

async function commit(message: string): Promise<string> {
  await git('add', '--all');
  await git('commit', '--quiet', '-m', message);
  return (await git('rev-parse', 'HEAD')).trim();
}

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'choir-std-exec-git-')));
  repo = join(root, 'repo');
  await mkdir(join(repo, 'sub'), { recursive: true });
  await git('init', '--quiet');
  const hooks = join(root, 'empty-hooks');
  await mkdir(hooks);
  await git('config', '--local', 'core.hooksPath', hooks);
  await writeFile(join(repo, 'exists.md'), 'old\n');
  await writeFile(join(repo, 'sub', 'keep.md'), 'keep\n');
  base = await commit('base');
  runner = new RecordingRunner();
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

/** A workflow whose body is `body`. */
function workflow<O>(
  output: z.ZodType<O>,
  body: (ctx: WorkflowContext) => Promise<O>,
): WorkflowDefinition<null, O> {
  return defineWorkflow({
    name: 'std-exec-git',
    version: '1',
    input: z.null(),
    output,
    run: (ctx) => body(ctx),
  });
}
const options = (runId: string, cwd = repo) => ({
  runId,
  cwd,
  stateDir: join(root, 'state'),
  fingerprint: 'std-exec-git-v1',
  input: null,
  harness: inert,
  processRunner: runner,
});

/** Run `body` once and return its output. */
async function run<O>(
  output: z.ZodType<O>,
  body: (ctx: WorkflowContext) => Promise<O>,
  runId = 'run',
): Promise<O> {
  const result = await runWorkflow(workflow(output, body), options(runId));
  return result.output as O;
}

const node = (source: string): Command => [process.execPath, '-e', source];

describe('check', () => {
  it('returns a passing outcome with stdout then stderr', async () => {
    const outcome = await run(CheckOutcome, (ctx) =>
      exec.check(ctx, 'ok', node("process.stdout.write('out'); process.stderr.write('err\\n')")),
    );
    expect(outcome).toEqual({
      passed: true,
      code: 0,
      signal: null,
      output: 'out\nerr\n',
      truncated: false,
    });
  });

  it('returns a failure as data with the saved stream tails', async () => {
    const outcome = await run(CheckOutcome, (ctx) =>
      exec.check(
        ctx,
        'fails',
        node("process.stdout.write('out\\n'); process.stderr.write('err'); process.exit(3)"),
      ),
    );
    expect(outcome).toEqual({
      passed: false,
      code: 3,
      signal: null,
      output: 'out\nerr',
      truncated: false,
    });
  });

  it('runs an explicit shell command', async () => {
    const outcome = await run(CheckOutcome, (ctx) =>
      exec.check(ctx, 'shell', { shell: 'echo hi; exit 4' }),
    );
    expect(outcome).toMatchObject({ passed: false, code: 4, output: 'hi\n' });
  });

  it('reports a signal', async () => {
    const outcome = await run(CheckOutcome, (ctx) =>
      exec.check(ctx, 'killed', node("process.kill(process.pid, 'SIGKILL')")),
    );
    expect(outcome).toMatchObject({ passed: false, code: null, signal: 'SIGKILL' });
  });

  it('uses the failure message when a command cannot start and printed nothing', async () => {
    const outcome = await run(CheckOutcome, (ctx) =>
      exec.check(ctx, 'missing', ['quiet-choir-no-such-command']),
    );
    expect(outcome).toMatchObject({ passed: false, code: null, signal: null, truncated: false });
    expect(outcome.output).toMatch(/^Cannot start quiet-choir-no-such-command/u);
  });

  it('keeps the last 4000 characters of a long output without splitting a surrogate pair', async () => {
    const outcome = await run(CheckOutcome, (ctx) =>
      exec.check(ctx, 'long', node("process.stdout.write('\\u{1F600}'.repeat(2000) + 'x')")),
    );
    expect(outcome.output).toBe(`${'\u{1F600}'.repeat(1999)}x`);
    expect(outcome.output).toHaveLength(3999);
    expect(outcome).toMatchObject({ passed: true, truncated: true });
    const exact = await run(
      CheckOutcome,
      (ctx) => exec.check(ctx, 'exact', node("process.stdout.write('y'.repeat(4000))")),
      'exact',
    );
    expect(exact).toMatchObject({ output: 'y'.repeat(4000), truncated: false });
    const over = await run(
      CheckOutcome,
      (ctx) =>
        exec.check(
          ctx,
          'over',
          node("process.stdout.write('w'); process.stderr.write('y'.repeat(3999))"),
        ),
      'over',
    );
    // Stdout without a final newline gets one before stderr, so 4001 characters keep the last 4000.
    expect(over).toMatchObject({ output: `\n${'y'.repeat(3999)}`, truncated: true });
  });

  it('marks a failure whose saved tail is full as truncated', async () => {
    const outcome = await run(CheckOutcome, (ctx) =>
      exec.check(
        ctx,
        'noisy',
        node("process.stdout.write('a'.repeat(3000)); process.stderr.write('e'); process.exit(1)"),
      ),
    );
    expect(outcome).toEqual({
      passed: false,
      code: 1,
      signal: null,
      output: `${'a'.repeat(1024)}\ne`,
      truncated: true,
    });
  });

  it('drops the half surrogate pair a saved failure tail starts with', async () => {
    // Each stream is 1201 UTF-16 units; the saved 1024-unit tail starts on a low surrogate.
    const outcome = await run(CheckOutcome, (ctx) =>
      exec.check(
        ctx,
        'emoji',
        node(
          "const s = '\\u{1F600}'.repeat(600); process.stdout.write(s + 'x'); process.stderr.write(s + 'z'); process.exit(1)",
        ),
      ),
    );
    expect(outcome).toEqual({
      passed: false,
      code: 1,
      signal: null,
      output: `${'\u{1F600}'.repeat(511)}x\n${'\u{1F600}'.repeat(511)}z`,
      truncated: true,
    });
    // No lone surrogate: with the u flag, a pair is one code point and never matches \p{Cs}.
    expect(outcome.output).not.toMatch(/\p{Cs}/u);
  });

  it('marks an overflowing capture as truncated', async () => {
    const outcome = await run(CheckOutcome, (ctx) =>
      exec.check(ctx, 'capped', node("process.stdout.write('z'.repeat(100))"), {
        maxOutputBytes: 10,
      }),
    );
    expect(outcome).toMatchObject({ passed: true, truncated: true });
  });

  it('forwards options: accepted exit codes and the working directory', async () => {
    const any = await run(CheckOutcome, (ctx) =>
      exec.check(ctx, 'any', node('process.exit(2)'), { okExitCodes: 'any' }),
    );
    expect(any).toMatchObject({ passed: true, code: 2 });
    const cwd = await run(
      CheckOutcome,
      (ctx) => exec.check(ctx, 'cwd', node('process.stdout.write(process.cwd())'), { cwd: 'sub' }),
      'cwd',
    );
    expect(cwd.output).toBe(join(repo, 'sub'));
  });

  it('settles a failure even when the options were widened to onError throw', async () => {
    const widened: ExecOptions = { onError: 'throw' };
    const outcome = await run(CheckOutcome, (ctx) =>
      exec.check(ctx, 'widened', node('process.exit(5)'), widened),
    );
    expect(outcome).toMatchObject({ passed: false, code: 5 });
  });

  it('replays a saved failure on resume without running the command again', async () => {
    const definition = workflow(CheckOutcome, async (ctx) => {
      const outcome = await exec.check(ctx, 'tests', node('process.exit(7)'));
      await ctx.step('tail', {
        input: null,
        schema: z.null(),
        run({ attempt }) {
          if (attempt === 1) throw new Error('Injected tail failure');
          return null;
        },
      });
      return outcome;
    });
    await expect(runWorkflow(definition, options('resume'))).rejects.toThrow(
      'Injected tail failure',
    );
    expect(runner.commands).toHaveLength(1);
    const resumed = await runWorkflow(definition, { ...options('resume'), resume: true });
    expect(runner.commands).toHaveLength(1);
    expect(resumed.output).toMatchObject({ passed: false, code: 7 });
    expect(resumed.steps['tests']?.attempts).toBe(1);
  });
});

describe('Git queries', () => {
  it('head returns the full commit ID of HEAD', async () => {
    const sha = await run(z.string(), (ctx) => exec.head(ctx, 'head'));
    expect(sha).toBe(base);
    expect(runner.commands).toEqual([['git', 'rev-parse', 'HEAD']]);
  });

  it('head refuses output that is not a full object ID, and throws when there is no commit', async () => {
    const empty = join(root, 'empty');
    await mkdir(empty);
    await execute('git', ['init', '--quiet'], { cwd: empty });
    const accepted = workflow(z.string(), (ctx) => exec.head(ctx, 'head', { okExitCodes: 'any' }));
    await expect(runWorkflow(accepted, options('unborn-any', empty))).rejects.toThrow(
      'Expected a full Git object ID (head), got "HEAD"',
    );
    const failing = workflow(z.string(), async (ctx) => {
      try {
        return await exec.head(ctx, 'head');
      } catch (error) {
        return error instanceof ExecError ? 'ExecError' : 'other';
      }
    });
    expect((await runWorkflow(failing, options('unborn', empty))).output).toBe('ExecError');
  });

  it('status lists staged, unstaged and every untracked file from the repository root', async () => {
    expect(await run(z.array(z.string()), (ctx) => exec.status(ctx, 'clean'))).toEqual([]);
    await writeFile(join(repo, 'exists.md'), 'new\n');
    await writeFile(join(repo, 'staged.md'), 'staged\n');
    await git('add', 'staged.md');
    await mkdir(join(repo, 'fresh', 'deep'), { recursive: true });
    await writeFile(join(repo, 'fresh', 'deep', 'new.md'), 'new\n');
    await writeFile(join(repo, 'sp ace.md'), 'x\n');
    const lines = await run(
      z.array(z.string()),
      (ctx) => exec.status(ctx, 'dirty', { cwd: 'sub' }),
      'dirty',
    );
    // Porcelain v1 quotes a path with a space, as the TSDoc says.
    expect(lines).toEqual([
      ' M exists.md',
      'A  staged.md',
      '?? fresh/deep/new.md',
      '?? "sp ace.md"',
    ]);
    expect(runner.commands.at(-1)).toEqual([
      'git',
      '--no-optional-locks',
      'status',
      '--porcelain=v1',
      '--untracked-files=all',
    ]);
  });

  it('assertClean passes on a clean tree and names the changed paths otherwise', async () => {
    await run(z.null(), async (ctx) => {
      await exec.assertClean(ctx, 'clean');
      return null;
    });
    await writeFile(join(repo, 'exists.md'), 'new\n');
    await writeFile(join(repo, 'untracked.md'), 'x\n');
    const dirty = workflow(z.null(), async (ctx) => {
      await exec.assertClean(ctx, 'clean');
      return null;
    });
    await expect(runWorkflow(dirty, options('dirty'))).rejects.toThrow(
      'Expected a clean working tree (clean): 2 changed or untracked paths: M exists.md; ?? untracked.md',
    );
    for (let index = 0; index < 11; index++)
      await writeFile(join(repo, `n${String(index).padStart(2, '0')}.md`), 'x\n');
    await expect(runWorkflow(dirty, options('many'))).rejects.toThrow(
      'Expected a clean working tree (clean): 13 changed or untracked paths: M exists.md; ?? n00.md; ?? n01.md; ?? n02.md; ?? n03.md; ?? n04.md; ?? n05.md; ?? n06.md; ?? n07.md; ?? n08.md; and 3 more',
    );
  });

  it('assertClean replays the recorded status on resume', async () => {
    const definition = workflow(z.null(), async (ctx) => {
      await exec.assertClean(ctx, 'clean');
      await ctx.step('tail', {
        input: null,
        schema: z.null(),
        run({ attempt }) {
          if (attempt === 1) throw new Error('Injected tail failure');
          return null;
        },
      });
      return null;
    });
    await expect(runWorkflow(definition, options('resume'))).rejects.toThrow(
      'Injected tail failure',
    );
    await writeFile(join(repo, 'later.md'), 'written after the check\n');
    const resumed = await runWorkflow(definition, { ...options('resume'), resume: true });
    expect(resumed.status).toBe('completed');
    expect(runner.commands).toHaveLength(1);
  });

  it('assertClean replays a recorded dirty status on resume, even after the tree is cleaned', async () => {
    await writeFile(join(repo, 'untracked.md'), 'x\n');
    const definition = workflow(z.null(), async (ctx) => {
      await exec.assertClean(ctx, 'clean');
      return null;
    });
    const message =
      'Expected a clean working tree (clean): 1 changed or untracked path: ?? untracked.md';
    await expect(runWorkflow(definition, options('dirty-resume'))).rejects.toThrow(message);
    await rm(join(repo, 'untracked.md'));
    await expect(
      runWorkflow(definition, { ...options('dirty-resume'), resume: true }),
    ).rejects.toThrow(message);
    expect(runner.commands).toHaveLength(1);
  });

  it('diff shows unstaged changes by default and a range when given', async () => {
    await writeFile(join(repo, 'exists.md'), 'new\n');
    const unstaged = await run(z.string(), (ctx) => exec.diff(ctx, 'diff'));
    expect(unstaged).toContain('diff --git a/exists.md b/exists.md');
    expect(unstaged).toContain('-old\n+new\n');
    expect(runner.commands.at(-1)).toEqual([
      'git',
      'diff',
      '--no-color',
      '--no-ext-diff',
      '--no-relative',
      '--',
    ]);
    await git('add', 'exists.md');
    expect(await run(z.string(), (ctx) => exec.diff(ctx, 'staged'), 'staged')).toBe('');
    expect(await run(z.string(), (ctx) => exec.diff(ctx, 'head', 'HEAD'), 'head')).toContain(
      '+new\n',
    );
    const next = await commit('change');
    const range = await run(
      z.string(),
      (ctx) => exec.diff(ctx, 'range', `${base}..${next}`, { cwd: 'sub' }),
      'range',
    );
    expect(range).toContain('diff --git a/exists.md b/exists.md');
    expect(runner.commands.at(-1)).toEqual([
      'git',
      'diff',
      '--no-color',
      '--no-ext-diff',
      '--no-relative',
      `${base}..${next}`,
      '--',
    ]);
  });

  it('diff refuses a truncated diff', async () => {
    await writeFile(join(repo, 'exists.md'), 'new\n'.repeat(100));
    const truncated = workflow(z.string(), (ctx) =>
      exec.diff(ctx, 'diff', undefined, { maxOutputBytes: 16 }),
    );
    await expect(runWorkflow(truncated, options('truncated'))).rejects.toThrow(
      'Incomplete Git output: diff',
    );
  });

  it('changedFiles lists both sides of a rename and unquoted paths', async () => {
    await git('mv', 'exists.md', 'moved.md');
    await mkdir(join(repo, 'odd dir'));
    await writeFile(join(repo, 'odd dir', 'ünï "q".md'), 'x\n');
    await commit('rename and add');
    await writeFile(join(repo, 'sub', 'keep.md'), 'changed\n');
    await writeFile(join(repo, 'untracked.md'), 'x\n');
    const committed = await run(z.array(z.string()), (ctx) =>
      exec.changedFiles(ctx, 'files', `${base}..HEAD`),
    );
    expect([...committed].sort()).toEqual(['exists.md', 'moved.md', 'odd dir/ünï "q".md'].sort());
    expect(runner.commands.at(-1)).toEqual([
      'git',
      'diff',
      '--name-only',
      '-z',
      '--no-renames',
      '--no-relative',
      `${base}..HEAD`,
      '--',
    ]);
    const unstaged = await run(
      z.array(z.string()),
      (ctx) => exec.changedFiles(ctx, 'unstaged', undefined, { cwd: 'sub' }),
      'unstaged',
    );
    expect(unstaged).toEqual(['sub/keep.md']);
  });

  it('commits lists the commits in a range, oldest first', async () => {
    await writeFile(join(repo, 'one.md'), '1\n');
    const first = await commit('one');
    await writeFile(join(repo, 'two.md'), '2\n');
    const second = await commit('two');
    const listed = await run(z.array(z.string()), (ctx) =>
      exec.commits(ctx, 'commits', `${base}..HEAD`),
    );
    expect(listed).toEqual([first, second]);
    expect(runner.commands.at(-1)).toEqual(['git', 'rev-list', '--reverse', `${base}..HEAD`, '--']);
    expect(
      await run(z.array(z.string()), (ctx) => exec.commits(ctx, 'none', 'HEAD..HEAD'), 'none'),
    ).toEqual([]);
  });

  it.each([
    ['diff', (ctx: WorkflowContext, range: string) => exec.diff(ctx, 'q', range)],
    ['diffStat', (ctx: WorkflowContext, range: string) => exec.diffStat(ctx, 'q', range)],
    ['changedFiles', (ctx: WorkflowContext, range: string) => exec.changedFiles(ctx, 'q', range)],
    ['commits', (ctx: WorkflowContext, range: string) => exec.commits(ctx, 'q', range)],
    ['log', (ctx: WorkflowContext, range: string) => exec.log(ctx, 'q', range)],
  ] as const)(
    '%s refuses a range that starts with -, is empty or holds NUL, before any effect',
    async (_name, query) => {
      // One rule for every range helper: text Git would read as an option never reaches it.
      const ranges = ['--output=/tmp/x', '-n1', '-', '--', '', 'a\0b'];
      const refused = workflow(z.array(z.string()), async (ctx) => {
        const messages: string[] = [];
        for (const range of ranges) {
          try {
            await query(ctx, range);
            messages.push('accepted');
          } catch (error) {
            messages.push(error instanceof TypeError ? error.message : 'other');
          }
        }
        return messages;
      });
      expect((await runWorkflow(refused, options('refused'))).output).toEqual(
        ranges.map(
          (range) =>
            `Expected a Git revision or range such as main..HEAD, got ${JSON.stringify(range)}`,
        ),
      );
      expect(runner.commands).toEqual([]);
    },
  );

  it('log lists the commits in a range with their metadata, oldest first', async () => {
    await writeFile(join(repo, 'one.md'), '1\n');
    const first = await commit('Add one');
    await writeFile(join(repo, 'two.md'), '2\n');
    await git('add', '--all');
    await git(
      'commit',
      '--quiet',
      '--author=Ünï Åuthor <u@example.invalid>',
      '--date=2026-01-31T09:30:00+01:00',
      '-m',
      'Fix "quotes", tabs\tand ünïcode\nacross two lines\n\nThe body is not the subject.',
    );
    const second = (await git('rev-parse', 'HEAD')).trim();
    await git('commit', '--quiet', '--allow-empty', '--allow-empty-message', '-m', '');
    const third = (await git('rev-parse', 'HEAD')).trim();
    const listed = await run(z.array(Commit), (ctx) => exec.log(ctx, 'log', `${base}..HEAD`));
    expect(runner.commands.at(-1)).toEqual([
      'git',
      '-c',
      'core.abbrev=auto',
      'log',
      '-z',
      '--reverse',
      '--no-color',
      '--no-show-signature',
      '--encoding=UTF-8',
      '--format=%H%x00%h%x00%an%x00%aI%x00%s',
      '--end-of-options',
      `${base}..HEAD`,
      '--',
    ]);
    expect(listed.map((entry) => entry.sha)).toEqual([first, second, third]);
    for (const entry of listed) {
      expect(entry.sha.startsWith(entry.shortSha), entry.sha).toBe(true);
      expect(Commit.parse(entry)).toEqual(entry);
    }
    expect(listed[0]).toMatchObject({ author: 'Fixture', subject: 'Add one' });
    expect(listed[1]).toEqual({
      sha: second,
      shortSha: second.slice(0, listed[1]?.shortSha.length),
      author: 'Ünï Åuthor',
      date: '2026-01-31T09:30:00+01:00',
      subject: 'Fix "quotes", tabs\tand ünïcode across two lines',
    });
    expect(listed[2]).toMatchObject({ author: 'Fixture', subject: '' });
    // The same commits, in the same order, as std.exec.commits lists them.
    const ids = await run(
      z.array(z.string()),
      (ctx) => exec.commits(ctx, 'commits', `${base}..HEAD`),
      'ids',
    );
    expect(ids).toEqual([first, second, third]);
    expect(
      await run(z.array(Commit), (ctx) => exec.log(ctx, 'none', 'HEAD..HEAD'), 'none'),
    ).toEqual([]);
  });

  it('log abbreviates at Git default length whatever core.abbrev the repository sets', async () => {
    // core.abbrev accepts 4 to 6, which a std.types.Commit's shortSha (7 to 64) would refuse.
    await git('config', '--local', 'core.abbrev', '4');
    await writeFile(join(repo, 'one.md'), '1\n');
    const first = await commit('one');
    const listed = await run(z.array(Commit), (ctx) => exec.log(ctx, 'log', `${base}..HEAD`));
    expect(listed).toMatchObject([{ sha: first, shortSha: first.slice(0, 7), subject: 'one' }]);
  });

  it('log replays the saved listing on resume after a tail failure', async () => {
    await writeFile(join(repo, 'one.md'), '1\n');
    const first = await commit('one');
    const definition = workflow(z.array(Commit), async (ctx) => {
      const listed = await exec.log(ctx, 'log', `${base}..HEAD`);
      await ctx.step('tail', {
        input: null,
        schema: z.null(),
        run({ attempt }) {
          if (attempt === 1) throw new Error('Injected tail failure');
          return null;
        },
      });
      return listed;
    });
    await expect(runWorkflow(definition, options('log-resume'))).rejects.toThrow(
      'Injected tail failure',
    );
    await writeFile(join(repo, 'two.md'), '2\n');
    await commit('two, made after the listing');
    const resumed = await runWorkflow(definition, { ...options('log-resume'), resume: true });
    expect(resumed.output?.map((entry) => entry.sha)).toEqual([first]);
    expect(resumed.steps['log']?.attempts).toBe(1);
    expect(runner.commands).toHaveLength(1);
  });

  it('diffStat summarizes unstaged changes by default and a range when given', async () => {
    expect(await run(z.string(), (ctx) => exec.diffStat(ctx, 'clean'), 'clean')).toBe('');
    await writeFile(join(repo, 'exists.md'), 'new\n');
    await writeFile(join(repo, 'untracked.md'), 'never listed\n');
    expect(await run(z.string(), (ctx) => exec.diffStat(ctx, 'stat'), 'stat')).toBe(
      ' exists.md | 2 +-\n 1 file changed, 1 insertion(+), 1 deletion(-)\n',
    );
    expect(runner.commands.at(-1)).toEqual([
      'git',
      '-c',
      'core.quotePath=false',
      'diff',
      '--stat=10000,10000',
      '--stat-graph-width=40',
      '--no-color',
      '--no-ext-diff',
      '--no-relative',
      '--end-of-options',
      '--',
    ]);
    // A long, non-ASCII path is shown whole and unquoted, whatever width the terminal reports.
    const deep = `${'deep/'.repeat(20)}ünï café.md`;
    await mkdir(join(repo, ...deep.split('/').slice(0, -1)), { recursive: true });
    await writeFile(join(repo, deep), 'line\n'.repeat(100));
    await rm(join(repo, 'untracked.md'));
    const next = await commit('change');
    const columns = process.env['COLUMNS'];
    process.env['COLUMNS'] = '40';
    try {
      const range = await run(
        z.string(),
        (ctx) => exec.diffStat(ctx, 'range', `${base}..${next}`, { cwd: 'sub' }),
        'range',
      );
      const lines = range.split('\n');
      expect(lines[0]).toMatch(/^ deep\/(?:deep\/){19}ünï café\.md \| 100 \+{40}$/u);
      expect(lines[1]).toMatch(/^ exists\.md {2,}\| {3}2 \+-$/u);
      expect(lines.slice(2)).toEqual([' 2 files changed, 101 insertions(+), 1 deletion(-)', '']);
    } finally {
      if (columns === undefined) delete process.env['COLUMNS'];
      else process.env['COLUMNS'] = columns;
    }
    expect(runner.commands.at(-1)).toEqual([
      'git',
      '-c',
      'core.quotePath=false',
      'diff',
      '--stat=10000,10000',
      '--stat-graph-width=40',
      '--no-color',
      '--no-ext-diff',
      '--no-relative',
      '--end-of-options',
      `${base}..${next}`,
      '--',
    ]);
  });

  it('diffStat replays the saved summary on resume after a tail failure', async () => {
    await writeFile(join(repo, 'exists.md'), 'new\n');
    const definition = workflow(z.string(), async (ctx) => {
      const stat = await exec.diffStat(ctx, 'stat', 'HEAD');
      await ctx.step('tail', {
        input: null,
        schema: z.null(),
        run({ attempt }) {
          if (attempt === 1) throw new Error('Injected tail failure');
          return null;
        },
      });
      return stat;
    });
    await expect(runWorkflow(definition, options('stat-resume'))).rejects.toThrow(
      'Injected tail failure',
    );
    await writeFile(join(repo, 'exists.md'), 'old\n');
    const resumed = await runWorkflow(definition, { ...options('stat-resume'), resume: true });
    expect(resumed.output).toContain(' exists.md | 2 +-');
    expect(runner.commands).toHaveLength(1);
  });

  it.each([
    ['diffStat', (ctx: WorkflowContext) => exec.diffStat(ctx, 'q', 'HEAD', { maxOutputBytes: 8 })],
    ['log', (ctx: WorkflowContext) => exec.log(ctx, 'q', 'HEAD', { maxOutputBytes: 8 })],
  ] as const)('%s refuses truncated output', async (_name, query) => {
    await writeFile(join(repo, 'exists.md'), 'new\n');
    await expect(
      runWorkflow(
        workflow(z.unknown(), (ctx) => query(ctx)),
        options('truncated'),
      ),
    ).rejects.toThrow('Incomplete Git output: q');
  });

  it('runs in a runtime worktree when given one', async () => {
    const result = await runWorkflow(
      workflow(
        z.object({ before: z.string(), after: z.string(), files: z.array(z.string()) }),
        async (ctx) => {
          const tree = await ctx.worktree('tree');
          const before = await exec.head(ctx, 'before', { worktree: tree });
          await ctx.step('edit', {
            input: null,
            worktree: tree,
            schema: z.null(),
            async run({ cwd }) {
              await writeFile(join(cwd, 'exists.md'), 'in tree\n');
              return null;
            },
          });
          // The runtime captures the step's change as the handle's next snapshot commit.
          const after = await exec.head(ctx, 'after', { worktree: tree });
          await exec.assertClean(ctx, 'clean', { worktree: tree });
          const files = await exec.changedFiles(ctx, 'files', `${before}..${after}`, {
            worktree: tree,
          });
          return { before, after, files };
        },
      ),
      { ...options('worktree'), worktrees: { root: join(root, 'worktrees') } },
    );
    expect(result.output?.before).toBe(base);
    expect(result.output?.after).not.toBe(base);
    expect(result.output?.files).toEqual(['exists.md']);
    expect(await git('status', '--porcelain')).toBe('');
  });
});
