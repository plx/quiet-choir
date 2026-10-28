// Git mechanics as durable commands. The manifest is computed here, so slicing is provably
// disjoint and complete; agents never resolve the range.
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

/** Split the manifest into consecutive, disjoint slices. */
export const slices = (manifest: string[], size: number) =>
  Array.from({ length: Math.ceil(manifest.length / size) }, (_, index) =>
    manifest.slice(index * size, (index + 1) * size),
  );

/** One slice's commits with their full patches, for a summarizer. */
export const slicePatch = (ctx: WorkflowContext, shas: string[]) =>
  std.exec.git(ctx, 'patch', ['show', '--format=fuller', '--stat', '--patch', ...shas, '--']);

/** The range's messages and file stats, for a fact-checker that must not trust the summaries. */
export const rangeLog = (ctx: WorkflowContext, start: string, end: string) =>
  std.exec.git(ctx, 'log', ['log', '--format=fuller', '--stat', `${start}..${end}`, '--']);
