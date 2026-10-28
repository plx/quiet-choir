// Git and command mechanics as durable effects. Every test command settles with onError: 'return',
// so a nonzero exit, timeout or signal is a recorded result, not a crash.
import type { WorkflowContext, WorktreeHandle } from 'quiet-choir';
import * as std from 'quiet-choir/std';
import { Sha, type Check } from '../contracts.js';

/** Fail unless the repository has no tracked or untracked change: publication needs a clean tree. */
export async function assertClean(ctx: WorkflowContext, id: string) {
  const status = await std.exec.git(ctx, id, ['status', '--porcelain=v1', '--untracked-files=all']);
  if (status !== '') throw new Error(`Expected a clean repository (${id}): ${status}`);
}

/** The commit every net writer's checkout starts from. */
export const baseCommit = async (ctx: WorkflowContext) =>
  Sha.parse((await std.exec.git(ctx, 'base', ['rev-parse', 'HEAD'])).trim());

/**
 * Whether the checkout's HEAD is still `base`. `ctx.merge` with `target: 'checkout'` rebases onto
 * whatever HEAD is when it prepares, so a checkout that moved would receive an unverified tree.
 */
export const stillAt = async (ctx: WorkflowContext, id: string, base: string) =>
  (await std.exec.git(ctx, id, ['rev-parse', 'HEAD'])).trim() === base;

/** The text of `path` at `commit`, read as command `id`. */
export const show = (ctx: WorkflowContext, id: string, commit: string, path: string) =>
  std.exec.git(ctx, id, ['show', `${commit}:${path}`], { maxOutputBytes: 8 * 1024 * 1024 });

/** Run one argv in `tree` as command `id`, returning its row and the tail of its output. */
export async function run(
  ctx: WorkflowContext,
  id: string,
  tree: WorktreeHandle,
  argv: Check['argv'],
): Promise<{ check: Check; output: string }> {
  const result = await ctx.exec(id, argv, { worktree: tree, onError: 'return' });
  if (result.ok)
    return {
      check: { argv, code: result.value.code, truncated: result.value.truncated, failure: null },
      output: (result.value.stdout + result.value.stderr).slice(-4096),
    };
  // A settled failure carries no truncation flag, so `truncated: null` means unknown.
  return {
    check: { argv, code: result.error.code ?? null, truncated: null, failure: result.error.kind },
    output: `${result.error.stdoutTail ?? ''}${result.error.stderrTail ?? ''}`,
  };
}

/**
 * A command passed when it exited 0 normally. Output past the capture limit is still kept (its
 * head and tail) and reported as `truncated`, but it says nothing about the exit status.
 */
export const green = (check: Check) => check.failure === null && check.code === 0;
export const passed = (checks: Check[]) => checks.every(green);

/** Run every command in `tree`, in order, as `verify/<n>`, recording each outcome. */
export async function verify(
  ctx: WorkflowContext,
  tree: WorktreeHandle,
  commands: Check['argv'][],
): Promise<Check[]> {
  const checks: Check[] = [];
  for (const [index, argv] of commands.entries())
    checks.push((await run(ctx, ctx.id('verify', index), tree, argv)).check);
  return checks;
}

/** The argv that runs one net: the operator's test command with the net's path appended. */
export const netArgv = (testCommand: Check['argv'], netFile: string): Check['argv'] => [
  ...testCommand,
  netFile,
];
