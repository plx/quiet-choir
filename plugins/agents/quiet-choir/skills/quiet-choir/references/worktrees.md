# Worktree isolation and integration

Use `isolation: 'worktree'` on a Claude or Codex call when writers may touch the same files,
concurrent commands need a stable tree, or failed partial edits are unsafe to build on. Keep file
sharding when writers have structurally disjoint targets and do not run commands that observe each
other's edits. Isolation is explicit; ordinary calls still run in their configured directory.

The runtime creates detached Git worktrees above the harness interface. The harness receives an
absolute `cwd`; native Claude/Codex worktree flags are never used. Git 2.38+ is required. Embedded
callers supply `RunOptions.processRunner`, usually `new NodeProcessRunner()`; the CLI supplies it.
Dry-run synthesizes fresh isolation instead of creating it. An isolated Claude or Codex call
(`isolation: 'worktree'`, `worktree: true`, or `{ kind: 'worktree', base }`) is planned in an
absolute placeholder directory under the cache root that is never created, runs no
`worktrees.setup`, and returns an unchanged change `{ base, commit: null, ref: null, files: [] }`.
The base is resolved with a read-only `git rev-parse`, the only Git command a rehearsal runs, so an
unresolvable base or an isolated `cwd` outside the repository fails with the same configuration
error as a real run. Outside a Git working tree a placeholder of forty zeros stands in, with a
warning that the real run would fail. `ctx.merge` over unchanged changes returns the real no-op
result `{ commit, merged: [], conflicts: [] }`, where `commit` is the existing target branch or
`HEAD`. The rehearsal report marks these calls with `worktree.synthesized` and lists the merges
under `merges`; no refs, worktrees or cache directories are created. `ctx.worktree`, effects
isolated on a handle, and merges of captured commits still fail with a configuration error before
Git or agent invocation. Rehearse them with a fixture harness in a temporary repository; Git,
commands, and local callbacks remain real, while agent responses incur no model calls.

The source directory must belong to a Git working tree with committed history. Dirty source files
produce a warning: isolated calls start from committed files only. Unmet prerequisites (Git version,
repository, cache root, isolated `cwd`, or a foreign handle) are configuration failures: they are
never retried or settled as data, so correcting them and resuming runs the call live.

<!-- skills-check: fragment; reason: Inside a workflow with ctx and an editor profile declared and granted. -->

```ts
const edit = await ctx.codex.text('edit', {
  prompt: 'Fix the failing parser test.',
  profile: 'editor',
  isolation: 'worktree',
});
if (!edit.worktree) throw new Error('Missing isolated change');
const integration = await ctx.merge('integrate', [edit.worktree]);
```

Declare and grant the editing profile as usual. Isolation does not grant tools or filesystem access.
It is not a sandbox: a command can still write outside its directory. Native configuration defaults
to restricted mode; [harness isolation](harness-isolation.md) explains explicit opt-ins and
remaining managed-policy dependencies. Use `worktree: true` or a handle with an inherited role to
combine checkout isolation and inherited native configuration.

## Attempt lifecycle

Use `{ kind: 'worktree', base: 'branch-name' }` or
`{ kind: 'worktree', base: { commit: 'full-object-id' } }` to select a base. The default is `HEAD`.
The runtime resolves and saves the base before invocation; resume does not follow a moved ref.
Logical options enter the effect identity. Disposable attempt paths do not. Relative `cwd` retains
its position within the source repository, including when the run starts in a monorepo subdirectory.

Every attempt receives a fresh directory. Failed, timed-out, and cancelled attempts are retained
according to policy, never reused for a later per-call attempt. Only a validated successful result
is captured. The runtime stages tracked and untracked files, honors Git ignores, leaves out the
paths `worktrees.setup` created and the `worktrees.captureExclude` patterns (see
[cache policy](#cache-policy-and-cleanup)), creates a snapshot commit with a fixed identity, and
pins it under `refs/quiet-choir/<run>/<namespace>/…`. Hooks and commit signing are disabled for
these internal Git operations. The agent need not run Git commits.

An isolated `object()` or `text()` result includes `worktree: { base, commit, ref, files }`.
`commit` and `ref` are null when unchanged from the base. File statuses are added, modified,
deleted, or renamed; rename paths name the destination. Ordinary and legacy results omit `worktree`,
keeping their existing schema and replay identities. `value()` returns only the output; use a result
method or a shared handle when later integration needs the captured change.

The directory is a cache. Pinned commits are the durable record. Completed replay runs neither Git
nor the harness. Effects remain at least once: a crash before checkpoint completion may repeat an
agent call, and external writes outside the isolated tree are not rolled back.

## Shared write, test, fix sequences

`ctx.worktree(id, { base? })` returns a JSON `{ id, path, base }` handle owned by the creating run.
Use it as agent `isolation`, local-step `worktree`, or exec `worktree`:

<!-- skills-check: fragment; reason: Inside a workflow with ctx, z, and an editor profile declared and granted. -->

```ts
const tree = await ctx.worktree('workspace');
await ctx.claude.text('edit', {
  prompt: 'Implement the change.',
  profile: 'editor',
  isolation: tree,
});
const test = await ctx.exec('test', ['npm', 'test'], { worktree: tree, okExitCodes: 'any' });
await ctx.step('inspect', {
  input: { testCode: test.code },
  worktree: tree,
  schema: z.null(),
  run: async ({ cwd }) => {
    /* local work inside cwd */ return null;
  },
});
const merged = await ctx.merge('integrate', [tree]);
```

Effects on one handle serialize through result validation, snapshot capture, and checkpoint save.
Before each live attempt the cache resets to its latest completed snapshot and cleans untracked
files; ignored caches such as `node_modules` remain. Missing directories rebuild from the saved
commit. A failed write cannot become the next effect's baseline. Local `StepContext.cwd` is the
mapped execution directory; the handle's `path` is the repository root. Write through managed
effects, not body code using `handle.path`: body code reruns and bypasses serialization.

Handles belong to one run. Forks create new handles; immutable `WorktreeChange` results can be
reused from the source run. Cleaning a fork never removes source-owned caches or pins.

## Explicit integration

`ctx.merge(id, changes, options?)` integrates changes or shared handles in input order. Shared
handles are resolved to saved snapshots under their locks before integration starts. Options are:

| Option                 | Behavior                                                                            |
| ---------------------- | ----------------------------------------------------------------------------------- |
| `strategy: 'rebase'`   | Default: apply each snapshot's net change onto the preceding clean result           |
| `strategy: 'merge'`    | Preserve source commits as merge parents                                            |
| `strategy: 'squash'`   | Publish one final commit parented on the starting commit                            |
| `onConflict: 'report'` | Default: record conflicting inputs, skip them, and continue with other inputs       |
| `onConflict: 'fail'`   | Reject without publishing the integration target                                    |
| `target: 'ref'`        | Default: publish a run-owned ref; leave the source checkout unchanged               |
| `target: { branch }`   | Create/update an unoccupied local branch; refuse a branch checked out anywhere      |
| `target: 'checkout'`   | Explicitly fast-forward the source checkout; refuse dirty state or a changed target |

The result is `{ commit, merged, conflicts: [{ commit, files }] }`. `commit` always names the last
clean integrated tree, never a tree containing conflict markers. Conflict path lists can be empty
for structural conflicts. Inspect source snapshots when building a repair prompt, then base the
repair call on `result.commit`. An unchanged source is a no-op. The target's initial commit,
resolved inputs, and computed result are checkpointed so retries do not silently rebase onto a moved
`HEAD`. Publishing a branch compares its old value; a resumed publication recognizes its
already-published result. External repository writers still need coordination.

Git's [merge-tree protocol](https://git-scm.com/docs/git-merge-tree/2.38.0) computes integration
without an index or worktree. Explicit checkout publication uses a fast-forward-only merge with
[ignored-file overwrite disabled](https://git-scm.com/docs/git-merge/2.38.0#Documentation/git-merge.txt---no-overwrite-ignore).

## Cache policy and cleanup

The policy fields are `root`, `keep`, `setup` and `captureExclude`. Declare them on the root
workflow definition, so `workflow execute` uses them too:

```ts
import { symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { defineWorkflow, z } from 'quiet-choir';

export default defineWorkflow({
  name: 'ticket',
  version: '1',
  input: z.object({}),
  output: z.array(z.string()),
  worktrees: {
    captureExclude: ['**/*.log', 'tmp/**'],
    // This module sits at the repository root; link its dependencies into each checkout.
    setup: async ({ path }) => {
      await symlink(join(import.meta.dirname, 'node_modules'), join(path, 'node_modules'));
    },
  },
  async run(ctx) {
    const edit = await ctx.codex.text('edit', {
      prompt: 'Fix the failing test.',
      isolation: 'worktree',
    });
    return edit.worktree?.files.map((file) => file.path) ?? [];
  },
});
```

`RunOptions.worktrees` takes the same fields. Each field it sets replaces the definition's field of
the same name; the others keep the definition's values. Only the root definition passed to
`runWorkflow` (or the CLI) is read: a child workflow's `worktrees` field is ignored. The definition
field is validated when the workflow loads (`workflow validate` reports a bad `keep`, an empty
`root`, a non-function `setup` or a non-string pattern). None of these fields enters step identity
or the workflow fingerprint, so changing them never needs `--accept-code-change` beyond the usual
source drift check.

From the CLI, `--worktree-keep all|failed|none` and `--worktree-root DIR` on `workflow execute`,
`workflow start` and `workflow resume` replace the definition's `keep` and `root`. A relative root
resolves against the invocation's directory. Like `--wait-mode`, both are recorded in the run's
launch policy and inherited, field by field, by a later `workflow resume`, `execute --resume`,
`answer --resume` or `workflow tick` that does not repeat them; emitted resume commands include
them. Tick has no worktree flags of its own. `setup` and `captureExclude` have no flags: declare
them in code.

The default root is project-specific XDG state outside the checkout; an explicit root must also be
outside it. The canonical root is pinned on first use, so a different root on a later execution does
not relocate an existing run's caches and handles: the run keeps its root and records a worktree
warning naming both paths. Each run has a unique namespace, including runs with the same ID in
different state containers.

`keep: 'failed'` is the default: remove completed caches after draining, retain failed attempts for
inspection until the whole run completes, then remove all caches. `'all'` keeps every cache;
`'none'` removes all caches after draining even on failure. Pins remain in all three cases. Cleanup
failures are warnings and do not repeat validated agent work.

`setup(context)` provisions dependencies after creation/reset, for per-call attempts and for shared
handles (at `ctx.worktree` and before each effect on the handle). Its context includes `path`,
mapped `cwd`, pinned `base`, run/step IDs, attempt, and cancellation signal. Honor cancellation and
keep provisioning repeatable. It is a live callback, not a durable step; do not nest context
operations. Meaningful dependency changes still require explicit workflow version/dependency
discipline. It never runs under `--dry-run`.

`workflow inspect RUN` includes base, commit, changed files, and current directory state.
`workflow clean RUN` acquires the usual writer/orphan guards and removes owned leftover caches
without loading workflow source. `--refs` additionally deletes recorded pins only if their values
still match. It does not delete user branches or run Git garbage collection. Removing pins can make
future recovery or integration impossible after Git collects otherwise unreachable objects.

### What capture leaves out

The checkout is clean before setup runs (a fresh `worktree add`, or a reset and `git clean` of a
handle), so after setup returns the runtime lists the untracked, non-ignored paths with
`git status --porcelain --untracked-files=normal` and saves them on the cache's ledger entry before
any agent or command starts. Capture excludes those paths literally, so a resumed run excludes them
too. `normal` reports a new untracked directory as one path: a `node_modules` tree that setup
creates without an ignore rule is one entry, not thousands. The trade-off is that a file an agent
creates inside a directory that setup created is not captured either. Tracked files that setup
modifies are captured like agent edits; setup should only add untracked or ignored artifacts.

`captureExclude` lists Git glob pathspecs, relative to the repository root, that capture never
stages. `*` stays within one directory and `**` spans directories: `tmp/**` is everything under
`tmp`, `*.log` is top-level logs, and `**/*.log` is logs at any depth. A matching tracked file keeps
its previous content in the snapshot. Files that match neither list are still captured.

A captured symlink whose target is absolute, or climbs out of the repository from the link's
directory (judged lexically, without following other links), adds a worktree warning naming the
step, the link and its target. Run results and `workflow inspect` show it. The link is still
captured; create it from `setup` or list it in `captureExclude` to keep it out.

### Node dependencies

Git's `node_modules/` ignore rule matches directories only, so a `node_modules` symlink is untracked
and not ignored, and plain `git add --all` would commit it. Two recipes:

- Link the source checkout's dependencies from setup, as in the example above. The link is excluded
  from capture only because setup created it; an agent that creates the same link gets it captured,
  with the symlink warning.
- Install per checkout with `npm ci --prefer-offline` from setup (through your own process call;
  setup has no `exec`). The installed `node_modules/` directory is ignored and never captured, and
  `--prefer-offline` installs from npm's local cache when it can.
