// Git mechanics as durable commands. The gated range is pinned in code and always ends at the
// checkout's HEAD, because that is the tree the operator's commands run against; assessors and
// confirmers read the same commit in their own unchanged checkouts.
import { z, type WorkflowContext } from 'quiet-choir';
import * as std from 'quiet-choir/std';
import { Sha } from '../contracts.js';

/** Release ranges outgrow the default 1 MiB capture; std.exec.git throws rather than truncate. */
const maxOutputBytes = 16 * 1024 * 1024;

/** The checkout's HEAD: its commit, and the ref it is on (`HEAD` when detached). */
export async function headOf(ctx: WorkflowContext, id: string) {
  const [commit = '', ref = ''] = (
    await std.exec.git(ctx, id, ['rev-parse', 'HEAD^{commit}', '--symbolic-full-name', 'HEAD'])
  )
    .trim()
    .split('\n');
  return { commit: Sha.parse(commit), ref };
}

/** The last line Git wrote to stderr for a settled probe, or its failure kind. */
const why = (error: { readonly kind: string; readonly stderrTail?: string }) =>
  (error.stderrTail ?? '').trim().split('\n').at(-1) || error.kind;

/**
 * The paths where the checkout differs from HEAD, as `git status --porcelain` lines. With
 * `untracked`, untracked files count too (ignored ones never do), so the operator's commands see
 * exactly HEAD plus ignored files such as dependencies; without it only tracked changes count, so
 * a test's untracked artifacts do not refuse the gate.
 */
export const dirt = async (ctx: WorkflowContext, id: string, untracked: boolean) =>
  (
    await std.exec.git(ctx, id, [
      'status',
      '--porcelain=v1',
      `--untracked-files=${untracked ? 'normal' : 'no'}`,
    ])
  )
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);

/**
 * The default start: the nearest tag matching `pattern` reachable from HEAD, excluding HEAD's own
 * tags, so a tagged release candidate is gated against the previous release. Tag names cannot hold
 * glob characters, so each `--exclude` matches exactly one tag.
 */
async function previousTag(ctx: WorkflowContext, pattern: string) {
  const own = await std.exec.git(ctx, 'tags-at-head', ['tag', '--points-at', 'HEAD']);
  const excluded = own.split('\n').filter(Boolean);
  // A missing tag is an answer, not a crash, so this probe settles instead of using std.exec.git.
  const tag = await ctx.exec(
    'tag',
    [
      'git',
      'describe',
      '--tags',
      '--abbrev=0',
      `--match=${pattern}`,
      ...excluded.map((name) => `--exclude=${name}`),
      'HEAD',
    ],
    { onError: 'return' },
  );
  return tag.ok
    ? { ok: true as const, tag: tag.value.stdout.trim() }
    : {
        ok: false as const,
        reason: `No tag matching ${pattern} other than HEAD's own is reachable from HEAD (${why(tag.error)}); pass since.`,
      };
}

/**
 * Pin `since..HEAD` and list it oldest first, with the ref HEAD is on, so code can tell when a
 * command moved it. Without `since`, the start is {@link previousTag}; when there is none, `since`
 * names no commit, or it is not an ancestor of HEAD, the window is refused with a reason. A start
 * off HEAD's history would make the log (`start..end`) and the patch (the two trees) disagree: the
 * patch would also undo every change only the start has.
 */
export async function gitWindow(ctx: WorkflowContext, since: string | undefined, pattern: string) {
  let from = since ?? null;
  if (from === null) {
    const previous = await previousTag(ctx, pattern);
    if (!previous.ok) return previous;
    from = previous.tag;
  }
  const resolved = await ctx.exec(
    'since',
    ['git', 'rev-parse', '--verify', '--end-of-options', `${from}^{commit}`],
    { onError: 'return' },
  );
  if (!resolved.ok)
    return {
      ok: false as const,
      reason: `since ${from} does not name a commit (${why(resolved.error)}).`,
    };
  const start = Sha.parse(resolved.value.stdout.trim());
  const { commit: end, ref } = await headOf(ctx, 'head');
  // Exit 1 is the answer "not an ancestor"; any other failure is a real error and fails the run.
  const ancestor = await ctx.exec('ancestor', ['git', 'merge-base', '--is-ancestor', start, end], {
    okExitCodes: [0, 1],
  });
  if (ancestor.code !== 0)
    return {
      ok: false as const,
      reason: `since ${from} (${start}) is not an ancestor of HEAD, so its log and its patch would disagree; pass since=$(git merge-base ${from} HEAD) to gate from where they diverged.`,
    };
  const listed = await std.exec.git(ctx, 'manifest', [
    'rev-list',
    '--reverse',
    `${start}..${end}`,
    '--',
  ]);
  const manifest = z.array(Sha).parse(listed.trim().split('\n').filter(Boolean));
  return { ok: true as const, since: from, start, end, ref, manifest };
}

/** The range's commits, oldest first, with their file stats. */
export const rangeLog = (ctx: WorkflowContext, start: string, end: string) =>
  std.exec.git(
    ctx,
    'log',
    ['log', '--reverse', '--format=fuller', '--stat', `${start}..${end}`, '--'],
    { maxOutputBytes },
  );

/** The whole range as one diff: a stat summary first, then the patch. */
export const rangePatch = (ctx: WorkflowContext, start: string, end: string) =>
  std.exec.git(ctx, 'patch', ['diff', '--stat', '--patch', '--find-renames', start, end, '--'], {
    maxOutputBytes,
  });
