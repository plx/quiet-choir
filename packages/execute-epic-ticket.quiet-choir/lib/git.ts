// Git mechanics of execute-epic-ticket as durable local steps: the start (worktree, branch, rebase),
// the verification of an implementer's report, the diff snapshot and the push with lease. Each is
// one ctx.step identified by a version constant and its input, never its callback text, and each
// reads before it writes: a step is at least once, so a retry after a crash finds the state the
// last attempt left.
//
// The worktree is a dedicated persistent checkout at <root>/worktree, not ctx.worktree: the ticket
// branch must outlive a run (a blocked run restarted with a new run ID reuses it), carry the
// implementer's own commits, and be rehearsable under --dry-run. Every command runs through the
// step's context.exec with the worktree as cwd (no `git -C`), so a rehearsal answers it from
// fixtures. The command wrappers are merge-down's.
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import type { Settled, StepContext, WorkflowContext } from 'quiet-choir';
import { checkedOut, git, rebaseInProgress, run } from '../../merge-down.quiet-choir/lib/git.js';
import { stripAnsi } from '../../merge-down.quiet-choir/lib/policy.js';
import {
  Published,
  Snapshot,
  Started,
  Verified,
  type Published as PublishedResult,
  type Snapshot as SnapshotResult,
  type Started as StartedResult,
  type Verified as VerifiedResult,
} from '../contracts.js';
import { branchName, branchPrefix } from './policy.js';

/** Where a run keeps its worktree and state: `<root>/worktree` and `<root>/state/epic-E/issue-N`. */
export interface Paths {
  readonly root: string;
  readonly workdir: string;
  readonly stateDir: string;
  /** `<root>/state/epic-E`, for the ledger. */
  readonly epicDir: string;
}

/** The directory of one ticket's state files. */
export function ticketDir(paths: Paths, ticket: number): string {
  return join(paths.epicDir, `issue-${String(ticket)}`);
}

/**
 * The run's paths: the input root, or `<main checkout>-epic-burndown-package` beside the checkout,
 * separate from the native script's `-epic-burndown`.
 */
export async function resolvePaths(
  ctx: WorkflowContext,
  root: string | undefined,
  epic: number,
): Promise<Paths> {
  let base = root === undefined ? null : resolve(ctx.cwd, root);
  if (base === null) {
    const common = await ctx.exec('git-common-dir', [
      'git',
      'rev-parse',
      '--path-format=absolute',
      '--git-common-dir',
    ]);
    base = `${dirname(common.stdout.trim())}-epic-burndown-package`;
  }
  return {
    root: base,
    workdir: join(base, 'worktree'),
    stateDir: join(base, 'state'),
    epicDir: join(base, 'state', `epic-${String(epic)}`),
  };
}

/** Whether git exits 0. */
async function gitOk(context: StepContext, cwd: string, args: readonly string[]): Promise<boolean> {
  return (await run(context, ['git', ...args], { cwd })).code === 0;
}

/** `git status --porcelain` lines; untrimmed, since a line starts with its status columns. */
async function porcelain(context: StepContext, W: string): Promise<string[]> {
  const status = await run(context, ['git', 'status', '--porcelain'], { cwd: W });
  if (status.code !== 0) throw new Error(`git status failed: ${status.stderr.trim()}`);
  return status.stdout.split('\n').filter((line) => line.trim() !== '');
}

const count = async (context: StepContext, W: string, range: string): Promise<number> =>
  Number(await git(context, W, ['rev-list', '--count', range]));

/** Whether a merge is in progress in the worktree. */
async function mergeInProgress(context: StepContext, W: string): Promise<boolean> {
  const path = await git(context, W, [
    'rev-parse',
    '--path-format=absolute',
    '--git-path',
    'MERGE_HEAD',
  ]);
  return existsSync(path);
}

/** The ticket branches under `namespace` (`refs/heads` or `refs/remotes/origin`), sorted. */
async function ticketBranches(
  context: StepContext,
  W: string,
  namespace: string,
  prefix: string,
  ticket: number,
): Promise<string[]> {
  const listed = await git(context, W, [
    'for-each-ref',
    '--format=%(refname)',
    `${namespace}/${prefix}/`,
  ]);
  return listed
    .split('\n')
    .filter(Boolean)
    .map((ref) => ref.slice(namespace.length + 1))
    .filter((branch) => branch.startsWith(`${prefix}/${String(ticket)}-`))
    .sort();
}

/** The other worktree that has `branch` checked out, or null. */
async function heldElsewhere(
  context: StepContext,
  W: string,
  branch: string,
): Promise<string | null> {
  const listed = await git(context, W, ['worktree', 'list', '--porcelain']);
  let path: string | null = null;
  for (const line of listed.split('\n')) {
    if (line.startsWith('worktree ')) path = line.slice('worktree '.length);
    else if (
      line === `branch refs/heads/${branch}` &&
      path !== null &&
      resolve(path) !== resolve(W)
    )
      return path;
  }
  return null;
}

/** The input of {@link start}. */
export interface StartInput {
  readonly paths: Paths;
  readonly dir: string;
  readonly base: string;
  readonly epic: number;
  readonly ticket: number;
  readonly title: string;
}

/**
 * Prepare the ticket's branch in the persistent worktree: create the worktree at the default branch
 * unless it exists, fetch the default branch and every `epic-E/*` branch, then reuse a local
 * `epic-E/N-*` branch, adopt a remote one, or create `epic-E/N-<slug>` from the default branch, so
 * a branch either tool pushed is the same ticket. A reused branch is rebased onto the default
 * branch; a conflicting rebase is aborted and reported as `conflict`. It refuses (`refused`, with
 * nothing changed) a rebase or merge in progress, uncommitted changes on another branch, commits on
 * a detached HEAD that no branch holds, a local branch that lacks commits its remote has, and a
 * branch checked out in another worktree (the native script's worktree may hold it).
 */
export function start(ctx: WorkflowContext, id: string, input: StartInput): Promise<StartedResult> {
  return ctx.step(id, {
    identity: 'version',
    version: 'epic-ticket.start/2',
    input: { ...input, paths: { ...input.paths } },
    schema: Started,
    async run(context) {
      const { paths, base, epic, ticket } = input;
      const W = paths.workdir;
      const target = `origin/${base}`;
      const prefix = branchPrefix(epic);
      let worktreeCreated = false;
      if (!existsSync(join(W, '.git'))) {
        await mkdir(paths.root, { recursive: true });
        await git(context, context.cwd, ['fetch', '--quiet', 'origin', base]);
        await git(context, context.cwd, ['worktree', 'add', '--detach', W, target]);
        worktreeCreated = true;
      }
      await mkdir(input.dir, { recursive: true });
      await git(context, W, ['fetch', '--quiet', 'origin', base]);
      await git(context, W, [
        'fetch',
        '--quiet',
        'origin',
        `+refs/heads/${prefix}/*:refs/remotes/origin/${prefix}/*`,
      ]);
      const planPath = join(input.dir, 'plan.json');
      const result = (fields: Partial<StartedResult>): StartedResult => ({
        refused: null,
        worktreeCreated,
        branch: '',
        source: 'new',
        resumed: false,
        ahead: 0,
        behind: 0,
        dirty: [],
        rebase: 'up-to-date',
        baseSha: '',
        remoteSha: null,
        planFile: existsSync(planPath) ? planPath : null,
        ...fields,
      });
      if (await rebaseInProgress(context, W))
        return result({ refused: `a rebase is in progress in ${W}; finish or abort it first` });
      if (await mergeInProgress(context, W))
        return result({ refused: `a merge is in progress in ${W}; finish or abort it first` });

      const local = (await ticketBranches(context, W, 'refs/heads', prefix, ticket))[0];
      const remote = (await ticketBranches(context, W, 'refs/remotes/origin', prefix, ticket))[0];
      const [branch, source]: [string, StartedResult['source']] =
        local !== undefined
          ? [local, 'local']
          : remote !== undefined
            ? [remote, 'remote']
            : [branchName(epic, ticket, input.title), 'new'];
      const resumed = source !== 'new';
      const ref = await checkedOut(context, W);
      const current = ref?.replace(/^refs\/heads\//, '') ?? null;
      const dirty = await porcelain(context, W);
      if (dirty.length && current !== branch)
        return result({
          branch,
          source,
          resumed,
          dirty,
          refused: `the worktree ${W} has uncommitted changes on ${current ?? 'a detached HEAD'}, not ${branch}; commit or discard them before starting #${String(ticket)}: ${dirty.slice(0, 10).join('; ')}`,
        });
      // Commits made on a detached HEAD (say, after a botched rebase) are held by no branch;
      // checking out another branch would leave them only in the reflog.
      if (current === null) {
        const orphans = await git(context, W, [
          'log',
          '--format=%h %s',
          'HEAD',
          '--not',
          '--branches',
          '--remotes',
        ]);
        if (orphans)
          return result({
            branch,
            source,
            resumed,
            refused: `the worktree ${W} is on a detached HEAD with commits no branch holds; put them on a branch before starting #${String(ticket)}: ${orphans.split('\n').slice(0, 5).join('; ')}`,
          });
      }
      // The remote tip is the push lease only if the branch already holds it: a lease on commits
      // another checkout pushed would let publish force them away.
      const remoteRef = `refs/remotes/origin/${branch}`;
      const remoteSha = (await gitOk(context, W, ['rev-parse', '--verify', '--quiet', remoteRef]))
        ? await git(context, W, ['rev-parse', remoteRef])
        : null;
      if (
        remoteSha !== null &&
        source === 'local' &&
        !(await gitOk(context, W, [
          'merge-base',
          '--is-ancestor',
          remoteSha,
          `refs/heads/${branch}`,
        ]))
      ) {
        const lacking = await git(context, W, [
          'log',
          '--format=%h %s',
          `refs/heads/${branch}..${remoteSha}`,
        ]);
        return result({
          branch,
          source,
          resumed,
          refused: `origin/${branch} has commits ${branch} lacks (${lacking.split('\n').slice(0, 5).join('; ')}); pull or reconcile them before starting #${String(ticket)}`,
        });
      }
      if (current !== branch) {
        const elsewhere = await heldElsewhere(context, W, branch);
        if (elsewhere !== null)
          return result({
            branch,
            source,
            resumed,
            refused: `branch ${branch} is checked out in another worktree (${elsewhere}), perhaps the native script's; check out something else there or remove that worktree`,
          });
        if (source === 'local') await git(context, W, ['checkout', '--quiet', branch]);
        else if (source === 'remote')
          await git(context, W, [
            'checkout',
            '--quiet',
            '-b',
            branch,
            '--track',
            `origin/${branch}`,
          ]);
        else await git(context, W, ['checkout', '--quiet', '--no-track', '-B', branch, target]);
      }
      let rebase: StartedResult['rebase'] = 'up-to-date';
      if (resumed && (await count(context, W, `HEAD..${target}`)) > 0) {
        if ((await porcelain(context, W)).length) rebase = 'skipped-dirty';
        else {
          const rebased = await run(context, ['git', 'rebase', target], {
            cwd: W,
            env: { GIT_EDITOR: 'true' },
          });
          await writeFile(
            join(input.dir, 'rebase.log'),
            stripAnsi(rebased.stdout + rebased.stderr),
          );
          if (rebased.code === 0) rebase = 'rebased';
          else {
            await run(context, ['git', 'rebase', '--abort'], { cwd: W });
            rebase = 'conflict';
          }
        }
      }
      return result({
        branch,
        source,
        resumed,
        rebase,
        remoteSha,
        ahead: await count(context, W, `${target}..HEAD`),
        behind: await count(context, W, `HEAD..${target}`),
        dirty: await porcelain(context, W),
        baseSha: await git(context, W, ['rev-parse', target]),
      });
    },
  });
}

/**
 * Check an implementer's report mechanically: HEAD, the branch the worktree is on, how many
 * commits the branch has of its own, which reported commits are not in it, and what is
 * uncommitted. The workflow decides; this step only reads.
 */
export function verify(
  ctx: WorkflowContext,
  id: string,
  input: { readonly workdir: string; readonly base: string; readonly commits: readonly string[] },
): Promise<Settled<VerifiedResult>> {
  return ctx.step(id, {
    identity: 'version',
    version: 'epic-ticket.verify/1',
    input: { ...input, commits: [...input.commits] },
    schema: Verified,
    onError: 'return',
    async run(context) {
      const W = input.workdir;
      const head = await git(context, W, ['rev-parse', 'HEAD']);
      const ref = await checkedOut(context, W);
      const missingCommits: string[] = [];
      for (const commit of input.commits) {
        const known =
          (await gitOk(context, W, ['rev-parse', '--verify', '--quiet', `${commit}^{commit}`])) &&
          (await gitOk(context, W, ['merge-base', '--is-ancestor', commit, head]));
        if (!known) missingCommits.push(commit);
      }
      return {
        head,
        branch: ref?.replace(/^refs\/heads\//, '') ?? null,
        ahead: await count(context, W, `origin/${input.base}..HEAD`),
        missingCommits,
        dirty: await porcelain(context, W),
      };
    },
  });
}

/** Write own.diff, own.stat and commits.txt for HEAD against the default branch. */
export function snapshot(
  ctx: WorkflowContext,
  id: string,
  input: { readonly workdir: string; readonly dir: string; readonly base: string },
): Promise<Settled<SnapshotResult>> {
  return ctx.step(id, {
    identity: 'version',
    version: 'epic-ticket.snapshot/1',
    input: { ...input },
    schema: Snapshot,
    onError: 'return',
    async run(context) {
      const W = input.workdir;
      const target = `origin/${input.base}`;
      await mkdir(input.dir, { recursive: true });
      const files = {
        diff: join(input.dir, 'own.diff'),
        stat: join(input.dir, 'own.stat'),
        commits: join(input.dir, 'commits.txt'),
      };
      const head = await git(context, W, ['rev-parse', 'HEAD']);
      await git(context, W, ['diff', `--output=${files.diff}`, `${target}...HEAD`]);
      const stat = await git(context, W, ['diff', '--stat=120', `${target}...HEAD`], {
        large: true,
      });
      await writeFile(files.stat, `${stat}\n`);
      const commits = await git(
        context,
        W,
        ['log', '--reverse', '--format=%h %s', `${target}..HEAD`],
        {
          large: true,
        },
      );
      await writeFile(files.commits, `${commits}\n`);
      return {
        head,
        ahead: commits ? commits.split('\n').length : 0,
        stat: stat.split('\n').at(-1)?.trim() ?? '',
        files,
      };
    },
  });
}

/** Why the publish step refuses, or null when it may push or skip. */
export function publishRefusal(state: {
  readonly branch: string;
  readonly current: string | null;
  readonly head: string;
  readonly sha: string;
  readonly dirty: readonly string[];
  readonly remote: string;
  readonly lease: string | null;
}): string | null {
  if (state.current !== state.branch)
    return `the worktree is on ${state.current ?? 'a detached HEAD'}, not ${state.branch}`;
  if (state.dirty.length)
    return `the worktree has uncommitted changes: ${state.dirty.slice(0, 5).join('; ')}`;
  if (state.head !== state.sha)
    return `HEAD ${state.head} is not the head the check suite passed at (${state.sha})`;
  if (state.remote !== state.sha && state.remote !== (state.lease ?? ''))
    return `origin/${state.branch} moved to ${state.remote || 'nothing'} (expected ${state.lease ?? 'no branch'}); someone else pushed`;
  return null;
}

/**
 * Push `sha`, the head the full check suite passed at, to `origin/<branch>`, with a lease on
 * `lease` (the remote head the start step saw, or no branch). It refuses when the worktree is not
 * on the branch, is dirty, or has moved off `sha`, and when the remote moved to anything else. A
 * remote already at `sha` (pushed before a crash) is skipped.
 */
export function publish(
  ctx: WorkflowContext,
  id: string,
  input: {
    readonly workdir: string;
    readonly branch: string;
    readonly sha: string;
    readonly lease: string | null;
  },
): Promise<Settled<PublishedResult>> {
  return ctx.step(id, {
    identity: 'version',
    version: 'epic-ticket.publish/1',
    input: { ...input },
    schema: Published,
    onError: 'return',
    async run(context) {
      const W = input.workdir;
      const ref = `refs/heads/${input.branch}`;
      const current = (await checkedOut(context, W))?.replace(/^refs\/heads\//, '') ?? null;
      const head = await git(context, W, ['rev-parse', 'HEAD']);
      const dirty = await porcelain(context, W);
      const listed = await git(context, W, ['ls-remote', 'origin', ref]);
      const remote = listed.split(/\s+/)[0] ?? '';
      const refused = publishRefusal({ ...input, current, head, dirty, remote });
      if (refused !== null) throw new Error(refused);
      if (remote === input.sha) return { head: input.sha, pushed: false };
      await git(context, W, [
        'push',
        '--quiet',
        `--force-with-lease=${ref}:${input.lease ?? ''}`,
        'origin',
        `${input.sha}:${ref}`,
      ]);
      return { head: input.sha, pushed: true };
    },
  });
}
