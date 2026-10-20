# 0055: Remove leftover launch directories through rm

- Status: accepted
- Issue: #261 (found while implementing #137); runner-record generation binding: #465
- Builds on: [0036](0036-detached-start.md) (detached start and its `launch/` evidence) and
  [0049](0049-guard-held-run-removal.md) (guard-held `workflow rm`)

## Context

`workflow start` creates `<runId>/launch/<n>.log`, `<n>.result.json` and, for stdin input,
`<n>.input.json` under the run's legacy guard, before its detached runner creates the run record. A
runner that fails before the record exists, for example on a type error, leaves `<runId>/launch/`
with no `run.json`. `list`, `inspect` and `clean` key off the record, and `rm` reported
`run.not_found`, so the only way to clear such a directory was to delete it by hand. That is
harmless once the start is over, but deleting it while the start is still in flight loses the only
copy of the runner's log, and the runner may still create the record.

Nothing on disk said whether the start was over. The runner takes no lock until after its type
check, so the lock cannot show it, and the files' age alone cannot tell a slow import from a dead
start.

## Decision

- Start records its runner. Right after a successful spawn and before it polls, start writes
  `launch/<n>.runner.json` = `{pid, host, osStartTime, log}` with mode 0600 and flag `wx`. `log` =
  `{dev, ino, birthtimeNs}` is the identity of the `<n>.log` that start allocated, read with a
  bigint `fstat` of its handle and stored as decimal strings, so a 64-bit inode keeps its precision.
  It binds the record to that launch generation (#465). The write is best effort. Allocation skips
  an `n` whose `<n>.runner.json` survives, so a stale record never describes a new launch.
- When its own write fails (or rejects), start first checks with a bigint `lstat` that the slot's
  current `<n>.log` is still the one it allocated. When that log is gone or another, start is itself
  the stale generation, so it leaves the record alone: it is the newer start's. Otherwise it reads
  `<n>.runner.json` and removes it unless it parses with a binding equal to its own log. A record in
  that slot can then only come from a stale start whose single `open(path, 'wx')` stalled across a
  full run lifecycle, a `workflow rm` and the reuse of the same run ID and launch number. The launch
  is left with no runner record and is judged by its age. Removing by path is safe only there:
  allocation skipped every slot that held a record, so no other legitimate writer targets it, and rm
  cannot remove the directory meanwhile because the launch is in flight either way. A stale writer
  whose open already succeeded writes into the unlinked file harmlessly. A small window remains
  between the `lstat` and the unlink; losing a newer record in it needs another removal and reuse of
  the slot inside that window. Otherwise the write never touches an existing record.
- A leftover launch directory is `<stateDir>/<runId>/` for a valid run ID with no `run.json`, no
  flat `<runId>.json`, no `<runId>.inbox/`, `<runId>.cancel.json` or `<runId>.json.v<N>` sibling,
  holding exactly one entry, the directory `launch/`, whose entries are all regular files named
  `<n>.log`, `<n>.result.json`, `<n>.input.json` or `<n>.runner.json`. Anything else (a lock, a
  journal, an unknown file or sibling) is not a leftover and keeps today's `run.not_found`.
- A launch number is settled when its `<n>.runner.json` parses and `liveness()` says the runner is
  `dead`, or, without a runner record, when its newest file is older than a fixed floor of one hour
  (`launchSettleFloorMs`). An `alive`, `unknown` or `remote` runner, or an unparsable record, keeps
  it in flight. A record whose `log` binding differs from the current `<n>.log` (by dev, inode or
  birth time, read with a bigint `lstat`), or whose launch has no `<n>.log`, counts as unparsable:
  it belongs to another generation, so it keeps the launch in flight and its runner's liveness is
  not read. When only the birth time differs and the current log's birth time equals its change time
  (`ctimeNs`, from the same `lstat` and never stored), the binding is ambiguous instead: the
  runner's liveness is read, and a dead runner settles the launch only once its newest file is also
  older than the floor. This applies equally to the launch judgement of an unreadable run (ADR
  0060). An empty `launch/` is judged by its own age. A leftover is removable only when every launch
  is settled. The rules live in the pure module `launch-leftover-decision.ts`.
- `workflow list` reports removable leftovers in `leftoverLaunches`, from every scanned container,
  and prints a launcher-correct `workflow rm ID --state-dir DIR` line for each. In-flight leftovers
  are omitted; with `--status` the array is empty.
- `workflow rm ID` removes one. It keeps its normal path whenever a record exists; otherwise, when
  the ID names a leftover, it sweeps dead tombstones and judges every launch. In flight, it refuses
  with `run.active` (`details.status: "starting"`), and `--force` never overrides that: there is no
  record to force over, and a live runner would lose its log. Otherwise it takes only the legacy
  guard, without a working directory, so it never registers a project. A held or unreadable guard
  (or a lock beside it, even an empty directory) is refused as `run.locked` before the guard is
  taken, as for an ordinary run. Start's allocation and the runner's `lockRun` take the same guard
  first, so nothing can interleave. Under the guard it re-checks that no record exists
  (`run.exists`) and that the directory is still a settled leftover (`run.active` for a launch
  allocated meanwhile). It renames `<runId>/` to a tombstone and flushes the container (the commit
  point), then deletes the tombstone. The result is the ordinary `workflow.rm.result` with
  `launchOnly: true`; `--refs` is accepted and does nothing. A dry run takes no guard but reports
  the same verdict, including `run.locked` for a held guard.
- `workflow clean` and `workflow prune` are unchanged. Clean works on a run's recorded worktree
  ledger, which a leftover does not have, and prune selects runs by their records (ADR 0050).

## Consequences

- An operator sees each leftover in `workflow list` with the command that removes it, and no longer
  needs to delete run directories by hand.
- The public `CliErrorCode` union is unchanged: the refusals reuse `run.active`, `run.locked` and
  `run.exists`. `run.active` here differs from its usual meaning, since `--force` does not override
  it; the message and `details.status: "starting"` say so.
- The judgement is only as good as the runner record. A start killed between the spawn and the
  `runner.json` write, whose runner then stays alive without a record past the floor (a hung import,
  for example), could be judged settled and removed under it. The runner would then fail to create
  its record or create it in a fresh directory. The floor also delays the removal of launches from
  builds that wrote no runner record until an hour after their last write.
- A runner record on another host (a shared state directory), or a damaged one, keeps the leftover
  in flight for good; remove such a directory by hand once the start is known to be over.
- The binding includes birth time because dev and inode alone cannot tell generations apart: the
  interleaving deletes the first generation's log before the second creates its own, and a
  filesystem such as ext4 often reuses a freed inode number at once. Birth times are compared
  exactly as nanosecond strings; `fstat` at start and `lstat` at the judgement read the same inode,
  so they agree where the birth time is real. A filesystem that reports no birth time gives `0`, and
  the binding then rests on dev and inode alone.
- Where the platform reports no birth time at all, Node can fall back to the change time (libuv does
  where it reads `stat` instead of `statx`), so the log's birth time moves with every write and a
  record never matches its own log exactly. Hence the ambiguous case: a birth time that equals the
  current change time is that fallback's signature, which a log never changed since its creation
  also shows. Settling such a launch only with a dead runner past the floor trusts the record no
  further than the age rule trusts a launch without one, so a stale record in a young reused launch
  still keeps it in flight; a live runner in the record keeps it in flight longer. A birth time that
  differs while the current log's birth and change times differ is another generation's, as before.
  Start's discard likewise treats an ambiguous current log as its own and keeps a bound record whose
  binding is not `different` from the current log: a record it keeps is one the judgement weighs by
  its runner, and a newer start's record bound to the log now in the slot is never removed.
- Records from builds before #465 have no `log`. They still parse and are judged by their runner's
  liveness as before, so a stale unbound record can still settle a reused launch.
- A stale record that lands in a slot before start allocates makes start skip that `n`. The slot is
  then a launch with only a runner record and no `<n>.log`, which the binding keeps in flight for
  good, like a damaged record; remove it by hand. Before #465 such a launch was settled once its
  runner was dead.
- Reading a runner's liveness on macOS runs `ps` once per runner record, so list grows slightly
  slower with the number of leftovers. Directories that are not leftovers are not read.
- Removing unreadable or corrupt run records (#367), sweeping other crash leftovers (#369) and
  having prune remove leftovers in bulk are separate decisions.
  [0060](0060-remove-an-unreadable-run-on-request.md) now covers removing a damaged record with
  `workflow rm --unreadable`.
