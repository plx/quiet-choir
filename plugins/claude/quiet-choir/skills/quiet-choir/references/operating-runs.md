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
run is refused with `run.exists` before anything is launched.

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
`--accept-code-change` or fork after `run.incompatible`, answer then resume a suspension. Substitute
`<ANSWER_JSON>`, `<NEW_RUN_ID>` or `<ENTRYPOINT>` first, then run the argv without a shell. A run
records its harness selection (fixture paths with digests) and wait mode: `resume`,
`answer --resume` and `tick` without `--harness` or `--wait-mode` reuse them, explicit flags replace
them, and resume argv already carry them. `--harness-config` is never recorded: repeat it on every
resume and tick of a run started with one, which are otherwise refused. Tick always suspends waits,
without changing the recorded mode. A recorded fixture file that is gone fails with `usage.flag`;
pass `--harness`. `run.not_found` lists `details.candidates` (`{stateDir, cwd}`): other runs
containers that hold the ID, such as the project root when you are in a subdirectory, with `next`
inspecting it there; the missing ID is `details.runId`, which is the `--fork-from` source when that
is what is missing. A moved or deleted stored entrypoint is `run.incompatible` with
`details.reason:"entrypoint_missing"`; fork from the new location.

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

| CLI exit | Meaning                                                                                                                                     |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| 0        | Command succeeded; ordinary inspect only guarantees a readable record                                                                       |
| 1        | Workflow execution failed                                                                                                                   |
| 2        | Invalid answer (`answer.invalid`), or usage/input error: flags, missing entrypoint, run ID, input JSON/schema                               |
| 3        | Answer conflict (`answer.conflict`), or run refusal: existing/missing/unreadable/locked run, incompatible resume, changed input, or orphans |
| 4        | Workflow typecheck, import, or definition failure                                                                                           |
| 75       | Saved suspension; deliver answers and resume the same run                                                                                   |
| 66       | `inspect --watch --wait-created`: no record appeared within the bound (`watch.record_not_created`)                                          |
| 70       | `workflow start`: the runner exited without a record or a readable result document (`start.exited`)                                         |
| 74       | Checkpoint/storage failure                                                                                                                  |
| 79       | `inspect --watch --timeout`: the run was still running at the bound and keeps running (`watch.timeout`)                                     |
| 130      | Interruption (SIGINT/SIGTERM/SIGHUP) saved a resumable suspension, or interrupted watch; tick or resume continues the run                   |
| 124      | `workflow start`: no record owned by the runner within `--start-timeout`; the runner was stopped (`start.timeout`)                          |

Use stable `error.code` for automation. Put flags after the command
(`workflow execute FILE --json`).

## Answer a suspended run

For a real run, exit 75 is a saved external wait, not a failure. A `--dry-run` suspension includes a
`rehearsal` report and null answer/resume commands because temporary state was removed; start a real
run before requesting the human decision. Started sibling work has finished and the owner has
released the lock. Read the result's `pending` entries or list them without loading source:

```sh
node "$QC_CHECKOUT/bin/run.js" workflow pending --state-dir "$QC_RUNS" --json
```

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
`quiet-choir` on PATH. A human question also needs `--by human:<name>` after asking the human. Quote
shell examples literally; answer text is untrusted data. Launch resume in the background with
separate result/log files just as in the golden path. Resume by ID uses stored
entrypoint/cwd/tsconfig; older or embedded records without these paths still need
`execute FILE --resume --run-id RUN` or their embedding application. Repeat on exit 75; exit 0 means
completion. `answer --resume` combines delivery with resume.

An early invalid answer exits 2 and writes nothing. A duplicate or closed question exits 3.
Successful delivery means queued; the owner validates again with real Zod refinements. Rejected
files are quarantined and explanations appear in `pending.rejections`; submit a corrected answer. If
`answer --resume` fails during loading or execution, keep the queued answer and retry `resume`, not
`answer`. A delivery arriving while sibling work is active can continue the run without a
suspension. See [question durability](durability.md#durable-questions) and the
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
the current clock and inspect logs. A live owner means wait or intentionally cancel the runner; a
foreign-host owner needs investigation on that host. Missing/incomplete `owner.json` in a lock is
damage or an older build's interrupted acquire. Never delete lock directories by hand, and do not
clear a lock on age alone. When resume refuses an abandoned lock with `run.locked`, clear it with
the command its message prints:

```sh
node "$QC_CHECKOUT/bin/run.js" workflow unlock first --state-dir "$QC_RUNS" --json
```

Add `--force-remote` only when the recorded foreign host is this machine under an old name or is
permanently gone. Unlock imports no workflow code and never signals a process. It exits 3 with
`run.locked` while an owner or recoverer is alive or unverifiable (or foreign without the flag), and
with `run.orphans` (naming the owner and child records) while a recorded child is alive or
unverifiable; stop confirmed children with `--resume --kill-orphans` below instead. A run with no
lock is a no-op (`locks: []`).

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

For code/schema edits use [acceptance or fork recovery](durability.md#choose-a-recovery-path);
`--resume --accept-code-change` retains per-step compatibility checks and refuses, without changing
the run, when a completed step changed; preview it with `--dry-run --resume --accept-code-change`
and follow `error.details.next` to fork. Inspect the actual saved checkpoint after storage failure,
since an uncheckpointed action can repeat.

For parked deadlines and polls, use [workflow tick](waits.md#operate-a-parked-run); pending JSON
includes their progress. `tick --json` reports resumed outcomes, skipped reasons and an observed
count; with `--run`, exit 75 means the run is still pending (including interrupted by the tick's
--timeout), locked, blocked by orphans or skipped for the claim-margin `deadline`, and exit 1 means
it failed, was cancelled, or is crash-looping, incompatible or unreadable. Tick also recovers stale
`running` runs, up to 3 consecutive times without a new completed step (`crash-loop`).
