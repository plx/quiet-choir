import { commitId, mergeTreeOutput, type WorktreeGit } from '../../worktrees/git.js';
import type { HarnessInvocation } from './model.js';
import type { StepRecord } from './record.js';
import type {
  MergeCommitOptions,
  MergeOptions,
  MergeResult,
  WorktreeChange,
} from './worktree-model.js';
import type { MergeIdentity, MergePreparation, WorktreeLedger } from './worktree-schema.js';
import { identitySchema } from './worktree-schema.js';

/** Author and committer of a created commit. @internal */
export interface CommitIdentity {
  readonly author: MergeIdentity;
  readonly committer: MergeIdentity;
}
const quietChoir: MergeIdentity = { name: 'quiet-choir', email: 'quiet-choir@localhost' };
/** The identity of snapshot commits and of merges without `MergeOptions.commit`. @internal */
export const fixedIdentity: CommitIdentity = { author: quietChoir, committer: quietChoir };

/**
 * Parse `git var GIT_*_IDENT` output (`Name <email> 1790737520 -0500`), dropping the timestamp and
 * zone, and validate it with the same rules as an explicit author; null when either fails. Pure.
 * @internal
 */
export function parseIdent(output: string): MergeIdentity | null {
  const match = /^(.+) <([^<>]*)> \d+ [+-]\d{4}$/u.exec(output.replace(/\r?\n$/u, ''));
  if (!match) return null;
  const parsed = identitySchema.safeParse({ name: match[1], email: match[2] });
  return parsed.success ? parsed.data : null;
}

async function configIdent(
  git: WorktreeGit,
  repo: string,
  variable: 'GIT_AUTHOR_IDENT' | 'GIT_COMMITTER_IDENT',
  invocation: HarnessInvocation,
): Promise<MergeIdentity> {
  const result = await git.run(repo, ['var', variable], invocation, {
    codes: [0, 1, 128],
  });
  const ident = result.code === 0 ? parseIdent(result.stdout) : null;
  if (!ident)
    throw new Error(
      `Merge commit author from git config is unavailable: ${
        result.code === 0
          ? `git var ${variable} printed an unusable identity`
          : result.stderr.trim() || `git var ${variable} exited ${String(result.code)}`
      }`,
    );
  return ident;
}

/**
 * Resolve the requested message and identity once, before anything is committed. Only a
 * `'git-config'` author runs Git (the read-only `git var`). @internal
 */
export async function resolveCommit(
  git: WorktreeGit,
  repo: string,
  commit: MergeCommitOptions,
  invocation: HarnessInvocation,
): Promise<NonNullable<MergePreparation['commit']>> {
  const author = commit.author ?? 'quiet-choir';
  if (author === 'quiet-choir') return { message: commit.message, ...fixedIdentity };
  if (author === 'git-config')
    return {
      message: commit.message,
      author: await configIdent(git, repo, 'GIT_AUTHOR_IDENT', invocation),
      committer: await configIdent(git, repo, 'GIT_COMMITTER_IDENT', invocation),
    };
  const explicit = { name: author.name, email: author.email };
  return { message: commit.message, author: explicit, committer: explicit };
}

/**
 * Create a commit object with `git commit-tree`, dated `date` for both author and committer.
 * `identity` replaces the fixed quiet-choir author and committer. @internal
 */
export async function commitTree(
  git: WorktreeGit,
  repo: string,
  tree: string,
  parents: readonly string[],
  message: string,
  date: string,
  invocation: HarnessInvocation,
  identity: CommitIdentity = fixedIdentity,
): Promise<string> {
  const env = {
    GIT_AUTHOR_NAME: identity.author.name,
    GIT_AUTHOR_EMAIL: identity.author.email,
    GIT_COMMITTER_NAME: identity.committer.name,
    GIT_COMMITTER_EMAIL: identity.committer.email,
    GIT_AUTHOR_DATE: date,
    GIT_COMMITTER_DATE: date,
  };
  return commitId(
    (
      await git.run(
        repo,
        ['commit-tree', tree, ...parents.flatMap((parent) => ['-p', parent]), '-F', '-'],
        invocation,
        { input: `${message}\n`, env },
      )
    ).stdout.trim(),
  );
}

/**
 * The Git operations computing an integration needs: no ref, index or checkout changes, only
 * object reads and writes. A dry-run preview supplies a quarantined driver. @internal
 */
export interface IntegrationRuntime {
  readonly git: WorktreeGit;
  readonly repo: string;
  /** Create a commit object; `identity` replaces the fixed quiet-choir author and committer. */
  commit(
    tree: string,
    parents: readonly string[],
    message: string,
    date: string,
    identity?: CommitIdentity,
  ): Promise<string>;
}

/** Git/storage operations supplied by the run owner while holding integration/handle locks. @internal */
export interface MergeRuntime {
  readonly git: WorktreeGit;
  readonly ledger: WorktreeLedger;
  save(): Promise<void>;
  pin(ref: string, commit: string): Promise<void>;
  ref(key: string): string;
  /**
   * Run a command that enumerates worktrees without racing another worktree add, in this process or
   * another quiet-choir process using the same repository.
   */
  administer<T>(work: () => Promise<T>): Promise<T>;
  /** Create a commit object; `identity` replaces the fixed quiet-choir author and committer. */
  commit(
    tree: string,
    parents: readonly string[],
    message: string,
    date: string,
    identity?: CommitIdentity,
  ): Promise<string>;
}

async function revision(
  runtime: MergeRuntime,
  ref: string,
  invocation: HarnessInvocation,
): Promise<string | null> {
  const result = await runtime.git.run(
    runtime.ledger.repo,
    ['rev-parse', '--verify', '--quiet', '--end-of-options', `${ref}^{commit}`],
    invocation,
    { codes: [0, 1] },
  );
  return result.code === 0 ? commitId(result.stdout.trim()) : null;
}
/**
 * What the merge target checks need: a Git driver, the repository, and a way to run the worktree
 * listing without racing a concurrent `worktree add`. The real merge supplies its run driver and the
 * repository administration lock; a dry-run preview supplies the read-only driver and only the
 * in-process administration queue, so it writes nothing (#312). @internal
 */
export interface TargetCheckRuntime {
  readonly git: WorktreeGit;
  readonly repo: string;
  /** Run a command that enumerates worktrees without racing another worktree add. */
  administer<T>(work: () => Promise<T>): Promise<T>;
}

async function branchFree(
  runtime: TargetCheckRuntime,
  ref: string,
  invocation: HarnessInvocation,
): Promise<void> {
  const listed = await runtime.administer(() =>
    runtime.git.run(runtime.repo, ['worktree', 'list', '--porcelain', '-z'], invocation),
  );
  if (listed.stdout.split('\0').includes(`branch ${ref}`))
    throw new Error(
      `Merge target ${ref} is checked out; use target: 'checkout' explicitly for this checkout.`,
    );
  const symbolic = await runtime.git.run(runtime.repo, ['symbolic-ref', '-q', ref], invocation, {
    codes: [0, 1],
  });
  if (symbolic.code === 0) throw new Error('Merge branch target cannot be a symbolic ref.');
}
async function cleanCheckout(
  runtime: TargetCheckRuntime,
  invocation: HarnessInvocation,
): Promise<void> {
  if (
    await runtime.git.text(
      runtime.repo,
      ['status', '--porcelain', '--untracked-files=normal'],
      invocation,
    )
  )
    throw new Error('Merge target checkout is dirty; commit or stash changes before integration.');
}

/**
 * The checks a merge makes on its target before it prepares anything: a `branch` target's ref must
 * be a valid ref name (`git check-ref-format`, which fails with an `ExecError`), not checked
 * out in any worktree and not a symbolic ref; a `checkout` target must have no uncommitted or
 * untracked changes. A `ref` target is checked by the merge itself. The real merge and the dry-run
 * preview both run this function, so a rehearsal fails exactly as the real run would (#312).
 * @internal
 */
export async function checkMergeTarget(
  runtime: TargetCheckRuntime,
  kind: 'ref' | 'branch' | 'checkout',
  ref: string,
  invocation: HarnessInvocation,
): Promise<void> {
  if (kind === 'branch') {
    await runtime.git.run(runtime.repo, ['check-ref-format', ref], invocation);
    await branchFree(runtime, ref, invocation);
  }
  if (kind === 'checkout') await cleanCheckout(runtime, invocation);
}
async function checkoutBranch(
  runtime: MergeRuntime,
  invocation: HarnessInvocation,
): Promise<string | null> {
  const branch = await runtime.git.run(
    runtime.ledger.repo,
    ['symbolic-ref', '-q', 'HEAD'],
    invocation,
    { codes: [0, 1] },
  );
  return branch.code === 0 ? branch.stdout.trim() : null;
}

/**
 * Integrate `changes` onto `base` in order, without an index, checkout or ref update: each input
 * with a commit is merged with `merge-tree --write-tree` (onto a virtual commit whose parent is the
 * input's base, except under the `merge` strategy) and committed with `commit-tree`; a conflicting
 * input is reported and skipped, or fails the merge under `onConflict: 'fail'`. The real merge and
 * the dry-run preview both compute through this function. @internal
 */
export async function computeIntegration(
  runtime: IntegrationRuntime,
  id: string,
  base: string,
  changes: readonly WorktreeChange[],
  options: MergeOptions,
  date: string,
  custom: MergePreparation['commit'],
  invocation: HarnessInvocation,
): Promise<MergeResult> {
  const { git, repo } = runtime;
  let current = base;
  const merged: string[] = [],
    conflicts: { commit: string; files: string[] }[] = [];
  const strategy = options.strategy ?? 'rebase';
  const identity = custom && { author: custom.author, committer: custom.committer };
  let last: { tree: string; parents: string[] } | undefined;
  for (const change of changes) {
    if (!change.commit) continue;
    let ours = current;
    if (strategy !== 'merge') {
      // Git 2.38 has no --merge-base option. This virtual commit gives the current
      // tree exactly the source base as parent, implementing its net patch in memory.
      const tree = commitId(await git.text(repo, ['rev-parse', `${current}^{tree}`], invocation));
      ours = await runtime.commit(
        tree,
        [change.base],
        `quiet-choir merge base ${id}`,
        date,
        identity,
      );
    }
    const result = await git.run(
      repo,
      ['merge-tree', '--write-tree', '--name-only', '-z', '--no-messages', ours, change.commit],
      invocation,
      { codes: [0, 1] },
    );
    const parsed = mergeTreeOutput(result);
    if (result.code === 1) {
      conflicts.push({ commit: change.commit, files: parsed.conflicts });
      if (options.onConflict === 'fail')
        throw new Error(
          `Merge input ${change.commit} conflicts${parsed.conflicts.length ? `: ${parsed.conflicts.join(', ')}` : '.'}`,
        );
      continue;
    }
    last = {
      tree: parsed.tree,
      parents: strategy === 'merge' ? [...new Set([current, change.commit])] : [current],
    };
    current = await runtime.commit(
      last.tree,
      last.parents,
      `quiet-choir integrate ${id}: ${change.commit}`,
      date,
      identity,
    );
    merged.push(change.commit);
  }
  if (strategy === 'squash' && merged.length) {
    const tree = commitId(await git.text(repo, ['rev-parse', `${current}^{tree}`], invocation));
    current = await runtime.commit(
      tree,
      [base],
      custom?.message ?? `quiet-choir squash ${id}`,
      date,
      identity,
    );
  } else if (custom && last) {
    // Which input is the last clean one is only known after the loop (later inputs may
    // conflict), so the final commit is recreated with the same tree and parents and the
    // requested message; the generated-message commit it replaces stays unreferenced.
    current = await runtime.commit(last.tree, last.parents, custom.message, date, identity);
  }
  return { commit: current, merged, conflicts };
}

/** Compute clean trees without an index/worktree; publish only a checkpointed result. @internal */
export async function integrate(
  runtime: MergeRuntime,
  id: string,
  step: StepRecord,
  changes: readonly WorktreeChange[],
  options: MergeOptions,
  date: string,
  invocation: HarnessInvocation,
): Promise<MergeResult> {
  const { git, ledger } = runtime;
  const checks: TargetCheckRuntime = {
    git,
    repo: ledger.repo,
    administer: (work) => runtime.administer(work),
  };
  let prepared = step.merge;
  if (!prepared) {
    const target = options.target ?? 'ref';
    const kind = typeof target === 'object' ? 'branch' : target;
    const ref =
      typeof target === 'object'
        ? `refs/heads/${target.branch}`
        : target === 'checkout'
          ? 'HEAD'
          : runtime.ref(`merge:${id}:${step.fingerprint}`);
    await checkMergeTarget(checks, kind, ref, invocation);
    const expected = await revision(runtime, ref, invocation);
    if (kind === 'ref' && expected !== null)
      throw new Error('Unrecorded merge target already exists.');
    const base = expected ?? (await revision(runtime, 'HEAD', invocation));
    if (!base) throw new Error('Merge requires a committed HEAD or existing target branch.');
    for (const change of changes) {
      if (
        (await revision(runtime, change.base, invocation)) !== change.base ||
        (change.commit && (await revision(runtime, change.commit, invocation)) !== change.commit)
      )
        throw new Error('Merge input commit is unavailable in this repository.');
    }
    // Only a merge that can create a commit resolves an identity, so a no-op never runs git var.
    const commit =
      options.commit && changes.some((change) => change.commit !== null)
        ? await resolveCommit(git, ledger.repo, options.commit, invocation)
        : undefined;
    prepared = {
      base,
      ref,
      target: kind,
      expected,
      changes: structuredClone(changes),
      checkoutBranch: kind === 'checkout' ? await checkoutBranch(runtime, invocation) : null,
      date,
      ...(commit ? { commit } : {}),
    };
    step.merge = prepared;
    await runtime.save();
    await runtime.pin(runtime.ref(`merge-base:${id}:${step.fingerprint}`), base);
  }
  if (!prepared.result) {
    prepared.result = await computeIntegration(
      { git, repo: ledger.repo, commit: runtime.commit.bind(runtime) },
      id,
      prepared.base,
      prepared.changes,
      options,
      prepared.date,
      prepared.commit,
      invocation,
    );
    // Pin before publishing a user-selected ref/checkout, so the commit remains available
    // even if publication fails. Persisted result makes a crash after CAS reconcilable.
    await runtime.save();
  }
  const result = prepared.result;
  await runtime.pin(runtime.ref(`integration:${id}:${step.fingerprint}`), result.commit);
  if (prepared.target === 'checkout') {
    await cleanCheckout(checks, invocation);
    if ((await checkoutBranch(runtime, invocation)) !== prepared.checkoutBranch)
      throw new Error('Merge checkout branch changed since integration was prepared.');
  } else if (prepared.target === 'branch') await branchFree(checks, prepared.ref, invocation);
  const current = await revision(runtime, prepared.ref, invocation);
  if (current !== result.commit) {
    if (current !== prepared.expected)
      throw new Error('Merge target changed since integration was prepared.');
    if (prepared.target === 'checkout') {
      await git.run(
        ledger.repo,
        [
          '-c',
          'merge.autoStash=false',
          '-c',
          'merge.verifySignatures=false',
          'merge',
          '--ff-only',
          '--no-edit',
          '--no-verify',
          '--no-overwrite-ignore',
          result.commit,
        ],
        invocation,
      );
    } else {
      if (prepared.target === 'ref') {
        ledger.refs[prepared.ref] = result.commit;
        await runtime.save();
      }
      await git.run(
        ledger.repo,
        [
          'update-ref',
          '--no-deref',
          prepared.ref,
          result.commit,
          prepared.expected ?? '0'.repeat(result.commit.length),
        ],
        invocation,
      );
    }
  }
  return result;
}
