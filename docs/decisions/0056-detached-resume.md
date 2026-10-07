# 0056: Detached resume reports a run only when its runner records an execution

- Status: accepted
- Issue: #262
- Amends [0036](0036-detached-start.md), which left `--resume` and `--dry-run` out of
  `workflow start`.

## Context

`workflow start` launched only new persisted runs. It dropped six execute flags: `--resume`,
`--kill-orphans`, `--accept-code-change`, `--dry-run`, `--stub-steps` and `--full`. Before this
change oclif reported them as unknown flags. A host that wanted a detached resume had to background
`workflow execute --resume` itself, with the redirects and polling that ADR 0036 removed for new
runs.

The readiness signal of ADR 0036 does not carry over to a resume. The record is readable before the
new runner starts. The run lock is not enough either, because the runner takes it before it refuses
`run.incompatible`, `run.input_changed`, a harness or code-change mismatch and similar cases. A
lock-only rule would report `started` for a resume that then refuses without touching the record,
and the host would read the old `suspended` or `failed` status as progress.

## Decision

**Which flags start accepts.**

- `--resume` is accepted. `start --resume --run-id ID [FILE]` resumes an existing run detached. FILE
  is optional as for execute, and `--resume` without `--run-id` is refused before spawning with
  `usage.resume_requires_run_id`, because a generated ID can never exist.
- `--kill-orphans` is accepted with `--resume`. Orphan recovery runs while the runner acquires the
  lock, before it owns the run. A `run.orphans` refusal comes back as the runner's failure document,
  and the start timeout also covers recovery, including its kill grace.
- `--accept-code-change` is accepted with `--resume`. Its preflight refusals happen before the
  execution is recorded and come back as the runner's own error. Both flags already depend on
  `--resume` in execute's flag table, so oclif enforces the pairing.
- `--dry-run` is refused. A dry run uses temporary checkpoints and removes its state, so no record
  remains for a detached runner to own, and no rule could return before the rehearsal ends. Its
  report goes only to the result file, so a detached rehearsal gains nothing over backgrounding the
  foreground command.
- `--stub-steps` is refused, because it applies only to `--dry-run`.
- `--full` is refused, because it only shapes execute's foreground result document. Start prints its
  own start result, and `workflow inspect RUN --json --full` reads a started run's whole record.

The refused flags stay in start's flag table as hidden entries without `dependsOn`, so oclif parses
them. Start then fails with `usage.flag` (exit 2) before any I/O, including reading `--input -`. The
message gives the reason, and `next[0]` is the launcher-correct foreground command:
`workflow execute` followed by start's own arguments as given, minus `--start-timeout` and its
value.

**Resume readiness is an execution recorded by the runner.** When a body execution starts, the
runtime saves an `ExecutionRecord` `{n, pid}` under the lock (the `run.started` save). Before it
spawns the runner, start reads the run's last execution number as a baseline (0 when the record is
unreadable, in which case the runner reports `run.unreadable` itself). The pure `decideStart` gains
a `resume` mode:

- While the runner lives, start succeeds once the record is readable and holds an execution with `n`
  above the baseline and `pid` equal to the runner's PID. Past `--start-timeout` it stops the runner
  and fails with `start.timeout`; otherwise it waits.
- After the runner exits with a usable document, such an execution counts whatever the document
  says, because the runner resumed and then completed, failed, suspended or was interrupted. A
  success document with a readable record also counts. This covers a completed run, whose resume
  returns the stored output without a new execution. Any other document is a failure that reports
  the runner's own refusal (`run.locked`, `run.orphans`, `run.incompatible`, `run.input_changed`,
  `usage.*`) with the run's ID. An exit without a usable document is `start.exited`, as for a new
  run.

The baseline also guards against PID reuse, because an old execution whose PID matches the new
runner's does not count. The new-run rule of ADR 0036 is unchanged.

**Before spawning.** A resume inverts start's existence check under the same legacy guard. When
neither `<runId>/run.json` nor the legacy flat checkpoint exists, start refuses with `run.not_found`
(with `readRun`'s wording, candidates and inspect entries) and creates nothing, so no `launch/`
leftover appears. An existing run's launch files take the smallest free `n`, so the evidence of
earlier launches is kept. A held guard (a live runner of the same run, or a `workflow rm` in
progress) is refused with `run.locked`, and for a resume the failure carries the run's ID.

## Consequences

- The ticket asked for readiness to mean that ownership moves to the new runner. This rule reads
  ownership from the record, not from the lock owner's PID. The plain lock signal would report
  refusals made under the lock as started resumes. It costs nothing extra, because the execution is
  saved before the body runs.
- A contended resume, while another process owns the run, is refused before spawning when the owner
  holds the guard. If the second runner is spawned first, its own `run.locked` comes back. Either
  way it is never reported as started.
- `workflow resume --detach` and a detached `answer --resume` are not added. A host uses
  `start --resume`, which takes execute's resume flags.
- Detached rehearsal stays out of scope. Hosts run `workflow execute --dry-run` in the foreground or
  background it themselves.
