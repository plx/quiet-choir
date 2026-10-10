# 0055: Remove leftover launch directories through rm

- Status: accepted
- Issue: #261 (found while implementing #137)
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
  `launch/<n>.runner.json` = `{pid, host, osStartTime}` with mode 0600 and flag `wx`. The write is
  best effort: a failure changes nothing else. Allocation skips an `n` whose `<n>.runner.json`
  survives, so a stale record never describes a new launch.
- A leftover launch directory is `<stateDir>/<runId>/` for a valid run ID with no `run.json`, no
  flat `<runId>.json`, no `<runId>.inbox/`, `<runId>.cancel.json` or `<runId>.json.v<N>` sibling,
  holding exactly one entry, the directory `launch/`, whose entries are all regular files named
  `<n>.log`, `<n>.result.json`, `<n>.input.json` or `<n>.runner.json`. Anything else (a lock, a
  journal, an unknown file or sibling) is not a leftover and keeps today's `run.not_found`.
- A launch number is settled when its `<n>.runner.json` parses and `liveness()` says the runner is
  `dead`, or, without a runner record, when its newest file is older than a fixed floor of one hour
  (`launchSettleFloorMs`). An `alive`, `unknown` or `remote` runner, or an unparsable record, keeps
  it in flight. An empty `launch/` is judged by its own age. A leftover is removable only when every
  launch is settled. The rules live in the pure module `launch-leftover-decision.ts`.
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
- Reading a runner's liveness on macOS runs `ps` once per runner record, so list grows slightly
  slower with the number of leftovers. Directories that are not leftovers are not read.
- Removing unreadable or corrupt run records (#367), sweeping other crash leftovers (#369) and
  having prune remove leftovers in bulk are separate decisions.
  [0060](0060-remove-an-unreadable-run-on-request.md) now covers removing a damaged record with
  `workflow rm --unreadable`.
