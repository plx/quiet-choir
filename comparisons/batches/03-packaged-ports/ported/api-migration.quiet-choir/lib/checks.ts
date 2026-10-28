// Git and command mechanics as durable effects. Verification commands settle with onError:
// 'return', so a nonzero exit, timeout or signal is a recorded result, not a crash.
import type { WorkflowContext, WorktreeHandle } from 'quiet-choir';
import * as std from 'quiet-choir/std';
import { Sha, type Check, type Failure, type Round } from '../contracts.js';
import { outcomeOf } from './policy.js';

// Listings are complete or fail (std.exec.git refuses truncated output), so allow large ones.
const listing = { maxOutputBytes: 16 * 1024 * 1024 };

/** Fail unless the repository has no tracked or untracked change: publication needs a clean tree. */
export async function assertClean(ctx: WorkflowContext, id: string) {
  const status = await std.exec.git(ctx, id, ['status', '--porcelain=v1', '--untracked-files=all']);
  if (status !== '') throw new Error(`Expected a clean repository (${id}): ${status}`);
}

/** The commit every migrator's isolated checkout starts from. */
export const baseCommit = async (ctx: WorkflowContext) =>
  Sha.parse((await std.exec.git(ctx, 'base', ['rev-parse', 'HEAD'])).trim());

/** Every file tracked at `commit`, repository-relative from any run directory. */
export async function tracked(ctx: WorkflowContext, id: string, commit: string) {
  const args = ['ls-tree', '-r', '-z', '--name-only', '--full-tree', commit] as const;
  return (await std.exec.git(ctx, id, args, listing)).split('\0').filter(Boolean);
}

/** The text files tracked at `commit` that contain any of `terms` as a fixed string. */
export async function mentions(ctx: WorkflowContext, id: string, commit: string, terms: string[]) {
  const patterns = terms.flatMap((term) => ['-e', term]);
  // git grep exits 1 when nothing matches; `:(top)` searches the whole tree from any directory.
  const args = ['grep', '-l', '-z', '-I', '-F', '--full-name', ...patterns, commit, '--', ':(top)'];
  const out = await std.exec.git(ctx, id, args as [string, ...string[]], {
    ...listing,
    okExitCodes: [0, 1],
  });
  return out
    .split('\0')
    .filter(Boolean)
    .map((line) => line.slice(`${commit}:`.length));
}

/** Whether two commits hold the same tree. */
export async function sameTree(ctx: WorkflowContext, id: string, a: string, b: string) {
  const [left, right] = (await std.exec.git(ctx, id, ['rev-parse', `${a}^{tree}`, `${b}^{tree}`]))
    .trim()
    .split('\n');
  return left !== undefined && left === right;
}

/**
 * Run one argv in `tree` as command `id`, returning its row and the tail of its output. A nonzero
 * exit is a completed result (okExitCodes: 'any'), because a settled failure keeps only 1024
 * characters of each stream and the triager needs the red output; a signal or timeout settles.
 */
async function run(ctx: WorkflowContext, id: string, tree: WorktreeHandle, argv: Check['argv']) {
  const result = await ctx.exec(id, argv, {
    worktree: tree,
    okExitCodes: 'any',
    onError: 'return',
  });
  if (result.ok)
    return {
      check: {
        argv,
        code: result.value.code,
        signal: result.value.signal,
        truncated: result.value.truncated,
        failure: null,
      },
      output: (result.value.stdout + result.value.stderr).slice(-4096),
    };
  // A settled failure carries no truncation flag, so `truncated: null` means unknown.
  return {
    check: {
      argv,
      code: result.error.code ?? null,
      signal: result.error.signal ?? null,
      truncated: null,
      failure: result.error.kind,
    },
    output: `${result.error.stdoutTail ?? ''}${result.error.stderrTail ?? ''}`,
  };
}

const green = (check: Check) => check.failure === null && check.code === 0 && !check.truncated;

/**
 * One verification pass over `commit`: every command in a fresh checkout of it (`tree`,
 * `command/<n>`), then a search of the commit for the old API (`leftovers`), kept to the files
 * their migrators reported fully migrated. Call it under a scope per pass.
 */
export async function verifyRound(
  ctx: WorkflowContext,
  options: { commit: string; commands: Check['argv'][]; terms: string[]; migrated: string[] },
): Promise<{ round: Round; failures: Failure[] }> {
  const { commit, commands, terms, migrated } = options;
  const tree = await ctx.worktree('tree', { base: { commit } });
  const checks: Check[] = [];
  const failures: Failure[] = [];
  for (const [index, argv] of commands.entries()) {
    const { check, output } = await run(ctx, ctx.id('command', index), tree, argv);
    checks.push(check);
    if (!green(check))
      failures.push({
        command: argv.join(' '),
        outcome: outcomeOf(check),
        output: output.trimEnd() || '(no output)',
      });
  }
  const found = terms.length ? await mentions(ctx, 'leftovers', commit, terms) : [];
  const leftovers = found.filter((file) => migrated.includes(file));
  const passed = !failures.length && !leftovers.length;
  return { round: { commit: Sha.parse(commit), checks, leftovers, passed }, failures };
}
