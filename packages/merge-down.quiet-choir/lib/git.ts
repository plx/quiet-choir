// Git mechanics of merge-down-pr as durable local steps: the sync (worktree, fork points, rebase),
// the snapshot after conflict resolution, the fixer verification, the push with lease and the
// branch cleanup. Each is one ctx.step identified by a version constant and its input, never its
// callback text, so a reformatted helper does not strand a run, and each reads before it writes,
// because a step is at least once: a retry after a crash finds the state the last attempt left.
//
// Every command runs through the step's context.exec, so a rehearsal answers it from fixtures.
// Git commands run with the worktree as cwd rather than `git -C <path>`, which keeps their argv free
// of run-specific paths for fixture rules.
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  z,
  type ExecResult,
  type Settled,
  type StepContext,
  type WorkflowContext,
} from 'quiet-choir';
import { Sync, type Sync as SyncResult } from '../contracts.js';
import { forkPointRef, localBranch, publishPlan, stripAnsi } from './policy.js';

/** Where a run keeps its worktree and state: `<root>/worktree` and `<root>/state/pr-N`. */
export interface Paths {
  readonly root: string;
  readonly workdir: string;
  readonly stateDir: string;
  readonly dir: string;
}

const LARGE = 64 * 1024 * 1024;

/** Run a command and return its result whatever its exit code; a signal or timeout still throws. */
export async function run(
  context: StepContext,
  argv: readonly [string, ...string[]],
  options: {
    readonly cwd?: string;
    readonly env?: Readonly<Record<string, string>>;
    readonly timeoutMs?: number;
    readonly maxOutputBytes?: number;
  } = {},
): Promise<ExecResult> {
  const result = await context.exec([...argv], {
    ...options,
    ...(options.env === undefined ? {} : { env: { ...options.env } }),
    okExitCodes: 'any',
  });
  if (result.code === null)
    throw new Error(`${argv.join(' ')} ended by ${result.signal ?? 'a signal'}`);
  return result;
}

/** Run git in `cwd` and return its trimmed stdout; a nonzero exit throws with the output's tail. */
export async function git(
  context: StepContext,
  cwd: string,
  args: readonly string[],
  options: { readonly env?: Readonly<Record<string, string>>; readonly large?: boolean } = {},
): Promise<string> {
  const result = await run(context, ['git', ...args], {
    cwd,
    ...(options.env === undefined ? {} : { env: options.env }),
    ...(options.large ? { maxOutputBytes: LARGE } : {}),
  });
  if (result.code !== 0) {
    const detail = (result.stderr || result.stdout).trim().slice(-2000);
    throw new Error(`git ${args.join(' ')} exited ${String(result.code)}: ${detail}`);
  }
  if (result.truncated) throw new Error(`git ${args.join(' ')}: output was truncated`);
  return result.stdout.trim();
}

/** Whether git exits 0. */
async function gitOk(context: StepContext, cwd: string, args: readonly string[]): Promise<boolean> {
  return (await run(context, ['git', ...args], { cwd })).code === 0;
}

const remoteBranchExists = (context: StepContext, W: string, branch: string): Promise<boolean> =>
  gitOk(context, W, ['show-ref', '--verify', '--quiet', `refs/remotes/origin/${branch}`]);

/** Whether a rebase is still in progress in the worktree. */
export async function rebaseInProgress(context: StepContext, W: string): Promise<boolean> {
  for (const name of ['rebase-merge', 'rebase-apply']) {
    const path = await git(context, W, ['rev-parse', '--path-format=absolute', '--git-path', name]);
    if (existsSync(path)) return true;
  }
  return false;
}

/** Create the persistent worktree at the default branch unless it exists. */
async function ensureWorktree(context: StepContext, paths: Paths, base: string): Promise<boolean> {
  if (existsSync(join(paths.workdir, '.git'))) return false;
  await mkdir(paths.root, { recursive: true });
  await git(context, context.cwd, ['fetch', '--quiet', 'origin', base]);
  await git(context, context.cwd, ['worktree', 'add', '--detach', paths.workdir, `origin/${base}`]);
  return true;
}

/** An open pull request as fork-point recording reads it. */
export interface OpenBranch {
  readonly number: number;
  readonly baseRefName: string;
  readonly headRefName: string;
}

/**
 * Record each stacked PR's fork point (its parent's head as the child saw it) the first time any
 * run sees it, and never overwrite it. The refs live in the shared repository, so the native
 * script and this package honor each other's records.
 */
async function recordForkPoints(
  context: StepContext,
  W: string,
  base: string,
  open: readonly OpenBranch[],
): Promise<number[]> {
  const recorded: number[] = [];
  for (const q of open) {
    if (q.baseRefName === base) continue;
    const ref = forkPointRef(q.number);
    if (await gitOk(context, W, ['rev-parse', '--verify', '--quiet', ref])) continue;
    if (!(await remoteBranchExists(context, W, q.baseRefName))) continue;
    if (!(await remoteBranchExists(context, W, q.headRefName))) continue;
    const parent = `origin/${q.baseRefName}`;
    // Only trust an intact stack: the parent's current head must be inside the child.
    if (
      !(await gitOk(context, W, ['merge-base', '--is-ancestor', parent, `origin/${q.headRefName}`]))
    )
      continue;
    await git(context, W, ['update-ref', ref, await git(context, W, ['rev-parse', parent])]);
    recorded.push(q.number);
  }
  return recorded;
}

/** What a snapshot of the rebased branch reports. */
export const Snapshot = z.object({
  head: z.string(),
  ownCommits: z.int(),
  stat: z.string(),
});
export type Snapshot = z.output<typeof Snapshot>;

/** Write own.diff, own.stat and commits.txt for HEAD against the default branch. */
async function snapshotFiles(context: StepContext, paths: Paths, base: string): Promise<Snapshot> {
  const W = paths.workdir;
  if (await rebaseInProgress(context, W))
    throw new Error('a rebase is still in progress in the worktree');
  await mkdir(paths.dir, { recursive: true });
  const target = `origin/${base}`;
  const head = await git(context, W, ['rev-parse', 'HEAD']);
  await git(context, W, ['diff', `--output=${join(paths.dir, 'own.diff')}`, `${target}...HEAD`]);
  const stat = await git(context, W, ['diff', '--stat=120', `${target}...HEAD`], { large: true });
  await writeFile(join(paths.dir, 'own.stat'), `${stat}\n`);
  const commits = await git(context, W, ['log', '--reverse', '--format=%h %s', `${target}..HEAD`], {
    large: true,
  });
  await writeFile(join(paths.dir, 'commits.txt'), `${commits}\n`);
  return {
    head,
    ownCommits: commits ? commits.split('\n').length : 0,
    stat: stat.split('\n').at(-1)?.trim() ?? '',
  };
}

/** The input of {@link sync}: everything it needs from the GitHub reads, as plain data. */
export interface SyncInput {
  readonly pr: number;
  readonly repo: string;
  readonly base: string;
  readonly paths: Paths;
  readonly headRefName: string;
  readonly baseRefName: string;
  /** The parent pull request (the one whose head is this PR's base), or null without one. */
  readonly parent: { readonly number: number | null; readonly state: string | null } | null;
  readonly open: readonly OpenBranch[];
}

/**
 * Check out the PR in the dedicated worktree and rebase its own commits onto the default branch.
 * It first resets anything a crashed attempt left (an unfinished rebase or merge, a dirty tree),
 * records fork points of stacked PRs without overwriting any, and refuses a PR whose parent is
 * still open or that was stacked with no trustworthy fork point. The result's status is
 * `up-to-date`, `rebased`, `conflict` (the rebase stopped; it is still in progress), `error` or
 * `blocked`, with the native script's fields.
 */
export function sync(ctx: WorkflowContext, id: string, input: SyncInput): Promise<SyncResult> {
  return ctx.step(id, {
    identity: 'version',
    version: 'merge-down.sync/1',
    input: { ...input, paths: { ...input.paths }, open: input.open.map((o) => ({ ...o })) },
    schema: Sync,
    async run(context) {
      const { paths, base } = input;
      const W = paths.workdir;
      const created = await ensureWorktree(context, paths, base);
      await mkdir(paths.dir, { recursive: true });
      await git(context, W, ['fetch', '--quiet', '--prune', 'origin']);
      await run(context, ['git', 'rebase', '--abort'], { cwd: W });
      await run(context, ['git', 'merge', '--abort'], { cwd: W });
      await git(context, W, ['reset', '--quiet', '--hard']);
      await git(context, W, ['clean', '--quiet', '-fd']);
      const forkPointsRecorded = await recordForkPoints(context, W, base, input.open);
      const branch = localBranch(input.pr);
      const empty: SyncResult = {
        status: 'blocked',
        reason: null,
        worktreeCreated: created,
        localBranch: branch,
        headRef: input.headRefName,
        origHead: null,
        target: null,
        forkPoint: null,
        forkSource: null,
        conflictedFiles: [],
        forkPointsRecorded,
        upstreamDelta: null,
        originalCommits: null,
        newHead: null,
        ownCommits: null,
        stat: null,
        log: null,
      };
      if (input.baseRefName !== base && input.parent?.state !== 'MERGED') {
        const who =
          input.parent?.number == null
            ? 'has no PR'
            : `#${String(input.parent.number)} is ${String(input.parent.state)}`;
        return {
          ...empty,
          reason: `base branch ${input.baseRefName} is not ${base} and ${who}; land the parent first`,
        };
      }
      await git(context, W, ['checkout', '--quiet', '-B', branch, `origin/${input.headRefName}`]);
      const origHead = await git(context, W, ['rev-parse', 'HEAD']);
      const target = `origin/${base}`;
      const result: SyncResult = {
        ...empty,
        status: 'up-to-date',
        origHead,
        target: await git(context, W, ['rev-parse', target]),
      };
      if (!(await gitOk(context, W, ['merge-base', '--is-ancestor', target, 'HEAD']))) {
        const ref = forkPointRef(input.pr);
        const recorded = (await gitOk(context, W, ['rev-parse', '--verify', '--quiet', ref]))
          ? await git(context, W, ['rev-parse', ref])
          : null;
        let forkPoint: string;
        let forkSource: 'recorded' | 'base-branch' | 'merge-base';
        if (
          recorded &&
          (await gitOk(context, W, ['merge-base', '--is-ancestor', recorded, 'HEAD']))
        ) {
          [forkPoint, forkSource] = [recorded, 'recorded'];
        } else if (
          input.baseRefName !== base &&
          (await remoteBranchExists(context, W, input.baseRefName))
        ) {
          forkPoint = await git(context, W, ['merge-base', 'HEAD', `origin/${input.baseRefName}`]);
          forkSource = 'base-branch';
        } else {
          // A stacked PR whose parent branch is gone has no trustworthy fork point: the merge-base
          // with the default branch predates the parent's commits, so the rebase would replay them.
          if (input.baseRefName !== base || (await wasStacked(context, input))) {
            return {
              ...result,
              status: 'blocked',
              reason: `PR was stacked on another branch, and no fork point was recorded before that branch was rewritten or deleted. Record ${ref} (the parent's head as this PR saw it) and re-run, or rebase it by hand.`,
            };
          }
          forkPoint = await git(context, W, ['merge-base', 'HEAD', target]);
          forkSource = 'merge-base';
        }
        // What changed underneath this PR since it was written: the input to a semantic rebase.
        const patch = join(paths.dir, 'upstream-delta.patch');
        await git(context, W, ['diff', `--output=${patch}`, forkPoint, target]);
        const deltaStat = await git(context, W, ['diff', '--stat=120', forkPoint, target], {
          large: true,
        });
        await writeFile(join(paths.dir, 'upstream-delta.stat'), `${deltaStat}\n`);
        const originalCommits = Number(
          await git(context, W, ['rev-list', '--count', `${forkPoint}..HEAD`]),
        );
        Object.assign(result, {
          forkPoint,
          forkSource,
          upstreamDelta: deltaStat.split('\n').at(-1)?.trim() ?? '',
          originalCommits,
        });
        const rebase = await run(context, ['git', 'rebase', '--onto', target, forkPoint], {
          cwd: W,
          env: { GIT_EDITOR: 'true' },
          maxOutputBytes: LARGE,
        });
        const log = join(paths.dir, 'rebase.log');
        await writeFile(log, stripAnsi(rebase.stdout + rebase.stderr));
        if (rebase.code === 0) result.status = 'rebased';
        else {
          const conflicted = await git(context, W, ['diff', '--name-only', '--diff-filter=U']);
          Object.assign(result, {
            conflictedFiles: conflicted.split('\n').filter(Boolean),
            status: (await rebaseInProgress(context, W)) ? 'conflict' : 'error',
            log,
          });
        }
      }
      if (result.status === 'rebased' || result.status === 'up-to-date') {
        const snap = await snapshotFiles(context, paths, base);
        Object.assign(result, { newHead: snap.head, ownCommits: snap.ownCommits, stat: snap.stat });
      }
      return result;
    },
  });
}

/** Whether GitHub's timeline shows the PR was ever retargeted, i.e. stacked on another branch. */
async function wasStacked(context: StepContext, input: SyncInput): Promise<boolean> {
  const events = await context.exec.json(
    [
      'gh',
      'api',
      '--paginate',
      '--slurp',
      `repos/${input.repo}/issues/${String(input.pr)}/timeline`,
    ],
    {
      schema: z.array(z.array(z.object({ event: z.string().nullish() }).loose())),
      maxOutputBytes: LARGE,
    },
  );
  return events
    .flat()
    .some((e) => ['base_ref_changed', 'automatic_base_change_succeeded'].includes(e.event ?? ''));
}

/**
 * Snapshot the branch after a conflict resolution: refuse while a rebase is in progress, then
 * write the diff files and report the head and how many of the PR's commits survived.
 */
export function snapshot(
  ctx: WorkflowContext,
  id: string,
  input: { readonly paths: Paths; readonly base: string },
): Promise<Settled<Snapshot>> {
  return ctx.step(id, {
    identity: 'version',
    version: 'merge-down.snapshot/1',
    input: { paths: { ...input.paths }, base: input.base },
    schema: Snapshot,
    onError: 'return',
    run: (context) => snapshotFiles(context, input.paths, input.base),
  });
}

/** What {@link verifyFixes} reports. */
export const Verified = z.object({ head: z.string(), missingCommits: z.array(z.string()) });
export type Verified = z.output<typeof Verified>;

/** Check a fixer's report mechanically: every commit it names exists and is in HEAD. */
export function verifyFixes(
  ctx: WorkflowContext,
  id: string,
  input: { readonly workdir: string; readonly commits: readonly string[] },
): Promise<Settled<Verified>> {
  return ctx.step(id, {
    identity: 'version',
    version: 'merge-down.verify-fixes/1',
    input: { workdir: input.workdir, commits: [...input.commits] },
    schema: Verified,
    onError: 'return',
    async run(context) {
      const W = input.workdir;
      const head = await git(context, W, ['rev-parse', 'HEAD']);
      const missingCommits: string[] = [];
      for (const commit of input.commits) {
        const known =
          /^[0-9a-f]{4,40}$/i.test(commit) &&
          (await gitOk(context, W, ['rev-parse', '--verify', '--quiet', `${commit}^{commit}`])) &&
          (await gitOk(context, W, ['merge-base', '--is-ancestor', commit, head]));
        if (!known) missingCommits.push(commit);
      }
      return { head, missingCommits };
    },
  });
}

/** What {@link publish} reports. */
export const Published = z.object({
  head: z.string(),
  previousHead: z.string().nullable(),
  pushed: z.boolean(),
});
export type Published = z.output<typeof Published>;

/**
 * Push `sha`, the head that passed the local checks, to the PR branch with a lease on the head this
 * run last saw. It refuses when the worktree's HEAD has moved off `sha`. It reads the remote head
 * first and accepts either the expected head or `sha`, so a retry after a crash that already pushed
 * finds the remote at `sha` and skips the push instead of failing its lease. Any other remote head
 * means someone else pushed, and the step fails.
 */
export function publish(
  ctx: WorkflowContext,
  id: string,
  input: {
    readonly workdir: string;
    readonly branch: string;
    readonly expected: string;
    readonly sha: string;
  },
): Promise<Settled<Published>> {
  return ctx.step(id, {
    identity: 'version',
    version: 'merge-down.publish/2',
    input: { ...input },
    schema: Published,
    onError: 'return',
    async run(context) {
      const W = input.workdir;
      const { sha, expected } = input;
      const ref = `refs/heads/${input.branch}`;
      const head = await git(context, W, ['rev-parse', 'HEAD']);
      const listed = await git(context, W, ['ls-remote', 'origin', ref]);
      const remote = listed.split(/\s+/)[0] ?? '';
      const plan = publishPlan({ sha, head, remote, expected });
      if ('refused' in plan) throw new Error(plan.refused);
      if (plan.action === 'skip') {
        // Pushed already, by this step before a crash or because nothing changed.
        return { head: sha, previousHead: expected === sha ? null : expected, pushed: false };
      }
      await git(context, W, [
        'push',
        '--quiet',
        `--force-with-lease=${ref}:${remote}`,
        'origin',
        `${sha}:${ref}`,
      ]);
      return { head: sha, previousHead: remote, pushed: true };
    },
  });
}

/** After the merge: detach the worktree and delete the local branch, ignoring what is gone. */
export function cleanupBranch(
  ctx: WorkflowContext,
  id: string,
  input: { readonly workdir: string; readonly branch: string },
): Promise<null> {
  return ctx.step(id, {
    identity: 'version',
    version: 'merge-down.cleanup/1',
    input: { ...input },
    schema: z.null(),
    async run(context) {
      if (!existsSync(join(input.workdir, '.git'))) return null;
      await run(context, ['git', 'checkout', '--quiet', '--detach'], { cwd: input.workdir });
      await run(context, ['git', 'branch', '--quiet', '-D', input.branch], { cwd: input.workdir });
      return null;
    },
  });
}
