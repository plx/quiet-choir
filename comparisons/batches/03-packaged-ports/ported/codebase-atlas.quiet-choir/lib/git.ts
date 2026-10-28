// Git facts as durable commands: the commit the atlas describes, its tracked files and whether the
// checkout the readers see differs from it. Paths are relative to the workflow directory.
import type { WorkflowContext } from 'quiet-choir';
import * as std from 'quiet-choir/std';
import { Sha } from '../contracts.js';

/** The commit the atlas names; agents read the checkout, so `dirty` says whether they match. */
export const pinCommit = async (ctx: WorkflowContext) =>
  Sha.parse(
    (
      await std.exec.git(ctx, 'commit', [
        'rev-parse',
        '--verify',
        '--end-of-options',
        'HEAD^{commit}',
      ])
    ).trim(),
  );

/** Whether tracked files differ from HEAD; untracked files are not part of the atlas. */
export const isDirty = async (ctx: WorkflowContext) =>
  (await std.exec.git(ctx, 'status', ['status', '--porcelain=v1', '-z', '--untracked-files=no']))
    .length > 0;

/**
 * Every tracked file at `commit` under the workflow directory, NUL-separated so no name is quoted.
 * A listing past 8 MiB fails as incomplete rather than proving coverage from a truncated list.
 */
export const trackedFiles = async (ctx: WorkflowContext, commit: string) =>
  (
    await std.exec.git(ctx, 'files', ['ls-tree', '-r', '-z', '--name-only', commit], {
      maxOutputBytes: 8 * 1024 * 1024,
    })
  )
    .split('\0')
    .filter(Boolean);
