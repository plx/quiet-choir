---
description: >-
  Launch a quiet-choir workflow file or package in the background, follow its events with Monitor,
  answer its questions, and report how it ended.
argument-hint: WORKFLOW [--workflow NAME] [--input JSON] [--run-id ID] [--fixtures FILE]
allowed-tools: Bash, Monitor, TaskStop, AskUserQuestion, Read
---

# Run a quiet-choir workflow

Run one quiet-choir workflow to its end from this session: rehearse it, launch it in the background,
follow its event lines with Monitor, answer any questions it asks, and report the outcome. The
command drives an existing quiet-choir checkout; it does not install the runtime.

Arguments: `$ARGUMENTS`

## 1. Resolve the run

Read the arguments above. The first word is the workflow: a workflow file, or a `*.quiet-choir`
package directory (the CLI treats a path whose last segment ends in `.quiet-choir` as a
[package](../skills/quiet-choir/references/packages.md)). `--workflow NAME` selects a workflow the
package declares; without it the package's entry runs, and it is only valid with a package.
`--fixtures FILE` is a [fixture file](../skills/quiet-choir/references/rehearsal.md#fixtures) that
answers the rehearsal's agent calls and commands; the rehearsal uses it and the launch never does.
`--input JSON` is the workflow input (default `{}`), and `--run-id ID` is the run ID (1 to 128
letters, digits, `_` or `-`, starting with a letter or digit). Without `--run-id`, step 2 derives
one. Ask the user when the workflow is missing or ambiguous.

Resolve `QC_CHECKOUT`, `QC_TARGET`, `QC_WORKFLOW` and `QC_RUNS` to absolute paths as the skill's
[first-run setup](../skills/quiet-choir/SKILL.md#run-a-first-workflow-against-a-project) describes:
a built runtime checkout, the target project (the run's working directory), the workflow file or
package directory, and a state directory outside the target worktree. Also set `QC_INPUT` to the
input JSON, `QC_REHEARSAL_INPUT` to the input the rehearsal takes (the same JSON as `QC_INPUT`
unless step 2 says otherwise), `QC_WORKFLOW_NAME` to the `--workflow` name and `QC_FIXTURES` to the
absolute fixture path; set each of the last two to the empty string `''` when its flag is absent.
Set `QC_RUN` to an explicit `--run-id` once you have one.

Shell state does not persist between Bash calls. Start **every** Bash call with one `export` line
that sets each value resolved so far as a single-quoted literal (paths absolute; write a `'` inside
a value as `'\''`), for example
`export QC_CHECKOUT='/abs/quiet-choir' QC_TARGET='/abs/project' QC_WORKFLOW='/abs/merge-down.quiet-choir' QC_WORKFLOW_NAME='merge-down-pr' QC_FIXTURES='' QC_RUNS='/abs/runs' QC_RUN='merge-down-merge-down-pr-20261001-1204' QC_INPUT='{"pr":42}' QC_REHEARSAL_INPUT='{"pr":42,"root":"/tmp/qc-rehearsal-x1"}'`,
then the block below unchanged. Later steps add `QC_STEP`, `QC_ANSWER`, `QC_BY` and `QC_EXECUTION`
the same way.

## 2. Validate and rehearse

Validate first. The blocks pass `--workflow` and `--harness` only when `QC_WORKFLOW_NAME` or
`QC_FIXTURES` is non-empty, with two expansions per flag so each yields exactly one word (or none)
in sh, bash and zsh. Stop and report if validation fails. If it fails with `usage.entrypoint`
because a package has no entry, or does not declare the name, report the error's `details.workflows`
and ask the user which workflow to run; then start again with that name.

<!-- skills-check: example run-validate -->

```sh
cd "$QC_TARGET" || exit 1
node "$QC_CHECKOUT/bin/run.js" workflow validate "$QC_WORKFLOW" \
  ${QC_WORKFLOW_NAME:+--workflow} ${QC_WORKFLOW_NAME:+"$QC_WORKFLOW_NAME"} --json || exit 1
```

Without an explicit `--run-id`, derive the run ID from that validate result now, and add `QC_RUN` to
the export line from here on. For a package it is the result's `package.name`, a `-`, its
`workflow.name`, a `-` and a UTC timestamp (`date -u +%Y%m%d-%H%M`), such as
`merge-down-merge-down-pr-20261022-1204`; the validate result names the workflow even when
`--workflow` was omitted and the entry was selected. For a single workflow file it is the file's
base name without `.workflow.*` plus a UTC timestamp, such as `review-20261001-1204`. In either
form, replace every character other than a letter, digit, `_` or `-` with `-`, then shorten the name
part so the whole ID, `-YYYYMMDD-HHMM` included, has at most 128 characters. If a command still
refuses the ID with `usage.run_id`, ask the user for a `--run-id`.

Then rehearse without paid calls, and show the user a short summary of the rehearsal: the number of
`calls` and their harnesses (`harnessCounts`), `nominalClaudeCeilingUsd`, and every warning. A real
package usually needs `--fixtures`, because synthesized command output (for example empty `gh`
reads) cannot drive it; a rehearsal that reaches a question exits 75, which is expected. A rehearsal
still runs local steps and file writes, so when the input names a location the workflow writes to
(such as merge-down's `root`, which holds its worktree and state files), set `QC_REHEARSAL_INPUT` to
a copy of the input that points it at a fresh temporary directory (`mktemp -d`) outside the target
and the live location.

<!-- skills-check: example run-rehearse -->

```sh
cd "$QC_TARGET" || exit 1
node "$QC_CHECKOUT/bin/run.js" workflow execute "$QC_WORKFLOW" \
  ${QC_WORKFLOW_NAME:+--workflow} ${QC_WORKFLOW_NAME:+"$QC_WORKFLOW_NAME"} \
  ${QC_FIXTURES:+--harness} ${QC_FIXTURES:+"fixture:$QC_FIXTURES"} \
  --run-id "$QC_RUN" --state-dir "$QC_RUNS" --input "$QC_REHEARSAL_INPUT" --dry-run --json
```

## 3. Launch in the background

Run this block with Bash `run_in_background: true` and a Bash `timeout` longer than the watch's
`--timeout` (for example 600000 ms for `8m`). Do not add `nohup` or `&`: the background task must
end when the watch ends, so that its completion notification means the run reached an outcome. The
launch takes the live input `QC_INPUT` and never takes fixtures. Steps 4 to 6 take only the run ID:
a package run resumes through its manifest and its recorded workflow, so they need no selection.

<!-- skills-check: example run-launch -->

```sh
cd "$QC_TARGET" || exit 1
node "$QC_CHECKOUT/bin/run.js" workflow start "$QC_WORKFLOW" \
  ${QC_WORKFLOW_NAME:+--workflow} ${QC_WORKFLOW_NAME:+"$QC_WORKFLOW_NAME"} \
  --run-id "$QC_RUN" --state-dir "$QC_RUNS" --input "$QC_INPUT" --json &&
  node "$QC_CHECKOUT/bin/run.js" workflow inspect "$QC_RUN" --state-dir "$QC_RUNS" \
    --watch --final --json --summary --timeout 8m
```

## 4. Follow with Monitor

Right after the launch, start Monitor with this block and a `timeout_ms`. `workflow events` derives
one short JSON line per transition from the run record, without importing the workflow.
`--from-start` replays what happened before Monitor started, `--wait-created` covers a record that
`start` has not created yet, and the filter passes step failures, settled failures, opened questions
and the terminal run states. Tell the user about each matching line as it arrives. If Monitor times
out first, start it again the same way.

<!-- skills-check: example run-follow -->

```sh
node "$QC_CHECKOUT/bin/run.js" workflow events "$QC_RUN" --state-dir "$QC_RUNS" \
  --follow --from-start --wait-created 60s |
  grep --line-buffered -E '"ev":"(step\.failed|step\.settled|wait\.opened|run\.(completed|failed|cancelled|suspended))"'
```

## 5. Read the outcome

When the background task's completion notification arrives, stop the monitor with TaskStop and read
the task's output. Use its **last stdout line**: a `kind: "workflow.error"` document is a failure
(branch on `error.code`); otherwise it is the final snapshot (branch on `status`). Interpret the
exit code with the skill's
[exit table](../skills/quiet-choir/SKILL.md#drive-a-run-from-claude-code): report the output on 0,
the root cause and `next` commands on 1, and how to continue on 79, 3 or 130. On 75, continue below.

## 6. Answer and follow again

On 75, set `QC_EXECUTION` to the snapshot's `execution`. The snapshot lists waiting steps but not
their questions, so read the open questions without loading workflow code:

<!-- skills-check: example run-pending -->

```sh
node "$QC_CHECKOUT/bin/run.js" workflow pending --state-dir "$QC_RUNS" --run "$QC_RUN" --json
```

The listing is limited to this run and already omits answered rows and rows of ended runs. For each
`pending[]` entry, ask the user with AskUserQuestion, mapping it as the
[answer loop](../skills/quiet-choir/references/operating-runs.md#answer-a-suspended-run) describes,
and never choose a human's answer yourself. Set `QC_STEP` to the entry's `stepId`, `QC_ANSWER` to
the answer JSON, and `QC_BY` to `human:` plus the user's name (or `agent:claude-code` for an `agent`
or `any` question you answer within your task). Deliver one answer at a time with this block in the
background, as in step 3; when other questions are still open, the resumed run suspends again and
the next round asks them. A refused answer (exit 2 or 3) ends the block with its error document as
the last line; ask again, using `error.details.issues` to name the field that was refused.
`answer --resume` runs the resumed execution inside this task, so give the Bash call the longest
timeout available; if the host stops it, the run saves a resumable suspension (exit 130) and
`workflow resume` continues it.

<!-- skills-check: example run-answer -->

```sh
cd "$QC_TARGET" || exit 1
node "$QC_CHECKOUT/bin/run.js" workflow answer "$QC_RUN" "$QC_STEP" --state-dir "$QC_RUNS" \
  --json "$QC_ANSWER" --by "$QC_BY" --resume
answered=$?
case "$answered" in 0 | 1 | 75 | 130) ;; *) exit "$answered" ;; esac
node "$QC_CHECKOUT/bin/run.js" workflow inspect "$QC_RUN" --state-dir "$QC_RUNS" \
  --watch --final --json --summary --timeout 8m
```

Then start Monitor again with this block. `--after-execution` ignores the suspended execution, so
the follower waits for the resumed one instead of stopping on the old `suspended` status.

<!-- skills-check: example run-follow-again -->

```sh
node "$QC_CHECKOUT/bin/run.js" workflow events "$QC_RUN" --state-dir "$QC_RUNS" \
  --follow --after-execution "$QC_EXECUTION" |
  grep --line-buffered -E '"ev":"(step\.failed|step\.settled|wait\.opened|run\.(completed|failed|cancelled|suspended))"'
```

Repeat step 5 and this step until the run ends with another status.
