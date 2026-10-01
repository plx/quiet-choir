# 0036: Detached start reports a run only when its runner owns the record

- Status: accepted
- Issue: #137
- Builds on launcher-correct emitted commands (#135) and resumable interruptions (ADR 0029).

## Context

Launching a run in the background took a nine-command recipe (`umask`, `mkdir`, `chmod`,
`nohup … execute … &`, redirects), and the `inspect` that followed usually failed with
`run.not_found` because the runner had not written its record yet. A host had to pick the run ID
itself, poll for the record, and could not tell a slow start from a failure before the record (a
type error), whose only evidence was a log file.

## Decision

`workflow start FILE [execute flags]` spawns `workflow execute … --json` detached and waits on the
filesystem. The CLI adapter builds a plain-data plan; `StartWorkflowExecutor` runs it.

- **The parent owns the ID and paths.** Start generates the run ID when `--run-id` is absent and
  resolves the state directory before spawning, so both are known before the record exists. It
  passes its own argv through unchanged (aliases, `=` forms and environment-sourced values keep
  working), dropping only its own `--json` and `--start-timeout` and appending `--run-id`,
  `--state-dir` and `--json`. The runner validates every other flag, so a refusal such as
  `usage.flag` comes back as the runner's own error instead of a duplicated check.
- **Spawn Node, not a PATH word.** The runner is
  `[execPath, (development execArgv), realpath(argv1)]`. No PATH lookup is needed, development
  loader flags survive, and the child PID is the PID that takes the run lock.
- **Readiness is ownership, not existence.** While the runner lives, start succeeds once the record
  is readable and the lock owner's PID is the runner's. After the runner exits, a readable record
  counts when the runner reported success, or a failure other than `run.exists` or `run.locked` (it
  created the run and then failed or was interrupted). The rule is the pure `decideStart`,
  table-tested like `decideReplay`. A concurrent start of the same ID therefore never reports the
  other runner's record as its own, and start refuses `run.exists` before spawning anything.
- **Never leave an unreported runner.** When no owned record appears within `--start-timeout`
  (default 60s), or start itself is interrupted, it sends SIGTERM to the runner's process group,
  waits the kill grace plus 2 s so a runner that owns a record can save its resumable suspension
  (ADR 0029), then sends SIGKILL. The runner is tracked by the CLI's process supervisor until it is
  reported, so a second signal kills it too. After success the parent unrefs the runner, which keeps
  running in its own session.
- **Evidence is per launch and private.** The runner's stdout and stderr go to
  `<stateDir>/<runId>/launch/<n>.result.json` and `<n>.log`, created exclusively (0600, in 0700
  directories) for the smallest free `n`; stdin input is saved as `<n>.input.json`. The runner never
  inherits start's stdio, so a host capturing start's output does not wait for the runner.
- **Failures keep the single failure contract.** A failure is a `workflow.error` document with an
  added `launch` field (attempted run ID, PID, paths, exit). A pre-record failure carries the
  runner's error code, diagnostics and exit, with top-level `runId: null`. Two new codes cover what
  only start can observe: `start.timeout` (exit 124, the `timeout(1)` convention) and `start.exited`
  (exit 70, EX_SOFTWARE) for a runner that exited without a record or a readable document. Hosts
  already branch on `kind`, `ok` and `exitCode` for every command, so a separate failed-start kind
  would add a second shape for no gain.

## Consequences

- The skill's golden path is four commands: `cd`, `validate`, `start`, `inspect`.
- A pre-record failure leaves `<runId>/launch/` without `run.json`. `list` and `inspect` ignore it,
  and its log is the only copy of the compiler output, so it is kept; cleaning such directories is a
  follow-up.
- The public `CliErrorCode` union gains `start.timeout` and `start.exited`.
- `start` does not cover `--resume` or `--dry-run`: a dry-run removes its state, so no record would
  appear, and a detached resume is a separate decision.
- Detached sessions and process-group signals are POSIX behaviour; Windows is not claimed.
