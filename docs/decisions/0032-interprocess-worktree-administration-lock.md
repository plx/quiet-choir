# 0032: Interprocess worktree administration lock

- Status: accepted
- Issue: #108
- Extends [ADR 0022](0022-runtime-owned-worktree-isolation.md)'s worktree isolation and reuses
  [ADR 0030](0030-rename-published-run-locks.md)'s crash-atomic lock protocol.

## Context

Git reads every registered worktree's metadata while it adds or lists one, so a concurrent
`git worktree add` can expose another add's half-written admin directory and fail with "failed to
read .../commondir". The runtime serialized its `worktree add`, `list` and `remove` commands (and
the registration repair) with an in-memory queue keyed by the repository's common Git directory.
That queue covered concurrent attempts inside one process only. Two `workflow` processes against the
same repository, including `workflow clean` alongside a live run, still raced. The failure is an
ordinary attempt failure before launch, not corrupted state, but nothing prevented it.

## Decision

Every administration command takes two layers of exclusion, both keyed by the realpath of
`git rev-parse --git-common-dir`. The in-process queue stays the outer layer, so calls in one
process wait on a promise rather than polling a file. Inside it, the call takes an interprocess lock
and releases it as soon as the Git command finishes.

**Location.** The lock is `<common Git dir>/quiet-choir/worktree-admin.lock`, not a file in the
state directory. Runs started from different linked checkouts have different default state
directories (the default hashes the checkout), and `--state-dir` or `QUIET_CHOIR_STATE_DIR` can
differ per process. The common Git directory is the only location every process administering that
repository shares, and a process that can run `git worktree add` can already write there. The
private `quiet-choir/` subdirectory (mode 0700) keeps the lock's publish and tombstone siblings out
of the Git directory's top level; Git ignores unknown entries there.

**Protocol.** The lock reuses `lock.ts`'s primitives unchanged, with no mechanism of its own: a lock
directory published whole by rename holding a durable `owner.json` (`pid`, `host`, `token`,
`osStartTime`); the link-published `recovery.json` claim that lets exactly one contender retire a
dead or released owner; the tombstone rename with token verification on release and recovery; the
owner and marker liveness rules; and the sweep of stray `.tmp` and `.gone` siblings. `claimRecovery`
now takes its refusal as a factory, and the run lock passes its unchanged `run.locked` text. The
admin lock records no child processes, so recovery has nothing to stop.

**Waiting, not refusing.** A run lock refuses on contention because a second writer for one run is
an error. Two runs administering one repository is normal, so this lock waits:

- A vanished lock is retried at once; a dead or released owner is recovered, then retried.
- A live local owner, or a live recoverer, is waited on with jittered backoff (about 5 ms, doubling
  to 200 ms). The wait has no bound, matching the in-process queue it extends, because
  `worktree add` on a large checkout can legitimately take long; it ends on the caller's abort
  signal, which rejects with the signal's reason and leaves no publish directory behind. Cache
  cleanup has no caller to cancel it, so its wait is bounded at 30 s and a timeout becomes an
  ordinary cleanup warning naming the lock path.
- A holder this host cannot judge (an owner or recoverer on another host, an unknown liveness, or
  unreadable metadata) is polled until a stuck deadline of 30 s, then the attempt fails with a plain
  `Error` naming the lock path, the holder's PID and host when known, and the remedy: after
  confirming no quiet-choir process on any machine sharing the repository is administering it, clear
  it with `quiet-choir workflow unlock --worktree-admin <common Git dir>`, adding `--force-remote`
  for a holder on another host. For a local holder of unknown liveness, which unlock refuses, the
  message says to wait for that PID to exit or stop it first. The message uses the default
  `quiet-choir` program words. It never tells the operator to remove the directory by hand, which
  could race with a live holder. The deadline restarts when a different holder appears.

Acquisition happens before any harness launches, so a refusal is an ordinary pre-launch attempt
failure, subject to retry policy; it is neither a `CheckpointError` nor a `ConfigurationError`.

**Leaked locks of this process.** A failed release (for example `EACCES` on the tombstone rename)
leaves a lock owned by this live PID, which every later acquire in this process would otherwise wait
on forever. Each process keeps the tokens of the admin locks it holds in a set at
`globalThis[Symbol.for('quiet-choir.worktreeAdminTokens')]`, shared by the CLI's second module
instance (see [ADR 0028](0028-brand-public-errors-across-module-instances.md)). A token is added
before the publish rename and removed after the release finishes or fails. A contended lock that
names this PID and host with a token not in the set is treated as released and recovered. A release
that finds the lock already gone succeeds; another release error is thrown only when the Git command
succeeded, so the command's own failure is never masked. The process's own OS start time is probed
once, not on every acquire, because the probe spawns `ps` on macOS.

**Rejected: bounded retry.** Retrying Git's transient "failed to read .../commondir" errors would
absorb the race without new lock state, but with real serialization among quiet-choir processes it
would only mask bugs, and parsing Git's error text is fragile. It is not shipped alongside the lock.

## Consequences

- `workflow clean`, live runs, resumed runs and runs rooted at different linked checkouts of one
  repository serialize their worktree administration against each other.
  `test/worktree-admin-race.test.ts` races real `git worktree add`, `list` and `remove` cycles in
  four processes and checks a shared log for overlapping critical sections; the test fails without
  the interprocess lock.
- Git commands run outside quiet-choir, such as a person's `git worktree add`, are not serialized.
- quiet-choir now writes a `quiet-choir/` directory into users' Git directories. A read-only or
  otherwise unwritable Git directory fails at that directory with its path; such a repository could
  not run `git worktree add` anyway.
- Each administration command costs a few extra renames and fsyncs. Calls within one process queue
  in memory, so only other processes poll.
- A live process that holds the lock across a hung Git command blocks other processes until the
  command times out or is cancelled, exactly as it blocked its own process before. Cleanup's Git
  calls have 10 s timeouts; the others honor the run signal.
- A lock leaked by a still-running process (a release failure) blocks other processes until that
  process exits; its own later calls recover it.
- Amended by #243: `workflow unlock --worktree-admin PATH` clears this lock with the same judgment
  and token-verified tombstone removal as a run unlock (`decideUnlock`). PATH is any path inside the
  repository; the lock belongs to the repository, not to a run. A dead or released owner, a dead
  recoverer, and missing or unreadable metadata are cleared (with a warning for the metadata). A
  holder on another host is refused unless `--force-remote` asserts that host is gone; a locally
  alive or unknown owner or recoverer is always refused. Refusals are `worktree.locked` (exit 3),
  with the command to rerun in `details.next`. Nothing is ever signaled. Removal takes the lock's
  recovery claim, as an automatic recoverer does: unlock sets aside the marker it observed (dead,
  unreadable, or foreign under `--force-remote`) only while it is still that marker, links its own
  `recovery.json` through `claimRecovery`, re-reads the owner token under the claim, and only then
  retires the lock with both tokens checked. A concurrent recoverer waits on unlock's live marker
  instead of retiring and replacing the lock under it, and a live marker or a changed owner refuses
  the unlock ("changed during unlock; retry"). Run unlock shares this removal.
- Plain `workflow inspect RUN` (text or JSON, not `--summary` or `--watch`) shows the lock of the
  repository in the run's worktree ledger as `worktreeAdminLock` (holder PID, host, token, state, OS
  start time and an approximate `acquiredAt` from `owner.json`'s modification time), and an
  `Unlock:` hint when unlock would not refuse. Runs without a worktree ledger, `workflow list`,
  watches and tick run no Git for it, and a missing repository never fails the inspection.
- Mixed builds are not coordinated: an older build serializes only within its own process.
