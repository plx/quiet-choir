import { commitId, mergeTreeOutput, type WorktreeGit } from '../../worktrees/git.js';
import type { HarnessInvocation } from './model.js';
import type { StepRecord } from './record.js';
import type { MergeOptions, MergeResult, WorktreeChange } from './worktree-model.js';
import type { WorktreeLedger } from './worktree-schema.js';

/** Git/storage operations supplied by the run owner while holding integration/handle locks. @internal */
export interface MergeRuntime {
  readonly git: WorktreeGit;
  readonly ledger: WorktreeLedger;
  save(): Promise<void>;
  pin(ref: string, commit: string): Promise<void>;
  ref(key: string): string;
  commit(tree: string, parents: readonly string[], message: string, date: string): Promise<string>;
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
async function branchFree(
  runtime: MergeRuntime,
  ref: string,
  invocation: HarnessInvocation,
): Promise<void> {
  const listed = await runtime.git.run(
    runtime.ledger.repo,
    ['worktree', 'list', '--porcelain', '-z'],
    invocation,
  );
  if (listed.stdout.split('\0').includes(`branch ${ref}`))
    throw new Error(
      `Merge target ${ref} is checked out; use target: 'checkout' explicitly for this checkout.`,
    );
  const symbolic = await runtime.git.run(
    runtime.ledger.repo,
    ['symbolic-ref', '-q', ref],
    invocation,
    { codes: [0, 1] },
  );
  if (symbolic.code === 0) throw new Error('Merge branch target cannot be a symbolic ref.');
}
async function cleanCheckout(runtime: MergeRuntime, invocation: HarnessInvocation): Promise<void> {
  if (
    await runtime.git.text(
      runtime.ledger.repo,
      ['status', '--porcelain', '--untracked-files=normal'],
      invocation,
    )
  )
    throw new Error('Merge target checkout is dirty; commit or stash changes before integration.');
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
    if (kind === 'branch') {
      await git.run(ledger.repo, ['check-ref-format', ref], invocation);
      await branchFree(runtime, ref, invocation);
    }
    if (kind === 'checkout') await cleanCheckout(runtime, invocation);
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
    prepared = {
      base,
      ref,
      target: kind,
      expected,
      changes: structuredClone(changes),
      checkoutBranch: kind === 'checkout' ? await checkoutBranch(runtime, invocation) : null,
      date,
    };
    step.merge = prepared;
    await runtime.save();
    await runtime.pin(runtime.ref(`merge-base:${id}:${step.fingerprint}`), base);
  }
  if (!prepared.result) {
    let current = prepared.base;
    const merged: string[] = [],
      conflicts: { commit: string; files: string[] }[] = [];
    const strategy = options.strategy ?? 'rebase';
    for (const change of prepared.changes) {
      if (!change.commit) continue;
      let ours = current;
      if (strategy !== 'merge') {
        // Git 2.38 has no --merge-base option. This virtual commit gives the current
        // tree exactly the source base as parent, implementing its net patch in memory.
        const tree = commitId(
          await git.text(ledger.repo, ['rev-parse', `${current}^{tree}`], invocation),
        );
        ours = await runtime.commit(
          tree,
          [change.base],
          `quiet-choir merge base ${id}`,
          prepared.date,
        );
      }
      const result = await git.run(
        ledger.repo,
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
      current = await runtime.commit(
        parsed.tree,
        strategy === 'merge' ? [...new Set([current, change.commit])] : [current],
        `quiet-choir integrate ${id}: ${change.commit}`,
        prepared.date,
      );
      merged.push(change.commit);
    }
    if (strategy === 'squash' && merged.length) {
      const tree = commitId(
        await git.text(ledger.repo, ['rev-parse', `${current}^{tree}`], invocation),
      );
      current = await runtime.commit(
        tree,
        [prepared.base],
        `quiet-choir squash ${id}`,
        prepared.date,
      );
    }
    prepared.result = { commit: current, merged, conflicts };
    // Pin before publishing a user-selected ref/checkout, so the commit remains available
    // even if publication fails. Persisted result makes a crash after CAS reconcilable.
    await runtime.save();
  }
  const result = prepared.result;
  await runtime.pin(runtime.ref(`integration:${id}:${step.fingerprint}`), result.commit);
  if (prepared.target === 'checkout') {
    await cleanCheckout(runtime, invocation);
    if ((await checkoutBranch(runtime, invocation)) !== prepared.checkoutBranch)
      throw new Error('Merge checkout branch changed since integration was prepared.');
  } else if (prepared.target === 'branch') await branchFree(runtime, prepared.ref, invocation);
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
