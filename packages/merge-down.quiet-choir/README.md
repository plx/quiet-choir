# merge-down.quiet-choir

A quiet-choir [package](../../docs/packages.md) with one workflow, `merge-down-pr`, that lands
**one** pull request the way a careful maintainer would. It is the first dog-food port of a native
Claude Code workflow script ([#589](https://github.com/plx/quiet-choir/issues/589)): it replaces
[`.claude/workflows/merge-down-pr.js`](../../.claude/workflows/merge-down-pr.js) and its helper CLI
[`merge-down.mjs`](../../.claude/workflows/merge-down-pr/merge-down.mjs), whose
[README](../../.claude/workflows/merge-down-pr/README.md) documents the behavior this port keeps.
The native script stays as the fallback.

It rebases the PR onto the default branch in a dedicated worktree, reviews it against its issue
(with a local `codex review`), triages its review threads, fixes what is in scope, files follow-ups
for what is not, gates on CI and the reviewers, squash-merges at the gated head, and records what
happened on the issue.

```
merge-down.quiet-choir/
  package.ts               definePackage: name merge-down, entry merge-down-pr
  workflows/merge-down-pr.ts   control flow only
  contracts.ts             input, agent result schemas, the ledger record
  roster.ts                the tier map as a roster
  prompts.ts, prompts/     every prompt as a markdown template; _fragments/ for shared text
  lib/policy.ts            pure decision rules (unit-tested in test/merge-down-package.test.ts)
  lib/prepare.ts           GitHub reads and the state files
  lib/git.ts, checks.ts, codex.ts   git, check-suite and local-review mechanics as durable steps
  lib/teams.ts             FixTeam and ResolveTeam slots
  tsconfig.json            maps quiet-choir, quiet-choir/github and quiet-choir/std to src/
```

The package imports only `quiet-choir`, `quiet-choir/github` and `quiet-choir/std`. Its
`tsconfig.json` maps those specifiers to `../../src` with `paths`, so lint and typecheck work before
a build (CI lints first). The CLI type-checks and loads the package with that tsconfig; a copy of
the package outside this repository would drop the mapping and resolve the installed `quiet-choir`.

## Land a PR with the package

From a checkout of this repository (the run's working directory is the repository the PR belongs
to):

```sh
npm ci && npm run build
node bin/run.js configuration doctor
node bin/run.js workflow validate packages/merge-down.quiet-choir --json
node bin/run.js workflow execute packages/merge-down.quiet-choir \
  --run-id merge-down-pr-<PR> --wait-mode block \
  --input '{"pr":<PR>,"repo":"plx/quiet-choir","parentEpic":576}'
```

- Add `standingNotes` (an array of strings) or `followupEpic` to the input as a stack walk needs.
  The first follow-up creates the follow-up epic; pass the result's `followupEpic` to later runs.
- `--wait-mode block` keeps the CI and review waits in the process. Without it a long wait suspends
  the run, and `node bin/run.js workflow resume merge-down-pr-<PR>` (or `workflow tick`) continues
  it.
- After an interruption, `node bin/run.js workflow resume merge-down-pr-<PR>` restarts the body and
  reuses every completed effect: reads, agent calls, the check suite, pushes and writes.
- Read the ledger record with `node bin/run.js workflow inspect merge-down-pr-<PR> --json` (the
  run's `output`).
- A zero-publish rehearsal of a real PR: the same command with `"until":"review"` in the input and a
  different run ID. It reads GitHub and runs the reviewer and the local check suite and Codex
  review, but pushes, comments, files and merges nothing.
- Only same-repository PRs land: the gate pushes to `origin`, so a PR whose head is in a fork (or a
  deleted one) is `blocked` at `prepare` before the sync touches the worktree, and a sync that finds
  `origin/<head branch>` at another head than Prepare read blocks at `rebase`.
- A `blocked`, `stopped` or `deferred` run is complete. Once the cause is handled, start a new run
  (a new `--run-id`): every step re-reads GitHub and git state, as the native script's re-runs do.

The worktree and state live under `<main checkout>-merge-down-package/` by default (`root` overrides
it): `worktree/` and `state/pr-N/`. The local branch is `merge-down/package/pr-N`. Both differ from
the native script's (`-merge-down/`, `merge-down/pr-N`), so falling back to `merge-down-pr.js` never
collides with a package run. The fork-point refs (`refs/merge-down/fork-point/<pr>`) are
deliberately shared, so a stack recorded by either tool is honored by both.

One root serves one unfinished run at a time: every run checks out its own PR's branch in the same
`worktree/`. A run resumed after another PR's run used the root finds that branch checked out, and
blocks (`worktree belongs to another run`) instead of working there: each fix round and check suite,
and the push, first checks that the worktree is on `merge-down/package/pr-N`, and the push also
checks that the head it publishes descends from the head this run synced. Restart such a run with a
new `--run-id`, or give runs that must interleave distinct `root`s.

## How it works

| Stage   | Who (model / effort)                                                                  | What                                                                                                                                                                                                                                                                |
| ------- | ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Prepare | no agent                                                                              | GitHub reads (PR, issue, parent, children, stack, threads, alerts) into `state/pr-N/`; the `sync` step checks out the PR and rebases it, recording fork points first.                                                                                               |
| Rebase  | `Surgeon` opus / high (`Mechanic` sonnet / high for Dependabot)                       | Only on conflicts, through the `ResolveTeam.resolver` slot; the `snapshot` step then verifies that no rebase is in progress and that the PR's commits survived.                                                                                                     |
| Review  | `Reviewer` opus / medium → `Judge` opus / xhigh                                       | In parallel: the `check-0` suite, the change review (or the dependency review, by `Reviewer` for a major bump, else `Mechanic`) and the first local Codex review, triaged by `Reviewer`. Escalation on the native reasons.                                          |
| Fix     | `FixTeam.mechanic` sonnet / high or `.surgeon` opus / high ∥ `Scribe` sonnet / medium | The slot by complexity; the workflow verifies the reported commits and runs the suite at the new head, with one surgeon repair on failure. The scribe drafts follow-ups and the workflow files them.                                                                |
| Gate    | no agent (`Reviewer` triages new threads)                                             | Retarget stacked PRs, push with lease, confirm GitHub sees the head, fix the closing keyword, reply to and resolve threads, dismiss settled alerts; then CI ∥ reviewers ∥ a local Codex review of the head; loop on findings or red CI.                             |
| Land    | no agent                                                                              | CI re-read at landing (a fresh wait on the gated head); the `land/merge` step rereads the guards (open, head, base, CI, unanswered threads, open alerts) and squash-merges at the gated SHA; the issue closed or reopened, children read, the local branch deleted. |
| Report  | `Scribe` sonnet / medium                                                              | Drafts the issue summary and headline; the workflow posts the comment.                                                                                                                                                                                              |

Every mechanical step is a durable effect that costs no model call. There is no Clerk or Copyist and
no verified relay: no nonces, FNV hashes or saved `last/` outputs. GitHub reads, waits and writes go
through `quiet-choir/github`, except the merge; git, the check suite and the merge run as versioned
`ctx.step` callbacks (`lib/git.ts`, `lib/checks.ts`, `lib/land.ts`) that read before they write, so
a step retried after a crash finds the state the last attempt left (a push that already happened is
skipped, fork points are never overwritten, leftovers of a crashed rebase are reset, a PR already
merged at the gated head is reported merged). Agents never write to GitHub.

The land guards and the merge are one step, `land/merge` (`merge-down.land/2`), rather than
checkpointed reads followed by `pr.merge`: a resume reuses completed reads, so a merge attempt that
failed after them would otherwise be retried on stale guards. Every attempt of the step, a retry's
(up to three on a process failure or timeout) or a resumed run's, reads the PR's state, head and
base, its CI rollup (which must be the gated head's; pending or failed checks, or a missing required
check, block), the unresolved threads whose last comment is not the viewer's and the open
code-scanning alerts, and only then issues the REST merge (`PUT pulls/N/merge` with `sha` set to the
gated head; never auto-merge or a merge queue). A guard that fails, or a merge GitHub refuses, is
`blocked` at `land`.

The check suite runs inside the workflow (input `checkCommand`, default `npm run check`, with
`npm ci` when package.json or the lockfile changed) as one step with a 45-minute deadline. Its
output goes to `state/pr-N/<label>.log`; the step returns a small verdict pinned to its head. Fixers
run focused checks only; no head is published without a passing suite at that exact head. The suite
certifies a clean HEAD only: a worktree with uncommitted or untracked changes (a fixer's unfinished
edit, or one an interrupted attempt left) fails as `dirty worktree` without running the suite, with
the changes listed in the log and excerpt so the repair commits or discards them, and a HEAD that
moves while the suite runs fails as `HEAD moved`.

The local Codex review is a command effect, not an agent call:
`codex review --base origin/<default>` with the native `-c model`, `review_model`,
`sandbox_mode="workspace-write"` and effort settings, in a throwaway worktree at the reviewed SHA
under `state/pr-N/review-<sha12>` (dependencies cloned copy-on-write when package.json and the
lockfile match, else `npm ci`), with a 54-minute deadline, and removed in a `finally`, after a
failed setup too. Its IDs are keyed by round, SHA, model and effort, so a resume reuses a finished
review; the runtime's process lifecycle replaces the native start, wait, stop and reap subcommands.
Tags are counted in pure code.

## Input

| Field                | Default                              | Meaning                                                                                              |
| -------------------- | ------------------------------------ | ---------------------------------------------------------------------------------------------------- |
| `pr`                 | required                             | The PR to land.                                                                                      |
| `repo`               | the checkout's GitHub repository     | `OWNER/REPO`.                                                                                        |
| `root`               | `<main checkout>-merge-down-package` | Directory for `worktree/` and `state/`.                                                              |
| `until`              | `merge`                              | `prepare`, `review`, `fix` or `merge`. Anything before `merge` publishes nothing.                    |
| `codex`              | `auto`                               | `auto`, `always` or `never`, as natively.                                                            |
| `codexMode`          | `local`                              | `local` (`codex review`) or `github` (comment `@codex review` and wait for the Codex app).           |
| `codexModel`         | `gpt-6-astra`                        | Model of the local review (`model` and `review_model`).                                              |
| `codexEffort`        | Codex's configuration                | Reasoning effort of the local review.                                                                |
| `maxCodexRounds`     | 3                                    | Base number of Codex re-reviews; past it only while the latest round found a valid major or blocker. |
| `codexRoundsHardCap` | 5                                    | Upper bound on Codex re-reviews; the gate also stops after `codexRoundsHardCap + 3` rounds.          |
| `maxCiRepairs`       | 2                                    | CI repair attempts.                                                                                  |
| `followupEpic`       | none                                 | Epic that follow-ups attach to; created on first use.                                                |
| `followupEpicTitle`  | `Epic: initial enhancements, wave 2` | Title of a new follow-up epic.                                                                       |
| `parentEpic`         | none                                 | Epic the landed issues belong to.                                                                    |
| `standingNotes`      | `[]`                                 | Decisions every reviewer, resolver and fixer applies without re-litigating.                          |
| `checkCommand`       | `npm run check`                      | The local check suite.                                                                               |
| `requiredChecks`     | `[]`                                 | CI check names that must register before a green rollup counts; one that never does blocks the gate. |

## Result

The ledger record keeps the native field names and shape (`MergeDownResult` in `contracts.ts`):
`status`, `pr`, `url`, `title`, `kind`, `issue`, `mergeCommit`, `rebase`, `review`, `threads`,
`codexReviewsRequested`, `codexMode`, `localReviews`, `codexFindings`, `rounds`, `ciRepairs`,
`followups`, `followupEpic`, `summaryCommentUrl`, `headline`, `notes` and `blocked`, plus
`children`, `dependency`, `fixes`, `fixNotes`, `triageNotes`, `deferredFindings` and `flakyChecks`
when they apply. `agents.clerkRuns` is gone with the relay.

| Status     | When                                                                                                               |
| ---------- | ------------------------------------------------------------------------------------------------------------------ |
| `merged`   | Squash-merged at the gated head.                                                                                   |
| `closed`   | A Dependabot PR closed with an `@dependabot ignore` comment.                                                       |
| `deferred` | A Dependabot PR that needs a real migration.                                                                       |
| `blocked`  | `blocked: { stage, reason }`; the PR is left open.                                                                 |
| `stopped`  | `until` stopped the run: `prepared`; `review`, `check`, `plannedWork`; `review`, `plannedReplies`; `plannedClose`. |
| `skipped`  | The PR is not open.                                                                                                |

The native `error` status, its answer to bad arguments, is the input schema's refusal here: an
invalid input fails before the run starts.

## Deviations from the native script

- **No relay.** Every `merge-down.mjs` subcommand is a durable step or a `quiet-choir/github` call;
  the clerk and copyist tiers are gone.
- **The workflow runs the suite.** Fixers report items and notes, not `checkPassed`; the workflow
  verifies their commits and runs the suite at the new head, and a failure gets one repair
  (mechanic, then surgeon) with the log path.
- **The scribe drafts, the workflow files.** Follow-ups are structured drafts filed with
  `issue.create` under the follow-up epic (or a comment on the duplicate); the report scribe returns
  the comment and the workflow posts it.
- **Dependency PRs** are recognized by a `dependabot/` head branch, because `pr.view` returns no
  author. A Dependabot PR that does not close itself within 90 s of its closing comment is `blocked`
  at `close` (there is no `pr.close` write), as is one merged instead of closed meanwhile (its merge
  commit in `mergeCommit`).
- **The follow-up epic** gets sub-issues but no checklist line (there is no `issue.edit` write).
- **Closing links** are confirmed by a bounded poll; the native script's re-save of the body after a
  retarget is not repeated. A missing link is a note, and land closes the issue explicitly.
- **A retarget with nothing to push** leaves CI as it ran against the old base, since only the push
  restarts it; the ledger notes this, which explains a required check that never registers.
- **Stale heads.** Before the waits, a poll confirms GitHub reports the pushed head, because the
  waits accept only an ancestor as a stale view, not the head a rebase push leased against.
- **Codex in `github` mode** counts as having reviewed when a Codex thread exists; the summary-row
  and reaction history the native helper read is the `codexReviewer` wait's business now.
- **Thread replies and alert dismissals** that fail fail the run (resumable; the writes are
  reconciled) instead of becoming a ledger note.
- **Mechanics that fail** (`sync` aside) settle into `blocked`; `sync` and the GitHub reads throw,
  so a transient failure leaves a resumable run.

## Known limitations

- `summarizeChecks` counts every run of a check in the rollup, including a run that a concurrency
  group cancelled for a newer duplicate, as the native script did before #645. This repository's CI
  uses `cancel-in-progress`, so a live gate can read a cancelled duplicate as a failure and spend a
  repair round or block. Filed as #665; not reimplemented here.
- Claude Code runs headless with the roster's `allowedTools` shell patterns; a command a prompt does
  not anticipate is denied rather than prompted. The roster limits (for example `Surgeon` at 200
  turns, USD 25 and two hours) can be raised on resume with `--profile Surgeon.maxTurns=…`.
- `HOST/OWNER/REPO` (GitHub Enterprise) is not supported by the few raw `gh api` reads in
  `lib/prepare.ts` and the polls.

## Rehearsal

```sh
npm run build && npm run packages:rehearse
```

[`scripts/rehearse-packages.mjs`](../../scripts/rehearse-packages.mjs) validates the package and
checks its `package` section, refuses `ctx.claude`, `ctx.codex` and `ctx.agent(` in the package and
any multi-line literal in `workflows/`, and rehearses the cases in
[`packages/rehearsals/merge-down/`](../rehearsals/merge-down) (kept outside the package root, which
is fingerprinted) with `execute --dry-run --harness fixture:<case>.fixtures.json`: `clean-land` (a
stacked PR retargeted to `main` with nothing to push, noted, merged in round 1), `fix-round` (a
stacked PR retargeted before the push, a Codex thread fixed with a commit and replied to, a new
thread that only the gate's refresh read after CI sees triaged, merged in round 2), `stop-at-fix`
(`until: fix`, with the planned `Addressed in` reply), `dirty-fix` (the fixer leaves uncommitted
edits, so its check fails as `dirty worktree` and the surgeon's repair is checked instead),
`blocked-gate` (red CI, a rerun that fails again, `maxCiRepairs: 0`), `rerun-reconciled` (red CI
whose failed jobs were already re-run: the gate still waits, records the flake and calls no fixer),
`land-red-ci` (the gate sees green CI but the land-time wait sees red: blocked at `land`, no merge),
`fork-head` (a PR whose head is in a fork: blocked at `prepare` before any git command or push) and
`land-retry` (the first merge attempt passes its guards but its PUT fails; the retry rereads them,
finds a new unanswered thread and blocks at `land` without a second PUT). Every agent call and
command is answered by its fixtures (`"commands": "fixture"`), no rule may go unused, no command may
fail except the simulations a case lists in `failures`, and a case's `order` lists steps that must
start in that order (the retarget before the push). It runs in `npm run check` and in the Package
rehearsals CI job.

## Measurements

Measured on this branch with the commands below, against the native originals.

| Measure                                                  | Package                                       | Native                                                               |
| -------------------------------------------------------- | --------------------------------------------- | -------------------------------------------------------------------- |
| Total lines (package without README; script plus helper) | 4,576 in 28 files                             | 3,377 (merge-down-pr.js 1,552 + merge-down.mjs 1,825)                |
| Prompt prose                                             | 355 lines, 21.9 KB in prompts/\*\*/\*.md      | 12 multi-line template literals, 139 lines, 19.2 KB in the script    |
| Control flow                                             | 1,351 lines in workflows/                     | the whole 1,552-line script                                          |
| Mechanics                                                | 2,191 lines in lib/ (623 of them pure policy) | 1,825 lines in merge-down.mjs                                        |
| Agent call sites                                         | 9 roster or team-slot calls                   | 9 judgment `agent(` calls + 13 clerk relay calls (one `agent(` site) |
| Model calls per mechanical step                          | 0                                             | 1 haiku clerk, plus a sonnet copyist on a failed relay               |

```sh
find packages/merge-down.quiet-choir -type f ! -name README.md -print0 | xargs -0 cat | wc -l
find packages/merge-down.quiet-choir/prompts -name '*.md' -print0 | xargs -0 cat | wc -l
cat packages/merge-down.quiet-choir/workflows/*.ts | wc -l
cat packages/merge-down.quiet-choir/lib/*.ts | wc -l
grep -nE '\.value\(' packages/merge-down.quiet-choir/workflows/*.ts
wc -l .claude/workflows/merge-down-pr.js .claude/workflows/merge-down-pr/merge-down.mjs
grep -n 'agent(' .claude/workflows/merge-down-pr.js
grep -nE 'clerk\(' .claude/workflows/merge-down-pr.js
```

The package is about 36% longer than the native pair. The relay protocol is gone, but the port
spells out what the native JavaScript left implicit: Zod contracts for every agent result and the
ledger (384 lines in `contracts.ts`), typed prompt parameters (161 lines in `prompts.ts`), the
roster's tools and limits, versioned step definitions, and Prettier's 100-column formatting of typed
TypeScript. The prose moved out of the control flow nearly unchanged in size.

## API follow-ups

Awkwardness met in the port, filed against the ADRs rather than worked around here, under the
follow-up epic #594:

| Gap                                                                                       | ADR       | Issue |
| ----------------------------------------------------------------------------------------- | --------- | ----- |
| `summarizeChecks` counts cancelled duplicate runs and superseded attempts of a check      | 0045      | #665  |
| Waits accept only an ancestor as a stale head, not the head a rebase push leased against  | 0045      | #666  |
| `pr.view` returns no author, so a Dependabot PR is recognized by its branch               | 0044      | #667  |
| No `issue.edit` (follow-up epic checklist) and no `pr.close` (Dependabot close fallback)  | 0046/0047 | #668  |
| No timeline read, and `issue.view` cannot tell an issue from a pull request number        | 0044      | #669  |
| The Codex harness has no review mode, so `codex review` is a command effect               | 0063      | #670  |
| `std` has no shell-capable roster fragment and no limits sized for long fix rounds        | 0063      | #671  |
| `identity: 'version'` is internal, but package mechanics need source-independent identity | 0063/0065 | #672  |
| Wall-clock settle windows in waits cannot be rehearsed (CodeQL settle, `graceMs`)         | 0045      | #673  |
| Nothing keeps formatters off a package's prompt templates                                 | 0064/0065 | #674  |
| Fixtures for multi-read waits must spell full GraphQL argv                                | 0065      | #675  |
