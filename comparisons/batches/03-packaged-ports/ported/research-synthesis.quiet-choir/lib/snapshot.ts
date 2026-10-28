// The snapshot the local roles read: HEAD, pinned once before any of them runs, and a check that a
// read-only role's call left it unchanged.
import type { WorkflowContext, WorktreeChange } from 'quiet-choir';
import * as std from 'quiet-choir/std';
import { Sha } from '../contracts.js';

export const headCommit = async (ctx: WorkflowContext) =>
  Sha.parse((await std.exec.git(ctx, 'head', ['rev-parse', '--verify', 'HEAD^{commit}'])).trim());

/** A local role's output, refused when the call changed its snapshot. */
export function unchanged<T>(result: { output: T; worktree?: WorktreeChange }): T {
  if (!result.worktree) throw new Error('A snapshot call returned no receipt');
  if (result.worktree.files.length)
    throw new Error(
      `A read-only role changed its snapshot: ${JSON.stringify(result.worktree.files)}`,
    );
  return result.output;
}
