# GitHub reads, waits and writes

`quiet-choir/github` gives a workflow typed GitHub reads, waits and writes over the installed `gh`
CLI. Each read is exactly one durable `ctx.exec.json` with an ID you choose, so it checkpoints,
replays and rehearses like any other command. A read never returns a silently truncated list: when
GitHub reports another page that the read did not fetch, it throws `IncompleteCollectionError`. Each
[wait](#waits) for CI, reviews or a merge is exactly one `ctx.poll`, pinned to a head SHA. Each
[write](#writes) (a comment, a thread reply, an issue created, closed or reopened, an alert
dismissed, a pull request created, edited or merged, failed workflow runs rerun) is exactly one
`ctx.step` that reads before it writes, so a rerun after a crash finds the earlier attempt's write
instead of repeating it, and a merge happens only at the head SHA you name. The designs are recorded
in [ADR 0044](decisions/0044-gh-backed-github-reads.md),
[ADR 0045](decisions/0045-head-pinned-github-waits.md),
[ADR 0046](decisions/0046-reconciled-github-writes.md) and
[ADR 0047](decisions/0047-pull-request-writes-and-head-pinned-merge.md).

Epic selection is planned separately (#163).

## Install and authenticate

Install [gh](https://cli.github.com/) and sign in with `gh auth login` (add `--hostname HOST` for
GitHub Enterprise Server). quiet-choir never handles a token: every gh command inherits your
environment, so `gh`'s own login, `GH_TOKEN` or `GH_HOST` apply as they do in your shell, and
nothing secret enters argv, an environment overlay or the checkpoint. The reads need a `gh` whose
`gh api` supports `--paginate --slurp` (see `gh api --help`); they were developed against gh 2.100.

```ts
import { defineWorkflow, z } from 'quiet-choir';
import { github } from 'quiet-choir/github';

export default defineWorkflow({
  name: 'pr-checks',
  version: '1',
  input: z.object({ repo: z.string(), pr: z.int().positive() }),
  output: z.string(),
  async run(ctx, input) {
    const gh = github(ctx, { repo: input.repo });
    const pr = await gh.pr.view(ctx.id('pr', input.pr), { number: input.pr });
    return pr.checks.state;
  },
});
```

`repo` is `OWNER/REPO`, or `HOST/OWNER/REPO` for an Enterprise host, which adds `--hostname HOST`
right after `gh api`. Owner and name may use letters, digits, `.`, `_` and `-` and must not start
with `-`; anything else throws when `github(ctx, { repo })` is called. `parseGithubRepo` exposes the
same parser.

## Reads

Every read takes `(id, args, policy?)` and runs `gh api`, either GraphQL or REST. gh's `--json`
output for `pr view` or `pr list` hides nested page information, so the reads never use it.

| Read                                       | Command                                                         | Result                                                                                                                                                                                                        |
| ------------------------------------------ | --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `repo.info(id)`                            | `gh api graphql`                                                | `{ host, owner, name, nameWithOwner, defaultBranch, isPrivate, viewer, viewerPermission }`                                                                                                                    |
| `pr.view(id, { number })`                  | `gh api graphql`                                                | Title, URL, body, state, draft, `mergeable`, `mergeStateStatus`, head SHA and branches, `closingIssues` (number and repository) and `checks` for the head commit                                              |
| `pr.list(id, { head?, base?, state? })`    | `gh api graphql --paginate --slurp`                             | Every matching pull request (number, title, state, draft, branches, head SHA, URL, body), sorted by number. `state` is `open` (default), `closed`, `merged` or `all`                                          |
| `pr.reviewThreads(id, { number })`         | `gh api graphql --paginate --slurp`                             | Every thread with every comment: `id`, `isResolved`, `isOutdated`, `path`, `line` (current, else original), `author`, `isBot`, `lastAuthor`, the first comment's `alert`, `priority` badge, `title` and `url` |
| `issue.view(id, { number, comments? })`    | `gh api graphql`, paginated over comments with `comments: true` | Number, title, state, body, URL, author and labels, plus every comment with `comments: true`                                                                                                                  |
| `codeScanning.alerts(id, { ref, state? })` | `gh api --paginate repos/O/R/code-scanning/alerts?...`          | `{ status: 'ok', alerts }` with number, rule, severity, path, line, message, state and URL; or `{ status: 'unavailable', reason, alerts: [] }`                                                                |

`checks` follows one set of rules, exported as `summarizeChecks`: a commit status passes when
`SUCCESS`, is pending when `PENDING` or `EXPECTED`, and fails otherwise; a check run is pending
until `COMPLETED`, then passes when its conclusion is `SUCCESS`, `NEUTRAL` or `SKIPPED`, and fails
otherwise. `checks.state` is `none`, `pending` (any pending), `failure` (any failed) or `success`,
and each item keeps GitHub's state string and, for an Actions check, the workflow run ID for
`gh run`. A deleted account is reported as `ghost`. A pull request number passed to `issue.view`
makes gh exit 1, so the read rejects.

The response schemas (`pullRequestViewResponseSchema`, `reviewThreadsResponseSchema` and so on) and
their `Raw*` types are exported too, for fixtures and for code that wants the raw shape.

## Occurrence IDs

A read is a memoized snapshot, not a live view:

- A completed read replays forever under its ID, on every resume, without running gh.
- To observe new state, use a fresh occurrence ID, for example one keyed by round or by head SHA
  (`ctx.id('threads', pr, headSha)`), or wait for it with one of the [waits](#waits).
- IDs inside a loop must be unique per iteration; the durability lint reports a literal ID in a loop
  (QC005).
- Reads are at least once and safe to repeat: a read that failed or never finished runs again on
  resume.

## Failures

- **Truncated collections.** A read checks every connection it requests. When the last page of a
  paginated connection, or any nested connection (a thread's comments, closing issues, check
  contexts, labels), reports another page, the read throws `IncompleteCollectionError`. Its
  `connection` names the connection (for example `pullRequest.reviewThreads[PRRT_x].comments`),
  `stepId` the read's ID, and `cause` the underlying schema `ExecError`. The check runs inside the
  exec's schema, so the read is never checkpointed as completed, the run's root cause names the
  read, and a resume runs it again.
- **Code scanning not set up.** gh exits 1 on an HTTP error and prints GitHub's error body. The
  code-scanning read accepts exit 1 only when stdout is that body alone and says code scanning is
  not enabled, has no analysis, or needs Advanced Security; it then completes with
  `status: 'unavailable'`, which replays as data. "No alerts" is `status: 'ok'` with an empty list.
- **Everything else rejects.** Not Found, bad credentials, a GraphQL error, an error page after
  alerts, an empty stdout from a network failure, a timeout or any other exit code rejects with an
  `ExecError`; nothing is settled, so a resume retries the read.
- **Code scanning skips `--slurp`.** With `--slurp`, gh closes its outer array even when a later
  page fails, so the alerts fetched before a dropped connection would parse as a complete list.
  Plain `--paginate` merges the REST pages into one array and writes its closing `]` only after the
  last page, so a failure after the first page leaves unparseable JSON and the read rejects.
- **Retry.** There is no default retry, because deciding which gh failures are transient would mean
  guessing from messages. Reads are safe to repeat, so pass one when you want it, such as
  `{ retry: { maxAttempts: 3, on: ['process', 'timeout'] } }`. A network failure that leaves no JSON
  on stdout has kind `schema`, the same kind as an incomplete collection.
- **Output caps.** A read keeps up to `maxOutputBytes` of stdout (1 MiB by default). Larger output
  rejects the read instead of shrinking it, so raise the cap for pull requests with many or long
  review comments, for example `{ maxOutputBytes: 16 * 1024 * 1024 }`.

The third argument accepts only `timeoutMs`, `maxOutputBytes` and `retry`. They are policy, never
identity, so raising them for a resume keeps completed reads. A read's identity is its argv, its
response schema and the fixed exec defaults (no environment overlay, empty stdin, the workflow cwd).
Changing a query or schema in a later quiet-choir version changes that identity.

## Inspection

Each read records `meta: { integration: 'github', op }` on its step (`ExecOptions.meta`; see
[commands and files](command-effects.md)). `workflow inspect` shows the steps as `github.pr.view`,
`github.codeScanning.alerts` and so on, instead of the bare `gh api` command.

## Rehearsal and fixtures

`--dry-run` lists every read in the report's `commands` and synthesizes its response from the
schema: booleans are false, arrays have one item, and every connection reports no next page, so the
synthesized values pass the completeness checks and the mappers. Synthesized strings never match
real data; a branch that compares two of them (such as a closing issue's repository with the
repository's name) takes the "different" path.

To rehearse a specific path, answer a read with an exec fixture rule whose `json` is the raw `gh`
response: one object for `repo.info`, `pr.view` and `issue.view`, an array of pages for the
paginated GraphQL reads, and one alert array (or a GitHub error body) for code scanning. Match by
step ID, or by `argvPrefix` such as `["gh", "api", "graphql"]`. `workflow fixtures export` writes
such rules from a completed run, since the checkpoint holds the validated raw response. See
[command fixtures](rehearsal.md#command-fixtures).

## Waits

| Wait                                                      | Each check reads                                                          | Result `status`                                                      |
| --------------------------------------------------------- | ------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| `waitChecks(id, { pr, sha, timeoutMs \| deadline, ... })` | `pr.head` (plus a compare inside the stale grace)                         | `success`, `failure`, `no-checks`, `head-moved`, `closed`, `timeout` |
| `waitPr(id, { pr, sha, until, timeoutMs \| deadline })`   | One GraphQL read of state, head and merge commit (a command poll)         | `merged`, `closed`, `head-moved`, `timeout`                          |
| `waitReview(id, { pr, sha, since, reviewers, ... })`      | `pr.head`, then the comments, reviews, reactions or alerts reviewers need | `clean`, `findings`, `error`, `head-moved`, `closed`, `timeout`      |

Each wait is exactly one `ctx.poll` under your ID, so it leaves one `wait` record however many
checks it makes, suspends and resumes through `workflow tick` like any poll, and replays its result
without reading GitHub. Its reads run inside the observation through `context.exec`; they are not
steps. `pr.head` is one GraphQL read of the pull request's number, state, head and last commit's
check rollup, without the title, body or closing issues; only truncated check contexts fail it.
Exactly one of `timeoutMs` and `deadline` is required; at the bound the wait returns `timeout` with
its last progress instead of a raw deadline outcome. `sha` is the full 40-character lowercase hex
head SHA, compared with GitHub's full head SHA; a wait throws on an abbreviated one before it opens,
since it could never match.

- `waitChecks` returns `{ status, headRefOid, failed: [{ name, url, runId }], pending }`. It rolls
  up the checks of the head with the rules of `summarizeChecks`: `failure` only once nothing is
  pending, `runId` is the Actions run for `gh run`. `no-checks` is reported only once `graceMs`
  (default 300000) has passed since the wait's first check; before that, no checks keeps waiting. A
  pull request that closes or merges before CI finishes is `closed`.
- `waitPr` returns `{ status, headRefOid, mergeCommit }`. `until: 'merged'` ends at a merge, at a
  close, or as soon as the head leaves `sha`; `until: 'closed'` waits through pushes for any close.
  A pull request closed without merging is `closed` at once with either. `merged` requires the
  merged head to be `sha`; a merge of another head is `head-moved`.
- `waitReview` returns
  `{ status, headRefOid, by: [{ name, status, detail }], untriagedThreads, openAlerts }`. Once every
  reviewer has a final verdict, the same check reads the review threads, the viewer and the open
  code-scanning alerts on `refs/pull/N/merge`: `untriagedThreads` holds the IDs of unresolved
  threads whose last comment is not the authenticated viewer's, and `openAlerts` the alert numbers.
  `status` is `findings` when any reviewer found something, else `error` when any failed, else
  `clean`. A pull request that closes before every reviewer is final is `closed`.

### Head pinning and stale views

No wait reports `success`, `clean` or `merged` for a SHA other than `sha`. Every check reads the
pull request's head first. A different head ends the wait with `head-moved` and that head in
`headRefOid`, before any check or reviewer rule runs. `waitChecks` also ignores a check rollup that
GitHub still reports for another commit, and keeps waiting.

Right after a push GitHub can report the previous head for a while. `staleGraceMs` (default 0,
strict) gives `waitChecks` and `waitReview` a window, measured from the wait's first check, in which
a head that `sha` descends from is a stale view: the wait asks GitHub's compare API
(`gh api repos/O/R/compare/HEAD...SHA`) and keeps waiting when it says `ahead`. Any other head, or
any different head after the window, is `head-moved`. A stale view never yields a result.

### Tolerance

Each wait tolerates `tolerate` (default 5) consecutive transient errors, so one 502 does not end it.
The classification uses typed facts, never message text: a gh process failure or timeout, output
that is not JSON (a dropped connection, an unclosed paginated array), a nonzero exit with an error
body, and an `observeTimeoutMs` expiry are transient. A 401 or 404 body or a GraphQL `NOT_FOUND`
error, an output cap overflow, JSON that fails the schema with exit 0, an
`IncompleteCollectionError` and a reviewer that throws fail the wait at once. A tolerated error
keeps the wait's note, so a reviewer's debounce survives it. `every` defaults to
`{ initialMs: 30000, maxMs: 120000 }` for `waitChecks` and `waitPr` and 30000 for `waitReview`,
whose `observeTimeoutMs` defaults to 120000 because it makes several reads per check.
`maxOutputBytes` (default 1 MiB) applies to each read; raise it for pull requests with very many
comments.

### Reviewers

`waitReview` waits for `ReviewerBot` adapters. Each one names a `login` and the `reads` it needs
(`comments`, `reviews`, `reactions` and `alerts`; default the first three). On every check the wait
reads the union of what unfinished reviewers need and calls each one's `observe(activity, context)`
with only its own login's comments, reviews and reactions (times in epoch milliseconds), the pull
request's head, state and checks (null while the rollup belongs to another commit), and the alerts
when declared. `observe` returns `{ status, note?, detail? }`: `pending` or `running` keeps waiting;
`clean`, `findings` and `error` are final and sticky, so a final reviewer is not observed again. The
check that sees the last verdict only commits the verdicts to the wait's note; the next check, one
`every` later, reads the review threads, the viewer and the open alerts and ends the wait, so a
tolerated error in those reads never observes a reviewer again. `note` is kept for the reviewer's
next check, in the wait's checkpointed note, so it survives suspend and tick; `detail` appears in
`by`.

- `codexReviewer()` follows `chatgpt-codex-connector[bot]`. A review on `sha` after `since` is
  `findings`; a +1 reaction after `since` is `clean`; a usage-limit notice after `since` is `error`;
  when the latest summary comment was updated after `since` and has rows for `sha`, all of them
  count (such as a Code Review and a Security Review row): any failed or cancelled row is `error`,
  any row not yet `Completed` is `running`, and rows that are all `Completed` are `clean` only when
  the previous check saw the same completed rows on the same summary update, because Codex posts its
  findings right after updating the summary and may add a row (such as a Security Review) after an
  earlier one completes; an eyes reaction is `running`. "After `since`" allows 5 seconds of clock
  skew. Take `since` at or after the push of `sha`: the +1 reaction carries no SHA.
- `codeqlReviewer({ settleMs = 60000, checkName = 'CodeQL' })` waits for the `checkName` check on
  the head to complete (with any conclusion), then keeps reading the open alerts for `settleMs`,
  because alerts land shortly after the check, and reports `findings` with their numbers or `clean`.
  The settle start lives in the note; the observer never sleeps. Code scanning that is not enabled,
  or needs Advanced Security, is `clean` at once (detail `unavailable`). GitHub's
  `no analysis found` may only mean the first analysis has not published, so it follows the same
  check and settle rules, and is `clean` (detail `unavailable`) only if GitHub still says so after
  the settle window, or when the head's checks hold no `checkName` check and have all been complete
  for `settleMs`. CodeQL publishes that check only after its analysis job finishes, so a running job
  keeps it `pending`. The default `checkName` is the code-scanning results check that GitHub
  publishes after the analysis is uploaded (the check run named `CodeQL` in the rollup), not the
  Actions job that runs the analysis (such as `Analyze JavaScript and TypeScript`), which it does
  not wait for by name; a different scanning tool needs its own `checkName`.

A custom reviewer is a plain object; core needs no change:

```ts
const lint: ReviewerBot = {
  name: 'lint',
  login: 'lint-bot[bot]',
  reads: ['comments'],
  identity: { lint: 1 },
  observe: (activity, { sha }) =>
    activity.comments.some((comment) => comment.body.includes(sha))
      ? { status: 'clean' }
      : { status: 'pending' },
};
```

Keep `observe` a pure decision: no I/O, clock or context operations. `context` carries `sha`,
`since`, `now` and the reviewer's `previous.note`.

### Identity and the clock

A wait's identity is its input (repository, `pr`, `sha`, `graceMs`, `staleGraceMs`, `until`,
`since`, and each reviewer's name, login, reads and `identity`), its result schema, its spacing and
an internal versioned identity such as `{ helper: 'github.waitChecks', version: 1 }` in place of the
observer's source text, so the helper's code formatting or loader cannot strand a waiting run. A
reviewer without `identity` contributes the SHA-256 of its `observe` source instead. Policy stays
out: `tolerate`, `observeTimeoutMs`, `maxOutputBytes` and the time bound's policy fields may change
on resume. A later quiet-choir version that changes a wait's meaning bumps its version, which makes
waits in flight refuse to resume with "wait changed"; start a new wait ID.

Observers have no run clock, so the grace, the stale grace and the CodeQL settle are measured with
the wall clock from the wait's first check, kept in its note; `RunOptions.clock` does not move them.

### Rehearsal

Under `--dry-run` the reads are synthesized, and a synthesized head never equals `sha`, so a
rehearsed `waitChecks`, `waitReview` or `waitPr` with `until: 'merged'` reports `head-moved` (and
`until: 'closed'` suspends at its first check); quiet-choir does not special-case rehearsals. To
rehearse another path, answer the wait's reads with
[exec fixture rules](rehearsal.md#command-fixtures) matching the wait's ID and each read's argv (for
example the GraphQL `query=` argument or the REST path), with raw `gh` responses: the `pr.head`
response (`{ data: { repository: { pullRequest } } }` with `number`, `state`, `headRefOid` set to
`sha` and `commits`), a JSON array for the REST comments, reviews and reactions, and
`{ data: { repository: { pullRequest } } }` with `state`, `headRefOid` and `mergeCommit` for
`waitPr`.

## Writes

| Write                                                       | gh calls: reads, then writes                                                                                                                                                                     | Result                                                                                                     |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------- |
| `comment(id, { number, body })`                             | Every comment (`gh api --paginate .../issues/N/comments`); `POST repos/O/R/issues/N/comments`                                                                                                    | `{ id, url, created }`                                                                                     |
| `thread.reply(id, { threadId, body, resolve? })`            | The thread with every comment (`gh api graphql --paginate --slurp`); `addPullRequestReviewThreadReply`; `resolveReviewThread`                                                                    | `{ comment: { id, url }, created, resolved }`                                                              |
| `issue.create(id, { title, body, labels?, parent? })`       | The viewer; the viewer's issues, newest first, page by page; `POST repos/O/R/issues`; with `parent`, the issue's parent and `addSubIssue`                                                        | `{ number, url, nodeId, created, parent }`                                                                 |
| `issue.close(id, { number, comment?, reason?, ifState? })`  | The issue's state; with `comment`, every comment and `POST .../comments`; `PATCH repos/O/R/issues/N` with `state: 'closed'` and `state_reason`                                                   | `{ number, state, stateReason, acted, comment }`                                                           |
| `issue.reopen(id, { number, comment?, ifState? })`          | As `close`, with `state: 'open'`                                                                                                                                                                 | `{ number, state, stateReason, acted, comment }`                                                           |
| `alert.dismiss(id, { number, comment, reason? })`           | `GET repos/O/R/code-scanning/alerts/N`; `PATCH` of the same path                                                                                                                                 | `{ number, state, reason, dismissed }`                                                                     |
| `pr.create(id, { head, base, title, body, draft? })`        | Every pull request for the head, any base (`gh api --paginate .../pulls?head=OWNER:HEAD&state=all`); the marker is searched across bases, open ones narrowed to the base; `POST repos/O/R/pulls` | `{ number, url, nodeId, state, created }`                                                                  |
| `pr.edit(id, { number, expectHead, title?, body?, base? })` | `GET repos/O/R/pulls/N`; `PATCH` of the same path with the fields that differ                                                                                                                    | `{ number, edited, reason, head, changed }`                                                                |
| `pr.merge(id, { number, sha, method? })`                    | `GET repos/O/R/pulls/N`; `PUT .../pulls/N/merge -f merge_method=METHOD -f sha=SHA`; after a merge, the pull request until it reports merged; after a refusal, the pull request once              | `{ merged: true, number, mergeCommit, head, acted }` or `{ merged: false, number, reason, head, message }` |
| `checks.rerunFailed(id, { sha, attempt? })`                 | Every workflow run of the commit (`gh api --paginate --slurp .../actions/runs?head_sha=SHA`); `POST .../actions/runs/ID/rerun-failed-jobs` per run; the runs until each rerun shows              | `{ rerun, skipped, confirmed }`                                                                            |

Each write is exactly one `ctx.step` under your ID, so it leaves one step record, and a completed
write replays its result without calling gh. Its callback runs every gh command through the step's
`context.exec.json`: the commands are not steps of their own, and every attempt of the step runs
them again, reads first. A request body (a comment, a title, a state change) goes to gh as JSON on
stdin (`gh api ... --input -`), never in argv, so it never shows in a process listing, never meets
the per-argument size limit, and never triggers gh's `@file` expansion. `HOST/OWNER/REPO` adds
`--hostname HOST` right after `gh api` in every command. Arguments are validated before the step
opens: numbers are positive integers, bodies, titles, labels and branch names nonempty strings
without NUL, SHAs the full 40 lowercase hex characters, branch names free of `:` (no `OWNER:BRANCH`
heads), and `ifState`, the reasons, `method` and `attempt` one of their documented values.

`close` and `reopen` take `ifState`, the state the issue must be in for the op to act: `open` for
`close` and `closed` for `reopen`, the defaults and the only accepted values (the opposite one
throws before the step opens). `close`'s `reason` is `completed` (default) or `not_planned`.

### Markers

A write that creates something (a comment, a reply, an issue or a pull request) carries a marker, an
HTML comment appended to the body after a blank line:

```text
Landed in #9.

<!-- quiet-choir:RUN_ID/STEP_ID -->
```

`RUN_ID/STEP_ID` is the step's idempotency key: the run ID and the full step ID, scope prefixes
included (`<!-- quiet-choir:nightly/round-2/note -->` for `note` inside
`ctx.scope('round-2', ...)`). It contains no environment value, token, timestamp or attempt number,
and the allowed ID characters cannot end the comment early. Before writing, the step searches for
the exact, full marker (so `run/a` never matches `run/a2`); a retry or resume of the same step finds
the comment, reply or issue an earlier attempt created, even when that attempt crashed after GitHub
committed the write and before its checkpoint.

- GitHub does not render HTML comments, so readers do not see the marker, but it is visible in the
  raw body, the API and the edit view. A body that leaves a code fence open would show it as text.
- A fork starts a new run ID, so a fork posts again any write its source started but did not
  complete; completed writes are reused from the source as data.
- A human who edits the marker out of a body, or deletes the comment or issue, defeats it: the next
  attempt of a step that has not completed writes again.
- The body with its marker must fit GitHub's 65536-character limit; a body that is too long throws a
  plain Error before any write.

### Guarantees

Every op names its class in the table below:

- **Reconciled**: it finds its own earlier write, by its marker or by the state it left, so a retry
  or resume after a crash between GitHub's commit and the checkpoint does not write again.
- **Conditional (check-then-act)**: it reads the current state and writes only when it still needs
  to. GitHub offers no `If-Match` on issue state, bodies or pull request fields, and resolving a
  thread, dismissing an alert or rerunning a run does not check a version, so a change by someone
  else between the read and the write is not detected.
- **Conditional (atomic)**: GitHub checks the precondition in the same request, a compare-and-set.
  Only the merge has one: `PUT .../merge` with `sha` merges only while the head is that SHA.
- **At-least-once**: repeated on every attempt. No op here is; a write of your own through
  `ctx.exec` or a step of your own is, unless it reconciles.

| Op                            | Guarantee                                                                                                                                                                                                                                                                                                                     | Not covered                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `comment`                     | Reconciled: reads every comment and posts only when none carries the marker.                                                                                                                                                                                                                                                  | A marker removed by an edit, or a deleted comment, lets a rerun post again.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `thread.reply`                | Reconciled reply: the same marker search over every comment of the thread. Conditional (check-then-act) resolve: only when wanted and the thread read reported `isResolved: false`.                                                                                                                                           | `resolveReviewThread` has no compare-and-set: someone resolving or unresolving the thread between the read and the mutation is not detected. `resolve: false` never unresolves.                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `issue.create`                | Reconciled by the marker over the viewer's issues in the repository (the REST list, not search, whose index lags). The `parent` link is conditional (check-then-act) on reading the issue's parent: none links it, `parent` already is a no-op, another parent throws without any write.                                      | The list is assumed to show an issue right after it is created; GitHub documents no consistency guarantee for it. A miss scans every issue the viewer created there. Reconciliation assumes the same `gh` account across attempts and resumes: a retry or resume after authentication switches to another account does not see the earlier account's marked issue and can create a duplicate. An issue is never moved to another parent, and cross-repository parents are not supported. A `parent` that does not exist fails after the issue is created; a rerun finds the issue and fails the same way. |
| `issue.close`, `issue.reopen` | Conditional (check-then-act): reads the state and acts only when it matches `ifState`; otherwise returns `acted: false` with no write. The optional comment is reconciled and posted before the state change, so a crash after the change cannot lose it.                                                                     | No `If-Match`: a state change by someone else between the read and the `PATCH` is not detected, and the `PATCH` applies anyway.                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `alert.dismiss`               | Conditional (check-then-act): reads the alert and dismisses it only when it is neither `dismissed` nor `fixed`; otherwise returns `dismissed: false` with no write.                                                                                                                                                           | No compare-and-set: a dismissal or reopening by someone else between the read and the `PATCH` is overwritten.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `pr.create`                   | Reconciled: lists every pull request for the head in any state and into any base, returns the one carrying the marker (even if retargeted), else an open one into the base (whoever opened it, unchanged), and posts only when there is neither, so a step never opens a second pull request even after its first was closed. | GitHub allows one open pull request per head and base: one opened by someone else between the list and the `POST` makes GitHub answer 422 and fails the attempt, and the retry returns it. The list is assumed to show a new pull request at once. A marker edited out, for example by a `pr.edit` body, before the step completes defeats it. Same-repository heads only.                                                                                                                                                                                                                                |
| `pr.edit`                     | Conditional (check-then-act): reads the pull request and sends one `PATCH` with the fields that differ, only when it is open and its head is `expectHead`; after a committed edit nothing differs, so a retry sends nothing.                                                                                                  | No `If-Match`: a push or an edit by someone else between the read and the `PATCH` is not detected, and a concurrent change to the same field is overwritten.                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `pr.merge`                    | Conditional (atomic): the `PUT` carries `sha`, and GitHub merges only while the head is that SHA. Reconciled by its read: merged at `sha` returns the merge commit with no second `PUT`; merged at another head throws.                                                                                                       | Readiness (base branch, review threads, alerts, checks) is the caller's; GitHub enforces only branch protection. A merge at `sha` by someone else also returns `merged: true` (with `acted: false`). A merge GitHub accepted but never reported within 20 reads throws, and the retry finds it.                                                                                                                                                                                                                                                                                                           |
| `checks.rerunFailed`          | Conditional (check-then-act) on the attempt baseline: reruns only completed runs with conclusion `failure` at or below `attempt`; a run past it was rerun already (by this step before a crash, by someone else or by an earlier round) and is skipped.                                                                       | A rerun of the same run started by someone else between the list and the `POST` is not detected; GitHub refuses to rerun a running workflow with an HTTP error, which fails the attempt, and the retry skips the run. A run below the baseline that this step reran before a crash and that failed again before the retry is rerun again: once only holds for runs at the baseline. Only conclusion `failure` is rerun, not `cancelled` or `timed_out`. Confirmation is best effort.                                                                                                                      |

Reactions, comment edits and deletions, and issue body edits are not provided: without `If-Match` an
edit cannot be made conditional, and run through `ctx.exec` or a step of your own they stay at least
once. `pr.edit` is conditional on the pull request's head and state, not on its fields: it is
check-then-act, and its fields are set rather than appended, so repeating it is harmless.

`acted`, `created`, `dismissed`, `edited` and `rerun` describe the attempt that returned, not the
step: after a crash past the state change, the retry finds the issue already closed and returns
`acted: false` (and `comment: null`) although an earlier attempt of the same step closed it. Read
the state fields (`state`, `stateReason`, `resolved`) for the outcome.

`issue.create` reads the viewer, then one page of 100 of the viewer's issues per command, newest
first, so the issue a crashed attempt just created is on the first page; pull requests in the list
are skipped. A create that finds nothing reads every page: an account that has opened thousands of
issues in the repository pays one command per hundred. Raise `maxOutputBytes` (1 MiB per command by
default) when those issues have long bodies. The scan is limited to the viewer's issues because a
miss would otherwise page through every issue and pull request in the repository; the price is that
it assumes one `gh` account across attempts and resumes (see the table above).

`alert.dismiss` sends GitHub's reason: an explicit `reason` (`false positive`, `used in tests` or
`won't fix`) wins; otherwise it is `used in tests` when the alert's most recent instance is in a
test-only path (a directory segment `test`, `tests` or `__tests__`, or a file ending in `.test` or
`.spec` plus `.js`, `.ts`, `.cjs`, `.mjs`, `.cts` or `.mts`) and `false positive` otherwise,
including an alert without a path. `alertDismissReason(path, reason?)` exports the rule. The comment
is truncated to GitHub's 280 characters, on a code-point boundary.

### Pull requests

`pr.create(id, { head, base, title, body, draft? })` opens a pull request from `head`, a branch in
the same repository, into `base`; a head with an `OWNER:` prefix throws, since cross-fork pull
requests are not supported. It lists the pull requests for that head in every state and into every
base, with an owner-qualified, URL-encoded `head` filter (a fork's branch of the same name never
matches; there is no `base` filter, which GitHub applies to the current base), and decides in this
order: a pull request carrying the step's marker, in any state and into any base (so a retargeted
one still matches), is returned; else an open one into `base`, whoever opened it, is returned
unchanged (change it with `pr.edit`); else it posts, with the marker appended to `body` and the
request on stdin. Only a `POST` sets `created: true`.

`pr.edit(id, { number, expectHead, title?, body?, base? })` needs at least one field and the full
head SHA you expect. It reads the pull request and returns `edited: false` with `reason: 'closed'`
for a closed or merged one, or `reason: 'head-moved'` when the head is not `expectHead`, without a
write. Otherwise it sends one `PATCH` with only the fields that differ and lists them in `changed`;
when none differs it sends nothing (`edited: false`, `reason: null`). A body is sent as given,
without a marker, so replacing the body of a pull request `pr.create` opened drops its marker; that
is harmless once the create step has completed, since a completed step replays from its checkpoint.

### Merging

`pr.merge(id, { number, sha, method? })` merges at exactly the full head SHA `sha`, with `method`
`squash` (default), `merge` or `rebase`. It reads the pull request first:

| Read or response                                      | Result                                                         |
| ----------------------------------------------------- | -------------------------------------------------------------- |
| Merged at `sha`                                       | `merged: true` with its merge commit, `acted: false`; no `PUT` |
| Merged at another head                                | Throws, naming both SHAs; never reported as `merged: false`    |
| Closed without merging                                | `merged: false`, `reason: 'closed'`; no `PUT`                  |
| Open at another head                                  | `merged: false`, `reason: 'head-moved'`; no `PUT`              |
| Open at `sha`: the `PUT` succeeds                     | `merged: true`, `acted: true`, after the confirmation below    |
| The `PUT` answers 409 (the head moved since the read) | `merged: false`, `reason: 'head-moved'`, GitHub's message      |
| The `PUT` answers 405                                 | `merged: false`, `reason: 'not-mergeable'`, GitHub's message   |
| Any other refusal                                     | Throws with GitHub's message                                   |

After a refused `PUT` the step reads the pull request again, and that read wins: merged at `sha`
(say, by someone else) is success, and a closed pull request or a moved head is reported as such.
`not-mergeable` covers what GitHub refuses with 405: merge conflicts, failing required checks or
reviews, a draft, or a branch protected by a merge queue, which the REST merge does not bypass. A
403, 404 or 422, or an error body without a `status`, as some GitHub Enterprise Server versions
send, throws instead: the step never claims a pull request is not mergeable without GitHub saying
so. A `PUT` that leaves no JSON (a dropped connection) fails the attempt, and the retry's first read
finds the merge if GitHub committed it.

The merge is `gh api -X PUT repos/O/R/pulls/N/merge -f merge_method=METHOD -f sha=SHA`, never
`gh pr merge`, `--auto` or a merge queue: `gh pr merge` may enable auto-merge or enqueue the pull
request, which would land it later without your checks. Unlike the other writes, its two fields go
in argv rather than on stdin: both are validated tokens (a method name and a 40-character SHA),
never free text, and the SHA stays visible in the process listing and the rehearsal report. After
GitHub accepts the merge, the step reads the pull request until it reports merged, at most 20 reads
3 seconds apart with the first at once, as `merge-down-pr`'s land loop does, so a following read
sees it merged; if it never does, the step throws, and the retry finds the merge. Cancelling the run
stops the wait.

Readiness is the caller's policy: check the base branch with `pr.view`, and the review threads, open
alerts and checks with [`waitChecks` and `waitReview`](#waits) (or `pr.reviewThreads` and
`codeScanning.alerts`) on the same `sha` before merging; see the [land example](#land-example).

### Rerunning failed runs

`checks.rerunFailed(id, { sha, attempt? })` reruns the failed jobs of the workflow runs of the
commit `sha`. It lists every run of the commit (complete or throw: a list with fewer distinct run
IDs than GitHub's `total_count` throws `IncompleteCollectionError`, and GitHub returns at most 1000
runs for a commit), reruns each completed run with conclusion `failure` whose `run_attempt` is at or
below the baseline `attempt` (`POST .../actions/runs/ID/rerun-failed-jobs`, one per run), and
reports runs past the baseline that failed again or are still running in `skipped`.

`attempt` is the run attempt you saw failing, a positive integer and part of the step's input: 1
(the default) for the first round, 2 after the first round's reruns failed again, and so on. A run
past the baseline was rerun already, by this step before a crash, by someone else or by an earlier
round, so a retried or resumed step does not rerun it again, and a round never reruns what a later
attempt already covers. That at-most-once guarantee holds for runs at the baseline. A run below the
baseline that this step reran before a crash, and that failed again before the retry or resume, is
still at or below the baseline and is rerun again; a caller that needs strictly once-only reruns
across mixed attempts passes the lowest failing attempt it saw. Then the step reads the runs until
every rerun one is queued, running or at a higher attempt, with the bounds of the merge
confirmation, so a following `waitChecks` does not read the failure it just reran; `confirmed` is
false when that never showed. A rerun step has no pull request: it reruns the commit's runs of every
workflow.

### Policy and identity

The third argument takes the same keys as a read: `timeoutMs` and `maxOutputBytes` apply to each gh
command of the write, and `retry` is the step's retry policy. There is no default retry; the writes
are safe to repeat, so pass one, such as `{ retry: { maxAttempts: 3 } }`. A rerun on resume needs no
policy: an unfinished write runs again and reconciles.

A write's identity is a version constant (`github.comment/1`, `github.thread.reply/1`,
`github.issue.create/1`, `github.issue.close/1`, `github.issue.reopen/1`, `github.alert.dismiss/1`,
`github.pr.create/1`, `github.pr.edit/1`, `github.pr.merge/1` and `github.checks.rerunFailed/1`),
its input (the repository as `HOST/OWNER/REPO` or `OWNER/REPO` and the normalized arguments, bodies
included) and its result schema, never the callback's source text or the policy. Changing a body or
title under the ID of a completed write refuses the resume like any changed step input; use a new
ID. A later quiet-choir version that changes an op's behaviour bumps its version. Each step records
`meta: { integration: 'github', op }`, so `workflow inspect` shows a failed or running write as
`github.comment`, `github.issue.close` and so on.

### Rehearsal

Under `--dry-run` the step callbacks run and their gh commands are synthesized, never spawned, so
the report's `commands` lists each write's reads and writes under its step ID (`parentStepId` is the
step, `outputSource` `synthesized`), with the write's argv but not its body. The response schemas
order their values so that synthesis takes the write path: a synthesized issue is open, a thread
unresolved, an alert open and an issue without a parent, and synthesized bodies never carry the
marker. A rehearsed `comment`, `thread.reply`, `issue.create`, `issue.close` and `alert.dismiss`
therefore list their writes; a rehearsed `issue.reopen` sees an open issue and lists only its read,
and a rehearsed reply resolves only with `resolve: true`, since a synthesized author is not a bot.
The pull request writes rehearse the same way: a synthesized pull request list holds one closed pull
request without the marker, so a rehearsed `pr.create` lists its `POST`; a synthesized head is never
a real SHA, so a rehearsed `pr.edit` or `pr.merge` lists only its read and returns `head-moved`; and
a synthesized workflow run is not a completed failure, so a rehearsed `checks.rerunFailed` lists
only its list read and reruns nothing. Answer the reads with
[exec fixture rules](rehearsal.md#command-fixtures) to rehearse another path, such as the merge
`PUT`. Under `--harness fixture` a command that no rule matches runs for real, writes included,
unless the fixture file sets `"commands": "fixture"`.

### Write example

This step of a review loop replies to the threads it fixed, resolves the bot ones, and closes the
issue with a comment once the pull request has landed:

```ts
import { defineWorkflow, z } from 'quiet-choir';
import { github } from 'quiet-choir/github';

export default defineWorkflow({
  name: 'wrap-up',
  version: '1',
  input: z.object({
    repo: z.string(),
    issue: z.int().positive(),
    merged: z.string(),
    fixed: z.array(z.object({ threadId: z.string(), note: z.string() })),
  }),
  output: z.boolean(),
  async run(ctx, { repo, issue, merged, fixed }) {
    const gh = github(ctx, { repo });
    const policy = { retry: { maxAttempts: 3 } };
    for (const { threadId, note } of fixed)
      await gh.thread.reply(ctx.id('reply', threadId), { threadId, body: note }, policy);
    const closed = await gh.issue.close(
      'close',
      { number: issue, comment: `Closed by ${merged}.` },
      policy,
    );
    return closed.state === 'CLOSED';
  },
});
```

## Gate example

This gate waits for CI and the reviewers on one head, then decides what to do next. It replaces
`merge-down-pr`'s `await` subcommand.

```ts
import { defineWorkflow, z } from 'quiet-choir';
import { codeqlReviewer, codexReviewer, github } from 'quiet-choir/github';

export default defineWorkflow({
  name: 'gate',
  version: '1',
  input: z.object({ repo: z.string(), pr: z.int().positive(), sha: z.string() }),
  output: z.enum(['restart', 'stop', 'fix-ci', 'triage', 'land']),
  async run(ctx, { repo, pr, sha }) {
    const gh = github(ctx, { repo });
    const since = await ctx.now('since'); // taken after the push of sha
    const bound = { pr, sha, timeoutMs: 3_600_000, staleGraceMs: 60_000 };
    const [ci, review] = await Promise.all([
      gh.waitChecks('ci', bound),
      gh.waitReview('review', { ...bound, since, reviewers: [codexReviewer(), codeqlReviewer()] }),
    ]);
    const statuses = [ci.status, review.status];
    if (statuses.includes('head-moved') || statuses.includes('timeout')) return 'restart';
    if (statuses.includes('closed')) return 'stop';
    if (ci.status !== 'success') return 'fix-ci';
    if (review.status !== 'clean' || review.untriagedThreads.length || review.openAlerts.length)
      return 'triage';
    return 'land';
  },
});
```

## Land example

When the gate says `land` or `fix-ci`, this step merges at the gated head or reruns the failed runs,
once per round. The gate already checked CI, the reviewers, untriaged threads and open alerts on
`sha`; the base branch is also the caller's to check, as `merge-down-pr` does before it lands.

```ts
import { defineWorkflow, z } from 'quiet-choir';
import { github } from 'quiet-choir/github';

export default defineWorkflow({
  name: 'land',
  version: '1',
  input: z.object({
    repo: z.string(),
    pr: z.int().positive(),
    sha: z.string(),
    gate: z.enum(['fix-ci', 'land']),
    round: z.int().positive(),
  }),
  output: z.enum(['landed', 'rerun', 'restart', 'blocked']),
  async run(ctx, { repo, pr, sha, gate, round }) {
    const gh = github(ctx, { repo });
    const policy = { retry: { maxAttempts: 3 } };
    if (gate === 'fix-ci') {
      // Round N reruns the runs that failed at or below attempt N.
      const rerun = await gh.checks.rerunFailed(
        ctx.id('rerun', sha, round),
        { sha, attempt: round },
        policy,
      );
      return rerun.rerun.length ? 'rerun' : 'blocked';
    }
    const merge = await gh.pr.merge(ctx.id('merge', sha), { number: pr, sha }, policy);
    if (merge.merged) return 'landed';
    return merge.reason === 'head-moved' ? 'restart' : 'blocked';
  },
});
```

## Runnable example

[`examples/patterns/github-snapshot.workflow.ts`](../examples/patterns/github-snapshot.workflow.ts)
makes all six reads for one pull request and returns its head SHA, CI state, code-scanning status,
linked issue, unresolved thread count and stacked pull requests. Reads after the pull request view
are keyed by its head SHA. Rehearse it first, then run it:

```sh
node bin/run.js workflow execute examples/patterns/github-snapshot.workflow.ts \
  --input '{"repo":"OWNER/REPO","pr":N}' --dry-run --json
node bin/run.js workflow execute examples/patterns/github-snapshot.workflow.ts \
  --input '{"repo":"OWNER/REPO","pr":N}' --json
```

The dry run lists five commands, because the synthesized closing issue's repository never equals the
synthesized repository name, so the issue read is skipped. A real run of a pull request that closes
an issue in the same repository makes all six reads.
