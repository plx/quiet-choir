# 0030: Publish, release and recover run locks by rename

- Status: accepted
- Issue: #208; amended by #209 (guarded `workflow unlock`)
- Extends [ADR 0002](0002-durable-external-workflows.md)'s local run lock and
  [ADR 0013](0013-process-ownership.md)'s dead-owner recovery.

## Context

Every writer holds two lock directories for a run, always in the same order: the legacy guard
`<runId>.json.lock` in the runs container, then the primary `<runId>/lock`. Before this decision,
none of their transitions was crash-atomic:

- Acquire made the directory with `mkdir` and wrote `owner.json` afterwards. A crash in between left
  an empty lock that every later acquire refused as "incomplete ownership metadata".
- Recovery claimed a dead owner's lock with a bare `mkdir(<lock>/recovery)`. A recoverer that
  crashed left it behind for good, and nothing could tell a live recoverer from a dead one, so tick
  skipped the run as `locked` forever.
- Release and recovery deleted the lock with a recursive `rm`. A crash mid-`rm` left a partly
  deleted lock, and a racing acquirer could see a lock without `owner.json`.
- Inspection read only the lock that ownership resolves to, so `classifyRecovery` and tick could not
  see the guard or a recovery claim.

## Decision

Every ownership transition is one rename (or one `link`), and whatever a crash leaves behind is a
state that a plain `workflow resume` or `workflow tick` recovers.

**Acquire.** Each acquire makes a private sibling directory `<lock>.<pid>.<uuid>.tmp` (mode 0700),
writes `owner.json` into it exclusively and fsyncs it, fsyncs the directory and the parent, renames
the directory onto the lock path and fsyncs the parent again. A lock therefore never exists without
a complete `owner.json`. The rename fails with `ENOTEMPTY` or `EEXIST` when a lock is present (and
with `EPERM` on Windows, which counts as contention only when the lock path exists); that is the
existing contention path, which reads `owner.json` and applies the dead/released recovery rules. Any
other failure removes the tmp directory. Because a rename replaces an empty directory, an empty lock
left by an older build's crashed `mkdir` is simply taken over.

A contender that reads a lock another process is retiring may find `owner.json` missing because the
lock is gone, or already replaced by a new, complete one. It judges a missing `owner.json` only
after repeated looks: a vanished lock means "look again", and only a lock that stays without
`owner.json` is refused as incomplete (damage, or an older build).

**Release and recovery.** Both re-verify the owner token, rename the lock to a tombstone
`<lock>.<pid>.<uuid>.gone`, fsync the parent, and check that the tombstone's `owner.json` (and, for
recovery, its `recovery.json`) carry the expected tokens. On a mismatch the tombstone is renamed
back and the transition refuses: release with "ownership was lost", recovery with "ownership changed
during recovery; retry". Otherwise the tombstone is deleted. Release keeps its errno contract: a
vanished lock, or a failed rename or tombstone removal after the token was verified, surfaces its
errno (`ENOENT`, `EACCES`), which the runner turns into a warning. The released-owner path (children
still alive) is unchanged.

**Sweep.** After publishing, the new owner removes the stray siblings of its own lock path, next to
the existing sweep of abandoned atomic-write files: every `.gone` tombstone, and every `.tmp`
directory whose embedded PID is dead. A live or unverifiable creator's `.tmp` stays. Sweep errors
are ignored: a stray is harmless, and one that cannot be removed must not block every later acquire.
Only a sweep removes files from a tombstone, so a retirer that finds a file missing from its own
verified tombstone treats it as already being swept. Run IDs cannot contain `.`, so the guard's
strays never appear as runs.

**Recovery marker.** `recovery/` is replaced by `recovery.json` `{ pid, host, osStartTime, token }`
with a fresh token per recovery attempt. It is published by writing and fsyncing
`recovery.<uuid>.tmp` inside the lock and `link()`ing it to `recovery.json`, so a visible marker is
always complete; `EEXIST` is contention and `ENOENT` means the lock itself vanished. A marker is
judged by the same liveness rules as an owner (a shared helper generalized from the owner check): an
alive, unknown or remote recoverer, or an unparseable marker (damage only), holds the lock with
"lock recovery is in progress". A dead recoverer's marker is reclaimed without ABA: rename it to
`recovery.<uuid>.stale`, read it back, and only if it still carries the token that was judged dead
unlink it and link a new marker (`EEXIST` means another recoverer won). Otherwise link it back
(leaving it aside if a newer marker took the name) and refuse with "retry". The recoverer then
re-verifies the owner token, stops or refuses orphans, re-reads its own marker token just before the
tombstone rename (a reclaimer may have judged it dead), and retires the lock. If recovery fails, it
removes only its own marker, with the same take-and-verify step.

**Inspection and classification.** The public `RunOwnership` gains a required `locks` array (an
additive change): every existing lock, primary first, then the guard, each with its path, its owner
and liveness (or null), any recovery marker with its liveness, and a warning only when `owner.json`
or `recovery.json` exists but cannot be read. The top-level `locked`, `owner`, `processes` and
`warning` are derived exactly as before, from the lock that ownership resolves to.
`classifyRecovery` stays pure: a run is `held` when the top-level owner is, or when any lock has a
warning, no readable owner, an owner that is not dead or released, or a recovery marker that is not
dead. Tick therefore skips a run as `locked` only while a recoverer is really alive, unknown or
remote, and a dead recoverer's run is recovered through ordinary lock acquisition.

## Consequences

- A SIGKILL right after a lock is published, after a release renamed it to a tombstone, or after a
  recovery marker was linked leaves a run that the next plain resume or tick recovers.
  `test/lock-crash-cli-smoke.mjs` injects each crash with a preload that patches `node:fs/promises`
  through `syncBuiltinESMExports()`, with no hook in production code.
- `test/lock-race.test.ts` races 200 acquire/release cycles across four processes against an
  observer that never sees a lock without a readable `owner.json`. The same test fails against the
  previous `mkdir` protocol.
- Mixed builds are not coordinated. An older build's in-flight `mkdir` acquire can have its empty
  lock replaced by this build's rename; its failed `owner.json` write then removes the newer owner's
  lock. An older build's `recovery/` directory is ignored, not respected, so a crashed old recoverer
  cannot wedge a run; a live old recoverer racing a new one is not excluded. Upgrade by letting
  older builds' runs finish or stop first.
- A lock that exists without a readable `owner.json` is still refused by acquire, and an unreadable
  `recovery.json` holds the lock. The guarded `workflow unlock` (amendment below) clears them.
- Windows is not tested: an empty legacy lock is not taken over there, because Windows refuses to
  rename onto an existing directory.

## Amendment: guarded `workflow unlock` (#209)

Operators need a sanctioned way to clear the locks that acquire refuses: incomplete metadata from
damage or an older build, a damaged marker, and a lock whose foreign host was renamed or is gone.
`quiet-choir workflow unlock RUN [--force-remote]` does so through the same protocol, and the
`run.locked` messages now print it.

- **Observe, judge, remove.** Unlock reads every existing lock (primary, then guard), then judges
  them all with the pure `decideUnlock` in `recovery-decision.ts` before anything is removed. In
  order: a foreign-host owner or recoverer without `--force-remote` refuses; a locally alive or
  unknown owner or recoverer refuses (`run.locked`); an alive or unknown child record in either lock
  refuses (`run.orphans`, naming the owner). Missing or unreadable `owner.json` and `recovery.json`
  are removable and reported as warnings; an atomically published marker is unreadable only after
  damage. Unlock never signals a process; stopping children stays with `resume --kill-orphans`.
- **`--force-remote` is an assertion, not an override.** It says the recorded host is this machine
  under an old name or is permanently gone, so the owner, recoverer and children are judged by local
  PID and birth-identity observations instead of the blanket `remote`/`unknown`. A recorded PID that
  happens to be alive here (for example without a recorded birth identity) still refuses, which is
  conservative.
- **Generalized tombstone check.** `retire()`'s expectation becomes
  `{ owner: string | null; recovery?: string | null }`: a string must match the file's token, null
  expects no readable file, and an omitted recovery is not checked; a file missing from the
  tombstone still counts as a sweep in progress. Release and recovery pass what they passed before.
  Unlock re-reads both tokens just before the rename and always passes both, so a marker linked by a
  concurrent recoverer, or a complete owner that replaced an empty older-build lock, fails the check
  and the lock is renamed back ("changed during unlock; retry"). A lock that vanished is reported
  `absent`. As with release, if a new acquirer publishes onto the vacated path first, the rename
  back fails and the orphaned tombstone is swept later; do not run unlock concurrently with a resume
  or tick of the same run.
- Amended by #243: removal now takes the lock's recovery claim first, as an automatic recoverer
  does. Unlock sets aside the marker it judged removable only while it is still that marker, links
  its own through `claimRecovery`, re-reads the owner token under the claim, and passes its own
  marker token to `retire()`. Automatic recovery racing the unlock waits on (or refuses at) unlock's
  live marker instead of retiring and replacing the lock, which the rename-back above could not
  prevent; a live recoverer's marker refuses the unlock with "changed during unlock; retry".
- A run with no lock is a no-op, but a run with neither a lock nor a checkpoint is `run.not_found`,
  so a mistyped ID is not a silent success. Unlock does not sweep strays; the next acquire does.
