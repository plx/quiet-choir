/**
 * Command, Git and publication helpers that ports re-create, each a thin, durable composition of
 * public context methods:
 *
 * - {@link json} formats data for prompts.
 * - {@link check} runs a command whose failure is data, such as a test suite, and returns a
 *   {@link CheckOutcome} with the end of its output.
 * - {@link git} returns complete Git output; {@link head}, {@link status}, {@link assertClean},
 *   {@link diff}, {@link changedFiles} and {@link commits} build on it for common queries.
 * - {@link committedArtifact} publishes a new file through a managed checkout.
 *
 * Each command helper records one `ctx.exec` step under the `id` it is given, so a resume replays
 * the saved result instead of running the command again. The Git helpers take the same options as
 * `ctx.exec` (without `onError`), such as `worktree` or `cwd`, and throw on truncated output.
 *
 * ```ts
 * import * as std from 'quiet-choir/std';
 *
 * await std.exec.assertClean(ctx, 'clean');
 * const base = await std.exec.head(ctx, 'base');
 * const tests = await std.exec.check(ctx, 'tests', ['npm', 'test']);
 * if (!tests.passed) ctx.log(`Tests failed:\n${tests.output}`);
 * const touched = await std.exec.changedFiles(ctx, 'touched', `${base}..HEAD`);
 * ```
 *
 * @module
 */
import { createHash } from 'node:crypto';
import { mkdir, realpath, writeFile } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import {
  z,
  type Command,
  type ExecOptions,
  type WorkflowContext,
  type WriteFileResult,
} from '../index.js';
import { Sha, isRepoPath, type CheckOutcome } from './types.js';

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
 * @param ctx - The workflow context.
 * @param id - The command's step ID, scoped like any `ctx.exec` call.
 * @param args - The Git arguments, without `git`.
 * @param options - `ctx.exec` options; failures always throw, so `onError` is not accepted and a forwarded value is overridden.
 * @returns The command's stdout.
 * @throws Error - `Incomplete Git output: <id>` when stdout or stderr was truncated, and the
 * `ExecError` of a failed command.
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

/** The most characters of output a {@link CheckOutcome} keeps: the end of the combined streams. */
const CHECK_OUTPUT_CHARS = 4000;

/** Characters of each stream a settled command failure keeps (`ExecStepError` tails). */
const FAILURE_TAIL_CHARS = 1024;

/** How many `status` lines an {@link assertClean} failure message lists. */
const DIRTY_LINES_SHOWN = 10;

/** Whether the UTF-16 code unit at `index` of `text` is a low (trailing) surrogate. */
function isLowSurrogate(text: string, index: number): boolean {
  const code = text.charCodeAt(index);
  return code >= 0xdc00 && code <= 0xdfff;
}

/** The last `max` UTF-16 code units of `text`, one fewer when the cut would split a pair. */
function tailChars(text: string, max: number): string {
  if (text.length <= max) return text;
  const start = text.length - max;
  return text.slice(isLowSurrogate(text, start) ? start + 1 : start);
}

/**
 * A saved failure tail without the lone low surrogate its cut can leave at the start: the runtime
 * keeps the last 1024 UTF-16 code units of a stream, which may begin inside a pair.
 */
function savedTail(tail: string | undefined): string {
  if (tail === undefined) return '';
  return isLowSurrogate(tail, 0) ? tail.slice(1) : tail;
}

/** Stdout then stderr, separated by a newline when stdout does not end with one. */
function joinStreams(stdout: string, stderr: string): string {
  if (stdout === '' || stderr === '') return stdout + stderr;
  return stdout.endsWith('\n') ? stdout + stderr : `${stdout}\n${stderr}`;
}

/**
 * Run `command` as the durable command `id` and return its outcome as data, for commands whose
 * failure the workflow handles, such as a test suite or a build. It is
 * `ctx.exec(id, command, { ...options, onError: 'return' })`, so a failure is saved and a resume
 * returns the same outcome without running the command again.
 *
 * `passed` is whether the command settled successfully: it exited with a code in `okExitCodes`
 * (default `[0]`) and no signal. `output` is the end of stdout followed by stderr, at most 4000
 * characters and never starting inside a surrogate pair. After a failure only the saved
 * 1024-character tail of each stream is available (less a half pair its cut leaves at the start),
 * and when both are empty `output` is the
 * failure message instead (a command that could not start, for example). `truncated` reports that
 * `output` may leave something out: the capture overflowed `maxOutputBytes`, the text was cut to
 * its end, or a saved failure tail was full.
 *
 * @param ctx - The workflow context.
 * @param id - The command's step ID, scoped like any `ctx.exec` call.
 * @param command - The argv to run, or an explicit `{ shell }` program.
 * @param options - `ctx.exec` options; `onError` is always `'return'`, so it is not accepted and a
 * forwarded value is overridden.
 * @returns Whether the command passed, its exit code and signal, and the end of its output.
 * @throws Error - Only failures `ctx.exec` does not settle, such as cancellation or a checkpoint
 * failure.
 */
export async function check(
  ctx: WorkflowContext,
  id: string,
  command: Command,
  options?: Omit<ExecOptions, 'onError'>,
): Promise<CheckOutcome> {
  // A caller can still widen `options` to `ExecOptions`, so force the settled overload at runtime.
  const settled = await ctx.exec(id, command, { ...options, onError: 'return' });
  if (settled.ok) {
    const { code, signal, stdout, stderr, truncated } = settled.value;
    const combined = joinStreams(stdout, stderr);
    const output = tailChars(combined, CHECK_OUTPUT_CHARS);
    return { passed: true, code, signal, output, truncated: truncated || output !== combined };
  }
  const { error } = settled;
  const tails = joinStreams(savedTail(error.stdoutTail), savedTail(error.stderrTail));
  const shown = tails === '' ? error.message : tails;
  const output = tailChars(shown, CHECK_OUTPUT_CHARS);
  return {
    passed: false,
    code: error.code ?? null,
    signal: error.signal ?? null,
    output,
    truncated:
      output !== shown ||
      (error.stdoutTail ?? '').length >= FAILURE_TAIL_CHARS ||
      (error.stderrTail ?? '').length >= FAILURE_TAIL_CHARS,
  };
}

/**
 * The arguments for an optional revision range, refusing text Git would read as an option, so a
 * range from data cannot change the command.
 */
function rangeArgs(range: string | undefined): string[] {
  if (range === undefined) return [];
  if (range === '' || range.startsWith('-') || range.includes('\0'))
    throw new TypeError(
      `Expected a Git revision or range such as main..HEAD, got ${JSON.stringify(range)}`,
    );
  return [range];
}

/** Refuse Git output that should be a full object ID. */
function checkSha(id: string, value: string): string {
  if (!Sha.safeParse(value).success)
    throw new Error(
      `Expected a full Git object ID (${id}), got ${JSON.stringify(value.slice(0, 200))}`,
    );
  return value;
}

/**
 * The commit `HEAD` names, from `git rev-parse HEAD` as the durable command `id`. Record it before
 * work that commits, to diff or list the work's commits afterwards. A `--dry-run` rehearsal
 * synthesizes empty stdout for a command, so there it throws unless an exec fixture answers `id`.
 *
 * @param ctx - The workflow context.
 * @param id - The command's step ID.
 * @param options - `ctx.exec` options, such as `worktree` or `cwd`; failures always throw.
 * @returns The full commit ID: 40 (SHA-1) or 64 (SHA-256) lowercase hexadecimal characters.
 * @throws Error - From {@link git}, as when the repository has no commit yet, or when the output is
 * not a full object ID.
 */
export async function head(
  ctx: WorkflowContext,
  id: string,
  options?: Omit<ExecOptions, 'onError'>,
): Promise<string> {
  return checkSha(id, (await git(ctx, id, ['rev-parse', 'HEAD'], options)).trim());
}

/**
 * The working tree's status lines, from `git --no-optional-locks status --porcelain=v1
 * --untracked-files=all` as the durable command `id`: one `XY path` line per changed or untracked
 * file (`XY orig -> path` for a staged rename), with paths relative to the repository root and
 * every untracked file listed individually. Ignored files are not listed. A path with spaces,
 * quotes, control or (under the default `core.quotePath`) non-ASCII characters is shown as Git
 * quotes it, in double quotes with C-style escapes; use {@link changedFiles} for exact paths. It
 * takes no optional locks, so it does not contend with Git commands running beside it.
 *
 * @param ctx - The workflow context.
 * @param id - The command's step ID.
 * @param options - `ctx.exec` options, such as `worktree` or `cwd`; failures always throw.
 * @returns The status lines in Git's order, without line terminators; empty when the tree is clean.
 * @throws Error - From {@link git}.
 */
export async function status(
  ctx: WorkflowContext,
  id: string,
  options?: Omit<ExecOptions, 'onError'>,
): Promise<string[]> {
  const output = await git(
    ctx,
    id,
    ['--no-optional-locks', 'status', '--porcelain=v1', '--untracked-files=all'],
    options,
  );
  return output.split('\n').filter((line) => line !== '');
}

/**
 * Require a clean working tree: no staged, unstaged or untracked change, as {@link status} reports
 * it under the durable command `id`. The status is recorded, so a resume decides the same way: a
 * check that passed still passes after later steps change the tree, and a check that failed fails
 * again even after the tree is cleaned. To check again, start a new run, or fork this one with
 * the step invalidated (`--fork-from <run> --invalidate <step>`).
 *
 * @param ctx - The workflow context.
 * @param id - The command's step ID.
 * @param options - `ctx.exec` options, such as `worktree` or `cwd`; failures always throw.
 * @returns Nothing, when the tree is clean.
 * @throws Error - `Expected a clean working tree (<id>): ...`, listing the first changed paths,
 * and the errors of {@link status}.
 */
export async function assertClean(
  ctx: WorkflowContext,
  id: string,
  options?: Omit<ExecOptions, 'onError'>,
): Promise<void> {
  const lines = await status(ctx, id, options);
  if (lines.length === 0) return;
  const shown = lines.slice(0, DIRTY_LINES_SHOWN).map((line) => line.trim());
  const more =
    lines.length > shown.length ? `; and ${String(lines.length - shown.length)} more` : '';
  throw new Error(
    `Expected a clean working tree (${id}): ${String(lines.length)} changed or untracked ${lines.length === 1 ? 'path' : 'paths'}: ${shown.join('; ')}${more}`,
  );
}

/**
 * A textual diff, from `git diff --no-color --no-ext-diff --no-relative [range] --` as the durable
 * command `id`, with paths relative to the repository root. Without `range` it is the unstaged
 * changes (the working tree against the index); pass `HEAD` for every uncommitted change to
 * tracked files, or a range such as `main...HEAD` for committed work. Untracked files are never
 * included. Output past `maxOutputBytes` (default 1 MiB) throws rather than returning a partial
 * diff.
 *
 * @param ctx - The workflow context.
 * @param id - The command's step ID.
 * @param range - A revision or range; it must not be empty or start with `-`.
 * @param options - `ctx.exec` options, such as `worktree`, `cwd` or `maxOutputBytes`; failures
 * always throw.
 * @returns The diff text; empty when nothing differs.
 * @throws TypeError - Before any effect, when `range` is empty, starts with `-` or contains NUL.
 * @throws Error - From {@link git}.
 */
export async function diff(
  ctx: WorkflowContext,
  id: string,
  range?: string,
  options?: Omit<ExecOptions, 'onError'>,
): Promise<string> {
  return git(
    ctx,
    id,
    ['diff', '--no-color', '--no-ext-diff', '--no-relative', ...rangeArgs(range), '--'],
    options,
  );
}

/**
 * The paths a diff touches, from `git diff --name-only -z --no-renames --no-relative [range] --` as
 * the durable command `id`: relative to the repository root and exactly as stored, never quoted.
 * Rename detection is off, so a renamed file lists both its old and new path. As for {@link diff},
 * without `range` it covers the unstaged changes, and untracked files are never included.
 *
 * @param ctx - The workflow context.
 * @param id - The command's step ID.
 * @param range - A revision or range; it must not be empty or start with `-`.
 * @param options - `ctx.exec` options, such as `worktree` or `cwd`; failures always throw.
 * @returns The changed paths in Git's order; empty when nothing changed.
 * @throws TypeError - Before any effect, when `range` is empty, starts with `-` or contains NUL.
 * @throws Error - From {@link git}.
 */
export async function changedFiles(
  ctx: WorkflowContext,
  id: string,
  range?: string,
  options?: Omit<ExecOptions, 'onError'>,
): Promise<string[]> {
  const output = await git(
    ctx,
    id,
    ['diff', '--name-only', '-z', '--no-renames', '--no-relative', ...rangeArgs(range), '--'],
    options,
  );
  return output.split('\0').filter((path) => path !== '');
}

/**
 * The commits in `range`, oldest first, from `git rev-list --reverse <range> --` as the durable
 * command `id`; for example `${base}..HEAD` lists the commits made since `base`.
 *
 * @param ctx - The workflow context.
 * @param id - The command's step ID.
 * @param range - A revision range such as `main..HEAD`; it must not be empty or start with `-`.
 * @param options - `ctx.exec` options, such as `worktree` or `cwd`; failures always throw.
 * @returns Full commit IDs, oldest first; empty when the range has no commits.
 * @throws TypeError - Before any effect, when `range` is empty, starts with `-` or contains NUL.
 * @throws Error - From {@link git}, or when a line is not a full object ID.
 */
export async function commits(
  ctx: WorkflowContext,
  id: string,
  range: string,
  options?: Omit<ExecOptions, 'onError'>,
): Promise<string[]> {
  const output = await git(ctx, id, ['rev-list', '--reverse', ...rangeArgs(range), '--'], options);
  return output
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => checkSha(id, line));
}

/**
 * The repository-relative path rule of {@link isRepoPath}: not absolute on POSIX or Windows, no
 * drive-letter prefix (`C:/x`, `C:x`), no backslash or NUL, and no `.`, `..`, empty or `.git`
 * segment.
 */
function checkPath(path: string): void {
  if (!isRepoPath(path))
    throw new Error('Use a repository-relative path without dot segments or .git');
}

/**
 * Publish a new file through a managed checkout, so later writers see a committed artifact rather
 * than an untracked one. It creates the worktree `document`, writes `content` to `path` in one
 * local step `write` on that worktree, then merges it into the workflow checkout as `publish`
 * (`target: 'checkout'`, `onConflict: 'fail'`). The step creates missing parent directories one
 * level at a time, refuses a parent that resolves outside the checkout (through a symbolic link,
 * for example), and refuses a file that already exists. Its identity is a versioned constant with
 * the path and content, not the callback text.
 *
 * The IDs are fixed, so a second call in the same scope collides: wrap each call in `ctx.scope` or
 * call it on `ctx.within(prefix)`.
 *
 * @param ctx - The workflow context.
 * @param path - The repository-relative target path.
 * @param content - The UTF-8 file content.
 * @returns A receipt: the absolute target under `ctx.cwd`, the content's SHA-256 and byte length,
 * and `previousSha256: null`, since the file did not exist.
 * @throws Error - Before any effect, when `path` is absolute or starts with a drive letter, or has a
 * `.`, `..`, empty or `.git` segment, a backslash or a NUL; from the step, when a parent escapes the checkout or the file
 * exists; and from the merge, when it conflicts.
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
      await writeFile(resolve(root, path), content, { flag: 'wx' });
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
