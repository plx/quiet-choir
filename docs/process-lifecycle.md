# Harness process ownership and recovery

Each workflow harness call owns a detached process group on macOS/Linux. Windows owns the immediate
child. quiet-choir records that ownership before sending task input, stops the group on every leader
exit (including success), and checks surviving records before recovering an abandoned run lock.

## Deadlines and cleanup

The leader's `exit` event ends the execution deadline. stdout/stderr can remain open in a background
helper, so the adapter drains them until both end or two seconds elapse. It then closes the pipes
and parses the bytes received. Valid successful protocol output retains its result and usage;
truncated or invalid output still fails protocol validation. Cleanup notices accompany successful
responses as step warnings.

After any exit, a surviving group receives SIGTERM, followed by SIGKILL after the cleanup grace. The
default grace is **3000ms**, configurable with `workflow execute --kill-grace-ms 5000` or
`new CliHarness({ killGraceMs: 5000 })`. The CLI applies the same value to orphan recovery. Embedded
orphan recovery instead uses `RunOptions.killGraceMs`, also defaulting to 3000ms. These values are
execution policy, outside identity and not sticky; repeat a CLI override on resume.

An optional `idleTimeoutMs` adds a second deadline. It starts once the prompt has been fully flushed
to stdin, or stdin has closed, so input-write backpressure never counts, and it restarts on every
stdout/stderr chunk; time a stream consumer spends holding a chunk does not count. On expiry it
starts the same SIGTERM, grace and SIGKILL sequence with code `QUIET_CHOIR_IDLE_TIMEOUT` (kind
`idle-timeout`). Leader exit clears it, so draining a leftover group is bounded only by the cleanup
periods below.

Input reaches stdin only after durable registration. An empty input closes stdin without a write,
and that EOF also waits for registration. A child may close stdin or exit before its input is
written, as a fast `git rev-parse` can under load; the resulting `EPIPE` or `ENOTCONN` does not fail
the call, so a `ctx.exec`, runtime Git call or harness process is judged by its exit status. When a
cleanup signal fails with `EPERM` because the group holds only exited (zombie) members, as macOS
reports for a leader not yet waited for, no cleanup warning is recorded.

A 500ms backstop after escalation closes inherited pipes and settles the invocation even when an
escaped descendant holds them. It is skipped when a leader exited without failure and its group is
already reaped; the two-second drain alone then bounds settlement. A deadline therefore initiates a
bounded sequence of `timeoutMs + killGraceMs + 500ms`; this is subject to event-loop scheduling and
OS/filesystem calls, not a real-time guarantee. Normal completion may also wait for the
drain/cleanup periods. A streaming consumer, such as a session or transcript callback, gets the
two-second delivery window and then a 500ms settlement bound after its pipes close; if it still has
not settled, the call fails and keeps its process record. Cleanup that cannot be confirmed retains
its process record. A saved successful result is not retried because record cleanup failed: the
returned run contains a warning and the lock remains inspectable.

## Interrupts

SIGINT, SIGTERM, and SIGHUP share the same behavior. The first cancels all run scopes, stops active
harness groups, drains owned work and, when storage remains available, saves a resumable `suspended`
run with `nextWakeAt` set to now and `interruptedBy` naming the signal; the command still exits 130,
and the next `workflow tick` or `resume` continues from the completed steps. The in-flight steps are
recorded as `cancelled` and run again on resume. stderr prints “Send again to force.” A
signal-ignoring local callback can still prevent graceful completion. A second signal sends SIGKILL
synchronously to every in-memory tracked group and exits 130 without waiting for checkpoints; under
`--json` it first writes the whole failure document to stdout, retrying a full pipe for up to five
seconds. The lock and an older `running` checkpoint may remain; tick recovers such a stale run.
Embedders that abort `RunOptions.signal` with a `RunInterruptedError` get the same resumable
suspension, while any other abort reason saves `cancelled`. See
[ADR 0029](decisions/0029-persist-interruptions-as-resumable-suspensions.md). EIO/EPIPE from a
closed terminal do not interrupt cleanup. Embedders own their signal handlers and may supply a
`ProcessSupervisor` to `runWorkflow`, then call `forceKill()` on a second signal.

A signal alone never cancels a run. To end a live local run on purpose, use
`workflow cancel RUN [--force] [--timeout 30s]` instead of `kill`
([ADR 0039](decisions/0039-cancel-a-live-run-through-a-token-bound-request.md)). It refuses
(`run.locked`, exit 3) unless the lock owner is alive on this host with the OS birth identity it
recorded, then writes `cancel.json` in the run directory bound to that owner's lock token,
re-verifies the owner, and sends one SIGINT to its PID, never a group. The owner's executor sees the
request in its first-signal abort and turns the interruption into a cancellation, so the runner
saves `cancelled` and the owner still exits 130; tick never resumes it. A request names one lock
acquisition, so a stale request never cancels a later execution, and a plain signal or tick deadline
without one still suspends. Cancelling a run that `workflow tick` is executing signals the tick
process: the run ends `cancelled` and that tick pass stops, as with any signal. An embedder owner
does not read the request and suspends, which cancel reports as `run.unowned`. `--force` sends a
second SIGINT only after the timeout, to the same re-verified owner; like a second signal (including
a cancel that reaches an owner already draining an earlier signal), it force-kills and can leave
`running` for tick's stale recovery. The identity check right before each signal narrows, but cannot
close, the window for PID reuse described below.

`configuration doctor` uses the same signal handling and three-second cleanup grace, with an
in-memory supervisor for probes. It has no resumable workflow or durable child registry. Embedded
probe callers can supply `DoctorOptions.processSupervisor` and `killGraceMs`.

SIGKILL and process crashes cannot run handlers. They can leave agents executing and editing files.
There is still a spawn-to-record gap, and descendants that create another session/group can escape
ownership. Process groups are not a sandbox or a complete process-tree containment mechanism.
Neither interruption nor recovery rolls back edits or makes external effects exactly once.

## Inspect before retrying

```sh
quiet-choir workflow inspect review-1 --state-dir "$qc_state_dir" --json
quiet-choir workflow execute review.workflow.ts --run-id review-1 \
  --state-dir "$qc_state_dir" --resume --kill-orphans --kill-grace-ms 5000
```

Inspection adds an ephemeral `ownership` object to the JSON run record. Text output names the owner
PID, host and liveness, including `dead: stale lock`, and each recorded process's binary, PID/group,
step, attempt and observed state, then one line per existing lock with its owner and any recovery
marker. The JSON `ownership.locks` array lists the current lock (`primary`) and the legacy guard
(`guard`) that exist, each with its `path`, `owner` (`pid`, `host`, liveness `state`, or null),
`recovery` (the `recovery.json` recoverer's `pid`, `host` and `state`, or null) and a `warning` when
either file exists but cannot be read. The top-level `locked`, `owner`, `processes` and `warning`
describe the lock that ownership resolves to, as before.
`inspectRunOwnership({ runId, stateDir, cwd })` exposes the same read-only view to embedders.
`readRun` continues returning only the persisted checkpoint. Inspection observations can change
immediately; they are not a lease or heartbeat.

Dead-owner recovery first links a `recovery.json` marker into the lock, so only one recoverer
proceeds; a dead recoverer's marker is reclaimed by the next acquire, and a live, unknown or remote
one holds the lock ([ADR 0030](decisions/0030-rename-published-run-locks.md)). It then reads
`<runId>/lock/processes/<pgid>.json` (PID on Windows) before retiring the lock through a tombstone
rename. Records are private, written exclusively and fsynced, and include run/step/attempt,
binary/cwd, spawn time, OS birth identity and the writer token. They contain no argv, input or env.
Version-discovery children are recorded too, using the triggering effect's identity and the run's
shared discovery signal, which aborts on interruption or once no effect still awaits discovery. This
is owner state, separate from the versioned replay checkpoint. Migrated runs acquire and retain the
legacy guard before the current lock; recovery checks both locations. All new children register
under the current lock. See [storage](storage.md).

A confirmed live child causes `OrphanProcessesError` (`code: 'run.orphans'`, CLI exit **3**) before
replacement effects run. `--kill-orphans` verifies identities, sends TERM, waits the selected grace,
sends KILL if needed, and confirms reaping before acquiring new ownership. First-signal cancellation
still completes this cleanup; a second signal reaches these recovery groups too. The flag requires
`--resume` on the CLI. A live or foreign-host owner is never reclaimed by this flag.

A different OS birth identity means the PID has been reused: the unrelated process is never
signaled. Missing/unreadable identity, a surviving group whose original leader cannot be identified,
and malformed records are reported and retained; `--kill-orphans` refuses to guess. Inspect those
processes separately and wait for their exit, then clear the abandoned lock with `workflow unlock`
(below). Do not delete records or lock directories by hand. Locks whose workflow finished but whose
processes could not be reaped have an explicit `released` owner state, so a long-lived embedding
process does not permanently obstruct recovery.

`quiet-choir workflow unlock RUN [--state-dir DIR] [--force-remote] [--json]` is the sanctioned way
to clear a lock that resume refuses: incomplete ownership metadata from damage or an older build, a
damaged `recovery.json`, or a foreign host that is gone. The `run.locked` messages print it. It
imports no workflow code and never signals a process. Before removing anything it judges both the
primary lock and the legacy guard: a locally alive or unverifiable owner or recoverer refuses with
`run.locked`, and an alive or unverifiable child record refuses with `run.orphans`, naming the owner
and the records (stop confirmed children with `workflow resume RUN --kill-orphans`). A foreign-host
owner or recoverer refuses unless `--force-remote` asserts that the recorded host is this machine
under an old name or is permanently gone; the owner, recoverer and children are then judged by local
PID and birth-identity observations, so a recorded PID that is alive here still refuses. Missing or
unreadable `owner.json` and `recovery.json` do not block it and are reported as warnings. Each lock
leaves only by the tombstone rename, while unlock holds its recovery claim as an automatic recoverer
would (so automatic recovery cannot retire and replace the lock under it) and after re-reading the
observed owner token under that claim; a lock that changed meanwhile, or a live recoverer's claim,
refuses with "changed during unlock; retry", and one that vanished is reported `absent`. A run with
no lock is a no-op. Do not run it concurrently with a resume or tick of the same run.

The repository's worktree administration lock (`<common Git dir>/quiet-choir/worktree-admin.lock`,
[ADR 0032](decisions/0032-interprocess-worktree-administration-lock.md)) belongs to no run, so it
has its own form: `quiet-choir workflow unlock --worktree-admin PATH [--force-remote] [--json]`,
where PATH is any path inside the repository. It applies the same judgment to the lock's owner and
recoverer (the lock records no children) and the same claimed, token-verified tombstone removal, and
refuses with `worktree.locked` (exit 3) instead of `run.locked`. A locally alive or unverifiable
holder is always refused, since the lock is held only for one Git command. When an attempt fails
because a holder on another host, of unknown liveness or with unreadable metadata kept the lock for
30 s, the error names this command. Plain `workflow inspect RUN` shows the lock of the repository in
the run's worktree ledger while it is held. Do not delete the lock directory by hand.

Linux identity combines boot ID and `/proc/<pid>/stat` start ticks; macOS uses boot time and the
C-locale `ps lstart` timestamp (one-second resolution); Windows uses the process creation timestamp
from PowerShell. Unavailable platform probes produce an unknown identity. These are conservative
birth-time checks, not atomic kernel process handles: macOS timestamp resolution and the interval
between checking and signaling limit the guarantee against extremely rapid PID reuse. Escaped groups
and children from the spawn-to-record gap still require separate operator investigation.

## Harness port migration

At version 0.0.0, `Harness.invoke(request, signal)` and optional `metadata(request, signal)` become
`invoke(request, invocation)` / `metadata(request, invocation)`. `HarnessInvocation` supplies
`signal`, `runId`, fully qualified `stepId`, `attempt`, and `trackProcess`. Process-free adapters
need only change their signal access; adapters that spawn children must register immediately after
spawn, await durable registration before sending input, and await `lease.release()` once reaped. The
port's `osStartTime` is an OS birth identity, not `new Date()`; use null when unavailable.

Registry persistence failure is `CheckpointError` with operation `process`. It aborts scheduling,
reaps the just-spawned native child, and cannot become retry or settled-failure data. A custom
adapter remains responsible for bounded cleanup and accurate process reports. The core installs no
global signal handlers, and the CLI keeps the live supervisor outside its serializable plan.

See [ADR 0013](decisions/0013-process-ownership.md). Relevant OS contracts are Node's distinction
between [exit and stdio close](https://nodejs.org/api/child_process.html#event-exit) and Linux's
[process stat fields](https://man7.org/linux/man-pages/man5/proc_pid_stat.5.html).
