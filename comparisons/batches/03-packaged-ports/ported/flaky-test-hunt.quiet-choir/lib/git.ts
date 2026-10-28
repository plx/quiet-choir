// Git facts as durable effects: the clean baseline, the history and CI-artifact evidence the
// sweepers cannot gather without a shell, the tracked test-file screen and the stress residue.
import type { WorkflowContext } from 'quiet-choir';
import * as std from 'quiet-choir/std';
import { History, Sha } from '../contracts.js';
import { historyFacts, historyLimits, logFormat, withPatches } from './policy.js';

/**
 * Require a clean checkout, at `expected` unless it is null, and return its HEAD. This is a local
 * step that throws, not a completed `git status` read: a completed read would replay its dirty
 * output on every resume, so cleaning the checkout and resuming could never pass.
 */
export const cleanAt = (ctx: WorkflowContext, id: string, expected: string | null) =>
  ctx.step(id, {
    input: { expected },
    schema: Sha,
    async run({ exec }) {
      const status = await exec(['git', 'status', '--porcelain=v1', '--untracked-files=all']);
      if (status.stdout !== '' || status.truncated)
        throw new Error(
          `The checkout must be clean (${id}); remove these changes and resume:\n${status.stdout}`,
        );
      const head = (await exec(['git', 'rev-parse', 'HEAD'])).stdout.trim();
      if (expected !== null && head !== expected)
        throw new Error(`The checkout moved from ${expected} to ${head} (${id})`);
      return head;
    },
  });

/** Inner Git reads of the history step may be long; only its reduced facts are checkpointed. */
const longRead = 64 * 1024 * 1024;
const globs = (testFiles: readonly string[]) => testFiles.map((glob) => `:(glob)${glob}`);

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
      const read = async (args: [string, ...string[]]) => {
        const result = await exec(['git', ...args], { maxOutputBytes: longRead });
        if (result.truncated) throw new Error(`Incomplete Git output: git ${args[0]}`);
        return result.stdout;
      };
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
      const facts = historyFacts(log, new Set(listed.split('\0').filter(Boolean)));
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

/**
 * Which of `files` Git tracks, matched literally, and which of those match the operator's test
 * globs: the second listing excludes the globs, leaving the tracked files that are not tests.
 */
export async function classify(ctx: WorkflowContext, files: string[], testFiles: string[]) {
  if (!files.length) return { tracked: new Set<string>(), tests: new Set<string>() };
  const literal = [...new Set(files)].map((file) => `:(literal)${file}`);
  const list = async (id: string, pathspecs: string[]) =>
    new Set(
      (await std.exec.git(ctx, id, ['ls-files', '-z', '--', ...pathspecs]))
        .split('\0')
        .filter(Boolean),
    );
  const tracked = await list('tracked', literal);
  const other = await list('not-tests', [
    ...literal,
    ...testFiles.map((glob) => `:(exclude,glob)${glob}`),
  ]);
  return { tracked, tests: new Set([...tracked].filter((file) => !other.has(file))) };
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
