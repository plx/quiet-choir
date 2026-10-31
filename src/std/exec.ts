/**
 * Command and publication helpers that ports re-create: {@link json} for embedding data in
 * prompts, {@link git} for complete Git output, and {@link committedArtifact} for publishing a new
 * file through a managed checkout. Each is a thin, durable composition of public context methods.
 *
 * @module
 */
import { createHash } from 'node:crypto';
import { mkdir, realpath, writeFile } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep, win32 } from 'node:path';
import { z, type ExecOptions, type WorkflowContext, type WriteFileResult } from '../index.js';

/**
 * The revision that identifies the `write` step of {@link committedArtifact}. Its identity is this
 * constant plus the path and content, never the callback text, so a later release that only
 * reformats the helper keeps completed writes replayable. Bump it only when the recorded behavior
 * changes; a bump makes completed `write` steps refuse to replay.
 */
const COMMITTED_ARTIFACT_VERSION = 'committed-artifact/1';

/**
 * Format `value` as two-space indented JSON, the form ports embed in prompts. Prompt text is part
 * of an agent call's identity, so a stable format keeps completed calls replayable.
 *
 * @param value - Any JSON-serializable value.
 * @returns The indented JSON text.
 * @throws TypeError - `Value is not JSON-serializable` when `JSON.stringify` yields no text, as for
 * `undefined`, a function or a symbol. Values it cannot serialize (a cycle, a BigInt) throw its own error.
 */
export function json(value: unknown): string {
  // The standard signature says `string`, but it returns undefined for these values.
  const text = JSON.stringify(value, null, 2) as string | undefined;
  if (text === undefined) throw new TypeError('Value is not JSON-serializable');
  return text;
}

/**
 * Run `git` with `args` as the durable command `id` and return its complete stdout. A silently
 * truncated listing cannot prove coverage, so output past `maxOutputBytes` throws instead of
 * returning the retained head and tail.
 *
 * The read is one plain `ctx.exec` effect, so a truncated read is saved as a completed command
 * before this helper throws. A resume replays it and throws again, even with a larger
 * `maxOutputBytes`, because the cap is policy. Size `maxOutputBytes` for the largest expected read
 * before the first run; after a truncation, read under a new ID or in a new run (#ISSUE-C11-1).
 *
 * A completed read also replays its saved stdout on resume, so do not decide a precondition the
 * operator can fix (a clean checkout, say) on it in the workflow body: the replayed value fails
 * every resume, even after the fix. Throw from a `ctx.step` callback that runs the command through
 * `context.exec` instead, so the failed step runs again.
 *
 * @param ctx - The workflow context.
 * @param id - The command's step ID, scoped like any `ctx.exec` call.
 * @param args - The Git arguments, without `git`.
 * @param options - `ctx.exec` options; failures always throw, so `onError` is not accepted and a forwarded value is overridden.
 * @returns The command's stdout.
 * @throws Error - `Incomplete Git output: <id>` when stdout or stderr was truncated, again on every
 * resume of the same ID, and the `ExecError` of a failed command.
 */
export async function git(
  ctx: WorkflowContext,
  id: string,
  args: readonly [string, ...string[]],
  options?: Omit<ExecOptions, 'onError'>,
): Promise<string> {
  // A caller can still widen `options` to `ExecOptions`, so force the throwing overload at runtime.
  const result = await ctx.exec(id, ['git', ...args], { ...options, onError: 'throw' });
  if (result.truncated) throw new Error(`Incomplete Git output: ${id}`);
  return result.stdout;
}

/**
 * The rule for a path under `ctx.cwd`: not absolute on POSIX or Windows, no drive-letter prefix
 * (`C:/x`, `C:x`), no backslash or NUL, and no `.`, `..`, empty or `.git` segment.
 */
function checkPath(path: string): void {
  const valid =
    path.length > 0 &&
    path.length <= 500 &&
    !path.startsWith('/') &&
    !isAbsolute(path) &&
    !win32.isAbsolute(path) &&
    !/^[A-Za-z]:/u.test(path) &&
    !path.includes('\\') &&
    !path.includes('\0') &&
    path
      .split('/')
      .every((part) => part !== '..' && part !== '.' && part !== '' && part !== '.git');
  if (!valid) throw new Error('Use a repository-relative path without dot segments or .git');
}

/**
 * Publish a new file through a managed checkout, so later writers see a committed artifact rather
 * than an untracked one. It creates the worktree `document`, writes `content` to `path` in one
 * local step `write` on that worktree, then merges it into the workflow checkout as `publish`
 * (`target: 'checkout'`, `onConflict: 'fail'`). The step creates missing parent directories one
 * level at a time, refuses a parent that resolves outside the checkout (through a symbolic link,
 * for example), and refuses a file that already exists in `document`, which starts from the
 * checkout's `HEAD` and keeps that base on resume. Its identity is a versioned constant with the
 * path and content, not the callback text.
 *
 * The checkout must be clean. An untracked file at `path`, or any uncommitted change elsewhere in
 * the checkout (an untracked file Git does not ignore included), gets past the write and fails at
 * `publish` with `Merge target checkout is dirty; commit or stash changes before integration.`
 * Cleaning the checkout and resuming then publishes. A refused write refuses again on resume, even
 * once `HEAD` drops the file, so a workflow that pays for agent calls before publishing should
 * check the path first with a command that fails, such as
 * `ctx.exec('absent', ['test', '!', '-e', path])`. A failed command runs again on resume, while a
 * completed `ctx.readFile` that found the file replays and keeps refusing.
 *
 * The IDs are fixed, so a second call in the same scope collides: wrap each call in `ctx.scope` or
 * call it on `ctx.within(prefix)`.
 *
 * @param ctx - The workflow context.
 * @param path - The target path, relative to `ctx.cwd` (a repository subdirectory when the run
 * starts in one), not to the repository root.
 * @param content - The UTF-8 file content.
 * @returns A receipt: the absolute target under `ctx.cwd`, the content's SHA-256 and byte length,
 * and `previousSha256: null`, since the file did not exist.
 * @throws Error - Before any effect, when `path` is absolute or starts with a drive letter, or has a
 * `.`, `..`, empty or `.git` segment, a backslash or a NUL; from the step, when a parent escapes the
 * checkout or with `Artifact <path> already exists at HEAD` when the file exists there; and from the
 * merge, when it conflicts or the checkout has uncommitted changes: a tracked change or an
 * untracked, non-ignored path (an untracked file already at `path` included).
 */
export async function committedArtifact(
  ctx: WorkflowContext,
  path: string,
  content: string,
): Promise<WriteFileResult> {
  checkPath(path);
  const tree = await ctx.worktree('document');
  await ctx.step('write', {
    input: { out: path, content },
    worktree: tree,
    version: COMMITTED_ARTIFACT_VERSION,
    identity: 'version',
    schema: z.null(),
    async run({ cwd }) {
      const root = await realpath(cwd);
      let parent = root;
      for (const part of path.split('/').slice(0, -1)) {
        parent = resolve(parent, part);
        try {
          await mkdir(parent);
        } catch (error) {
          if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error;
        }
        const actual = relative(root, await realpath(parent));
        const escaped = actual === '..' || actual.startsWith('..' + sep);
        if (escaped || isAbsolute(actual)) throw new Error('Artifact parent escapes checkout');
      }
      try {
        await writeFile(resolve(root, path), content, { flag: 'wx' });
      } catch (error) {
        // Node's message names the private worktree path, so it stays only in the cause.
        if (error instanceof Error && 'code' in error && error.code === 'EEXIST')
          throw new Error(
            `Artifact ${path} already exists at HEAD; committedArtifact only creates files`,
            { cause: error },
          );
        throw error;
      }
      return null;
    },
  });
  await ctx.merge('publish', [tree], { target: 'checkout', onConflict: 'fail' });
  return {
    path: resolve(ctx.cwd, path),
    sha256: createHash('sha256').update(content).digest('hex'),
    bytes: Buffer.byteLength(content),
    previousSha256: null,
  };
}
