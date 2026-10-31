// Git and command mechanics as durable effects. Every test and verify command runs with
// okExitCodes 'any' and onError 'return': a nonzero exit completes with its output, which a repair
// round needs (a settled failure keeps only 1024 characters per stream), and a timeout or signal
// is a recorded result, not a crash. Code judges the exit status.
import type { WorkflowContext, WorktreeHandle } from 'quiet-choir';
import * as std from 'quiet-choir/std';
import { Sha, type Check } from '../contracts.js';
import { bounded } from './policy.js';

/**
 * The checkout's uncommitted and untracked changes as one line, or null when it is clean. A dirty
 * checkout is a result, not a throw: the recorded status would replay on resume after a cleanup.
 */
export async function dirtyFiles(ctx: WorkflowContext, id: string): Promise<string | null> {
  const status = await std.exec.git(ctx, id, ['status', '--porcelain=v1', '--untracked-files=all']);
  const entries = status.split('\n').filter(Boolean);
  return entries.length ? `uncommitted changes: ${entries.join('; ')}` : null;
}

/** The commit every net writer's checkout starts from. */
export const baseCommit = async (ctx: WorkflowContext) =>
  Sha.parse((await std.exec.git(ctx, 'base', ['rev-parse', 'HEAD'])).trim());

/**
 * Whether the checkout's HEAD is still `base`. `ctx.merge` integrates onto whatever HEAD is when
 * it prepares, so a checkout that moved would receive an unverified tree.
 */
export const stillAt = async (ctx: WorkflowContext, id: string, base: string) =>
  (await std.exec.git(ctx, id, ['rev-parse', 'HEAD'])).trim() === base;

/** The merges a run makes, each of which can refuse. */
type MergeStep = 'integrate-nets' | 'integrate' | 'publish';

/**
 * The status of a refused merge (settled): checkout-moved when HEAD has left `base` (checked as
 * `moved/<step>`), since a commit made during the run is what a run-owned integration conflicts
 * with; merge-refused otherwise, such as a dirty checkout at publish. Either way, with its reason.
 */
export async function refused(
  ctx: WorkflowContext,
  step: MergeStep,
  base: string,
  error: { readonly message: string },
) {
  const moved = !(await stillAt(ctx, ctx.id('moved', step), base));
  const status = moved ? ('checkout-moved' as const) : ('merge-refused' as const);
  return { status, refusal: { step, message: error.message } };
}

/**
 * At most `max` bytes of `git <args>` stdout, as command `id`, with the shown byte count when cut.
 * A plain command keeps the first half of its capture on overflow, so capturing twice `max` (and a
 * UTF-8 sequence's slack) keeps the whole excerpt. An overflow is shown in part, not thrown as
 * std.exec.git does: that completed, truncated result would replay on every resume.
 */
export async function excerpt(
  ctx: WorkflowContext,
  id: string,
  args: readonly [string, ...string[]],
  max: number,
) {
  const result = await ctx.exec(id, ['git', ...args], { maxOutputBytes: 2 * max + 8 });
  return bounded(result.stdout, max);
}

/** The characters of each stream's tail a repair round sees. */
const TAIL = 4096;

/** A command's row and the tail of each output stream. */
export interface Ran {
  readonly check: Check;
  readonly stdout: string;
  readonly stderr: string;
}

/** Run one argv in `tree` as command `id`. */
export async function run(
  ctx: WorkflowContext,
  id: string,
  tree: WorktreeHandle,
  argv: Check['argv'],
): Promise<Ran> {
  const result = await ctx.exec(id, argv, {
    worktree: tree,
    okExitCodes: 'any',
    onError: 'return',
  });
  if (result.ok)
    return {
      check: { argv, code: result.value.code, truncated: result.value.truncated, failure: null },
      stdout: result.value.stdout.slice(-TAIL),
      stderr: result.value.stderr.slice(-TAIL),
    };
  // A timeout or signal; a settled failure carries no truncation flag, so `null` means unknown.
  return {
    check: { argv, code: result.error.code ?? null, truncated: null, failure: result.error.kind },
    stdout: result.error.stdoutTail ?? '',
    stderr: result.error.stderrTail ?? '',
  };
}

/**
 * A command passed when it exited 0 normally. Output past the capture limit is still kept (its
 * head and tail) and reported as `truncated`, but it says nothing about the exit status.
 */
export const green = (check: Check) => check.failure === null && check.code === 0;
export const passed = (checks: Check[]) => checks.every(green);

/** How a red command ended, for a reason line: its exit code, or the failure kind. */
export const ended = (check: Check) => check.failure ?? `exit ${String(check.code)}`;

/** Run every command in `tree`, in order, as `<id>/<n>`, recording each outcome. */
export async function verify(
  ctx: WorkflowContext,
  id: string,
  tree: WorktreeHandle,
  commands: Check['argv'][],
): Promise<Check[]> {
  const checks: Check[] = [];
  for (const [index, argv] of commands.entries())
    checks.push((await run(ctx, ctx.id(id, index), tree, argv)).check);
  return checks;
}

/**
 * Run every command, as `<id>/<n>`, in a fresh shared checkout of `commit` (the handle
 * `<id>/tree`); an empty list needs no checkout.
 */
export async function verifyAt(
  ctx: WorkflowContext,
  id: string,
  commit: string,
  commands: Check['argv'][],
): Promise<Check[]> {
  if (!commands.length) return [];
  const tree = await ctx.worktree(ctx.id(id, 'tree'), { base: { commit } });
  return verify(ctx, id, tree, commands);
}

/** The argv that runs one net: the operator's test command with the net's path appended. */
export const netArgv = (testCommand: Check['argv'], netFile: string): Check['argv'] => [
  ...testCommand,
  netFile,
];
