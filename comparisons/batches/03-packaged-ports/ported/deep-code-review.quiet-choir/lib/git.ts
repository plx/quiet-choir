// Git mechanics as durable commands: code pins the range, lists the changed files and cuts the
// patch the reviewers read, so no agent resolves the diff. Pathspecs are anchored at the
// repository root with :(top), because Git prints diff paths from the root whatever the cwd.
import { ExecError, type WorkflowContext } from 'quiet-choir';
import * as std from 'quiet-choir/std';
import { Sha, type ChangedFile } from '../contracts.js';

export interface Range {
  readonly base: string;
  readonly head: string;
}

/**
 * A Git command that exits nonzero fails the run either way; the rethrow only adds what failed and
 * Git's stderr, which its ExecError message ("Command exited with 128.") leaves out. Cancellation
 * and every other error pass through unchanged, and nothing is caught into another branch.
 */
async function named<T>(what: string, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (!(error instanceof ExecError) || error.kind !== 'process') throw error;
    throw new Error(`${what}: ${error.diagnostics.stderrTail.trim()}`, { cause: error });
  }
}

const commit = (ctx: WorkflowContext, id: string, revision: string) =>
  named(`Cannot resolve the ${id} revision ${JSON.stringify(revision)} to a commit`, async () =>
    Sha.parse(
      (
        await std.exec.git(ctx, id, [
          'rev-parse',
          '--verify',
          '--end-of-options',
          `${revision}^{commit}`,
        ])
      ).trim(),
    ),
  );

/** Pin the head and its merge base with `base`, so the patch is what a pull request shows. */
export async function pinRange(ctx: WorkflowContext, base: string, head: string): Promise<Range> {
  const tip = await commit(ctx, 'base', base);
  const end = await commit(ctx, 'head', head);
  const start = await named(`The base ${base} and head ${head} share no history`, () =>
    std.exec.git(ctx, 'merge-base', ['merge-base', tip, end]),
  );
  return { base: Sha.parse(start.trim()), head: end };
}

const diff = ['diff', '--no-ext-diff', '--no-renames', '--no-color'] as const;

/** One `-z --numstat` record: added, deleted and the path, with `-` counts for a binary file. */
function numstat(record: string): ChangedFile {
  const [added = '', deleted = '', ...path] = record.split('\t');
  const count = (value: string) => (value === '-' ? null : Number.parseInt(value, 10));
  return { path: path.join('\t'), added: count(added), deleted: count(deleted) };
}

/** Every changed file in scope with its line counts, in Git's path order. */
export async function changedFiles(
  ctx: WorkflowContext,
  range: Range,
  paths: readonly string[],
): Promise<ChangedFile[]> {
  const listed = await std.exec.git(ctx, 'files', [
    ...diff,
    '--numstat',
    '-z',
    range.base,
    range.head,
    '--',
    ...paths.map((path) => `:(top)${path}`),
  ]);
  return listed.split('\0').filter(Boolean).map(numstat);
}

/** The patch of exactly these files, matched literally; never call it with an empty list. */
export function patchOf(ctx: WorkflowContext, id: string, range: Range, files: readonly string[]) {
  if (!files.length) throw new Error('A patch needs at least one file');
  return std.exec.git(
    ctx,
    id,
    [...diff, range.base, range.head, '--', ...files.map((file) => `:(top,literal)${file}`)],
    { maxOutputBytes: 4 * 1024 * 1024 },
  );
}
