// Git and verification mechanics as durable commands. Verification commands settle with
// onError: 'return', so a nonzero exit, timeout or signal is a recorded result, not a crash.
import type { WorkflowContext, WorktreeHandle } from 'quiet-choir';
import * as std from 'quiet-choir/std';
import { Sha, type Check } from '../contracts.js';

/**
 * Fail before any agent call unless the checkout has no tracked or untracked change: publication
 * fast-forwards it, and a dirty checkout would refuse that only after every module was paid for.
 */
export async function assertClean(ctx: WorkflowContext, id: string) {
  const status = await std.exec.git(ctx, id, ['status', '--porcelain=v1', '--untracked-files=all']);
  if (status !== '')
    throw new Error(
      `The checkout must be clean, since publication fast-forwards it; commit the PRD or pass it inline (${id}): ${status}`,
    );
}

/** The commit the first builder's isolated checkout starts from. */
export const baseCommit = async (ctx: WorkflowContext) =>
  Sha.parse((await std.exec.git(ctx, 'base', ['rev-parse', 'HEAD'])).trim());

/** The first `max` files tracked at `commit`, and how many more there are, for the planner. */
export async function inventory(ctx: WorkflowContext, commit: string, max: number) {
  const args = ['ls-tree', '-r', '-z', '--name-only', '--full-tree', commit] as const;
  const files = (await std.exec.git(ctx, 'inventory', args, { maxOutputBytes: 16 * 1024 * 1024 }))
    .split('\0')
    .filter(Boolean);
  return { files: files.slice(0, max), omitted: Math.max(0, files.length - max) };
}

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
    // A settled failure carries no truncation flag, so `truncated: null` means unknown.
    checks.push(
      result.ok
        ? {
            argv,
            code: result.value.code,
            signal: result.value.signal,
            truncated: result.value.truncated,
            failure: null,
            tail: null,
          }
        : {
            argv,
            code: result.error.code ?? null,
            signal: result.error.signal ?? null,
            truncated: null,
            failure: result.error.kind,
            tail: `${result.error.stdoutTail ?? ''}${result.error.stderrTail ?? ''}`.trim() || null,
          },
    );
  }
  return checks;
}

export const passed = (checks: Check[]) =>
  checks.every((check) => check.failure === null && !check.truncated);
