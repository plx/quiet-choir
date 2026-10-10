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
read under the lock. The record read under the lock must also carry the `createdAt` of the run rm
inspected: `--run-id` is user-chosen, so another rm can delete that run and a new run can reuse the
ID before the lock is taken. rm then refuses with `run.exists` before touching any cache, ref or
file, and the replacement stays intact.

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

**A handshake with the lock-free answer writer.** `workflow answer` takes no lock, so a sweep alone
cannot stop it from recreating `<runId>/inbox/` or `<runId>.inbox/` after rm finished, leaving an
answer that a later run reusing the ID (`--run-id` is user-chosen) with the same question
fingerprint would ingest. After linking a delivery, the writer re-reads the run
(`withdrawDeliveryIfRunRemoved`): when the run is gone, or the ID names a run with another
`createdAt`, it withdraws the delivery and removes any empty inbox and run directory it recreated,
and fails with a conflict. A run reusing the ID may already have rejected that envelope and a new
writer published its own at the same path, so the writer first renames the path to a private name
and deletes what it took only if its `runCreatedAt` names the removed generation; anything else is
linked back, or left at the private name if the path was taken again, never overwritten. rm's commit
point (step 2 or 5) precedes its sweep in step 6, so a link before the commit point is swept or
renamed into the tombstone, and a link after it sees the run gone at the writer's check. That check
runs after the link, so it cannot stop a run that reuses the ID at once from registering the same
question and reading the delivery first. The envelope therefore carries `runCreatedAt`, the
`createdAt` of the run the writer addressed, and the owner rejects a delivery whose `runCreatedAt`
differs from its own record's (it moves to `.rejected.<uuid>.json` with a `question.rejections`
entry, and `pending` shows it as a queued delivery without attribution). The binding is the
guarantee and the writer's check is the cleanup. The field is optional, so envelopes from older
writers still parse and are accepted as before.

Amended by #371: a timestamp is not unique, so a replacement created with the removed run's exact
`createdAt` (a rewound or frozen clock) would pass every check above. The binding identity is now a
random per-run `generation` (a UUID the runner writes once, when it creates a record, under record
schema revision 17), and `runGeneration(run)` is that token, or `createdAt` for a record without
one. A record is never given a generation later: a resume that assigned one would make envelopes
already written for that run, bound to its `createdAt`, mismatch. rm pins the inspected run's
generation and refuses `run.exists` when the record under the lock carries another; its details add
`expectedGeneration` and `generation` beside `expectedCreatedAt` and `createdAt`, so an operator
sees why rm refused when the two timestamps are equal. Envelopes add `runGeneration` and keep
`runCreatedAt` for owners from older builds, which strip unknown keys and bind on it. An envelope is
addressed to a run when every binding field it carries matches (`envelopeBinding`): the owner
rejects any mismatch, `pending` withholds its attribution, and the writer's withdrawal deletes only
a match, so it never deletes a same-`createdAt` replacement's own delivery. An envelope with neither
field, from an older writer, is still accepted by the owner and kept by the withdrawal. One residual
is accepted rather than closed: a delivery from a `workflow answer` build before #371 carries only
`runCreatedAt`, so a same-`createdAt` replacement still accepts it. Rejecting such envelopes on runs
that have a generation would break mixed-version answering for a clock-rewind-only case.

Holding the guard while the primary is released keeps every other writer out, because each one takes
the guard first. Removing the flat marker before the directory, and renaming the directory to a
dotted name, mean `list` and `inspect` see either an intact run or none. A crash leaves an intact
run (rm again completes it), the leftover of an unmigrated flat run between steps 2 and 5 (which
[0061](0061-finish-interrupted-flat-run-removal.md) finishes), or a tombstone. Each rm sweeps
tombstones whose PID is dead, skipping live and unknown ones so a concurrent rm is never disturbed.
The signal is honoured only before step 2; after that the removal finishes, so an interrupt
(including a `workflow cancel` aimed at rm's own lock) cannot leave a half-deleted run.

**Start is excluded too.** `workflow start` is not a writer: it checks that the run does not exist
and creates `<runId>/launch/` before its detached runner takes the lock. For an unmigrated flat run,
whose `<runId>/` (holding only the primary lock) outlives `<runId>.json` from step 2 to step 5, that
check could pass mid-removal and step 5 would carry the new launch files into the tombstone. So
start makes its check and launch-file allocation under the guard (`withRunGuard`), releases it
before spawning the runner, and refuses a held guard with `run.locked`.

**Dry run and bytes.** `--dry-run` takes no lock, creates nothing and sweeps nothing. It exits 0
whenever the run exists and reports the verdict (`remove`, or the refusal), the paths, caches, refs
and bytes, so `prune` can preview many runs from the same plan. `workflow list` reports each run's
`bytes` (`runBytes`: lstat and readdir only, symlinks not followed, worktree caches excluded); a
size that cannot be measured is null with a list warning, not a skipped run.

## Consequences

- Operators and `prune` have one conservative removal primitive. A run that a pending wait or answer
  still needs is never removed by default, and no lock is ever overridden.
- A crash between steps 2 and 5 of an unmigrated flat run leaves a `<runId>/` holding only the lock,
  and backups, that no longer list as a run. This gap is closed by
  [0061](0061-finish-interrupted-flat-run-removal.md): `workflow rm ID` finishes such a removal
  under the run lock (`interrupted: true`), and `workflow prune` sweeps every one in the containers
  it scans, both refusing while a live owner holds the ID. A crash after step 5 leaves a tombstone
  that the next rm in the same runs container sweeps once the crashed process is dead. A reused PID
  delays that sweep until the new process exits.
- `RunLock` gains an internal primary-only release. The lock model itself is unchanged: no new lock
  file, no storage format change, and `src/workflow/runtime/model.ts` is untouched.
- Removing an unreadable run, a lone `<runId>/launch/` from a start that failed before its record,
  or stale project roots is out of scope here; rm reports `run.unreadable` or `run.not_found`.
  [0055](0055-remove-leftover-launch-directories.md) later lets rm remove the lone `launch/`, and
  [0060](0060-remove-an-unreadable-run-on-request.md) (#367) a damaged record with `--unreadable`.

See also [0050](0050-select-runs-for-prune-conservatively.md), which selects runs for
`workflow prune` and removes each through this primitive.
