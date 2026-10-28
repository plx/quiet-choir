// Git mechanics as durable commands: code pins the audited revision, and looks up the files a lens
// cited at that revision, so a finding about a file or line that does not exist never pays a
// panel. Each lookup reads only the cited files, never a listing of the whole tree.
import { ExecError, type WorkflowContext } from 'quiet-choir';
import * as std from 'quiet-choir/std';
import { Sha } from '../contracts.js';

/**
 * A Git command that exits nonzero fails the run either way; the rethrow only adds what failed and
 * Git's stderr, which its ExecError message ("Command exited with 128.") leaves out.
 */
async function named<T>(what: string, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (!(error instanceof ExecError) || error.kind !== 'process') throw error;
    throw new Error(`${what}: ${error.diagnostics.stderrTail.trim()}`, { cause: error });
  }
}

/** Pin `revision` to the commit every reader's snapshot starts from. */
export const pinRevision = (ctx: WorkflowContext, revision: string) =>
  named(`Cannot resolve the revision ${JSON.stringify(revision)} to a commit`, async () =>
    Sha.parse(
      (
        await std.exec.git(ctx, 'revision', [
          'rev-parse',
          '--verify',
          '--end-of-options',
          `${revision}^{commit}`,
        ])
      ).trim(),
    ),
  );

/**
 * The way up from the run's directory to the repository root ('' at the root). An isolated call
 * keeps the run's position inside the repository, so snapshot readers get it as `cwd` to start at
 * the root their prompts promise.
 */
export const toRoot = async (ctx: WorkflowContext) =>
  (await std.exec.git(ctx, 'root', ['rev-parse', '--show-cdup'])).trim().replace(/\/$/u, '');

/** A cited path at the audited commit: its object type, and its line count when it is text. */
export interface Located {
  readonly type: 'blob' | 'tree' | 'missing' | 'other';
  readonly lines: number | null;
}

const typeOf = (line: string): Located['type'] =>
  line === 'blob' || line === 'tree' ? line : line.endsWith(' missing') ? 'missing' : 'other';

/**
 * Look up every distinct cited file at `commit`: `cat-file --batch-check` answers one line per
 * `<commit>:<path>` input, in order, and `grep --count` counts the lines of the text blobs among
 * them (an empty or binary blob prints nothing, and no match at all exits 1). `--full-name` keeps
 * grep's paths root-relative when the run starts in a subdirectory.
 */
export async function locate(
  ctx: WorkflowContext,
  commit: string,
  files: readonly string[],
): Promise<Map<string, Located>> {
  const paths = [...new Set(files)];
  if (!paths.length) return new Map();
  const types = (
    await std.exec.git(ctx, 'locate', ['cat-file', '--batch-check=%(objecttype)'], {
      input: paths.map((path) => `${commit}:${path}\n`).join(''),
    })
  ).split('\n');
  const blobs = paths.filter((_, index) => typeOf(types[index] ?? '') === 'blob');
  const counted = blobs.length
    ? await std.exec.git(
        ctx,
        'lines',
        [
          'grep',
          '--full-name',
          '--count',
          '-I',
          '-z',
          '-e',
          '',
          commit,
          '--',
          ...blobs.map((path) => `:(top,literal)${path}`),
        ],
        { okExitCodes: [0, 1] },
      )
    : '';
  const lines = new Map<string, number>();
  for (const record of counted.split('\n').filter(Boolean)) {
    const [name = '', count = ''] = record.split('\0');
    lines.set(name.slice(commit.length + 1), Number.parseInt(count, 10));
  }
  return new Map(
    paths.map((path, index) => {
      const type = typeOf(types[index] ?? '');
      return [path, { type, lines: type === 'blob' ? (lines.get(path) ?? 0) : null }];
    }),
  );
}
