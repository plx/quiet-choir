# Operating a run from an agent session

## Launch and keep the result

Use the [golden path](../SKILL.md#run-a-first-workflow-against-a-project) with absolute paths and a
fresh run ID. Long foreground jobs can outlast the host tool's timeout; `nohup`, redirected stdin,
and separate result/log files let the runner continue after that command returns. Save the PID as a
diagnostic, not as durable proof of ownership. `nohup` handles terminal hangup at launch; direct
SIGINT/SIGTERM still cancel. Use one pair of files per run/attempt so a recovery does not overwrite
failure evidence. A machine reboot still stops local processes; there is no scheduler.

`--json` writes one success or failure document to stdout; logs and workflow console output go to
stderr. A failure document has `ok:false`, `exitCode`, `error:{code,message,stepId,details}`,
`runId`, `stateDir`, `diagnostics`, and the last readable `run` (possibly null). Typecheck
diagnostics are top-level, not inside `error`. A process killed before it can report may leave an
empty file. An initial missing record can mean loading is still underway or a pre-record failure;
inspect the log, result document, and observed runner before deciding which.

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
`.status`, or use `--watch`: final completed exits 0, failed 1, cancelled 130, stale 3. JSON watch
emits JSONL on changes; it is not a lossless event stream. Interrupting a watcher stops observation,
not the workflow. List/summary derive `stale` from ownership; full-record `.status` remains the last
saved status. Use [triage](inspection.md#classify-and-act) to interpret it.

| CLI exit | Meaning                                                                                             |
| -------- | --------------------------------------------------------------------------------------------------- |
| 0        | Command succeeded; ordinary inspect only guarantees a readable record                               |
| 1        | Workflow execution failed                                                                           |
| 2        | Usage/input error: flags, missing entrypoint, run ID, input JSON/schema                             |
| 3        | Run refusal: existing/missing/unreadable/locked run, incompatible resume, changed input, or orphans |
| 4        | Workflow typecheck, import, or definition failure                                                   |
| 74       | Checkpoint/storage failure                                                                          |
| 130      | Workflow interruption (SIGINT/SIGTERM/SIGHUP), or interrupted watch                                 |

Use stable `error.code` for automation. Put flags after the command
(`workflow execute FILE --json`).

## Stalls and orphan recovery

First read the saved owner/children without changing anything:

```sh
node "$QC_CHECKOUT/bin/run.js" workflow inspect first --state-dir "$QC_RUNS" --json |
  jq '{status, updatedAt, ownership, sleeps: [.steps | to_entries[] |
    select(.value.kind == "sleep" and .value.status == "running") |
    {id: .key, wakeAt: .value.wakeAt}]}'
cat "$QC_RUNS/first.json.lock/owner.json"
```

The lock can be absent; `cat` then failing is expected. `updatedAt` is not a heartbeat. A long agent
call or sleep may produce no checkpoint changes. Compare sleep `wakeAt` (epoch milliseconds) with
the current clock and inspect logs. A live owner means wait or intentionally cancel the runner; a
foreign-host owner needs investigation on that host. Missing/incomplete `owner.json` can be a writer
mid-acquire: recheck before treating it as abandoned. Do not delete a lock on age alone.

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
`--resume --accept-code-change` retains per-step compatibility checks. Inspect the actual saved
checkpoint after storage failure, since an uncheckpointed action can repeat.
