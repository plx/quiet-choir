import { delimiter } from 'node:path';
import type { HarnessInvocation } from '../workflow/runtime/model.js';
import type { ExecResult, ProcessRunner } from '../workflow/runtime/exec-model.js';
import { ExecError } from '../workflow/runtime/exec-error.js';
import { execResultSchema } from '../workflow/runtime/exec-schema.js';

/**
 * A temporary object directory that takes every object Git writes, with the repository's own object
 * directory as a read-only alternate. Dry-run merge previews (#310) compute through it, so they write
 * nothing into the repository. @internal
 */
export interface GitQuarantine {
  /** The temporary object directory, exported as `GIT_OBJECT_DIRECTORY` and `GIT_QUARANTINE_PATH`. */
  readonly objects: string;
  /** The repository's object directory, exported as `GIT_ALTERNATE_OBJECT_DIRECTORIES`. */
  readonly alternate: string;
}

/** The only commands a quarantined driver runs: none of them updates a ref, index or checkout. */
const quarantinedCommands = new Set(['rev-parse', 'merge-tree', 'commit-tree', 'var']);

/**
 * Whether a read-only driver runs `args`, each form exactly as listed, with no extra argument:
 * - `rev-parse` with any arguments, and `--version`.
 * - `config --name-only --get-regexp <pattern>`, which lists configuration names, and
 *   `config --type=bool --get <name>`, which reads one boolean.
 * - `ls-files --stage -z`, which lists the index's entries (the rehearsal finds gitlinks in it).
 * - The merge target checks a rehearsal shares with the real merge (#312): `check-ref-format <ref>`
 *   and `symbolic-ref -q <ref>`, each with exactly one operand that is not an option (a second
 *   `symbolic-ref` operand would write the ref, as would `-d`), `worktree list --porcelain -z`, and
 *   `status --porcelain --untracked-files=normal --no-renames`, which the driver's
 *   `GIT_OPTIONAL_LOCKS=0` keeps from refreshing the index. Git older than 2.44 ignores
 *   `GIT_NO_LAZY_FETCH`, so the rehearsal never runs `status` in a partial clone on such Git: it
 *   refuses with a configuration error instead.
 *
 * None of them can write to the repository.
 */
function readOnlyCommand(args: readonly string[]): boolean {
  const [name, first, second, third] = args;
  const operand = (value: string | undefined) => value !== undefined && !value.startsWith('-');
  switch (name) {
    case 'rev-parse':
      return true;
    case '--version':
      return args.length === 1;
    case 'check-ref-format':
      return args.length === 2 && operand(first);
    case 'symbolic-ref':
      return args.length === 3 && first === '-q' && operand(second);
    case 'status':
      return (
        args.length === 4 &&
        first === '--porcelain' &&
        second === '--untracked-files=normal' &&
        third === '--no-renames'
      );
    case 'worktree':
      return args.length === 4 && first === 'list' && second === '--porcelain' && third === '-z';
    case 'ls-files':
      return args.length === 3 && first === '--stage' && second === '-z';
    case 'config':
      return (
        args.length === 4 &&
        ((first === '--name-only' && second === '--get-regexp') ||
          (first === '--type=bool' && second === '--get'))
      );
    default:
      return false;
  }
}

/** The forms {@link readOnlyCommand} accepts, as its refusal names them. */
const readOnlyForms =
  'rev-parse, --version, check-ref-format <ref>, symbolic-ref -q <ref>, worktree list --porcelain -z, status --porcelain --untracked-files=normal --no-renames, ls-files --stage -z, config --name-only --get-regexp and config --type=bool --get';

/**
 * Quote one `GIT_ALTERNATE_OBJECT_DIRECTORIES` entry as a C-style string when Git would otherwise
 * split it at the platform path delimiter or read it as quoted. @internal
 */
export function alternateEntry(path: string, separator: string = delimiter): string {
  if (!path.includes(separator) && !path.startsWith('"')) return path;
  let quoted = '"';
  for (const character of path) {
    const code = character.charCodeAt(0);
    quoted +=
      character === '\\' || character === '"'
        ? `\\${character}`
        : code < 0x20 || code === 0x7f
          ? `\\${code.toString(8).padStart(3, '0')}`
          : character;
  }
  return `${quoted}"`;
}

/** Command protocol for local Git operations; the caller owns sequencing and checkpoint policy. @internal */
export class WorktreeGit {
  /** Fixed environment applied last, so neither the caller's nor the per-call environment overrides it. */
  private readonly fixedEnv: Readonly<Record<string, string>> | undefined;

  /**
   * @param mode - `true` refuses, before it reaches the runner, every command except `rev-parse`,
   * `--version`, a `config --name-only --get-regexp` listing, a `config --type=bool --get` read, an
   * `ls-files --stage -z` index listing and the exact merge target checks (`check-ref-format <ref>`, `symbolic-ref -q <ref>`, `worktree list
   * --porcelain -z` and `status --porcelain --untracked-files=normal --no-renames`).
   * Dry-run rehearsal resolves bases, checks the Git version, merge targets and the source
   * checkout, finds submodules, and checks for custom merge drivers and renormalizing filters
   * through this mode, so
   * it can never create refs, worktrees or objects. `GIT_OPTIONAL_LOCKS=0` keeps `status` from
   * refreshing the index, and it never fetches a missing object from a partial clone's promisor
   * remote (`GIT_NO_LAZY_FETCH`, which Git honors from 2.44; the rehearsal refuses merge previews
   * and `status` reads in a partial clone on older Git instead of running them). Both are fixed
   * whatever the caller's environment sets.
   * `{ quarantine }` runs only `rev-parse`, `merge-tree`, `commit-tree` and `var`, and points every
   * command at the quarantine's object directory, after the caller's `GIT_*` variables are removed
   * and the per-call environment applied, so new objects land there, Git refuses ref updates and
   * nothing lazy-fetches.
   */
  public constructor(
    private readonly runner: ProcessRunner,
    private readonly mode: boolean | { readonly quarantine: GitQuarantine } = false,
  ) {
    this.fixedEnv =
      mode === true
        ? // `status` would otherwise opportunistically rewrite the index to refresh stat data.
          { GIT_NO_LAZY_FETCH: '1', GIT_OPTIONAL_LOCKS: '0' }
        : typeof mode === 'object'
          ? {
              GIT_OBJECT_DIRECTORY: mode.quarantine.objects,
              GIT_ALTERNATE_OBJECT_DIRECTORIES: alternateEntry(mode.quarantine.alternate),
              // Git refuses every ref update while this is set (its receive-pack quarantine).
              GIT_QUARANTINE_PATH: mode.quarantine.objects,
              // A partial clone must not fetch missing objects during a preview.
              GIT_NO_LAZY_FETCH: '1',
            }
          : undefined;
  }

  public async run(
    cwd: string,
    args: readonly string[],
    invocation: HarnessInvocation,
    options: {
      readonly input?: string;
      readonly codes?: readonly number[];
      readonly env?: Readonly<Record<string, string>>;
      readonly timeoutMs?: number;
    } = {},
  ): Promise<ExecResult> {
    if (this.mode === true && !readOnlyCommand(args))
      throw new Error(
        `Read-only Git refuses ${args[0] ?? 'an empty command'}; only ${readOnlyForms} run.`,
      );
    if (typeof this.mode === 'object' && !quarantinedCommands.has(args[0] ?? ''))
      throw new Error(
        `Quarantined Git refuses ${args[0] ?? 'an empty command'}; only rev-parse, merge-tree, commit-tree and var run.`,
      );
    // Caller environment must not redirect repository/index ownership away from -C cwd. Windows
    // names are case-insensitive, so strip every casing on all platforms.
    const env = Object.fromEntries(
      Object.entries(process.env).filter(
        (entry): entry is [string, string] =>
          entry[1] !== undefined && !entry[0].toUpperCase().startsWith('GIT_'),
      ),
    );
    const result = execResultSchema.parse(
      await this.runner.run(
        {
          command: [
            'git',
            '-c',
            `core.hooksPath=${process.platform === 'win32' ? 'NUL' : '/dev/null'}`,
            '-c',
            'core.fsmonitor=false',
            '-c',
            'commit.gpgSign=false',
            '-c',
            'gc.auto=0',
            '-C',
            cwd,
            ...args,
          ],
          cwd,
          env: { ...env, ...options.env, LC_ALL: 'C', ...this.fixedEnv },
          inheritEnv: false,
          input: options.input ?? '',
          timeoutMs: options.timeoutMs ?? 120_000,
          maxOutputBytes: 16 * 1024 * 1024,
          capture: 'error',
          schema: null,
        },
        invocation,
      ),
    );
    if (result.truncated)
      throw new ExecError('Git output exceeded its capture limit.', 'output-limit', result);
    if (
      result.code === null ||
      result.signal !== null ||
      !(options.codes ?? [0]).includes(result.code)
    )
      throw new ExecError(
        `Git ${args[0] ?? 'command'} failed: ${result.stderr ? result.stderr.slice(-1024) : (result.signal ?? String(result.code))}`,
        'process',
        result,
      );
    return result;
  }

  public async text(
    cwd: string,
    args: readonly string[],
    invocation: HarnessInvocation,
  ): Promise<string> {
    const output = (await this.run(cwd, args, invocation)).stdout;
    return output.endsWith('\n') ? output.slice(0, -1) : output;
  }
}

/** Validate IDs before using them as Git revisions, paths, or ref values. @internal */
export function commitId(value: string): string {
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(value))
    throw new Error('Git did not return a full object ID.');
  return value;
}

/** Parse merge-tree -z --name-only output without interpreting marker text or localized messages. @internal */
export function mergeTreeOutput(result: ExecResult): { tree: string; conflicts: string[] } {
  const parts = result.stdout.split('\0');
  const tree = commitId(parts.shift() ?? '');
  if (result.code === 0) return { tree, conflicts: [] };
  if (result.code !== 1) throw new ExecError('Git merge-tree did not complete.', 'process', result);
  const boundary = parts.indexOf('');
  return {
    tree,
    conflicts: [...new Set(parts.slice(0, boundary === -1 ? parts.length : boundary))],
  };
}

/** Parse git diff --name-status -z, retaining raw UTF-8 path boundaries. @internal */
export function changedFiles(
  output: string,
): { path: string; status: 'added' | 'modified' | 'deleted' | 'renamed' }[] {
  const fields = output.split('\0');
  if (fields.at(-1) === '') fields.pop();
  const files: ReturnType<typeof changedFiles> = [];
  while (fields.length) {
    const code = fields.shift();
    const source = fields.shift();
    if (!code || source === undefined) throw new Error('Invalid Git name-status output.');
    const destination = /^[RC]/u.test(code) ? fields.shift() : source;
    if (destination === undefined) throw new Error('Invalid Git rename output.');
    const status = code.startsWith('R')
      ? 'renamed'
      : code === 'A' || code.startsWith('C')
        ? 'added'
        : code === 'D'
          ? 'deleted'
          : code === 'M' || code === 'T'
            ? 'modified'
            : undefined;
    if (status === undefined) throw new Error(`Unsupported Git change status: ${code}`);
    files.push({ path: destination, status });
  }
  return files;
}
