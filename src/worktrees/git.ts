import type { HarnessInvocation } from '../workflow/runtime/model.js';
import type { ExecResult, ProcessRunner } from '../workflow/runtime/exec-model.js';
import { ExecError } from '../workflow/runtime/exec-error.js';
import { execResultSchema } from '../workflow/runtime/exec-schema.js';

/** Command protocol for local Git operations; the caller owns sequencing and checkpoint policy. @internal */
export class WorktreeGit {
  /**
   * @param readOnly - Refuse every command except `rev-parse` before it reaches the runner. Dry-run
   * rehearsal resolves bases through this mode, so it can never create refs, worktrees or objects.
   */
  public constructor(
    private readonly runner: ProcessRunner,
    private readonly readOnly = false,
  ) {}

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
    if (this.readOnly && args[0] !== 'rev-parse')
      throw new Error(
        `Read-only Git refuses ${args[0] ?? 'an empty command'}; only rev-parse runs.`,
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
          env: { ...env, ...options.env, LC_ALL: 'C' },
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
