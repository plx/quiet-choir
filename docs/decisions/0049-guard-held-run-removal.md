# 0049: Remove a run while holding its legacy guard

- Status: accepted
- Issue: #364 (split from #166, retention)
- Builds on: [0030](0030-rename-published-run-locks.md) (run locks change hands by rename),
  [0032](0032-interprocess-worktree-administration-lock.md) (worktree administration lock) and
  [0019](0019-journal-storage-and-project-state.md) (legacy guard before the current lock)

## Context

Nothing in the CLI deleted a run. Transcripts, artifacts, inboxes, legacy backups and worktree
caches accumulated until an operator deleted directories by hand, which can race a live owner, a
`workflow answer`, or a `workflow list` that then reports a half-deleted run as unreadable. A
retention command (`workflow prune`, later slices) needs a safe primitive for removing one run.

The storage model constrains the order of any deletion:

- Every writer takes the legacy guard `<runId>.json.lock` in the runs container first, then the
  primary `<runId>/lock` inside the run directory. The primary lock therefore cannot outlive its
  directory, but the guard can.
- `listRunIds` lists a flat `<runId>.json` as a run, and `readRun` refuses a format-7 marker whose
  directory is missing ("Directory checkpoint ... missing"). Deleting the directory before the
  marker shows `list` an unreadable run.
- Run IDs match `^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$`, so a name that starts with a dot is never
  listed as a run.
- A failed run can still have waiting steps or a queued answer that `pending` turns into a resume
  entry, so the recorded status alone does not show whether something still needs the run.

## Decision

Add `workflow rm RUN [--force] [--refs] [--dry-run]`, executed by `removeRun` in
`src/workflow/runtime/run-removal.ts` behind a plain `workflow.rm` plan. It never imports workflow
code.

**Guard verdict.** A pure module (`removal-decision.ts`, table-tested, ESLint purity block) judges
the record and a read-only ownership observation, first match wins: `run.locked` when any lock's
owner or recoverer is alive, unknown or remote, or its metadata is missing or unreadable (`--force`
never overrides a lock; the message names `workflow unlock`, with `--force-remote` for a foreign
host); `run.orphans` when a dead or released owner's recorded child is alive or unknown; and, only
without `--force`, the new `run.active` (exit 3) when the status is running or suspended or any step
is waiting. Then rm takes the ordinary `lockRun` without a working directory, so ADR 0030 dead-owner
recovery applies and no project is registered, and it re-applies the `run.active` rule to the record
read under the lock.

**Caches first, and stop if Git cannot remove one.** `cleanWorktrees`' body became
`cleanOwnedWorktrees`, which rm runs under its own ownership, so `git worktree` administration stays
under the ADR 0032 lock and `workflow clean` is unchanged. While a cache remains and its repository
exists, rm stops before deleting the run and fails with `workflow.storage`, naming the remaining
caches, so the ledger survives for `workflow clean`. Caches Git already removed in that pass stay
removed and are recorded in the ledger (`details.removedCaches`), and no ref is deleted. A preflight
could not make Git removal atomic, so the contract names the partial outcome instead. When the
repository is gone, Git cannot run; rm deletes each cache directly. The trust boundary is the
operator's own state: the record is theirs and its namespace a schema-validated UUID, so rm adds
structural checks rather than independent ownership metadata, refusing (and deleting nothing) unless
the ledger root is absolute, every pending cache path is exactly
`<ledger.root>/<runId>-<namespace>/<64 hex digits>`, its ledger key is the SHA-256 digest of that
path (how `RunWorktrees` keys caches), and the namespace and each cache are real directories rather
than symbolic links. A corrupt ledger can then only name a directory `RunWorktrees` could have
created; a cache already gone is just marked removed. Pins are deleted only with `--refs`.

**Deletion order, with the guard held throughout.** 1. `<runId>.cancel.json` and
`<runId>.inbox/`. 2. The flat `<runId>.json`, then a directory fsync: the commit point of an
unmigrated flat run, whose `<runId>/` holds only the lock. 3. The `<runId>.json.v<N>` backups. 4.
Release only the primary lock (an internal `releaseOwner` on the handle `lockRun` returns, with the
usual token and live-child checks, at most once; the full release then frees only the guard). 5.
Rename `<runId>/` to `.<runId>.<pid>.<uuid>.removing`, then a directory fsync: the commit point of a
directory run. 6. The legacy siblings again, the tombstone, and the guard.

Holding the guard while the primary is released keeps every other writer out, because each one takes
the guard first. Removing the flat marker before the directory, and renaming the directory to a
dotted name, mean `list` and `inspect` see either an intact run or none. A crash leaves an intact
run (rm again completes it) or a tombstone. Each rm sweeps tombstones whose PID is dead, skipping
live and unknown ones so a concurrent rm is never disturbed. The signal is honoured only before step
2; after that the removal finishes, so an interrupt (including a `workflow cancel` aimed at rm's own
lock) cannot leave a half-deleted run.

**Dry run and bytes.** `--dry-run` takes no lock, creates nothing and sweeps nothing. It exits 0
whenever the run exists and reports the verdict (`remove`, or the refusal), the paths, caches, refs
and bytes, so `prune` can preview many runs from the same plan. `workflow list` reports each run's
`bytes` (`runBytes`: lstat and readdir only, symlinks not followed, worktree caches excluded); a
size that cannot be measured is null with a list warning, not a skipped run.

## Consequences

- Operators and `prune` have one conservative removal primitive. A run that a pending wait or answer
  still needs is never removed by default, and no lock is ever overridden.
- A crash between steps 2 and 5 of an unmigrated flat run can leave an empty `<runId>/` and backups
  that no longer list as a run; a crash after step 5 leaves a tombstone that the next rm in the same
  runs container sweeps once the crashed process is dead. A reused PID delays that sweep until the
  new process exits.
- `RunLock` gains an internal primary-only release. The lock model itself is unchanged: no new lock
  file, no storage format change, and `src/workflow/runtime/model.ts` is untouched.
- Removing an unreadable run, a lone `<runId>/launch/` from a start that failed before its record,
  or stale project roots is out of scope here; rm reports `run.unreadable` or `run.not_found`.
