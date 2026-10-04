# 0050: Select runs for prune conservatively

- Status: accepted
- Issue: #365 (split from #166, retention)
- Builds on: [0049](0049-guard-held-run-removal.md) (guarded `workflow rm`) and
  [0030](0030-rename-published-run-locks.md) (run lock model)

## Context

`workflow rm` (ADR 0049) removes one run at a time and refuses a held lock, live orphans and,
without `--force`, an active or waiting run. Multi-PR campaigns still leave hundreds of finished
runs, with their transcripts and failed-run caches, and runs whose workspace was deleted keep
listing forever. Operators need to remove them in bulk without weakening any of rm's guards.

The recorded status alone does not say whether a run is still needed:

- Inspection adds `stale` to the recorded statuses: a `running` record whose owner died. Tick may
  still recover it.
- A `failed` run can keep a `waiting` step, and `workflow pending` turns a queued answer into a
  resume entry, so a failed or even completed-looking run may still be consumed.
- Any lock owner or recoverer that is alive, unverifiable or remote, or unreadable lock metadata,
  holds a run (ADR 0030).

## Decision

Add
`workflow prune [--older-than DURATION] [--status S] [--missing-cwd] [--all] [--refs] [--dry-run]`,
executed by `pruneRuns` in `src/workflow/loader/prune.ts` behind a plain `workflow.prune` plan.
Prune selects; rm removes. Prune never deletes a file itself.

**No implicit delete-everything mode.** At least one of `--older-than`, `--status` or
`--missing-cwd` is required; a bare prune fails with `usage.flag` before reading anything.
`--status` accepts only `completed`, `failed` and `cancelled` and defaults to all three. Prune never
passes `--force`; deliberately removing an active run stays a per-run `workflow rm --force`. The
shared duration parser gains a `d` unit, since retention is measured in days; its other callers keep
their own range checks.

**A pure, table-tested selector.** `pruneDecision` in `src/workflow/loader/prune-selection.ts`
(ESLint purity block, `now` passed in) ANDs the filters: the observed status is one of the statuses;
`updatedAt` is strictly older than `--older-than` (an unparseable `updatedAt` never matches); with
`--missing-cwd`, the recorded cwd is known to be missing (stat fails with `ENOENT` or `ENOTDIR`; any
other error is unknown, which never matches). A matching run is then protected, first match wins:
`active` (observed running, stale or suspended; reachable only for a direct caller, since the CLI
accepts terminal statuses only), `locked` or `orphans` (`ownershipHold`, the first two steps of rm's
own verdict, extracted so both share them), `waiting`, and `queued-answer`. The orchestrator gathers
those facts with I/O and leaves the rules to the selector.

**Any inbox file protects a run.** `queued-answer` counts every entry in `<runId>/inbox/` and
`<runId>.inbox/`, and an unreadable inbox counts as one. A leftover delivery the owner would reject
also protects the run. That is deliberate: telling a valid queued answer from a stale one needs the
question's schema and the run's ownership, and guessing wrong loses an answer. The skip message
points at a deliberate `workflow rm` instead.

**Skip, do not fail.** Matching runs that stay are listed in `skipped` with a `reason`, a `code`
(the CLI code rm refuses, or would refuse, with; `workflow.storage`; or null for `queued-answer`), a
message and details, so an operator sees why an old run stayed. Runs that do not match are not
listed. A refusal or failure while removing one run (`locked`, `orphans`, `active`, `changed`,
`gone`, `refused` or `storage`, including a cache Git could not remove) is reported the same way and
the batch continues, as tick reports per-run outcomes. Prune exits 0 whenever enumeration succeeded.
A runs container that cannot be read is not a per-run problem and still fails the command
(`workflow.storage`); runs that `listRuns` cannot read only add warnings and are never removed.

**Sequential guarded removal, pinned to the selection.** Selected runs are removed oldest first, one
at a time, each by `removeRun` without `force` and under its own guard, so rm re-checks its refusals
under the lock and keeps worktree administration under the ADR 0032 lock. Between listing and
removal a resume, an answer or a new run reusing the ID can change the record. rm's `createdAt`
check already refuses a replacement; prune also passes an internal `expectedUpdatedAt`, the
`updatedAt` it selected on, which `removeRun` checks on its first read and again under the lock. A
mismatch refuses with `run.exists`, since the record is no longer the one inspected, and prune
reports it as `changed`. A queued answer can only be written for a waiting step, which the
under-lock `run.active` re-check refuses. A signal stops the batch between removals and fails with
`workflow.interrupted`, naming the runs already removed; they stay removed and a new prune
continues.

**Tombstones and dry run.** Before removing, prune sweeps dead rm tombstones in every scanned
container, so a crashed removal in a container prune selected nothing from is cleaned up too.
`--dry-run` runs every selected removal as an rm dry run: no lock, no sweep and no write, with rm's
paths, caches, refs and bytes, and a dry-run refusal moves the run to `skipped`.

## Consequences

- Retention is one command per policy, previewable byte for byte, and every deletion still passes
  rm's guards; a prune can never remove more than the same sequence of `workflow rm` calls would.
- Old runs with a stale inbox file, a waiting step or an unreadable lock stay until an operator
  removes them deliberately; they show up in `skipped` on every prune.
- `RemoveRunOptions` gains the internal `expectedUpdatedAt`; rm's own flags, refusals and deletion
  order are unchanged, and `src/workflow/runtime/model.ts` is untouched.
- Removing stale project roots for missing cwds (#366), size-based or keep-last-N selection,
  transcript-only trimming and scheduled pruning are out of scope.
