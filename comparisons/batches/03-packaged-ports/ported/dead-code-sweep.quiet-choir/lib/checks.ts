// Git and verification mechanics as durable commands. Verification commands settle with
// onError: 'return', so a nonzero exit, timeout or signal is a recorded result, not a crash.
import type { WorkflowContext, WorktreeHandle } from 'quiet-choir';
import * as std from 'quiet-choir/std';
import { Sha, type Check } from '../contracts.js';

/** The commit the remover's isolated checkout starts from. */
export const baseCommit = async (ctx: WorkflowContext) =>
  Sha.parse((await std.exec.git(ctx, 'base', ['rev-parse', 'HEAD'])).trim());

/** Run every verification command in the integrated tree, in order, recording each outcome. */
export async function verify(
  ctx: WorkflowContext,
  tree: WorktreeHandle,
  commands: Check['argv'][],
): Promise<Check[]> {
  const checks: Check[] = [];
  for (const [index, argv] of commands.entries()) {
    const result = await ctx.exec(ctx.id('verify', index), argv, {
      worktree: tree,
      onError: 'return',
    });
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
