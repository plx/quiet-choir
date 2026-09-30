# execute-epic-ticket

A Claude Code workflow ([`../execute-epic-ticket.js`](../execute-epic-ticket.js)) that takes **one**
ticket of an epic from "open issue" to "merged". It finds the next ticket the epic is ready for and
checks that the ticket still describes real work. Then it plans and implements the ticket in a
dedicated worktree, opens a PR, and lands the PR by running
[`merge-down-pr`](../merge-down-pr/README.md) as an inline child workflow. When there is nothing to
implement, it says why: the epic is done, nothing is ready, the ticket is obsolete, or a question
needs the maintainer.

It was written to burn down wave-2 epic #99, one ticket per run. It is also kept as a reference
workflow to port to quiet-choir itself, alongside `merge-down-pr`, so the structure is deliberately
explicit.

## Run it

```text
Workflow({ name: 'execute-epic-ticket', args: { epic: 99, followupEpic: 140 } })
```

| Argument          | Meaning                                                                                                                                                                                                                                                    |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `epic`            | Required. The epic whose checklist and sub-issues are the tickets.                                                                                                                                                                                         |
| `ticket`          | Work on this ticket instead of the survey's choice.                                                                                                                                                                                                        |
| `decision`        | The maintainer's answer to a `needs-decision` question on `ticket`. It is posted on the issue (removing the label) before planning.                                                                                                                        |
| `until`           | `survey`, `plan`, `implement`, `pr`, or `land` (default). `survey` and `plan` change nothing; `implement` commits only to the local branch; `pr` opens the PR and stops before landing.                                                                    |
| `followupEpic`    | Epic for follow-ups found along the way. If omitted, one titled `followupEpicTitle` (default "Epic: enhancements, wave 3") is found or created on first need; the result carries its number.                                                               |
| `standingNotes`   | Decisions every planner, implementer, and landing reviewer should apply without re-litigating (array of strings). Also forwarded to `merge-down-pr`.                                                                                                       |
| `maxCandidates`   | Tickets to try in one run when earlier ones turn out to be blocked by an undeclared dependency (default 3).                                                                                                                                                |
| `implementer`     | `auto` (default: by the plan's complexity), `mechanic`, or `surgeon`.                                                                                                                                                                                      |
| `mergeDown`       | Extra arguments for the `merge-down-pr` child, e.g. `{ maxCodexRounds: 2 }`.                                                                                                                                                                               |
| `commitTrailer`   | Lines every implementation commit message ends with (e.g. `Co-Authored-By: …`).                                                                                                                                                                            |
| `prFooter`        | Text the PR description ends with.                                                                                                                                                                                                                         |
| `root`            | Directory for `worktree/` and `state/` (default: `<main checkout>-epic-burndown`, next to the main checkout).                                                                                                                                              |
| `mergeDownScript` | Absolute path of `merge-down-pr.js` to run as the landing child. Default: the registered `merge-down-pr`. Pass the path while iterating on the child: a resume with unchanged parent code and arguments may not pick up edits to a child launched by name. |

### Outcomes

The result is a record whose `status` is one of:

| Status            | Meaning                                                                                                                                                |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `landed`          | The ticket's PR merged, the issue closed, and the epic's checklist line is ticked. `next` names the ticket the next run will take.                     |
| `pr-open`         | `until: 'pr'`: the PR is open and has had its first Codex review.                                                                                      |
| `closed-obsolete` | The code already satisfies the ticket, or it no longer applies. It was closed with the evidence, after an independent skeptic agreed.                  |
| `closed-split`    | A ticket that was split earlier: all its slices have closed, so it was closed too.                                                                     |
| `needs-decision`  | A question only the maintainer can answer (`decision`). It is posted on the issue with the `needs-decision` label. Rerun with `ticket` and `decision`. |
| `split`           | The ticket was too large for one PR; `slices` were filed as epic items right after it. The next run takes the first slice.                             |
| `held`            | `ticket` names a ticket with a hold label (`blocked`, `needs-decision`, `on-hold`) and no `decision` was given.                                        |
| `epic-done`       | No open tickets remain. Closing the epic is left to the maintainer.                                                                                    |
| `stalled`         | Open tickets remain, but none is ready (waiting on dependencies, held, or split).                                                                      |
| `blocked`         | A stage could not finish (`blocked.stage`, `blocked.reason`). Re-running is safe.                                                                      |
| `stopped`         | An `until` short of `land` was reached.                                                                                                                |

### Burning down an epic

Run the workflow once per ticket and read each result before the next run: relay `needs-decision`
questions to the maintainer, add anything decided to `standingNotes`, and pass the returned
`followupEpic` on. The epic's checklist order is the plan. Reorder the checklist to change what
comes next, and write "Depends on #N" in a ticket (or use GitHub's blocked-by link) to hold it back
until #N closes.

## How it works

| Stage     | Who (model / effort)                  | What                                                                                                                                                                                                                                                                      |
| --------- | ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Survey    | haiku / low                           | `epic.mjs survey`: the epic's checklist order, sub-issues, each ticket's state, dependencies, hold labels, split markers, and open PRs. Picks in-flight work first, then a finished split parent, then the first ready ticket.                                            |
| Plan      | opus / high (+ opus / medium skeptic) | `epic.mjs start` prepares the ticket's branch in the dedicated worktree. One planner reads the ticket and the code once and decides whether it is ready, obsolete, needs a decision, is blocked, or should be split. For a ready ticket it writes the plan (`plan.json`). |
| Implement | sonnet / high or opus / high          | The implementer follows the plan, commits, and runs the full check suite through `epic.mjs check`. The mechanic escalates to the surgeon when it leaves work unfinished. `epic.mjs verify` then checks the report mechanically.                                           |
| Publish   | sonnet / medium ∥ sonnet / medium     | A scribe writes the PR description while another writes up out-of-scope follow-ups (filed by `epic.mjs file-issue`). `epic.mjs open-pr` opens the PR, then the workflow waits for Codex's automatic first review.                                                         |
| Land      | `merge-down-pr`                       | Inline child workflow: review against the ticket, thread triage and fixes, CI + Codex + CodeQL gate, squash-merge, issue summary comment.                                                                                                                                 |
| Report    | haiku / low                           | `epic.mjs tick` checks the ticket off in the epic, `ledger` appends a line, and a fresh `survey` gives `remaining` and `next`.                                                                                                                                            |

### Structural verification

The main lesson of the #32 merge-down was to never take a model's word for a fact the workflow
depends on. Here:

- **The helper, not a prompt, enforces what gets published.** `open-pr` refuses a dirty worktree, a
  branch with no commits of its own, and a head without a passing check.
- **Implementer reports are checked mechanically.** Every acceptance criterion must be reported
  `done` with a commit. `verify` confirms each named commit is on the branch, the tree is clean, and
  the last full check passed at the exact head.
- **Closing a ticket needs two opinions.** An "obsolete" verdict is closed only if an independent
  skeptic agrees. If the skeptic disagrees, the ticket is re-planned instead.
- **Relayed outputs are verified.** Every clerk copy is checked by nonce and FNV-1a hash. A failed
  check re-reads the saved output instead of repeating the effect (same protocol as
  `merge-down-pr`).

### Resuming

Re-running is safe and picks up where the last run stopped:

- A ticket with an open PR goes straight to landing, so `merge-down-pr` is simply re-run.
- The planner reuses and re-validates a branch left by an interrupted run, along with its
  `plan.json`.
- Every GitHub write in the helper is idempotent: checklist ticks, label edits, filing by exact
  title, and editing an existing PR instead of opening a second one.

Within one Claude Code session, `resumeFromRunId` also replays completed agents from cache.

## Files

- `epic.mjs`: all git and GitHub mechanics. Each subcommand prints exactly one JSON object; run any
  of them by hand (`node epic.mjs survey --epic 99`).
- `state/epic-E/` (outside the repository): `survey.json`, `items.md`, one `issues/N.md` per ticket,
  `ledger.jsonl`, and one `issue-N/` directory per ticket worked on. That directory holds
  `issue.md`, `epic.md`, `plan.json`, check logs, the diff snapshot, and `pr.json`.

## Porting notes

This workflow is meant to be ported to quiet-choir after `merge-down-pr`, so it is written to make
the mapping easy to see:

| Here (Claude Code workflow)                                                   | In quiet-choir                                                                                                                                  |
| ----------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| Haiku clerks run `epic.mjs` and relay nonce+FNV-verified JSON                 | `ctx.exec.json` effects: no model cost, no relay, and the output is journaled.                                                                  |
| `needs-decision` returns, and a maintainer re-runs with `ticket` + `decision` | `ctx.ask` with an answer schema: the run suspends (exit 75), the answer is validated before delivery, and resume continues from the same point. |
| `awaitFirstReview` loops a clerk around `merge-down.mjs await`                | `ctx.poll` with a deadline; the observation is the Codex/CI state.                                                                              |
| `workflow('merge-down-pr', …)` (one level of nesting, untyped args)           | `ctx.workflow` with typed input/output; the child's effects share the parent's journal.                                                         |
| Cross-session resume via helper state files (`start.json`, `plan.json`)       | The run journal: resume replays the body and reuses completed effects.                                                                          |
| Model tiers passed per `agent()` call                                         | Named profiles (clerk/scribe/mechanic/planner/skeptic/surgeon) declared once.                                                                   |
| A dedicated worktree managed by the helper                                    | Runtime-owned worktree isolation for the implementer.                                                                                           |
| `until` for dry runs                                                          | Rehearsal: fixtures and `--dry-run`, plus `until` for partial runs.                                                                             |

Open questions for the port, recorded while writing this:

- Survey-and-pick is deterministic, but it depends on live GitHub state. As a durable effect, its
  snapshot is frozen on replay. That is right within a run, but a resumed run must not act on a
  stale "next ticket". The candidate a run started with should be pinned, and its state re-checked
  when the run resumes.
- The planner's verdict branches the workflow five ways. In quiet-choir that is ordinary code over a
  Zod discriminated union, which Codex's structured-output constraints make awkward (#100).
