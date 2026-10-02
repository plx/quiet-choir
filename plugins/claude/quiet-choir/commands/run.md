---
description: >-
  Launch a quiet-choir workflow in the background, follow its events with Monitor, answer its
  questions, and report how it ended.
argument-hint: WORKFLOW [--input JSON] [--run-id ID]
allowed-tools: Bash, Monitor, TaskStop, AskUserQuestion, Read
---

# Run a quiet-choir workflow

Run one quiet-choir workflow to its end from this session: rehearse it, launch it in the background,
follow its event lines with Monitor, answer any questions it asks, and report the outcome. The
command drives an existing quiet-choir checkout; it does not install the runtime.

Arguments: `$ARGUMENTS`

## 1. Resolve the run

Read the arguments above. The first word is the workflow file. `--input JSON` is the workflow input
(default `{}`), and `--run-id ID` is the run ID (default: the workflow file's base name without
`.workflow.*` plus a UTC timestamp, such as `review-20261001-1204`; 1 to 128 letters, digits, `_` or
`-`, starting with a letter or digit). Ask the user when the workflow file is missing or ambiguous.

Resolve `QC_CHECKOUT`, `QC_TARGET`, `QC_WORKFLOW` and `QC_RUNS` to absolute paths as the skill's
[first-run setup](../skills/quiet-choir/SKILL.md#run-a-first-workflow-against-a-project) describes:
a built runtime checkout, the target project (the run's working directory), the workflow file, and a
state directory outside the target worktree. Also set `QC_RUN` to the run ID and `QC_INPUT` to the
input JSON.

Shell state does not persist between Bash calls. Start **every** Bash call with one `export` line
that sets each value resolved so far as a single-quoted literal (paths absolute; write a `'` inside
a value as `'\''`), for example
`export QC_CHECKOUT='/abs/quiet-choir' QC_TARGET='/abs/project' QC_WORKFLOW='/abs/review.workflow.mts' QC_RUNS='/abs/runs' QC_RUN='review-20261001-1204' QC_INPUT='{}'`,
then the block below unchanged. Later steps add `QC_STEP`, `QC_ANSWER`, `QC_BY` and `QC_EXECUTION`
the same way.

## 2. Rehearse

Validate and rehearse without paid calls, then show the user a short summary of the rehearsal: the
number of `calls` and their harnesses (`harnessCounts`), `nominalClaudeCeilingUsd`, and every
warning. Stop and report if validation fails. A rehearsal that reaches a question exits 75; that is
expected.

<!-- skills-check: example run-preflight -->

```sh
cd "$QC_TARGET" || exit 1
node "$QC_CHECKOUT/bin/run.js" workflow validate "$QC_WORKFLOW" --json || exit 1
node "$QC_CHECKOUT/bin/run.js" workflow execute "$QC_WORKFLOW" \
  --run-id "$QC_RUN" --state-dir "$QC_RUNS" --input "$QC_INPUT" --dry-run --json
```

## 3. Launch in the background

Run this block with Bash `run_in_background: true` and a Bash `timeout` longer than the watch's
`--timeout` (for example 600000 ms for `8m`). Do not add `nohup` or `&`: the background task must
end when the watch ends, so that its completion notification means the run reached an outcome.

<!-- skills-check: example run-launch -->

```sh
cd "$QC_TARGET" || exit 1
node "$QC_CHECKOUT/bin/run.js" workflow start "$QC_WORKFLOW" \
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

On 75, set `QC_EXECUTION` to the snapshot's `execution`. For each entry of the snapshot's
`pending[]`, ask the user with AskUserQuestion, mapping it as the
[answer loop](../skills/quiet-choir/references/operating-runs.md#answer-a-suspended-run) describes,
and never choose a human's answer yourself. Set `QC_STEP` to the entry's `stepId`, `QC_ANSWER` to
the answer JSON, and `QC_BY` to `human:` plus the user's name (or `agent:claude-code` for an `agent`
or `any` question you answer within your task). Deliver one answer at a time with this block in the
background, as in step 3; when other questions are still open, the resumed run suspends again and
the next round asks them. A refused answer (exit 2 or 3) ends the block with its error document as
the last line; ask again.

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
