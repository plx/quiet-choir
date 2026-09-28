# 0022: Runtime-owned worktree attempts and explicit integration

Status: accepted

## Context

A durable reset step before an agent replays on resume, leaving the retried writer on top of partial
edits. Native harness worktree flags do not expose the directory or commit lifecycle to the engine,
and cannot coordinate local callbacks and commands. Isolation must therefore belong to
orchestration.

## Decision

The runtime uses its existing `ProcessRunner` port for Git and the existing durable process owner.
Harness adapters receive only a remapped `cwd`. Per-call attempts use fresh detached checkouts from
a base pinned before invocation. Successful validated trees become fixed-identity snapshot commits
and run-owned refs, recorded alongside the output. Physical paths are excluded from semantic
identity. Ordinary agent results retain their existing shape; isolated results add `worktree`.

A per-run namespace separates cache/ref ownership even when state containers reuse a run ID. Shared
handles have a pinned base and latest completed snapshot. A resource lock spans reset, invocation,
validation, capture, and durable save. Queued cancellation releases its position without starting
work. Failed snapshots never advance a handle. Missing caches rebuild; ignored dependency caches
survive resets. Completed handle creation cannot be reused into a different run.

Integration is a named effect with ordered inputs. `merge-tree` computes clean trees without
touching the checkout. Rebase/squash use a synthetic current-tree commit parented on the source
base, avoiding a dependency on newer `--merge-base` support absent from Git 2.38. Conflict status
comes from Git's exit code even when no filenames are reported. Report mode skips conflicting inputs
and continues; fail mode publishes nothing. Merge mode retains source parents, and squash emits one
final commit.

Persist the initial target value and resolved inputs before computation, and the computed result
before publication. A compare-and-swap publishes refs; retries recognize an already-published
result. Branch targets must be unoccupied, and only explicit checkout targets may fast-forward a
clean source checkout. Integration locks remain held through the final effect checkpoint.

Cleanup uses only recorded run-owned paths and refs, never global pruning or garbage collection.
Default retention removes all caches on completion but keeps failed attempts while recovery remains
possible. Source-free CLI cleanup acquires the ordinary writer and orphan checks. Explicit ref
cleanup compares recorded values and refuses changes or symbolic redirection.

## Consequences

Git 2.38+ and an injected process adapter are required for live isolation. Base files are committed
state; dirty files are warned about and excluded. Setup is repeatable live provisioning under the
nested-effect guard. Isolation is not a sandbox, and external effects remain at least once. Sharding
is still suitable for structurally disjoint edits. Worktree policies do not authorize tools or
grants.

The protocol relies on [merge-tree](https://git-scm.com/docs/git-merge-tree/2.38.0),
[commit-tree](https://git-scm.com/docs/git-commit-tree), and
[update-ref](https://git-scm.com/docs/git-update-ref). See [the operational guide](../worktrees.md).

## Follow-up from Workflow Lab Batch 02

Sibling Git registrations are serialized per repository without serializing their agent work.
Concurrent setter SIGKILL tests exposed a Git registration window: a planned checkout can have an
empty `commondir`, which prevents subsequent worktree creation. Resume reconciles only that narrow
state after ownership recovery and before live Git worktree operations. Both directions of the
checkout/registration link must match the ledger-owned path, the metadata directory must remain
inside the recorded repository, and publication checks the empty-file digest. Completed effects,
refs and failed per-call cache reuse rules are unchanged. Unowned or otherwise corrupt Git metadata
is not repaired implicitly.
