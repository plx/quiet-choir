// Git mechanics as durable commands: the window is pinned in code and the repository must stay
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

/** Fail unless the repository has no tracked or untracked change. */
export async function assertClean(ctx: WorkflowContext, id: string) {
  const status = await std.exec.git(ctx, id, ['status', '--porcelain=v1', '--untracked-files=all']);
  if (status !== '') throw new Error(`Expected a clean repository (${id}): ${status}`);
}
