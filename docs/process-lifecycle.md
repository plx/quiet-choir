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

A 500ms backstop after escalation closes inherited pipes and settles the invocation even when an
escaped descendant holds them. A deadline therefore initiates a bounded sequence of
`timeoutMs + killGraceMs + 500ms`; this is subject to event-loop scheduling and OS/filesystem calls,
not a real-time guarantee. Normal completion may also wait for the drain/cleanup periods. Cleanup
that cannot be confirmed retains its process record. A saved successful result is not retried
because record cleanup failed: the returned run contains a warning and the lock remains inspectable.

## Interrupts

SIGINT, SIGTERM, and SIGHUP share the same behavior. The first cancels all run scopes, stops active
harness groups, drains owned work and saves cancellation when storage remains available. stderr
prints “Send again to force.” A signal-ignoring local callback can still prevent graceful
completion. A second signal sends SIGKILL synchronously to every in-memory tracked group and exits
130 without waiting for checkpoints. The lock and an older `running` checkpoint may remain.
EIO/EPIPE from a closed terminal do not interrupt cleanup. Embedders own their signal handlers and
may supply a `ProcessSupervisor` to `runWorkflow`, then call `forceKill()` on a second signal.

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
step, attempt and observed state. `inspectRunOwnership({ runId, stateDir, cwd })` exposes the same
read-only view to embedders. `readRun` continues returning only the persisted checkpoint. Inspection
observations can change immediately; they are not a lease or heartbeat.

Dead-owner recovery reads `<runId>.json.lock/processes/<pgid>.json` (PID on Windows) before removing
the lock. Records are private, written exclusively and fsynced, and include run/step/attempt,
binary/cwd, spawn time, OS birth identity and the writer token. They contain no argv, input or env.
Version-discovery children are recorded too, using the triggering effect's identity and the run
cancellation signal. This is owner state, separate from the format-5 replay checkpoint.

A confirmed live child causes `OrphanProcessesError` (`code: 'run.orphans'`, CLI exit **3**) before
replacement effects run. `--kill-orphans` verifies identities, sends TERM, waits the selected grace,
sends KILL if needed, and confirms reaping before acquiring new ownership. First-signal cancellation
still completes this cleanup; a second signal reaches these recovery groups too. The flag requires
`--resume` on the CLI. A live or foreign-host owner is never reclaimed by this flag.

A different OS birth identity means the PID has been reused: the unrelated process is never
signaled. Missing/unreadable identity, a surviving group whose original leader cannot be identified,
and malformed records are reported and retained; `--kill-orphans` refuses to guess. Inspect those
processes separately and wait for their exit or deliberately repair the abandoned lock after
establishing ownership. Do not delete records simply because a checkpoint looks old. Locks whose
workflow finished but whose processes could not be reaped have an explicit `released` owner state,
so a long-lived embedding process does not permanently obstruct recovery.

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
