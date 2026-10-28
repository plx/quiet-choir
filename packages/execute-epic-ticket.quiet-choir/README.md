# execute-epic-ticket.quiet-choir

A quiet-choir [package](../../docs/packages.md) with one workflow, `execute-epic-ticket`, that takes
**one** ticket of an epic from "open issue" to "merged". It is the second dog-food port of a native
Claude Code workflow script ([#590](https://github.com/plx/quiet-choir/issues/590)): it replaces
[`.claude/workflows/execute-epic-ticket.js`](https://github.com/plx/quiet-choir/blob/657334c8b994ba6c0166347c4e61cefef4a54a50/.claude/workflows/execute-epic-ticket.js)
and its helper CLI
[`epic.mjs`](https://github.com/plx/quiet-choir/blob/657334c8b994ba6c0166347c4e61cefef4a54a50/.claude/workflows/execute-epic-ticket/epic.mjs),
whose
[README](https://github.com/plx/quiet-choir/blob/657334c8b994ba6c0166347c4e61cefef4a54a50/.claude/workflows/execute-epic-ticket/README.md)
documents the behavior this port keeps. The native script was removed in
[#693](https://github.com/plx/quiet-choir/issues/693); these links point at its last version on main
(commit 657334c).

It surveys the epic and picks the next ready ticket, checks that the ticket still describes real
work and plans it, implements it in a dedicated worktree, opens a PR, and lands the PR by running
the [merge-down package](../merge-down.quiet-choir/README.md)'s `merge-down-pr` workflow as a typed
inline child. When there is nothing to implement it says why: the epic is done, nothing is ready,
the ticket is obsolete, or a question needs the maintainer.

```
execute-epic-ticket.quiet-choir/
  package.ts                       definePackage: name execute-epic-ticket, entry execute-epic-ticket
  workflows/execute-epic-ticket.ts control flow only; declares merge-down-pr in `children`
  contracts.ts                     input, agent result schemas, step results, the result record
  roster.ts                        the tier map as a roster
  prompts.ts, prompts/             every prompt and multi-line GitHub text as a template
  lib/policy.ts                    pure decision rules (unit-tested in test/execute-epic-ticket-package.test.ts)
  lib/state.ts                     issue.md and epic.md renderers
  lib/git.ts, checks.ts, github.ts start, verify, snapshot, push, check suite, epic edits, labels
  lib/teams.ts                     the ImplementTeam slots
  tsconfig.json                    maps quiet-choir, quiet-choir/github and quiet-choir/std to src/
```

The package imports `quiet-choir`, `quiet-choir/github` and `quiet-choir/std`, and the merge-down
package: its `merge-down-pr` workflow (the landing child), its `MergeDownInput` contract, and its
generic helpers (`plain`, `stripAnsi`, `tail`, `failedStep`, `dirtyTreeLog`, `renderIssue`,
`resolveRepo`, the `run` and `git` command wrappers and `provisionDependencies`). They are compiler
dependencies of this package, so they are fingerprinted with it. Its `tsconfig.json` maps the
quiet-choir specifiers to `../../src` with `paths`, as merge-down's does.

## Run a ticket with the package

From a checkout of this repository (the run's working directory is the repository the epic belongs
to):

```sh
npm ci && npm run build
node bin/run.js configuration doctor
node bin/run.js workflow validate packages/execute-epic-ticket.quiet-choir --json
node bin/run.js workflow execute packages/execute-epic-ticket.quiet-choir \
  --run-id execute-epic-ticket-<EPIC>-<TICKET> --wait-mode block \
  --input '{"epic":<EPIC>,"repo":"plx/quiet-choir","followupEpic":<FOLLOW-UP EPIC>}'
```

- Leave `ticket` out to take the survey's pick; pass it to work on one ticket.
- `--wait-mode block` keeps the landing child's CI and review waits in the process. Without it a
  long wait suspends the run, and `node bin/run.js workflow resume <run-id>` (or `workflow tick`)
  continues it.
- After an interruption, `node bin/run.js workflow resume <run-id>` restarts the body and reuses
  every completed effect: the survey, agent calls, the check suite, the push, the PR and, inside the
  `land/` frame, every completed effect of the child. The survey is frozen within a run, which pins
  the candidate; a new run reads the epic again.
- Read the record with `node bin/run.js workflow inspect <run-id> --json` (the run's `output`). The
  human `inspect` view shows the landing child in its workflow tree as
  `land: merge-down-pr@1 completed`.
- A `blocked`, `stopped`, `needs-decision` or `held` run is complete. Once the cause is handled,
  start a new run (a new `--run-id`): the start step reuses the ticket branch, and filings match
  open issues by exact title, so nothing is redone. A ticket whose PR is open goes straight to the
  landing child.
- A zero-publish rehearsal of a real ticket: the same command with `"until":"plan"` (or
  `"implement"`) and a different run ID. It reads GitHub and plans (and implements on the local
  branch), but pushes, comments, files and merges nothing.

### The opt-in end-to-end landing (#590's verify-on-pr criterion)

The live acceptance run lands one ticket of epic #576 with the package, then this ticket's own PR.
It is opt-in and paid, so nothing runs it in CI. From a checkout of the #590 branch (with the
follow-up epic number the burn-down uses and its standing notes):

```sh
npm ci && npm run build && node bin/run.js configuration doctor
node bin/run.js workflow execute packages/execute-epic-ticket.quiet-choir \
  --run-id execute-epic-ticket-576-591 --wait-mode block \
  --input '{"epic":576,"ticket":591,"repo":"plx/quiet-choir","followupEpic":<FOLLOW-UP EPIC>,"standingNotes":[...]}'
node bin/run.js workflow inspect execute-epic-ticket-576-591
```

Recorded run: `execute-epic-ticket-576-591-b` ended `landed`; it merged #591 as PR #689 (merge
commit `14dbf3e`), and its `workflow inspect` shows `land: merge-down-pr@1 completed`.

`inspect` should show status `completed` with output status `landed`, and the workflow tree line
`land: merge-down-pr@1 completed`. The criterion is met when #591's PR is merged by that run and its
line in #576 is ticked. Then land #590's own PR the same way (it is in flight, so the run goes
straight to the merge-down child):

```sh
node bin/run.js workflow execute packages/execute-epic-ticket.quiet-choir \
  --run-id execute-epic-ticket-576-590 --wait-mode block \
  --input '{"epic":576,"ticket":590,"repo":"plx/quiet-choir","followupEpic":<FOLLOW-UP EPIC>,"standingNotes":[...]}'
```

The child frame's identity includes `merge-down-pr`'s version and input, and the package fingerprint
includes merge-down's sources, so editing either package while a run is unfinished makes the resume
refuse until `--accept-code-change`.

The worktree and state live under `<main checkout>-epic-burndown-package/` by default (`root`
overrides it): `worktree/` and `state/epic-E/issue-N/` (`issue.md`, `epic.md`, `plan.json`, the
check logs and the diff snapshot), plus `state/epic-E/ledger.jsonl`. They differ from the native
script's `-epic-burndown/`, but the branches do not: a ticket's branch is `epic-E/N-<slug>` with the
native slug, and the survey links PRs by that prefix, so a branch or PR either tool made is the same
ticket. The landing child uses `<root>/merge-down` when `root` is given, else its own default root.

## How it works

| Stage     | Who (model / effort)                                                   | What                                                                                                                                                                                                                                                                                                                                                                                                                  |
| --------- | ---------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Survey    | no agent                                                               | `gh.epic.snapshot` with the `epic-E/` head prefix, the states of outside dependencies (an unreadable one counts as open, so only the tickets naming it wait), and `nextTicket` with the native hold labels. In-flight work first, then a finished split, then the first ready ticket; `ticket` pins one. Sub-issue epics only: a task-list epic blocks at survey. An in-flight PR from another repository blocks too. |
| Plan      | `Planner` opus / high (+ `Skeptic` opus / medium)                      | The `start` step prepares the ticket branch in the worktree; the planner decides ready, obsolete, needs-decision, blocked or split. An obsolete verdict closes only if the skeptic agrees, else the ticket is planned again once. A ready plan is saved as `plan.json`.                                                                                                                                               |
| Implement | `ImplementTeam.mechanic` sonnet / high or `.surgeon` opus / high       | The slot by the plan's complexity and size (or `implementer`). The workflow then verifies the report (criteria, commits on the branch, commits of its own, a clean tree) and runs the full suite at that head; a failure gets one follow-up round (the mechanic escalates, the surgeon finishes) with the check log.                                                                                                  |
| Publish   | `Scribe` sonnet / medium ∥ `Scribe` sonnet / medium                    | The PR text from the plan, the report and the diff snapshot, beside the follow-up write-ups, which the workflow files (or matches to an open issue) under the follow-up epic. Push with lease at the checked head, then `pr.create`. In GitHub Codex mode, wait for Codex's first review.                                                                                                                             |
| Land      | [`merge-down-pr`](../merge-down.quiet-choir/README.md), with its tiers | `ctx.workflow('land', mergeDownPr, input)`: review against the ticket, thread triage and fixes, the CI and review gate, the squash-merge and the issue summary, in the `land/` frame.                                                                                                                                                                                                                                 |
| Report    | no agent                                                               | Tick the ticket's checklist line, append the ledger line, and survey again for `remaining` and `next`.                                                                                                                                                                                                                                                                                                                |

Every mechanical step is a durable effect that costs no model call. There is no Clerk, Copyist or
Recopyist and no verified relay. GitHub reads, waits and writes go through `quiet-choir/github`,
except what it lacks: the checklist tick and insert, label writes, the sub-issue link of an issue
found by title, an issue read that answers a 404 with null, and the exact-title lookup are versioned
steps over raw `gh api` in `lib/github.ts`. Git and the check suite run as versioned `ctx.step`
callbacks (`lib/git.ts`, `lib/checks.ts`). Each reads before it writes, so a retry or resume finds
the state the last attempt left: a ticked line is not ticked again, a listed slice is not listed
again, a push that happened is skipped.

Nothing unverified is published. The implementer reports criteria, not `checkPassed` or a head;
`verify` refuses missing reported commits, a branch with no commits of its own and a dirty tree; the
check suite (input `checkCommand`, default `npm run check`, 45-minute deadline, log under the
ticket's state directory) certifies a clean HEAD on the ticket branch only; and `publish` pushes
only the head the suite passed at, from a clean tree on the ticket branch. Every follow-up must be
filed or confirmed open before the PR opens, and an obsolete ticket closes only with the skeptic's
agreement.

## Input

| Field               | Default                                 | Meaning                                                                                                                                                             |
| ------------------- | --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `epic`              | required                                | The epic whose checklist and sub-issues are the tickets.                                                                                                            |
| `ticket`            | none                                    | Work on this ticket instead of the survey's choice.                                                                                                                 |
| `decision`          | none                                    | The maintainer's answer to a `needs-decision` question on `ticket`; posted on the issue (removing the label) before planning.                                       |
| `until`             | `land`                                  | `survey`, `plan`, `implement`, `pr` or `land`. `survey` and `plan` change nothing; `implement` commits only to the local branch.                                    |
| `followupEpic`      | none                                    | Epic for follow-ups; found by title or created on first need, and carried in the result.                                                                            |
| `followupEpicTitle` | `Epic: enhancements, wave 3`            | Title of that epic.                                                                                                                                                 |
| `standingNotes`     | `[]`                                    | Decisions every planner, implementer and landing reviewer applies without re-litigating; also passed to the child.                                                  |
| `maxCandidates`     | 3                                       | Tickets to try when earlier ones turn out blocked by an undeclared dependency.                                                                                      |
| `implementer`       | `auto`                                  | `auto` (by the plan), `mechanic` or `surgeon`.                                                                                                                      |
| `mergeDown`         | `{}`                                    | Overrides for the merge-down child: `root`, `until`, `codex`, `codexMode`, `codexModel`, `codexEffort`, Codex rounds, CI repairs, `checkCommand`, `requiredChecks`. |
| `commitTrailer`     | `''`                                    | Lines every implementation commit message ends with.                                                                                                                |
| `prFooter`          | the Claude Code line                    | Text the PR description ends with.                                                                                                                                  |
| `root`              | `<main checkout>-epic-burndown-package` | Directory for `worktree/` and `state/`.                                                                                                                             |
| `repo`              | the checkout's GitHub repository        | `OWNER/REPO`.                                                                                                                                                       |
| `checkCommand`      | `npm run check`                         | The full check suite, for this run and (unless `mergeDown.checkCommand` says otherwise) for the child.                                                              |
| `toolchain`         | none (npm)                              | The agents' toolchain, passed to the landing child too; see merge-down's [Toolchain](../merge-down.quiet-choir/README.md#toolchain).                                |

The native `tools`, `mergeDownTools` and `mergeDownScript` are gone: the child is imported
statically, and its source is fingerprinted with this package.

## Result

The record keeps the native field names and shape (`EpicTicketResult` in `contracts.ts`): `epic`,
`epicTitle`, `status`, `ticket`, `candidates`, `pr`, `plan`, `implementer`, `landing`, `followups`,
`followupEpic`, `slices`, `decision`, `skipped`, `remaining`, `next`, `headline`, `notes`,
`blocked`, `verifyOnPr` and `deviations`, plus `plannedClose`, `plannedSlices` or `plannedWork` when
`until` stops before publishing. `agents.clerkRuns` is gone with the relay. The statuses are the
native ones:

| Status            | When                                                                                                  |
| ----------------- | ----------------------------------------------------------------------------------------------------- |
| `landed`          | The PR merged through the child and the checklist line is ticked; `next` names the next run's ticket. |
| `pr-open`         | `until: 'pr'`: the PR is open (and, in GitHub Codex mode, reviewed).                                  |
| `closed-obsolete` | Closed with the evidence after the skeptic agreed (`completed` and ticked, or `not_planned`).         |
| `closed-split`    | A split ticket whose slices all closed; closed and ticked.                                            |
| `needs-decision`  | The question is posted with the `needs-decision` label; rerun with `ticket` and `decision`.           |
| `split`           | Slices filed as epic items right after the ticket, with the split marker; the next run takes slice 1. |
| `held`            | `ticket` names a held ticket and no `decision` releases it.                                           |
| `epic-done`       | No open tickets remain.                                                                               |
| `stalled`         | Open tickets remain but none is ready, or every candidate turned out blocked.                         |
| `blocked`         | `blocked: { stage, reason }`; a new run is safe.                                                      |
| `stopped`         | `until` stopped the run, or a named ticket is already closed.                                         |

The native `error` status, its answer to bad arguments, is the input schema's refusal: a `decision`
without a `ticket` or an unknown `until` fails before the run starts.

## Deviations from the native script

- **A dedicated worktree, not `ctx.worktree`.** The ticket branch lives in a persistent worktree at
  `<root>/worktree`, managed by the versioned `start`, `verify` and `publish` steps. `ctx.worktree`
  and effects on its handle fail with a configuration error under `--dry-run`, so the rehearsals
  could not reach Implement or Publish; and a handle belongs to one run and captures fixed-identity
  snapshot commits, so the implementer's own logical commits, per-criterion commit verification and
  a fresh run's reuse of the branch would be lost. merge-down made the same choice.
- **The workflow runs the suite.** Implementers run focused checks and report criteria; the workflow
  verifies the branch and runs `checkCommand` as one step. The native `check-start`/`check-wait`
  workaround for the shell's 10-minute limit, and the implementer's `checkPassed` and `head`, are
  gone. A failing suite is the unfinished work the one follow-up round gets, with its log.
- **No relay.** Every `epic.mjs` subcommand is a durable step or a `quiet-choir/github` call.
- **Raw `gh api` mechanics** for what `quiet-choir/github` lacks: the checklist tick and the slice
  insert (check-then-act on the epic body; an edit between the read and the PATCH is overwritten,
  the caveat of #668), label ensure, add and remove (a missing label on removal is success), and the
  sub-issue link (`addSubIssue` after a parent read; an issue under another parent is never moved).
- **Title lookup before filing.** `issue.create` reconciles only by its run-scoped marker, so a run
  restarted with a new run ID could file again; every slice, follow-up and the follow-up epic is
  first looked up by exact title among open issues, as the native helper filed: among the parent's
  open sub-issues (the epic's from the survey for a slice, the follow-up epic's for a follow-up),
  then by an exact-title search, then, since the search index lags a just-filed issue, among the 100
  newest open issues listed without a search, which is what the native helper's title-to-number
  records covered. A slice or follow-up found that way is linked as a sub-issue of its epic, since
  an interrupted run may have filed it before the link; a slice that already belongs to another
  parent blocks the split, and such a follow-up is kept where it is.
- **needs-decision stays a return-and-rerun** with `ticket` and `decision`, the native output
  contract, rather than `ctx.ask`: the burn-down orchestrator acts on the returned statuses.
- **An in-flight ticket with `until` short of `pr`** stops (`would land it`) instead of landing, and
  a named ticket that is already closed stops instead of blocking at the survey.
- **The PR body** is normalized as the native `open-pr` did (closing keywords for other issues,
  bare, qualified or as issue URLs, become `Refs`; `Closes #N` and `Part of #E` added when missing),
  and the filed follow-ups are listed from a template before the footer.
- **Slices** are filed as sub-issues of the epic with `issue.create` (an issue found by title is
  reused and linked to the epic), then one checklist step lists them after the parent.

## Known limitations

- Only epics with native sub-issues are surveyed. For a task-list epic `gh.epic.snapshot` has only
  the checkboxes (no labels, dependencies, split markers or issue states), so selecting from it
  would bypass the held, waiting and closed checks; the run blocks at survey instead. Attach the
  tickets as sub-issues.

- One root serves one unfinished run at a time: every run checks out its ticket's branch in the same
  `worktree/`. The check suite and the push refuse a worktree that is not on the ticket branch, but
  an agent is not probed before it edits the worktree (merge-down's `ownedAgent` is keyed by PR).
  Give runs that must interleave distinct `root`s.
- The start step refuses a ticket branch checked out in another worktree, which is what the native
  script's worktree does with a branch it started; check something else out there first. It also
  refuses a local ticket branch that lacks commits its `origin` branch has, rather than taking that
  tip as the push lease; pull or reconcile them first. The workflow's own rebase of a pushed branch
  is recognised (the branch's reflog held the old tip, or each remote commit has a patch-equivalent
  local one), and that tip stays the lease the push forces over. A ticket branch deleted on `origin`
  is pruned from the scoped fetch, so it is pushed afresh with no lease.
- Claude Code runs headless with the roster's `allowedTools` shell patterns (or a `toolchain`'s); a
  command a prompt does not anticipate is denied. The Situation fragment lists exactly what the
  roster allows. The roster limits can be raised on resume with `--profile Surgeon.maxTurns=…`.
- The landing child keeps merge-down's own limitations (its README lists them, for example #665's
  cancelled duplicate CI runs).

## Rehearsal

```sh
npm run build && npm run packages:rehearse
```

[`scripts/rehearse-packages.mjs`](../../scripts/rehearse-packages.mjs) validates every package in
its table and checks its `package` section (for this one: name and entry `execute-epic-ticket`, the
roster `Mechanic`, `Planner`, `Scribe`, `Skeptic` and `Surgeon` on claude, and the package's own
prompt names), refuses raw harness calls in the package and any multi-line literal in `workflows/`,
and rehearses the cases in
[`packages/rehearsals/execute-epic-ticket/`](../rehearsals/execute-epic-ticket) with
`execute --dry-run --harness fixture:<case>.fixtures.json`: `ready-landed` (plan, implement with a
verify-on-pr criterion and a follow-up, publish, then the merge-down child landing from merge-down's
clean-land rules under `land/`, and the report), `obsolete-closed` (the skeptic agrees; close and
tick), `needs-decision` (comment, ensure and add the label), `split` (two slices filed, the second
depending on the first, the checklist insert and the split marker), `epic-done`, `stalled`,
`task-list` (a task-list epic blocks at survey) and `unreadable-outside` (a dependency that 404s
counts as open, and an unrelated ready ticket is still picked). Every agent call and command is
answered by the fixtures (`"commands": "fixture"`) and no rule may go unused. For `ready-landed` the
script also requires the run record's `land` frame of `merge-down-pr` to be completed, and the
summary that `workflow inspect` prints (`summarizeRun` and `formatRunSummary` from `dist/`) to show
`land: merge-down-pr@1 completed`. It runs in `npm run check` and in the Package rehearsals CI job.

## Measurements

Measured on this branch with the commands below, against the native originals at commit 657334c.

| Measure                                                  | Package                                                      | Native                                                                                       |
| -------------------------------------------------------- | ------------------------------------------------------------ | -------------------------------------------------------------------------------------------- |
| Total lines (package without README; script plus helper) | 3,604 in 26 files                                            | 3,065 (execute-epic-ticket.js 1,371 + epic.mjs 1,694); rehearse.mjs adds 1,184               |
| Prompt prose                                             | 279 lines, 16.4 KB in prompts/\*\*/\*.md                     | 9 multi-line template literals, 92 lines, 11.5 KB in the script                              |
| Control flow                                             | 1,010 lines in workflows/                                    | the whole 1,371-line script                                                                  |
| Mechanics                                                | 1,698 lines in lib/ (568 of them pure policy)                | 1,694 lines in epic.mjs                                                                      |
| Agent call sites                                         | 6 roster or team-slot calls                                  | 6 judgment `agent(` calls + 22 clerk relay calls (one `agent(` site)                         |
| Model calls per mechanical step                          | 0                                                            | 1 haiku clerk (a sonnet copyist for the survey and report), plus a re-read on a failed relay |
| Rehearsal                                                | 8 cases in packages/rehearsals/ (JSON) and the shared script | rehearse.mjs, 1,184 lines                                                                    |

```sh
find packages/execute-epic-ticket.quiet-choir -type f ! -name README.md -print0 | xargs -0 cat | wc -l
find packages/execute-epic-ticket.quiet-choir -type f ! -name README.md | wc -l
find packages/execute-epic-ticket.quiet-choir/prompts -name '*.md' -print0 | xargs -0 cat | wc -lc
cat packages/execute-epic-ticket.quiet-choir/workflows/*.ts | wc -l
cat packages/execute-epic-ticket.quiet-choir/lib/*.ts | wc -l
wc -l packages/execute-epic-ticket.quiet-choir/lib/policy.ts
grep -nE '\.value\(' packages/execute-epic-ticket.quiet-choir/workflows/*.ts
git show 657334c8b994ba6c0166347c4e61cefef4a54a50:.claude/workflows/execute-epic-ticket.js | wc -l
git show 657334c8b994ba6c0166347c4e61cefef4a54a50:.claude/workflows/execute-epic-ticket/epic.mjs | wc -l
git show 657334c8b994ba6c0166347c4e61cefef4a54a50:.claude/workflows/execute-epic-ticket/rehearse.mjs | wc -l
git show 657334c8b994ba6c0166347c4e61cefef4a54a50:.claude/workflows/execute-epic-ticket.js | grep -n 'agent('
git show 657334c8b994ba6c0166347c4e61cefef4a54a50:.claude/workflows/execute-epic-ticket.js | grep -nE 'await (clerk|one)\('
```

The prose figures count bytes in thousands. The script's template literals were measured as
merge-down's were, with the TypeScript parser: every template literal whose source spans more than
one line, with its substitutions.

The package is about 18% longer than the native pair, and much of `lib/` is reused rather than
written: the command wrappers, dependency provisioning, the check-log helpers and the issue renderer
come from the merge-down package. The relay protocol is gone; the port spells out what the native
JavaScript left implicit: Zod contracts for every agent and step result and the record (358 lines in
`contracts.ts`), typed prompt parameters (125 lines in `prompts.ts`), the roster's tools and limits,
versioned step definitions, and Prettier's formatting of typed TypeScript. The prose grew by the
GitHub texts that were string literals in the script (the decision, split and close-split comments,
the follow-up epic body and section) and by the headless shell rules every agent now reads.

## API follow-ups

Awkwardness met in the port, filed with this change under the follow-up epic, or extending existing
issues:

| Gap                                                                                                     | ADR       | Issue          |
| ------------------------------------------------------------------------------------------------------- | --------- | -------------- |
| `ctx.worktree` cannot be rehearsed under `--dry-run`, and a handle cannot adopt a branch across runs    | 0063      | #681           |
| `quiet-choir/github` has no label writes (ensure, add, remove)                                          | 0046      | #682           |
| `quiet-choir/github` has no sub-issue link write for an issue it did not file                           | 0046      | not filed yet  |
| `issue.create` reconciles only by a run-scoped marker, so a fresh run refiles without a title lookup    | 0046      | #683           |
| `nextTicket` has no preferred-ticket option (the native `--prefer`)                                     | 0048      | #684           |
| Package mechanics (command wrappers, the check-suite runner) are imported across packages, not in `std` | 0063/0065 | #685; see #671 |
| The dry-run rehearsal report has no `RunSummary`, so the rehearsal renders it from `dist/`              | 0065      | #686           |
| Epic body edits (checklist tick and insert-after) need an `issue.edit` with a conditional body update   | 0046/0047 | #668           |
