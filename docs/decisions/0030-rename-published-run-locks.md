# 0030: Publish, release and recover run locks by rename

- Status: accepted
- Issue: #208
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
- A lock that exists without a readable `owner.json` is still refused, and an unreadable
  `recovery.json` holds the lock. Removing such a lock stays a manual operator step.
- Windows is not tested: an empty legacy lock is not taken over there, because Windows refuses to
  rename onto an existing directory.
