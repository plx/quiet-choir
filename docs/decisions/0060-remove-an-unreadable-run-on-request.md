# 0060: Remove a run whose record is damaged, on request

- Status: accepted
- Issue: #367 (found while implementing #364)
- Builds on: [0049](0049-guard-held-run-removal.md) (guard-held `workflow rm`) and
  [0055](0055-remove-leftover-launch-directories.md) (leftover launch directories and their
  in-flight judgement)

## Context

`workflow rm` judges a run from its record: its status and waiting steps decide `run.active`, its
generation (its `createdAt` before #371) pins the run it removes and its worktree ledger names the
caches and refs to clean. When the record cannot be read, rm reported `run.unreadable` (or
`run.not_found`, when `run.json` was present but `journal.jsonl` was missing) and the run could only
be deleted by hand. That leaves the operator to get the liveness checks, the lock order and the
deletion order right, which rm already encodes.

The lone `<runId>/launch/` of a start that failed before its record, the other case of #367, is
already removed by `workflow rm ID` ([0055](0055-remove-leftover-launch-directories.md)).

## Decision

- `workflow rm RUN --unreadable` removes a run whose record file (`<runId>/run.json` or the flat
  `<runId>.json`) is present but whose content is damaged. It is a per-ID flag, so it is explicit
  consent for one run; `workflow prune` never selects such a run, and stays as conservative as
  [0050](0050-select-runs-for-prune-conservatively.md) made it.
- What counts as damaged is an allowlist of content failures (`damagedRecordCode` in the pure
  `removal-decision.ts`): a `run.unreadable` read whose filesystem code is null (a parse or schema
  failure, a journal sequence gap, a format-7 marker whose directory is missing), `EISDIR` or
  `ENOTDIR`, and a `run.not_found` read while the record file is present (a missing companion, such
  as `run.json` without `journal.jsonl`), which rm now reports as `run.unreadable`. `EACCES`,
  `EPERM`, `EIO`, `EMFILE` and every other code are still refused, since the record may be intact,
  and so is `run.incompatible`, since a newer build can read and remove that record. A record path
  of the wrong kind, such as a directory at `<runId>.json`, is removed whole.
- Without the flag, rm's refusal of a damaged record keeps `run.unreadable` (exit 3) and names the
  removal command in its message and in `details.next`, built with the invocation's launcher and
  keeping `--dry-run` for a dry run. The top-level `next` passes it through.
- The flag only permits removing a damaged record. A readable run is judged and removed exactly as
  without it, and a leftover launch directory still takes the leftover path (`launchOnly: true`).
  `--force` adds nothing, because the status and waiting steps cannot be known, and never overrides
  a lock, orphans or an in-flight launch.
- Guards, before the lock: `ownershipHold` (it reads only lock metadata) refuses `run.locked` for an
  alive, unknown or remote owner or recoverer, or unreadable lock metadata, and `run.orphans` for a
  dead owner's live child. Every launch in `<runId>/launch/` is judged by the 0055 rule; any launch
  that may be in flight refuses `run.active` (`details.status: "starting"`), even with `--force`,
  since a `workflow start --resume` runner may be between its spawn and its lock. Files in `launch/`
  that are not launch evidence are ignored.
- rm then takes the run lock as ordinary rm does, without a working directory (recovering a dead
  owner's lock), and reads the record again. No writer or compaction can run while the locks are
  held, so that read is authoritative: a record that is still damaged by the same rule is removed; a
  readable one refuses `run.exists` ("became readable after rm inspected it"); a missing one is
  `run.not_found`; any other failure is reported as it is. The launches are judged again under the
  lock, then rm follows the unchanged guard-held deletion order of 0049, shared with the ordinary
  path.
- No worktree caches or refs are touched, because the ledger that names them cannot be read. The
  result has `unreadable: true` (false for every other removal) and a warning that points to
  `git worktree list` (and `git worktree prune`) in the run's repository and to
  `refs/quiet-choir/<runId>/`. A dry run takes no lock and reports `remove` or the refusal a real
  removal would meet now: `run.locked` or `run.orphans`, then `run.active`.

## Consequences

- A damaged run no longer needs hand deletion, and both #367 cases go through `workflow rm ID`: a
  lone `launch/` without a flag, a damaged record with `--unreadable`.
- Worktree caches and pinned refs that the damaged record named are orphaned. The warning says how
  to find them; removing them, or scanning cache roots for them, is out of scope.
- A permission or I/O problem never destroys a run that might be intact, at the cost of manual
  cleanup for a record that is both damaged and unreadable for such a reason.
- rm reports `run.unreadable` instead of `run.not_found` when the record file is present but a
  companion is missing; other commands keep their codes.
- Judging launches with the one-hour floor may refuse a damaged run that a build without runner
  records started recently, as for 0055.
- The public `CliErrorCode` union and the storage format are unchanged; `workflow.rm.result` gains
  the `unreadable` field.
