// Git and verification mechanics as durable commands. Verification commands settle with
// onError: 'return', so a nonzero exit, timeout or signal is a recorded result, not a crash.
import type { WorkflowContext, WorktreeHandle } from 'quiet-choir';
import * as std from 'quiet-choir/std';
import { Sha, type Check, type Plan } from '../contracts.js';

/** Fail unless the repository has no tracked or untracked change. */
export async function assertClean(ctx: WorkflowContext, id: string) {
  const status = await std.exec.git(ctx, id, ['status', '--porcelain=v1', '--untracked-files=all']);
  if (status !== '') throw new Error(`Expected a clean repository (${id}): ${status}`);
}

/** The commit every setter's isolated checkout starts from, and its file list. */
export async function baseline(ctx: WorkflowContext) {
  const base = Sha.parse((await std.exec.git(ctx, 'base', ['rev-parse', 'HEAD'])).trim());
  const inventory = await std.exec.git(ctx, 'inventory', ['ls-tree', '-r', '--name-only', base]);
  return { base, inventory };
}

/** Run every approved argv command in the integrated tree, in order, recording each outcome. */
export async function verify(
  ctx: WorkflowContext,
  tree: WorktreeHandle,
  commands: Plan['verifyCommands'],
): Promise<Check[]> {
  const checks: Check[] = [];
  for (const [index, argv] of commands.entries()) {
    const result = await ctx.exec(ctx.id('verify', index), argv, {
      worktree: tree,
      onError: 'return',
    });
    // A settled failure carries no truncation flag, so `truncated: null` means unknown and
    // `failure` names its kind.
    checks.push(
      result.ok
        ? { argv, code: result.value.code, truncated: result.value.truncated, failure: null }
        : { argv, code: result.error.code ?? null, truncated: null, failure: result.error.kind },
    );
  }
  return checks;
}

export const passed = (checks: Check[]) =>
  checks.every((check) => check.failure === null && !check.truncated);
