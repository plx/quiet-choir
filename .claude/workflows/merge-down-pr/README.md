# merge-down-pr

A Claude Code workflow ([`../merge-down-pr.js`](../merge-down-pr.js)) that lands **one** pull
request the way a careful maintainer would. It rebases the PR onto the default branch, triages its
review threads, and reviews it against its issue. It fixes what is in scope, files follow-ups for
what is not, gates on CI and Codex, squash-merges, and records what happened on the issue.

It was written to merge down the stack of PRs produced for epic #32. It is also kept as a reference
workflow to port to quiet-choir itself, so the structure is deliberately explicit.

## Run it

```text
Workflow({ name: 'merge-down-pr', args: { pr: 66, parentEpic: 32, followupEpic: 123 } })
```

| Argument             | Meaning                                                                                                                                                                                                                                                                                                                                                                                                    |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pr`                 | Required. The PR to land.                                                                                                                                                                                                                                                                                                                                                                                  |
| `followupEpic`       | Epic that follow-up issues attach to. If omitted, the first follow-up creates one; pass the returned `followupEpic` to later runs.                                                                                                                                                                                                                                                                         |
| `followupEpicTitle`  | Title for a newly created follow-up epic.                                                                                                                                                                                                                                                                                                                                                                  |
| `parentEpic`         | Epic the landed issues belong to (context for follow-ups).                                                                                                                                                                                                                                                                                                                                                 |
| `until`              | `prepare`, `review`, `fix`, or `merge` (default). Anything before `merge` is a dry run: nothing is pushed, commented, filed, or merged.                                                                                                                                                                                                                                                                    |
| `codex`              | `auto` (default: review again when the PR's own code changed, or Codex never reviewed it), `always`, or `never`.                                                                                                                                                                                                                                                                                           |
| `codexMode`          | `local` (default): a clerk runs `codex review` locally (see below). `github`: comment `@codex review` and wait for the Codex app.                                                                                                                                                                                                                                                                          |
| `codexModel`         | Model for the local review (default `gpt-6-astra`); overrides both `model` and `review_model`.                                                                                                                                                                                                                                                                                                             |
| `codexEffort`        | Reasoning effort for the local review (default: Codex's configuration).                                                                                                                                                                                                                                                                                                                                    |
| `maxCodexRounds`     | Base number of Codex re-reviews per run (default 3). Codex reports a few findings per pass, so on intricate PRs later rounds keep finding real problems that were already there. Beyond the base, re-reviews continue only while the latest round found a real major or blocker, up to `codexRoundsHardCap` (default 5). When re-reviews stop, new findings are still triaged and fixed, gated on CI only. |
| `codexRoundsHardCap` | Upper bound on Codex re-reviews when major findings keep appearing (default 5).                                                                                                                                                                                                                                                                                                                            |
| `maxCiRepairs`       | CI repair attempts (default 2).                                                                                                                                                                                                                                                                                                                                                                            |
| `standingNotes`      | Decisions made earlier in a stack walk that every reviewer, resolver, and fixer should apply without re-litigating (array of strings).                                                                                                                                                                                                                                                                     |
| `root`               | Directory for `worktree/` and `state/` (default: `<main checkout>-merge-down`, next to the main checkout).                                                                                                                                                                                                                                                                                                 |

The result is a ledger record with `status` (`merged`, `closed`, `deferred`, `blocked`, `stopped`,
`skipped`, or `error`), links, a count of thread decisions, fixes, follow-ups, the summary comment
URL, and a one-line `headline`. A `blocked` result names the stage and reason and leaves the PR
open; re-running is safe once the cause is handled.

### Walking a stack

Run the workflow once per PR, bottom-up. Each run needs its parent to be merged already. Squash
merging rewrites history, so the first `sync` records every stacked PR's fork point under
`refs/merge-down/fork-point/<pr>` before anything is rewritten. Each later run can then rebase only
the PR's own commits onto the new default branch. After a parent merges, GitHub deletes its branch
and retargets the child to the default branch.

## How it works

| Stage   | Who (model / effort)                           | What                                                                                                                                                                                                                                                                                                                                                          |
| ------- | ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Prepare | haiku / low                                    | `merge-down.mjs prepare`: snapshot the PR, issue, threads, CI, and Codex state into `state/pr-N/`; check out the PR in the dedicated worktree and rebase it.                                                                                                                                                                                                  |
| Rebase  | opus / high (sonnet / high for dependency PRs) | Only on conflicts. A semantic merge: adapt the PR to what changed beneath it (`upstream-delta.patch`).                                                                                                                                                                                                                                                        |
| Review  | haiku ∥ opus / medium → opus / xhigh           | The local check suite runs in parallel with one reviewer that triages every unresolved thread and reviews the PR against its issue. Suspected blockers, poor alignment, or many major fixes escalate.                                                                                                                                                         |
| Fix     | sonnet / high or opus / high ∥ sonnet / medium | The implementer is chosen by the reviewer's complexity rating; the scribe files follow-ups (deduplicated, as sub-issues of the follow-up epic). A minor finding of the workflow's own review that the implementer could not fully fix (partly or not at all) becomes a follow-up instead of blocking; threads, check/CI items and major findings still block. |
| Gate    | haiku / low                                    | Retarget, push with lease, reply to threads (Codex threads are resolved), and wait for CI while a clerk runs a local `codex review` of the pushed head. New findings, threads, or red CI loop back through triage and fix.                                                                                                                                    |
| Land    | haiku / low                                    | Squash-merge pinned to the gated SHA; confirm the issue closed (close it explicitly if GitHub did not).                                                                                                                                                                                                                                                       |
| Report  | sonnet / medium                                | Post an issue comment when something is worth recording; write the ledger headline.                                                                                                                                                                                                                                                                           |

Dependabot PRs replace the review with a dependency review (`merge`, `fix`, `close` with an
`@dependabot ignore …` command, or `defer`) and skip Codex.

### Local Codex review

By default (`codexMode: 'local'`) the workflow does not ask the Codex GitHub app for reviews.
Instead a Haiku clerk runs `merge-down.mjs local-review-start`, which launches
`codex review --base origin/<default> -c model="gpt-6-astra"` detached under Codex's workspace-write
sandbox, then `local-review-wait` in 9-minute slices (a review at xhigh effort can take well over 10
minutes). Each review runs in a throwaway worktree of its own (`state/pr-N/review-<sha>`, removed
when it ends), never in the workflow's worktree, which the check suite and later fix rounds use at
the same time. The review worktree gets dependencies (a copy-on-write clone of the workflow
worktree's `node_modules` when the lockfile matches, else `npm ci`) so Codex can run tests; the
result's `deps` says which. The review text lands in `state/pr-N/codex-review-<sha>.md`; the relayed
JSON carries its path, exit code, elapsed time, and a count of `[P0]`–`[P3]` findings, or the error.
A finished review is cached by head, model, and effort: one of the same head with the same
`codexModel` and `codexEffort` is reused, so a resumed run does not pay twice, and one still running
is waited for rather than started again. A review with another model or effort is replaced (a
running one is stopped first). When a wait fails or the review outlasts 54 minutes,
`local-review-stop` kills it (its whole process group) and removes its worktree. It also reaps
leftovers of a finished, failed review: a result file only says the runner ended, and a timeout can
leave codex descendants alive in the group. A start that relaunches a failed review reaps the
previous attempt's surviving group the same way first, and fails if it survives SIGKILL. A pid can
be reused once its process is gone, so each start also records the runner's start time: start, wait,
and stop treat the record as the review's only while a process with that pid has that start time,
or, once the runner has exited, while its process group survives (a pid is not reused while its
group exists). Otherwise nothing is signalled and the result carries a note that the stale record
was ignored.

The first review runs on the rebased head in parallel with the check suite and the merge-down
review; an Opus triage then turns its findings into fixes, follow-ups, or recorded rejections,
deduplicated against the review's own findings. Triage must give every tagged finding an entry: a
shortfall is retried once with the count and the ids returned so far, and if triage still returned
no finding at all the run blocks at the review step. A partial shortfall (the `[P0]`–`[P3]` count
can overcount when a tag is quoted in prose) is recorded in the ledger notes rather than blocking. A
finding that repeats an earlier fix decision is checked against the code at the reviewed head, and
is a new fix item if the defect is still there; only note, follow-up, and deferred repeats are
duplicates. A fix that the fixer could not finish was deferred to a follow-up issue, so triage sees
it as deferred (with the issue number) rather than as attempted, and its repeats do not start new
fix rounds. Each gate round that pushed new code reviews the pushed head in parallel with the CI
wait, bounded by `maxCodexRounds` / `codexRoundsHardCap` as before. A failed review is noted and the
gate proceeds on CI. When a local review ran, the gate refreshes its CI and unanswered-thread
snapshot once the review finishes (CI is settled by then, so this costs only the settle delay), so
threads that arrived during the review are triaged in the same round. `codexModel` and `codexEffort`
override the model and reasoning effort. Threads that the GitHub app (or anyone else) still posts
are triaged as unanswered threads.

### Codex signals (`codexMode: 'github'`)

Codex reviews only when a PR is opened or marked ready, or when someone comments `@codex review`;
pushes do not trigger it. It keeps a summary comment (`<!-- codex-pull-request-review-summary -->`)
with a per-commit status row, posts a review with inline threads when it has findings, and reacts 👍
when it has none. `merge-down.mjs await` counts a review as finished when either:

- a Codex review arrives on the pushed SHA (findings), or
- a fresh 👍 appears, or the summary row for that SHA reads "Completed" on two consecutive polls
  (clean).

### Other reviewers

Codex is not the only source of review threads. CodeQL posts code-scanning alerts as threads,
usually a few minutes after its check completes, and a human may comment at any time. After CI and
Codex settle, `await` waits briefly and then counts threads whose last comment is not ours, plus
open code-scanning alerts on the PR. Anything unanswered goes back through triage. A rejected alert
is dismissed with the triage's justification ("used in tests" for test files). As a backstop, `land`
refuses to merge while the PR has open alerts. Early in the #32 merge-down, two PRs landed with
CodeQL threads nobody had answered, which is why this rule exists (see #105).

### Verified relay

A Claude Code workflow script cannot run commands or read files, so every mechanical step goes
through a Haiku "clerk" that runs `merge-down.mjs` and copies its JSON into its final message.
Copies are not always faithful. In one early run, a clerk "helpfully" appended a filename to a
directory path, and another couldn't escape a multi-line test log inside a JSON string. So:

- each output carries `_nonce` (chosen by the workflow per call) and `_fnv` (an FNV-1a hash of the
  rest), and the workflow recomputes both before trusting a copy;
- clerks return a plain JSON object keyed by command id, so outputs are never re-escaped as strings,
  and large text (logs, diffs, threads) stays in files that only their paths point to;
- every output is also saved under `state/pr-N/last/`, and a failed verification re-reads it
  (`merge-down.mjs last`) instead of repeating the effect, so a retry never double-posts or
  double-merges;
- no clerk command may outlast the Bash tool's 10-minute foreground limit. The check suite takes
  about 11 minutes, so the first check runs as `check-start` (detached) followed by `check-wait`
  calls of up to 9 minutes each, the same bounded-slice pattern `await` uses for CI. Before this, a
  check that ran past 10 minutes (#273 and #279) lost its output, and the landing paid for a fix
  round that only re-ran the suite.

## Files

- `merge-down.mjs`: all git and GitHub mechanics. Each subcommand prints exactly one JSON object;
  run any of them by hand (`node merge-down.mjs state --pr 66`). Agents never improvise plumbing. A
  red CI run is re-run once (`rerun`) before any agent tries to fix it.
- `state/pr-N/` (outside the repository): `state.json`, `sync.json`, `body.md`, `issue.md`,
  `threads.md`, `own.diff`, `upstream-delta.patch`, check logs, and posted replies.

## Porting notes

This workflow is a reference point for quiet-choir's own design. Each `merge-down.mjs` subcommand is
a deterministic effect that a Claude Code workflow can only reach through an agent (a Haiku "clerk"
that runs the command and relays its JSON). In quiet-choir these become durable `ctx.exec` or
`ctx.step` calls with no model cost. The waits are `ctx.wait` polls, the Codex and CI loop is a
bounded `while`, and the tiered agents keep their models and effort levels.
