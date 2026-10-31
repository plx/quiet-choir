// Git facts as durable effects: the clean baseline, the history and CI-artifact evidence the
// sweepers cannot gather without a shell, the tracked test-file screen and the stress residue.
import { z, type StepContext, type WorkflowContext } from 'quiet-choir';
import * as std from 'quiet-choir/std';
import { Clean, History } from '../contracts.js';
import { historyFacts, historyLimits, logFormat, withPatches } from './policy.js';

/**
 * Require a clean checkout, at `expected` unless it is null, and return its HEAD with the working
 * directory's prefix in the repository (worktree receipts are repository-relative). This is a
 * local step that throws, not a completed `git status` read: a completed read would replay its
 * dirty output on every resume, so cleaning the checkout and resuming could never pass.
 */
export const cleanAt = (ctx: WorkflowContext, id: string, expected: string | null) =>
  ctx.step(id, {
    input: { expected },
    schema: Clean,
    async run({ exec }) {
      const status = await exec(['git', 'status', '--porcelain=v1', '--untracked-files=all']);
      if (status.stdout !== '' || status.truncated)
        throw new Error(
          `The checkout must be clean (${id}); remove these changes and resume:\n${status.stdout}`,
        );
      const head = (await exec(['git', 'rev-parse', 'HEAD'])).stdout.trim();
      if (expected !== null && head !== expected)
        throw new Error(`The checkout moved from ${expected} to ${head} (${id})`);
      return { head, prefix: (await exec(['git', 'rev-parse', '--show-prefix'])).stdout.trim() };
    },
  });

/** Inner Git reads of local steps may be long; only their reduced facts are checkpointed. */
const longRead = 64 * 1024 * 1024;
const globs = (testFiles: readonly string[]) => testFiles.map((glob) => `:(glob)${glob}`);
/** A complete `git` read inside a local step; truncated output fails the step. */
const reader =
  (exec: StepContext['exec']) =>
  async (args: [string, ...string[]]): Promise<string> => {
    const result = await exec(['git', ...args], { maxOutputBytes: longRead });
    if (result.truncated) throw new Error(`Incomplete Git output: git ${args[0]}`);
    return result.stdout;
  };
const entries = (text: string) => text.split('\0').filter(Boolean);

/**
 * The last `depth` commits' messages and files, reduced to flake mentions (with the test-file
 * diff of the first few) and test-file churn. It is one local step rather than completed `git`
 * reads, so the checkpoint keeps the reduced facts instead of a log that can run to megabytes.
 */
export const history = (
  ctx: WorkflowContext,
  base: string,
  depth: number,
  testFiles: readonly string[],
) =>
  ctx.step('history', {
    input: { base, depth, testFiles: [...testFiles] },
    schema: History,
    async run({ exec }) {
      const read = reader(exec);
      const log = await read([
        'log',
        logFormat,
        '--name-only',
        // Paths relative to the working directory, as the test command and the screen expect.
        '--relative',
        `--max-count=${String(depth)}`,
        base,
        '--',
      ]);
      const listed = await read(['ls-files', '-z', '--', ...globs(testFiles)]);
      const facts = historyFacts(log, new Set(entries(listed)));
      const shas = facts.mentions.slice(0, historyLimits.patched).map((commit) => commit.sha);
      const shown = shas.length
        ? await read([
            'show',
            '--format=%x1e%H',
            '--no-color',
            '--no-ext-diff',
            '--unified=3',
            '--relative',
            ...shas,
            '--',
            ...globs(testFiles),
          ])
        : '';
      return withPatches(facts, shown);
    },
  });

const artifactPatterns = [
  ':(top,glob).github/workflows/*',
  ':(top,glob).circleci/**',
  ':(top,glob).gitlab-ci.yml',
  ':(top,glob).buildkite/**',
  ':(top,glob)Jenkinsfile',
  ':(top,glob)azure-pipelines.yml',
  ':(top,glob,icase)**/*junit*.xml',
  ':(top,glob,icase)**/test-results/**',
  ':(top,glob,icase)**/test-reports/**',
  ':(top,glob,icase)**/*quarantine*',
  ':(top,glob,icase)**/*flaky*',
  ':(top,glob)**/*.trx',
];

/**
 * Tracked CI configuration, test reports and quarantine lists anywhere in the repository, at most
 * `limit` of them listed, relative to the working directory.
 */
export async function artifacts(ctx: WorkflowContext, limit = 60) {
  const listed = await std.exec.git(ctx, 'artifacts', [
    'ls-files',
    '-z',
    '--',
    ...artifactPatterns,
  ]);
  const paths = listed.split('\0').filter(Boolean);
  return { paths: paths.slice(0, limit), unlisted: Math.max(0, paths.length - limit) };
}

const Screened = z.object({ tracked: z.array(z.string()), tests: z.array(z.string()) });

/**
 * Which of `files` Git tracks, matched literally, and which of those the operator's test globs
 * list. Both listings use positive pathspecs only: `git ls-files` ignores an `:(exclude)` pathspec
 * when every positive pathspec shares a directory prefix (Git 2.43). It is one local step, so the
 * checkpoint keeps the screened files rather than every test file the globs list.
 */
export async function classify(ctx: WorkflowContext, files: string[], testFiles: string[]) {
  const unique = [...new Set(files)];
  const screened = unique.length
    ? await ctx.step('screen', {
        input: { files: unique, testFiles },
        schema: Screened,
        async run({ exec }) {
          const read = reader(exec);
          const literal = unique.map((file) => `:(literal)${file}`);
          const tracked = new Set(entries(await read(['ls-files', '-z', '--', ...literal])));
          const tests = new Set(entries(await read(['ls-files', '-z', '--', ...globs(testFiles)])));
          const named = unique.filter((file) => tracked.has(file));
          return { tracked: named, tests: named.filter((file) => tests.has(file)) };
        },
      })
    : { tracked: [], tests: [] };
  return { tracked: new Set(screened.tracked), tests: new Set(screened.tests) };
}

/** What the stress runs left in the checkout: a flake fact, and a publication blocker. */
export async function residue(ctx: WorkflowContext) {
  const status = await std.exec.git(ctx, 'residue', [
    'status',
    '--porcelain=v1',
    '--untracked-files=all',
  ]);
  return status.split('\n').filter(Boolean);
}
