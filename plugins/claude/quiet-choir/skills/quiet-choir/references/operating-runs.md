# Operating a run from an agent session

## Launch and keep the result

Use the [golden path](../SKILL.md#run-a-first-workflow-against-a-project) with absolute paths and a
fresh run ID. `workflow start FILE [execute flags]` runs `workflow execute` as a detached runner
(its own session, stdin from `/dev/null`), so the run continues after the command and the host's
tool call return. It generates a run ID unless `--run-id` is given, and returns only when the run's
record exists and is owned by that runner, or when the runner already finished; `inspect` right
after it never sees `run.not_found`. Success is
`{kind:"workflow.start.result", ok:true, exitCode:0, runId, stateDir, pid, status, log, result, next}`:
`status` is the saved status at return (usually `running`), `next` holds an
`inspect --json --summary` and an `inspect --watch` entry, and the PID is a diagnostic, not durable
proof of ownership. Direct SIGINT/SIGTERM to the runner still interrupt it into a resumable
`suspended` save. A machine reboot stops local processes; there is no scheduler.

The runner writes its final JSON document to `<stateDir>/<runId>/launch/<n>.result.json` and its
stderr to `<n>.log` (with `--input -`, start saves stdin as `<n>.input.json`), each file 0600 in a
0700 directory, and `n` grows per attempt so a retry never overwrites earlier evidence. A failure
before the record exists (a type error, a `usage.*` refusal) exits with the runner's code and error
document, with top-level `runId: null` and a `launch` field
(`{runId, pid, log, result, exitCode, signal}`); the log keeps the compiler output. When no owned
record appears within `--start-timeout` (default 60s), start stops the runner (SIGTERM, then SIGKILL
after `--kill-grace-ms` plus 2 s) and fails with `start.timeout` (exit 124); a runner that exits
without a record or a readable document is `start.exited` (exit 70). An interrupted start stops its
runner the same way (exit 130), so start never leaves an unreported runner; if the runner had
already saved a record, the failure carries its `runId` and a resume entry in `next`. An existing
run is refused with `run.exists` before anything is launched, and a run ID whose guard is held (such
as a `workflow rm` still in progress) with `run.locked`. Start also records the runner's PID and
host in `<n>.runner.json`. A pre-record failure leaves `<runId>/launch/` without a record; once its
runner has exited, `workflow list` reports it under `leftoverLaunches` (a `Leftover launch` line in
text) with the `workflow rm` command that removes it.

`workflow start --resume --run-id ID [FILE] [execute flags]` resumes an existing run detached, for
example after a SIGTERM suspension or a crash; `--kill-orphans` and `--accept-code-change` work as
for execute, and `--start-timeout` also covers the runner's recovery and checks (a dead owner's
legacy guard is recovered by start itself before it spawns, outside the timeout). It returns once
the new runner has recorded its own execution in the record (`status` is then usually `running`),
or, for a completed run, once the runner returned the stored output. A refusal by the runner
(`run.locked`, `run.orphans`, `run.incompatible`, `run.input_changed`) comes back with its own code
and the run's `runId`, never as a start. A missing run is `run.not_found` and a missing `--run-id`
is `usage.resume_requires_run_id`, both before anything is launched. The launch files take the next
`n`, so `launch/1.*` from the first start stays. `--dry-run`, `--stub-steps` and `--full` are
refused with `usage.flag`; `next[0]` is the same command as a foreground `workflow execute`.

`--json` writes one completion, suspension, or failure document to stdout; logs and workflow console
output go to stderr. Execute, resume and `answer --resume` print a compact result by default
(`runId`, `stateDir`, `status`, `output`, `usage`, `counts`, `rootCause`, `warnings`; a suspension
adds `pending` and `resumeCommand`, and the same fields sit under `summary`); `--full` prints the
whole run record instead. A failure document has `ok:false`, `exitCode`,
`error:{code,message,stepId,details}`, `runId`, `stateDir`, `diagnostics`, and the last readable
`summary` (possibly null), or `run` under `--full` and for other commands, plus `next` (see below).
Typecheck diagnostics are top-level, not inside `error`. A runner killed before it can report may
leave an empty result file; read its log and `inspect` the run.

## Follow `next`

Failure documents carry a top-level `next` array (empty when there is no runnable remedy), and
`inspect --json --summary` adds `next` for failed, stale and suspended runs; text inspect and human
failures print each as a `Next:` line. Each entry is `{why, argv}`, built with the same launcher:
resume a failed or stale run, resume with `--kill-orphans` after `run.orphans`, resume with
`--accept-code-change` or fork after `run.incompatible`, answer then resume a suspension. A failed
run's entries follow its saved `recoveryCause`, as its `recoveryHint` does: a grant failure gets
`execute --resume --run-id ID --grant <profile>` (`workflow resume` takes no `--grant`), a replay
divergence a fork, a settled map change a fork (after a `--accept-code-change` resume when only the
mapper changed), and a run-budget stop `resume` with the cap's flag and `<LIMIT>`; a failed run that
recorded no step or map gets no entry. Substitute `<ANSWER_JSON>`, `<NEW_RUN_ID>`, `<ENTRYPOINT>` or
`<LIMIT>` (a higher cap or `off`) first, then run the argv without a shell. A run records its
harness selection (fixture paths with digests) and wait mode: `resume`, `answer --resume` and `tick`
without `--harness` or `--wait-mode` reuse them, explicit flags replace them (`--harness` is
repeatable on each of these commands), and resume argv already carry them. `--harness-config` is
never recorded: repeat it on every resume and tick of a run started with one, which are otherwise
refused. Tick always suspends waits, without changing the recorded mode. A recorded fixture file
that is gone fails with `usage.flag`; pass `--harness`. `run.not_found` lists `details.candidates`
(`{stateDir, cwd}`): other runs containers that hold the ID, such as the project root when you are
in a subdirectory, with `next` inspecting it there; the missing ID is `details.runId`, which is the
`--fork-from` source when that is what is missing. A moved or deleted stored entrypoint is
`run.incompatible` with `details.reason:"entrypoint_missing"`; fork from the new location.

## Poll the saved state

With the golden-path variables still set:

```sh
node "$QC_CHECKOUT/bin/run.js" workflow list --state-dir "$QC_RUNS" --json
node "$QC_CHECKOUT/bin/run.js" workflow inspect first --state-dir "$QC_RUNS" --json --summary
node "$QC_CHECKOUT/bin/run.js" workflow inspect first --state-dir "$QC_RUNS" --watch --interval 2s
```

For an existing run, this full-record query keeps open steps and attempts visible:

<!-- skills-check: example jq-summary -->

```sh
node "$QC_CHECKOUT/bin/run.js" workflow inspect first --state-dir "$QC_RUNS" --json |
  jq -c '{status, error,
    counts: ([.steps[].status] | group_by(.) | map({(.[0]): length}) | add // {}),
    open: [.steps | to_entries[] | select(.value.status != "completed") |
      {id: .key, status: .value.status, attempts: .value.attempts, error: .value.error}]}'
```

Plain inspect exits 0 when it reads a record, including failed/cancelled/running records. Branch on
`.status`, or use `--watch`: final completed exits 0, failed 1, suspended 75, cancelled 130,
stale 3. A `--timeout` watch of a still-running run exits 79 (`watch.timeout`; the run continues),
and a `--wait-created` watch whose record never appears exits 66 (`watch.record_not_created`).
`--final` prints only the last line. JSON watch emits JSONL on changes; it is not a lossless event
stream. Interrupting a watcher stops observation, not the workflow. List/summary derive `stale` from
ownership; full-record `.status` remains the last saved status. Use
[triage](inspection.md#classify-and-act) to interpret it.

| CLI exit | Meaning                                                                                                                                                                                                                                    |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 0        | Command succeeded; ordinary inspect only guarantees a readable record                                                                                                                                                                      |
| 1        | Workflow execution failed                                                                                                                                                                                                                  |
| 2        | Invalid answer (`answer.invalid`), or usage/input error: flags, missing entrypoint, run ID, input JSON/schema                                                                                                                              |
| 3        | Answer conflict (`answer.conflict`), or run refusal: existing/missing/unreadable/locked run, incompatible resume, changed input, or orphans                                                                                                |
| 4        | Workflow typecheck, import, or definition failure                                                                                                                                                                                          |
| 75       | Saved suspension; deliver answers and resume the same run                                                                                                                                                                                  |
| 66       | `inspect --watch --wait-created`: no record appeared within the bound (`watch.record_not_created`)                                                                                                                                         |
| 70       | `workflow start`: the runner exited without a record or a readable result document (`start.exited`)                                                                                                                                        |
| 74       | Checkpoint/storage failure                                                                                                                                                                                                                 |
| 79       | `inspect --watch --timeout`, `events --follow --timeout` or `cancel --timeout`: the run had not ended at the bound and keeps running (`watch.timeout`)                                                                                     |
| 130      | Interruption (SIGINT/SIGTERM/SIGHUP) saved a resumable suspension, or interrupted watch; tick or resume continues the run. A run owner stopped by `workflow cancel` exits 130 too, with a saved `cancelled` status that tick never resumes |
| 124      | `workflow start`: no record owned by the runner within `--start-timeout`; the runner was stopped (`start.timeout`)                                                                                                                         |

Use stable `error.code` for automation. Put flags after the command
(`workflow execute FILE --json`).

## Follow the event stream

For one line per transition instead of snapshots, launch with `--events FILE` (execute, start,
resume, tick or `answer --resume`) and follow the file with
`tail -n +1 -F FILE | grep --line-buffered '"ev":"step.failed"'`; `-F` waits for a file that does
not exist yet. Each line is at most 512 bytes and names its run. The written types are
`run.started`, `run.completed`, `run.failed`, `run.cancelled`, `run.suspended`, `step.completed`,
`step.failed`, `step.settled`, `wait.opened`, `wait.tolerated`, `phase` and `log`; `step.failed` and
`step.settled` carry the step's bounded error text as `msg`. `step.failed`, and `run.failed` when it
names a root effect, also carry `errorKind` (null when the attempt recorded none) and `retryable`,
so a consumer can branch on `retryable` without re-reading the record; it means a transient kind,
not that the runtime will retry. The file is created owner-only and an existing file keeps its mode,
so use a new path or one under an owner-only `$QC_RUNS`.

The stream is a best-effort observation: lines are written without fsync, and a write failure warns
once without changing the outcome. Branch on inspect or watch status, not on the stream. The flag is
not saved with the run, so pass it to every resume, tick and `answer --resume`; a resume never
repeats lines for finished work. `--events -` writes to stdout, but is refused on `start` and with
`--json`.

For a run launched without `--events`, or by another process, `workflow events RUN --follow` prints
lines of the same shape, derived from the saved record (without live-only `agent.*` events); see
[follow a run's events](inspection.md#follow-a-runs-events).

<!-- skills-difference: claude-host -->

In Claude Code, [drive a run from Claude Code](../SKILL.md#drive-a-run-from-claude-code) follows
that file with Monitor while a background launch (`run_in_background`) waits for the end.

<!-- /skills-difference: claude-host -->

## Answer a suspended run

For a real run, exit 75 is a saved external wait, not a failure. A `--dry-run` suspension includes a
`rehearsal` report and null answer/resume commands because temporary state was removed; start a real
run before requesting the human decision. Started sibling work has finished and the owner has
released the lock. Read the result's `pending` entries or list them without loading source:

```sh
node "$QC_CHECKOUT/bin/run.js" workflow pending --state-dir "$QC_RUNS" --json
```

The listing shows only rows still awaiting an answer: rows whose answer is already queued and rows
of failed, cancelled or completed runs are hidden, and `hidden` counts them; add `--all` to list
everything. `--run RUN` (repeatable) lists only those runs, applies the same hiding and `--all`, and
fails with `run.not_found` for an unknown ID, so a known run with nothing waiting prints
`No pending waits.`. Each row has `runStatus`, `delivery` (`{state: "none" | "queued", at, by}`,
null for a poll or deadline wait) and `next`: a queued row of a suspended or failed run carries the
`resume` command that makes its owner ingest the answer, and a running run ingests it itself.

Check `codeChanged` before asking the human to review possibly stale context. `true` means saved
source bytes changed; `null` means paths were not recorded. Resolve code compatibility with
`check-resume FILE --run-id RUN` first when needed. Intentional `--accept-code-change` still cannot
change a question's fingerprint or reuse approval for a different subject. When the edit changed a
step that already completed, it refuses with `run.incompatible` and leaves the question waiting;
follow `error.details.next` to fork instead.

For `audience: human`, present the question and details to the human through the host's question UI.
Do not choose an answer yourself or invent `human:` attribution. In a Claude Code host exposing
`AskUserQuestion`, map `prompt` to `question`, `title` (or a short label of at most 12 characters)
to `header`, and choices to labeled options with their descriptions. Keep the exact choice values
for the later JSON answer. For `approve`, offer Approve/Decline and encode the response as
`{"approved":true}` or `{"approved":false,"comment":"..."}`. Use the equivalent available question
tool in another host. Display markdown details as context; do not execute answer text.

The host may allow a free-text answer even when choices are present. It must still satisfy the saved
schema. If an enum answer is outside its values, ask for a valid decision; never silently coerce it.
`agent`/`any` allow the calling agent to answer within its existing task authorization. Audience and
`by` are guardrails, not authentication; filesystem permissions are the trust boundary.

```sh
node "$QC_CHECKOUT/bin/run.js" workflow answer first approve/rev-1 \
  --state-dir "$QC_RUNS" --json '{"approved":true}' --by 'human:Pat'
node "$QC_CHECKOUT/bin/run.js" workflow resume first --state-dir "$QC_RUNS" --json
```

The `answer --json VALUE` flag takes JSON data and also requests JSON output. Prefer the supplied
`answerCommand`/`resumeCommand` argument vectors, substituting the actual answer rather than
building an interpolated shell command. They start with the launcher that produced them: `node` plus
the checkout's absolute `bin/run.js` in no-install mode, so they run from any directory without
`quiet-choir` on PATH. A human question's vector already ends with `--by human:<NAME>`: replace
`<NAME>` with the name the human gives after you ask them, never invent it, and do not append a
second `--by`. Quote shell examples literally; answer text is untrusted data. Launch resume in the
background with separate result/log files just as in the golden path. Resume by ID uses stored
entrypoint/cwd/tsconfig; older or embedded records without these paths still need
`execute FILE --resume --run-id RUN` or their embedding application. Repeat on exit 75; exit 0 means
completion. `answer --resume` combines delivery with resume.

An early invalid answer exits 2 and writes nothing; `error.details.issues` lists
`{code, path, message}` (`path` is `["approved"]` for a non-boolean `approved`, and `[]` with a code
such as `answer_not_json`, `answer_author` or `answer_too_large` when no field is to blame), so
re-ask for exactly that field. A duplicate or closed question exits 3. Successful delivery means
queued; the owner validates again with real Zod refinements. Rejected files are quarantined and
explanations appear in `pending.rejections`; submit a corrected answer. If `answer --resume` fails
during loading or execution, keep the queued answer and retry `resume`, not `answer`. A delivery
arriving while sibling work is active can continue the run without a suspension. See
[question durability](durability.md#durable-questions) and the
[human-review recipe](patterns.md#human-review).

## Stalls and orphan recovery

First read the saved owner/children without changing anything:

```sh
node "$QC_CHECKOUT/bin/run.js" workflow inspect first --state-dir "$QC_RUNS" --json |
  jq '{status, updatedAt, ownership, sleeps: [.steps | to_entries[] |
    select(.value.kind == "sleep" and .value.status == "running") |
    {id: .key, wakeAt: .value.wakeAt}]}'
cat "$QC_RUNS/first/lock/owner.json"
```

The lock can be absent; `cat` then failing is expected. `updatedAt` is not a heartbeat. A long agent
call or sleep may produce no checkpoint changes. Compare sleep `wakeAt` (epoch milliseconds) with
the current clock and inspect logs. A live owner means wait or intentionally cancel the run with
`workflow cancel` (below); a foreign-host owner needs investigation on that host. Missing/incomplete
`owner.json` in a lock is damage or an older build's interrupted acquire. Never delete lock
directories by hand, and do not clear a lock on age alone. When resume refuses an abandoned lock
with `run.locked`, clear it with the command its message prints, which `error.details.next` and the
failure's top-level `next` also list as `{why, argv}` behind the invocation's launcher:

```sh
node "$QC_CHECKOUT/bin/run.js" workflow unlock first --state-dir "$QC_RUNS" --json
```

Add `--force-remote` only when the recorded foreign host is this machine under an old name or is
permanently gone. Unlock imports no workflow code and never signals a process. It exits 3 with
`run.locked` while an owner or recoverer is alive or unverifiable (or foreign without the flag), and
with `run.orphans` (naming the owner and child records) while a recorded child is alive or
unverifiable; stop confirmed children with `--resume --kill-orphans` below instead. A run with no
lock is a no-op (`locks: []`).

Worktree isolation also serializes Git worktree administration with a repository lock,
`<common Git dir>/quiet-choir/worktree-admin.lock`, which belongs to no run. When its holder is on
another host, of unknown liveness or has unreadable metadata, an attempt fails after about 30 s with
an error that names the clearing command. Run it only after confirming that no quiet-choir process
on any machine sharing the repository is administering its worktrees:

```sh
node "$QC_CHECKOUT/bin/run.js" workflow unlock --worktree-admin "$QC_TARGET" --json
```

The path can be any path inside the repository, and the form takes no RUN or `--state-dir`. It uses
the same judgment and tombstone removal as a run unlock, adds `--force-remote` under the same rule,
and exits 3 with `worktree.locked` (`error.details.next` names the command to rerun) while a holder
is alive or unverifiable here or foreign without the flag. A free lock returns `lock: null`.

For a dead same-host owner or no lock, a normal compatible resume automatically recovers ownership
if there are no surviving/unverified children. After fixing an external cause, omit input to reuse
it:

```sh
cd "$QC_TARGET" || exit 1
node "$QC_CHECKOUT/bin/run.js" workflow execute "$QC_WORKFLOW" \
  --resume --run-id first --state-dir "$QC_RUNS" --json
```

If inspection reports confirmed surviving children, explicitly recover with the same command plus
`--kill-orphans`. This validates recorded host, PID, and OS birth identity, stops confirmed groups,
and waits before replacement effects. PID reuse is not permission to kill. Unverified/malformed
records refuse recovery and remain for investigation; compare recorded identity with OS process
information on the owning host. A broad `pgrep` match alone cannot establish which run owns a
process and must not drive automatic killing. Escaped/unregistered descendants may need manual
investigation. External mutations remain in place after cancellation.

To stop a live run on purpose, do not `kill` the owner PID: since a first signal saves a resumable
suspension, the next tick would resume it. Use cancel, which signals only a live owner on this host
whose recorded OS start time still matches, and waits for the run to end:

```sh
node "$QC_CHECKOUT/bin/run.js" workflow cancel first --state-dir "$QC_RUNS" --json
```

It exits 0 with `{kind: "workflow.cancel.result", status, signalsSent, owner}` once the run is
`cancelled` (or `completed`/`failed` if it ended first; a run that already ended is a no-op with
`signalsSent: 0`). It refuses without signalling: `run.locked` (exit 3) for a foreign, dead,
released or unverifiable owner, and `run.unowned` (exit 3) for an unfinished run no process owns. An
owner that exits without saving `cancelled` (an embedder, or a forced kill) is also `run.unowned`
with `details.reason: "owner-exited"`; tick may resume that run. After `--timeout` (default 30s) it
exits 79 with the last saved `status`; `--force` then sends one more SIGINT to the same verified
owner, which force-kills its groups and can leave `running` for stale recovery. Cancelling a run
that tick is executing stops that tick pass.

For code/schema edits use [acceptance or fork recovery](durability.md#choose-a-recovery-path);
`--resume --accept-code-change` retains per-step compatibility checks and refuses, without changing
the run, when a completed step changed; preview it with `--dry-run --resume --accept-code-change`
and follow `error.details.next` to fork. Inspect the actual saved checkpoint after storage failure,
since an uncheckpointed action can repeat.

For parked deadlines and polls, use [workflow tick](waits.md#operate-a-parked-run); pending JSON
includes their progress. `tick --json` reports resumed outcomes, skipped reasons and an observed
count; with `--run`, exit 75 means the run is still pending (including interrupted by the tick's
--timeout, also before the runtime reopened a stale run: outcome `interrupted`), locked, blocked by
orphans or skipped for the claim-margin `deadline`, and exit 1 means it failed, was cancelled, or is
crash-looping, incompatible or unreadable. Tick also recovers stale `running` runs, up to 3
consecutive times without a new completed step (`crash-loop`).

## Remove a run

Nothing deletes runs automatically; `workflow list` shows each run's on-disk `bytes` (its files in
the state directory, not worktree caches). Preview a removal first; the dry run takes no lock,
changes nothing and exits 0 with the `verdict` a removal would meet:

```sh
node "$QC_CHECKOUT/bin/run.js" workflow rm first --state-dir "$QC_RUNS" --dry-run --json
node "$QC_CHECKOUT/bin/run.js" workflow rm first --state-dir "$QC_RUNS" --json
```

rm imports no workflow code and never registers a project. It deletes the run directory
(transcripts, artifacts, `launch/`, inbox), the legacy flat files and backups, and the run's
worktree caches; pinned refs only with `--refs` (otherwise listed as `keptRefs`). It refuses with
exit 3 and changes nothing: `run.locked` while any lock owner or recoverer is alive, unverifiable or
remote, even with `--force` (clear an abandoned lock with `workflow unlock` first); `run.orphans`
for a dead owner's live child; and, without `--force`, `run.active` for a `running` or `suspended`
run or one with a `waiting` step, which a pending answer, wait or resume may still need. A cache Git
cannot remove while its repository exists stops rm before it deletes the run (`workflow.storage`,
exit 74, remaining caches in `error.details.caches`): caches Git already removed stay removed
(`error.details.removedCaches`), no ref is deleted, and the record stays; fix the cause and retry
with `workflow clean`. An interrupted rm leaves an intact run (run rm again) or a hidden
`.<run>.<pid>.<uuid>.removing` directory, which the next rm in that state directory sweeps.

`workflow rm ID` also removes the leftover `<runId>/launch/` of a start that failed before its
record, reporting `launchOnly: true`. While that start may still be in flight (its recorded runner
is alive, unverifiable or remote, or, without a runner record, its files are under an hour old) rm
refuses with `run.active`, and `--force` does not override it.

### Retention recipe

`workflow prune` removes finished runs in bulk through the same guarded rm, one run at a time. It
needs at least one filter (`--older-than`, `--status`, `--missing-cwd`); a bare prune is
`usage.flag` (exit 2). Work in this order:

1. List sizes. `workflow list --all --json` gives each run's `bytes`, `status`, `updatedAt` and
   `cwd` across every registered project.
2. Dry run. It takes no lock and changes nothing; `removed[]` lists what would go, with per-run and
   total `bytes`, and `skipped[]` lists the matching runs that stay, with a `reason`.
3. Prune with the same flags. It exits 0 even when some runs were skipped.

```sh
node "$QC_CHECKOUT/bin/run.js" workflow list --all --json
node "$QC_CHECKOUT/bin/run.js" workflow prune --older-than 7d --dry-run --json
node "$QC_CHECKOUT/bin/run.js" workflow prune --missing-cwd --dry-run --json
node "$QC_CHECKOUT/bin/run.js" workflow prune --older-than 7d --json
```

`--status` takes only `completed`, `failed` and `cancelled` (default all three; comma-separated or
repeated), `--older-than` compares `updatedAt` (`7d`, `12h`, `30m`), and `--missing-cwd` picks runs
whose recorded working directory is gone. Add `--all` to scan every registered project, or
`--state-dir` for one runs container. Prune never selects a `running`, `stale` or `suspended` run, a
run with a `waiting` step or an inbox file a resume could still consume (`queued-answer`; answers
the run already consumed and rejected deliveries do not count), or a run held by a lock owner,
recoverer or live orphan. A run that changed after selection is skipped as `changed`. For the rare
run you deliberately want gone while it is still active or waiting, inspect it and use
`workflow rm RUN --force`; prune never forces, and nothing overrides a held lock.

Pinned refs survive prune unless you pass `--refs`, and each removed run lists them as `keptRefs`.
The pins keep the runs' worktree commits reachable; once they are deleted, Git garbage collection
can drop those commits, so pass `--refs` only when no later recovery or integration needs them.

To clean up after deleted workspaces, combine `--missing-cwd` with `--all`. After removing the runs,
prune also removes stale XDG project roots: roots registered for a cwd that is gone, and roots
without a valid `project.json` (the `Skipped project` warnings of `list --all`) that hold only empty
`worktrees/` directories. Preview first, then run it:

```sh
node "$QC_CHECKOUT/bin/run.js" workflow prune --missing-cwd --all --dry-run --json
node "$QC_CHECKOUT/bin/run.js" workflow prune --missing-cwd --all --json
```

`roots[]` lists each stale root with `removed` and a `reason`. Removed roots are `missing-cwd` or
`empty`. A kept root is `runs-kept` (a run there stays; see `skipped[]`), `in-use` (a worktree
namespace names a run that still exists), `files` (anything but the bare layout, such as a live
cache; `paths` shows up to 20 blockers), `busy` (something appeared during removal; prune put the
root's `project.json` or `runs/.gitignore` back) or `storage`. Prune unlinks only `project.json` and
`runs/.gitignore` and removes directories with `rmdir`, so it never deletes a cache. Inspect a
`files` root and delete what you no longer need by hand, then prune again. Without both flags prune
never touches a root.
