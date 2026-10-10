# 0061: Finish an interrupted flat-run removal on rm and in prune

- Status: accepted
- Issue: #369 (found while implementing #364)
- Builds on: [0049](0049-guard-held-run-removal.md) (guard-held `workflow rm`),
  [0050](0050-select-runs-for-prune-conservatively.md) (`workflow prune`),
  [0055](0055-remove-leftover-launch-directories.md) (leftover launch directories) and
  [0030](0030-rename-published-run-locks.md) (dead-owner lock recovery)

## Context

`workflow rm` of an unmigrated flat run commits when it deletes the flat `<runId>.json` (step 2 of
0049). It then deletes the `.json.v<N>` backups, releases the primary lock and renames `<runId>/` to
a tombstone. A crash between step 2 and step 5 leaves `<runId>/` holding only the primary lock (or
nothing), any backups not yet deleted, and the legacy guard `<runId>.json.lock`, both locks owned by
the dead process. None of these list as a run, so `workflow rm ID` answered `run.not_found` and
nothing ever removed them. Tombstones (after step 5) were already swept by every rm and prune.

## Decision

**The leftover.** For a valid run ID in a runs container, the pure `interruptedRemovalShape` in
`removal-decision.ts` (table-tested, ESLint purity block) accepts exactly this shape:

- no record: neither `<runId>/run.json` nor `<runId>.json` (an entry that cannot be checked counts
  as present);
- no legacy `<runId>.inbox` or `<runId>.cancel.json`, which rm deletes before its commit point;
- `<runId>/` absent, or a real directory (not a symbolic link) whose entries are only the `lock`
  directory and that lock's `.tmp` or `.gone` strays;
- at least one of `<runId>/` or a `<runId>.json.v<N>` backup;
- the legacy guard may be present.

Everything else keeps `run.not_found`: `launch/` (the 0055 leftover, which also rejects backups, so
the two shapes are disjoint), `journal.jsonl` (a run before its first snapshot), `inbox/` or any
unknown entry. The I/O inspector `inspectInterruptedRemoval` (`interrupted-removal.ts`) gathers the
facts, including the stray flag from lock.ts's own stray parser, so the pure module never imports
lock.ts.

**Liveness.** Before taking any lock, `ownershipHold` refuses `run.locked` while a guard or primary
owner or recoverer is alive, unknown or remote, or its metadata is missing or unreadable, and
`run.orphans` while a dead owner's recorded child is alive or unknown; `--force` overrides neither.
A run that is being created holds the guard and the primary with a live owner, so it is refused. rm
then takes the ordinary run lock without a working directory, so 0030 dead-owner recovery reclaims
the crashed rm's locks and no project is registered (when only backups remain, the lock creates
`<runId>/`, which the deletion renames away). Every writer and start take the guard first, so under
the lock the facts cannot change: rm re-checks them, refusing `run.exists` when a record is present
now ("A run now holds ID ...") and `run.not_found` when the shape no longer matches, and the release
leaves everything else as it was. Only then does it run the 0049 deletion order again
(`deleteRunFiles`): each step tolerates a path that is already gone, so no new deletion logic is
needed, and the answer writer's handshake applies as before.

**rm finishes one ID; prune sweeps its containers.** `workflow rm ID` checks for the leftover right
after the 0055 leftover, in the dry run and the real removal alike, and only without prune's pinned
`expectedUpdatedAt`. The operator who saw rm crash knows the ID. A crash inside a prune leaves IDs
nobody saw, so `workflow prune` also scans each runs container it lists, right after its tombstone
sweep: one `readdir` per container, candidates being valid-ID entries and the IDs of `.json.v<N>`
backups, minus IDs whose `<runId>.json` is listed, then one inspection per candidate. A real prune
finishes each through `finishInterruptedRemoval`, never `removeRun`: if a candidate became a real
run between the scan and the lock, the finisher's re-check refuses it where `removeRun` would judge
and remove the new run. Refusals with `run.locked`, `run.orphans`, `run.exists` or `run.not_found`
are skipped silently (a held candidate is usually a run being created); any other failure becomes a
prune warning and the sweep goes on. A signal stops the sweep between candidates. A dry run lists
the candidates that ownership does not hold. rm does not scan its container: telling a leftover from
a directory run takes an lstat of `<runId>/run.json` per directory, too costly on every rm and
quadratic across a prune's removals.

**Legacy discovery.** Without `--state-dir` or `QUIET_CHOIR_STATE_DIR`, `resolveStateDir` picks the
legacy `<cwd>/.quiet-choir/runs` only while a record of the ID exists there, and an unmigrated flat
run, the one this leftover comes from, usually lives there. So rm alone resolves its container with
`resolveRemovalStateDir`: when the ordinary resolution is the project's default container and that
holds no record, interrupted removal or leftover launch directory of the ID, an interrupted removal
in the legacy container is finished there, with the usual legacy-directory warning. The other
commands keep `resolveStateDir`; prune already scans the legacy container of the project it runs in
when neither is set.

**Results.** `workflow.rm.result` gains `interrupted`: true only on this path (false everywhere
else, like `launchOnly` and `unreadable`), with `paths` (the directory, the guard and the backups
that exist), `bytes`, and empty `caches`, `refsRemoved` and `keptRefs`, since an ordinary rm removes
those before its commit point. `--refs`, `--force` and `--unreadable` change nothing on this path. A
dry run takes no lock and reports `remove`, or the `run.locked` or `run.orphans` refusal a real rm
would meet. `workflow.prune.result` gains `unfinishedRemovals`, the absolute `<stateDir>/<runId>`
paths finished (or, in a dry run, that a prune would finish), and an interrupted prune's
`workflow.interrupted` details carry the ones finished so far. Prune still deletes no file itself.

## Consequences

- The 0049 gap is closed: a crash between steps 2 and 5 of an unmigrated flat run is finished by the
  next `workflow rm ID` or by any later `workflow prune` scanning that container.
- The ADR 0051 root pruning runs after the sweep and counts the leftover's paths as removed, so a
  stale root whose `runs/` held only such a leftover can be judged empty, in a dry run too.
- Prune costs one more `readdir` per scanned container and one inspection per directory or backup ID
  not listed as flat. rm costs one inspection of its own ID, which stops at the record check for an
  ordinary run.
- A lone dead guard `<runId>.json.lock` with no directory or backups is not a leftover here: the
  next lock of that ID recovers it, as before.
- No new `CliErrorCode`, no storage format change, and `src/workflow/runtime/model.ts` is untouched;
  both result additions are new fields.
