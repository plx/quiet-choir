# Worktree helper module

This is the complete supporting module for [worktree per item](patterns.md#worktree-per-item). Copy
the fence into `worktree-helper.ts` beside `worktrees.workflow.ts`. It uses only Node and Git. The
verifier keeps it identical to `examples/patterns/worktree-helper.ts`; fake-harness tests create
real temporary worktrees, resume without losing edits, and reject changed branch ownership.

The caller chooses an absolute external root and authorizes repository edits. The helper creates new
work and validates reuse; it never resets, prunes, removes branches/worktrees, or commits edits. If
a Git operation fails halfway, inspect its registration/branch/path before retry. This recipe is not
automatic lifecycle management; [#59](https://github.com/plx/quiet-choir/issues/59) tracks that.

<!-- skills-check: example pattern-worktree-helper -->

```ts
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, mkdir, realpath } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { promisify } from 'node:util';

const execute = promisify(execFile);

/** Create or reuse only this run/item's registered worktree; never reset or remove existing work. */
export async function ensureWorktree(options: {
  readonly repo: string;
  readonly root: string;
  readonly runId: string;
  readonly item: string;
  readonly signal: AbortSignal;
}): Promise<string> {
  const { signal } = options;
  signal.throwIfAborted();
  if (!isAbsolute(options.repo) || !isAbsolute(options.root))
    throw new Error('Worktree repo and root must be absolute paths.');
  const repo = await realpath(options.repo);
  await mkdir(options.root, { recursive: true, mode: 0o700 });
  const root = await realpath(options.root);
  const key = createHash('sha256')
    .update(JSON.stringify([options.runId, options.item]))
    .digest('hex');
  const branch = `quiet-choir-${key}`;
  const target = join(root, branch);
  const git = async (cwd: string, args: readonly string[]): Promise<string> => {
    const result = await execute('git', [...args], { cwd, signal, encoding: 'utf8' });
    return result.stdout;
  };
  const listing = await git(repo, ['worktree', 'list', '--porcelain', '-z']);
  const registered = listing
    .split('\0\0')
    .find((block) => block.split('\0')[0] === `worktree ${target}`);
  let exists = true;
  try {
    const entry = await lstat(target);
    if (!entry.isDirectory() || entry.isSymbolicLink())
      throw new Error(`Refusing unowned worktree path: ${target}`);
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') exists = false;
    else throw error;
  }
  if (registered) {
    if (!exists || !registered.split('\0').includes(`branch refs/heads/${branch}`))
      throw new Error(`Worktree registration changed; inspect ${target}`);
    const common = ['rev-parse', '--path-format=absolute', '--git-common-dir'];
    const expected = await realpath((await git(repo, common)).trim());
    const actual = await realpath((await git(target, common)).trim());
    if (
      actual !== expected ||
      (await git(target, ['symbolic-ref', 'HEAD'])).trim() !== `refs/heads/${branch}`
    )
      throw new Error(`Worktree ownership changed; inspect ${target}`);
    return target;
  }
  if (exists) throw new Error(`Refusing existing unregistered directory: ${target}`);
  // Existing branch names and partial Git registrations refuse here; inspect them instead of pruning.
  await git(repo, ['worktree', 'add', '-b', branch, target, 'HEAD']);
  return target;
}
```
