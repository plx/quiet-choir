// Git mechanics as durable effects: the window is pinned in code and the repository must stay
// clean, so a collector that writes is caught by a status check rather than trusted.
import { z, type WorkflowContext } from 'quiet-choir';
import * as std from 'quiet-choir/std';
import { Sha } from '../contracts.js';

const commit = async (ctx: WorkflowContext, id: string, revision: string) =>
  Sha.parse(
    (
      await std.exec.git(ctx, id, [
        'rev-parse',
        '--verify',
        '--end-of-options',
        `${revision}^{commit}`,
      ])
    ).trim(),
  );

/** Pin both ends of `since..until` and list every commit in it, oldest first. */
export async function gitWindow(ctx: WorkflowContext, since: string, until: string) {
  const start = await commit(ctx, 'since', since);
  const end = await commit(ctx, 'until', until);
  const listed = await std.exec.git(ctx, 'manifest', [
    'rev-list',
    '--reverse',
    `${start}..${end}`,
    '--',
  ]);
  const manifest = z.array(Sha).parse(listed.trim().split('\n').filter(Boolean));
  return { start, end, manifest };
}

/** The window's messages and file stats, shared with every collector. */
export const changeLog = (ctx: WorkflowContext, start: string, end: string) =>
  std.exec.git(ctx, 'changes', ['log', '--format=fuller', '--stat', `${start}..${end}`, '--']);

/**
 * Fail unless the repository has no tracked or untracked change. This is a local step that throws,
 * not a completed `git status` read: a completed read would replay its dirty output on every
 * resume, so cleaning the checkout and resuming could never pass.
 */
export const assertClean = (ctx: WorkflowContext, id: string) =>
  ctx.step(id, {
    input: null,
    schema: z.null(),
    async run({ exec }) {
      const status = await exec(['git', 'status', '--porcelain=v1', '--untracked-files=all']);
      if (status.stdout !== '' || status.truncated)
        throw new Error(`Expected a clean repository (${id}): ${status.stdout}`);
      return null;
    },
  });

/**
 * Fail when the repository changed during the read-only calls. The status is a completed read on
 * purpose, so this refusal stands on every resume: a resume would reuse the evidence those calls
 * gathered from the changed checkout, and cleaning it afterwards does not make that evidence sound.
 */
export async function assertUnchanged(ctx: WorkflowContext, id: string) {
  const status = await std.exec.git(ctx, id, ['status', '--porcelain=v1', '--untracked-files=all']);
  if (status !== '')
    throw new Error(
      `Expected a clean repository (${id}): the checkout changed during read-only calls, whose evidence a resume would reuse, so start a new run:\n${status}`,
    );
}
