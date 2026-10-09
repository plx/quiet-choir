# Worktree isolation and integration

Use `worktree: true` on a Claude or Codex call when writers may touch the same files, concurrent
commands need a stable tree, or failed partial edits are unsafe to build on. Keep file sharding when
writers have structurally disjoint targets and do not run commands that observe each other's edits.
Isolation is explicit; ordinary calls still run in their configured directory.

The runtime creates detached Git worktrees above the harness interface. The harness receives an
absolute `cwd`; native Claude/Codex worktree flags are never used. Git 2.38+ is required. Embedded
callers supply `RunOptions.processRunner`, usually `new NodeProcessRunner()`; the CLI supplies it.
Dry-run synthesizes fresh isolation instead of creating it. An isolated Claude or Codex call
(`worktree: true` or `worktree: { base }`) is planned in an absolute placeholder directory under the
cache root that is never created, runs no `worktrees.setup`, and returns an unchanged change
`{ base, commit: null, ref: null, files: [] }`. The base is resolved with a read-only
`git rev-parse`, so an unresolvable base or an isolated `cwd` outside the repository fails with the
same configuration error as a real run. A rehearsal runs only read-only Git: `rev-parse`,
`--version`, `git status` of the source checkout, a merge target's `check-ref-format`,
`worktree list` and `symbolic-ref -q`, configuration reads, and a merge preview's quarantined
commands (below). Git older than 2.38, an invalid branch name, a `branch` target that is checked out
in any worktree (the current checkout included) or is a symbolic ref, and a dirty `checkout` target
fail as in a real run, and a dirty source checkout records the real uncommitted-changes warning.
Outside a Git working tree a placeholder of forty zeros stands in, with a warning that the real run
would fail. `ctx.merge` over unchanged changes returns the real no-op result
`{ commit, merged: [], conflicts: [] }`, where `commit` is the existing target branch or `HEAD`. A
dry-run resume or fork that reaches `ctx.merge` with captured commits (a replayed or reused isolated
step) or a replayed `ctx.worktree` handle previews the merge with the real integration code, so
`merged` and `conflicts` (and an `onConflict: 'fail'` error) match a real merge. Its objects go to a
temporary object directory, with the repository's objects as a read-only alternate, that is removed
when the rehearsal ends, so the preview `commit` (dated at the rehearsal attempt's start) resolves
only during the rehearsal and differs from a later real run's. A preview needs the repository:
outside a Git working tree it fails with a configuration error. The rehearsal report marks
synthesized calls with `worktree.synthesized` and lists the merges under `merges`, with `merged` and
`conflicts`; no refs, worktrees, cache directories or repository objects are created. `ctx.worktree`
and effects isolated on a handle still fail with a configuration error before Git or agent
invocation. Rehearse them with a fixture harness in a temporary repository; Git, commands, and local
callbacks remain real, while agent responses incur no model calls.

The source directory must belong to a Git working tree with committed history. Dirty source files
produce a warning: isolated calls start from committed files only. Unmet prerequisites (Git version,
repository, cache root, isolated `cwd`, or a foreign handle) are configuration failures: they are
never retried or settled as data, so correcting them and resuming runs the call live.

<!-- skills-check: fragment; reason: Inside a workflow with ctx and an editor profile declared and granted. -->

```ts
const edit = await ctx.codex.text('edit', {
  prompt: 'Fix the failing parser test.',
  profile: 'editor',
  worktree: true,
});
if (!edit.worktree) throw new Error('Missing isolated change');
const integration = await ctx.merge('integrate', [edit.worktree]);
```

Declare and grant the editing profile as usual. Isolation does not grant tools or filesystem access.
It is not a sandbox: a command can still write outside its directory. Native configuration defaults
to restricted mode; [harness isolation](harness-isolation.md) explains explicit opt-ins and
remaining managed-policy dependencies. `worktree` is the only checkout selector and `isolation` is
only that configuration mode, so `worktree: true` or a handle combines with an inherited role.

## Attempt lifecycle

Use `worktree: { base: 'branch-name' }` or `worktree: { base: { commit: 'full-object-id' } }` to
select a base. The default is `HEAD`. The runtime resolves and saves the base before invocation;
resume does not follow a moved ref. Logical options enter the effect identity. Disposable attempt
paths do not. Relative `cwd` retains its position within the source repository, including when the
run starts in a monorepo subdirectory.

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
Use it as the `worktree` of an agent call, a local step, or an exec:

<!-- skills-check: fragment; reason: Inside a workflow with ctx, z, and an editor profile declared and granted. -->

```ts
const tree = await ctx.worktree('workspace');
await ctx.claude.text('edit', {
  prompt: 'Implement the change.',
  profile: 'editor',
  worktree: tree,
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

| Option                 | Behavior                                                                                |
| ---------------------- | --------------------------------------------------------------------------------------- |
| `strategy: 'rebase'`   | Default: apply each snapshot's net change onto the preceding clean result               |
| `strategy: 'merge'`    | Preserve source commits as merge parents                                                |
| `strategy: 'squash'`   | Publish one final commit parented on the starting commit                                |
| `onConflict: 'report'` | Default: record conflicting inputs, skip them, and continue with other inputs           |
| `onConflict: 'fail'`   | Reject without publishing the integration target                                        |
| `target: 'ref'`        | Default: publish a run-owned ref; leave the source checkout unchanged                   |
| `target: { branch }`   | Create/update an unoccupied local branch; refuse a branch checked out anywhere          |
| `target: 'checkout'`   | Explicitly fast-forward the source checkout; refuse dirty state or a changed target     |
| `commit: { message }`  | Message of the final commit; intermediate commits keep generated messages               |
| `commit.author`        | `'quiet-choir'` (default), `'git-config'` or `{ name, email }` for every created commit |
| `onError: 'return'`    | Save a merge failure and return `Settled<MergeResult>`; resume replays it without Git   |

`onError: 'return'` makes a failed merge a durable branch decision: an `onConflict: 'fail'`
conflict, a dirty checkout target or a target that moved is saved as a settled failure and returned
as `{ ok: false, error }`, and resume replays it without running Git. Cancellation, configuration
failures (including a rehearsal Git refusal) and checkpoint failures still reject, and invalid
options reject before the step is recorded. `'return'` changes the merge's identity; omitting it or
passing `'throw'` does not. The default `onConflict: 'report'` already returns conflicts as data, so
with `'return'` it yields `{ ok: true, value }` holding the same conflicts.

The result is `{ commit, merged, conflicts: [{ commit, files }] }`. `commit` always names the last
clean integrated tree, never a tree containing conflict markers. Conflict path lists can be empty
for structural conflicts. Inspect source snapshots when building a repair prompt, then base the
repair call on `result.commit`. An unchanged source is a no-op. The target's initial commit,
resolved inputs, and computed result are checkpointed so retries do not silently rebase onto a moved
`HEAD`. Publishing a branch compares its old value; a resumed publication recognizes its
already-published result. External repository writers still need coordination.

`commit` gives the integration commits a message and identity, so a published branch can back a pull
request. The message replaces the generated one on the final commit: the squash commit, or the last
clean integrate commit for `rebase` and `merge`. Intermediate commits keep their generated
`quiet-choir integrate` messages. The author applies to every commit the merge creates, as both
author and committer. `'quiet-choir'` is `quiet-choir <quiet-choir@localhost>`. `'git-config'` runs
`git var GIT_AUTHOR_IDENT` and `git var GIT_COMMITTER_IDENT` in the repository. quiet-choir strips
every `GIT_*` variable from git's environment, so the identity comes from `user.name` and
`user.email` in git config, never from `GIT_AUTHOR_NAME` in the parent process. If git cannot
produce an identity the step fails; there is no fallback to `quiet-choir`. The identity is resolved
once, when the merge is prepared, and recorded with the target and commit date, so a retry or resume
reproduces the same commit ID even after git config changes. An empty message, or a name or email
with a newline, NUL or angle bracket, is rejected before anything is prepared. When nothing merges
(unchanged inputs, or every input conflicted) no commit is created and `commit` has no effect.
Supplying `commit` changes the step identity; merges without it keep theirs. Snapshot commits of
isolated attempts always keep the fixed `quiet-choir` identity.

Git's [merge-tree protocol](https://git-scm.com/docs/git-merge-tree/2.38.0) computes integration
without an index or worktree. Explicit checkout publication uses a fast-forward-only merge with
[ignored-file overwrite disabled](https://git-scm.com/docs/git-merge/2.38.0#Documentation/git-merge.txt---no-overwrite-ignore).

### Open a PR from an isolated change

Integrate into a branch with `commit`, then push `result.commit` in one `ctx.exec`:

<!-- skills-check: fragment; reason: Inside a workflow with ctx and an editor profile declared and granted. -->

```ts
const tree = await ctx.worktree('ticket');
await ctx.claude.text('fix', { prompt: 'Fix #42.', profile: 'editor', worktree: tree });
const result = await ctx.merge('integrate', [tree], {
  strategy: 'squash',
  target: { branch: 'ticket-42' },
  commit: { message: 'Fix #42', author: 'git-config' },
});
if (result.merged.length)
  await ctx.exec('push', [
    'git',
    'push',
    'origin',
    `${result.commit}:refs/heads/ticket-42`,
    '--force-with-lease=refs/heads/ticket-42:',
  ]);
```

The published branch is exactly the recorded `result.commit`, so nothing rewrites it after the
merge. `--force-with-lease=refs/heads/<branch>:<expected>` refuses to move a remote branch that does
not hold `<expected>`; leave `<expected>` empty when the remote branch must not exist yet, and pass
the commit you last pushed when updating it. Like every `ctx.exec`, the push is at least once: it
can run again if the run stops after the push but before its checkpoint. Pushing the same commit
again with the empty lease, after it succeeded, exits 0 and prints `Everything up-to-date` (checked
against a local bare repository). Open the PR itself (for example `gh pr create`) with another
ordinary `ctx.exec`; quiet-choir has no PR helper.

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
      worktree: true,
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
`workflow rm RUN` removes the whole run and reuses this cleanup first; it deletes pins only with
`--refs` and otherwise reports them as `keptRefs`; so does `workflow prune`, which removes each run
through rm. If Git cannot remove a cache while the repository exists, rm stops before deleting the
run: caches Git already removed stay removed and are recorded in the ledger, no ref is deleted, and
the record stays for a `workflow clean` retry. When the repository is gone, rm deletes the run's
caches inside `<root>/<runId>-<namespace>/` directly, and then the empty namespace directory. It
deletes only a real directory named by a SHA-256 digest that matches its ledger key, so a corrupt
record cannot point it elsewhere; otherwise it refuses and deletes nothing. See
[removing a run](operating-runs.md#remove-a-run).

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
