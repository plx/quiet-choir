# GitHub reads, waits and writes

`quiet-choir/github` gives a workflow typed GitHub reads, waits and writes over the installed `gh`
CLI. Each read is exactly one durable `ctx.exec.json` with an ID you choose, so it checkpoints,
replays and rehearses like any other command. A read never returns a silently truncated list: when
GitHub reports another page that the read did not fetch, it throws `IncompleteCollectionError`. Each
[wait](#waits) for CI, reviews or a merge is exactly one `ctx.poll`, pinned to a head SHA. Each
[write](#writes) (a comment, a thread reply, an issue created, closed or reopened, an alert
dismissed, a pull request created, edited or merged, failed workflow runs rerun) is exactly one
`ctx.step` that reads before it writes, so a rerun after a crash finds the earlier attempt's write
instead of repeating it, and a merge happens only at the head SHA you name. Authentication stays in
`gh`. The designs are ADRs 0044 to 0048 in the repository. For epics, [`epic.snapshot`](#epics)
reads an epic's items in one command and the pure `nextTicket` picks the next ticket, saying why
every other open one was skipped.

This is the condensed operational reference. The extension summary in
[Embedding and extensions](extensions.md#service-helper-pattern) says how the helper fits the
service-helper pattern; [GitHub snapshots](patterns.md#github-snapshots-through-gh) is the smallest
read recipe.

## Install and authenticate

Install [gh](https://cli.github.com/) and sign in with `gh auth login` (add `--hostname HOST` for
GitHub Enterprise Server). quiet-choir never handles a token: every gh command inherits your
environment, so `gh`'s own login, `GH_TOKEN` or `GH_HOST` apply as they do in your shell, and
nothing secret enters argv, an environment overlay or the checkpoint. The reads need a `gh` whose
`gh api` supports `--paginate --slurp`; they were developed against gh 2.100.

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
output hides nested page information, so the reads never use it.

| Read                                            | Result                                                                                                                                                                               |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `repo.info(id)`                                 | `{ host, owner, name, nameWithOwner, defaultBranch, isPrivate, viewer, viewerPermission }`                                                                                           |
| `pr.view(id, { number })`                       | Title, URL, body, state, draft, `mergeable`, `mergeStateStatus`, head SHA and branches, `closingIssues` (number and repository) and `checks` for the head commit                     |
| `pr.list(id, { head?, base?, state? })`         | Every matching pull request, sorted by number (paginated). `state` is `open` (default), `closed`, `merged` or `all`                                                                  |
| `pr.reviewThreads(id, { number })`              | Every thread with every comment: `id`, `isResolved`, `isOutdated`, `path`, `line`, `author`, `isBot`, `lastAuthor`, the first comment's `alert`, `priority` badge, `title` and `url` |
| `issue.view(id, { number, comments? })`         | Number, title, state, body, URL, author and labels, plus every comment with `comments: true`                                                                                         |
| `codeScanning.alerts(id, { ref, state? })`      | `{ status: 'ok', alerts }`, or `{ status: 'unavailable', reason, alerts: [] }`                                                                                                       |
| `epic.snapshot(id, { number, headRefPrefix? })` | The epic and its items in checklist order, from one unpaginated command; see [epics](#epics)                                                                                         |

`checks` follows one set of rules, exported as `summarizeChecks`: a commit status passes when
`SUCCESS`, is pending when `PENDING` or `EXPECTED`, and fails otherwise; a check run is pending
until `COMPLETED`, then passes when its conclusion is `SUCCESS`, `NEUTRAL` or `SKIPPED`, and fails
otherwise. `checks.state` is `none`, `pending` (any pending), `failure` (any failed) or `success`,
and each item keeps GitHub's state string and, for an Actions check, the workflow run ID for
`gh run`. A deleted account is reported as `ghost`. A pull request number passed to `issue.view`
makes gh exit 1, so the read rejects. The response schemas (`pullRequestViewResponseSchema`,
`reviewThreadsResponseSchema` and so on) and their `Raw*` types are exported for fixtures.

## Occurrence IDs

A read is a memoized snapshot, not a live view:

- A completed read replays forever under its ID, on every resume, without running gh.
- To observe new state, use a fresh occurrence ID, for example one keyed by round or by head SHA
  (`ctx.id('threads', pr, headSha)`), or wait for it with one of the [waits](#waits).
- IDs inside a loop must be unique per iteration; the durability lint reports a literal ID in a loop
  (QC005).
- Reads are at least once and safe to repeat: a read that failed or never finished runs again on
  resume.

## Failures and retry

- **Truncated collections.** When the last page of a paginated connection, or any nested connection
  (a thread's comments, closing issues, check contexts, labels), reports another page, the read
  throws `IncompleteCollectionError`. Its `connection` names the connection, `stepId` the read's ID,
  and `cause` the underlying schema `ExecError`. The read is never checkpointed as completed, and a
  resume runs it again.
- **Code scanning not set up.** The code-scanning read accepts gh's exit 1 only when stdout is
  GitHub's error body alone and says code scanning is not enabled, has no analysis, or needs
  Advanced Security; it then completes with `status: 'unavailable'`, which replays as data. "No
  alerts" is `status: 'ok'` with an empty list.
- **Everything else rejects.** Not Found, bad credentials, a GraphQL error, an empty stdout from a
  network failure, a timeout or any other exit code rejects with an `ExecError` and nothing is
  settled, so a resume retries the read. A gh failure that leaves no JSON on stdout is kind
  `process`; an error body that is JSON but not one the read accepts is kind `schema`.
- **Retry.** Reads get no default retry: kind `process` also covers permanent failures such as a
  missing login, and a default would change existing workflows. Reads are safe to repeat, so pass
  `{ retry: { maxAttempts: 3, on: ['process', 'timeout'] } }` when you want one. A network failure
  is kind `process` on every read; an incomplete collection only arises at exit 0 with valid JSON
  and is kind `schema`, so that policy retries the network failure and never the incomplete
  collection. A code-scanning error body that is JSON stays kind `schema`; code scanning has no
  completeness check, so its retry may add `'schema'`.
- **Output caps.** A read keeps up to `maxOutputBytes` of stdout (1 MiB by default, 8 MiB for
  `epic.snapshot`). Larger output rejects the read instead of shrinking it, so raise the cap for
  pull requests with many or long review comments, for example
  `{ maxOutputBytes: 16 * 1024 * 1024 }`.

The third argument accepts only `timeoutMs`, `maxOutputBytes` and `retry`. They are policy, never
identity, so raising them for a resume keeps completed reads. A read's identity is its argv, its
response schema and the fixed exec defaults (no environment overlay, empty stdin, the workflow cwd).
Changing a query or schema in a later quiet-choir version changes that identity.

## Inspection and rehearsal

Each read records `meta: { integration: 'github', op }` on its step, so `workflow inspect` shows
`github.pr.view`, `github.codeScanning.alerts` and so on, instead of the bare `gh api` command.

`--dry-run` lists every read in the report's `commands` and synthesizes its response from the
schema: booleans are false, arrays have one item, and every connection reports no next page, so the
synthesized values pass the completeness checks. Synthesized strings never match real data; a branch
that compares two of them (such as a closing issue's repository with the repository's name) takes
the "different" path.

To rehearse a specific path, answer a read with an exec fixture rule whose `json` is the raw `gh`
response: one object for `repo.info`, `pr.view`, `issue.view` and `epic.snapshot`, an array of pages
for the paginated GraphQL reads, and one alert array (or a GitHub error body) for code scanning.
Match by step ID, or by `argvPrefix` such as `["gh", "api", "graphql"]`. `workflow fixtures export`
writes such rules from a completed run. See [command fixtures](rehearsal.md#command-fixtures).

## Epics

`gh.epic.snapshot(id, { number, headRefPrefix? }, policy?)` reads one epic for burning it down
ticket by ticket, and the pure `nextTicket(snapshot, policy?)` picks the next ticket. The epic
body's checklist orders the items, "Depends on #N" lines and GitHub's blocked-by relations hold an
item back, hold labels park it, a split marker replaces it with its slices, and work already under
way is finished before new work starts.

### The snapshot

The snapshot is exactly one `gh api graphql` (no `--paginate`): the viewer, the epic and up to 100
sub-issues, each with its state and close reason, repository, labels, assignees, blocked-by
relations, linked pull requests (in any state) and comments, up to 100 of each. The checkpoint keeps
the raw response; the mapper parses it into a compact result with no bodies or comments:

| Field        | Meaning                                                                                                                                                                     |
| ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `repository` | The client's `OWNER/REPO`                                                                                                                                                   |
| `viewer`     | The authenticated login; only its split markers count                                                                                                                       |
| `epic`       | `{ number, title, state, url }`                                                                                                                                             |
| `source`     | `sub-issues` when the epic has native sub-issues, else `task-list`                                                                                                          |
| `total`      | `subIssuesSummary.total`, or the checklist length for `task-list`                                                                                                           |
| `checklist`  | The body's checklist lines that name an issue of the repository: `{ number, checked, title, isItem }`                                                                       |
| `items`      | `{ number, title, state, stateReason, url, repository, labels, assignees, checked, dependsOn, blockedBy, pullRequests, split }`, checklist order first, then GitHub's order |

With sub-issues, the items are exactly the sub-issues. An epic with no sub-issues falls back to its
checklist (`source: 'task-list'`): each line is an item whose state is `CLOSED` when checked and
`OPEN` otherwise, with no URL, labels, dependencies, linked pull requests or split. That fallback
sees only checkboxes, so it cannot tell a ticket under way or blocked from a ready one, unless the
read passes `headRefPrefix`.

#### Branch-linked pull requests

A pull request opened without a closing keyword is not linked to its issue, so its ticket looks
ready and can be picked again. Pass `headRefPrefix` to link by head branch as well:

<!-- skills-check: fragment; reason: a call inside a workflow body; gh, ctx and round come from the surrounding workflow -->

```ts
const snapshot = await gh.epic.snapshot(ctx.id('epic', round), {
  number: 172,
  headRefPrefix: 'epic-172/',
});
```

It is off by default. With it the same single `gh api graphql` also reads the repository's first 100
open pull requests, and item N is linked to every one whose head branch is the prefix followed by N,
either alone or followed by `-` and anything (`epic-172/357` and `epic-172/357-selector-by-branch`
for item 357). N is written without leading zeros, so `epic-172/0357-x`, `epic-172/3570-x`,
`epic-172/357x` and `epic-171/357-x` link nothing. The prefix must be nonempty, hold no NUL and not
end in a digit; anything else throws before `gh` runs.

- Each pull request appears once in an item's `pullRequests`: closing-reference entries first, then
  the branch-only matches in ascending number.
- Only open, same-repository pull requests link by branch: closed and merged ones do not, and
  neither do forks (`isCrossRepository`), since anyone could otherwise park a ticket by naming a
  fork branch. Items of other repositories get no branch matches.
- Task-list items link too, so an unchecked line with an open pull request on its branch is
  `in-flight`. `nextTicket` is unchanged.
- The prefix only filters in the mapper, so the recorded response keeps every open pull request. A
  resumed run that passes another prefix replays the same step and re-maps it.
- One page of 100 open pull requests: `hasNextPage` throws `IncompleteCollectionError` with
  `connection: 'repository.pullRequests'`.

### Text rules

Issue bodies and comments are read as Markdown with these rules:

- **Code is ignored.** Text in fenced blocks, indented code and inline code spans is ignored (except
  that checklist lines and dependency phrases are read at any indentation, including in indented
  code; see Checklist and Dependencies), following CommonMark: a fence is three or more backticks or
  tildes and closes only on the same character at least as long; it ends with the block quote or
  list item it opens in; HTML blocks (including `<!-- ... -->` comments) are tracked and have no
  inline code. A run with no closer is literal text.
- **Checklist.** Lines `- [ ] ...`, `* [x] ...` or `+ [X] ...` outside fenced code, at any
  indentation (nested items count); only fenced code is skipped, so put an example checklist in a
  fenced block. Each line counts for its first reference to the repository, `#N` or `OWNER/REPO#N`
  (case-insensitive); lines naming only other repositories, anchors such as `page#12`, and the epic
  itself are skipped, and the first line wins when a number is listed twice. `#0` and numbers beyond
  JavaScript's safe-integer range name no issue.
- **Dependencies** (`dependsOn`), from an item's body and all its comments, by any author: the
  phrases "depends on", "blocked by" and "requires" followed by a list such as `#4, #5 and #6`, and
  the marker `<!-- epic:depends-on 3,4 -->`. Only issues of the item's own repository count, and
  never the item itself. Indented code is read here, since a misread dependency only delays an item.
- **Splits** (`split`): the last `<!-- epic:split a,b -->` marker outside code in a comment by the
  viewer. Only the viewer counts, because a split closes an item once its slices close: someone
  quoting the syntax must not close an unfinished issue. Write markers at column 0.
- **Blocked-by relations** (`blockedBy`) keep their own states; the selector counts the ones not
  `CLOSED`.

### Picking the next ticket

`nextTicket(snapshot, { order?, holdLabels?, outside? })` gives each open item a status, in this
precedence:

| Status        | When                                                                                       |
| ------------- | ------------------------------------------------------------------------------------------ |
| `in-flight`   | A linked pull request is open (drafts included); a merged or closed one is ignored         |
| `close-split` | The item is split and every slice is closed                                                |
| `split`       | The item is split and a slice is open                                                      |
| `held`        | A hold label, compared case-insensitively (default `blocked`, `needs-decision`, `on-hold`) |
| `waiting`     | A dependency or blocked-by relation is open, or a dependency is unknown                    |
| `ready`       | None of the above                                                                          |

`in-flight` sees only the pull requests GitHub links to the issue: one whose description uses a
closing keyword (such as `Closes #N`) and whose base is the default branch, or one linked by hand
(or by `headRefPrefix`). A pull request stacked on another branch, or one without a closing
reference, is not seen, so its ticket can be picked again.

A closed item is done. The pick is the first `in-flight` item, else the first `close-split`, else
the first `ready`, in `order`: `listing` (default) or `number`. It returns
`{ pick, skipped, done }`, where `pick` is
`{ number, title, url, status, pullRequests, openSlices }` or null. Every other open item is in
`skipped` as `{ number, title, reason }`:

| Reason                                | Meaning                                                                                    | Detail                |
| ------------------------------------- | ------------------------------------------------------------------------------------------ | --------------------- |
| `in-flight`, `close-split` or `ready` | Ranked after the pick                                                                      | `pullRequests` (open) |
| `split`                               | A slice is still open                                                                      | `openSlices`          |
| `held`                                | A hold label                                                                               |                       |
| `waiting`                             | An open or unknown dependency                                                              | `waitingOn`           |
| `other-repository`                    | A sub-issue of another repository: the client reads one repository, so it is never picked  |                       |
| `not-a-sub-issue`                     | An unchecked checklist line naming an issue that is not a sub-issue (with sub-issues only) |                       |

`done` is true only when there is no pick and nothing is skipped, that is, every item is closed.
Open items with no pick (all waiting, held or split) are a stall, not done. Assignees are recorded
but not used: claims are out of scope.

A dependency or slice resolves from a snapshot item of the same repository, then from
`policy.outside`; one that neither knows counts as open, since it is not known to be done.
`outsideReferences(snapshot)` returns those numbers, sorted, so a workflow can read their states
with `issue.view` and pass the results, which already have `number` and `state`, as `outside`.

### Completeness, size and freshness

- **Complete or throw.** The read throws `IncompleteCollectionError` when the sub-issue page or any
  sub-issue's labels, assignees, blocked-by relations, linked pull requests or comments report
  another page (`connection` names it, such as `epic.subIssues[163].comments`), when fewer
  sub-issues are listed than `subIssuesSummary.total` (`epic.subIssues`), and, with `headRefPrefix`,
  when the repository has more than 100 open pull requests. `nextTicket` also throws for a snapshot
  holding fewer items than its `total`, so a hand-built snapshot cannot report an incomplete epic as
  done.
- **Size.** `maxOutputBytes` defaults to 8 MiB for this read; epic #99 measured 687 KB with 80
  sub-issues and their comments. An oversized response throws and never shrinks; raise the cap with
  the policy argument.
- **Freshness.** A completed snapshot replays forever under its ID, and the mapper and selector
  re-run deterministically on replay. To see fresh epic state, use a fresh occurrence ID, such as
  `ctx.id('epic', n, round)`; a resumed run keeps acting on the snapshot it recorded.
- **Hosts.** GitHub Enterprise Server versions or accounts without sub-issues or issue dependencies
  lack the `subIssues` or `blockedBy` fields; gh exits 1 and the read rejects. There is no fallback
  query.

`examples/patterns/next-ticket.workflow.ts` in the runtime checkout reads the repository, the epic
snapshot keyed by round, the outside references and the picked ticket with its comments, and returns
the pick and every skip reason:

```sh
node "$QC_CHECKOUT/bin/run.js" workflow execute \
  "$QC_CHECKOUT/examples/patterns/next-ticket.workflow.ts" \
  --input '{"repo":"OWNER/REPO","epic":N,"round":1}' --dry-run --json
```

## Waits

| Wait                                                      | Each check reads                                                          | Result `status`                                                      |
| --------------------------------------------------------- | ------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| `waitChecks(id, { pr, sha, timeoutMs \| deadline, ... })` | `pr.head` (plus a compare inside the stale grace)                         | `success`, `failure`, `no-checks`, `head-moved`, `closed`, `timeout` |
| `waitPr(id, { pr, sha, until, timeoutMs \| deadline })`   | One GraphQL read of state, head and merge commit (a command poll)         | `merged`, `closed`, `head-moved`, `timeout`                          |
| `waitReview(id, { pr, sha, since, reviewers, ... })`      | `pr.head`, then the comments, reviews, reactions or alerts reviewers need | `clean`, `findings`, `error`, `head-moved`, `closed`, `timeout`      |

Each wait is exactly one `ctx.poll` under your ID, so it leaves one `wait` record however many
checks it makes, suspends and resumes through `workflow tick` like any poll, and replays its result
without reading GitHub. Its reads run inside the observation; they are not steps. `pr.head` is one
GraphQL read of the pull request's number, state, head and last commit's check rollup. Exactly one
of `timeoutMs` and `deadline` is required; at the bound the wait returns `timeout` with its last
progress. `sha` is the full 40-character lowercase hex head SHA; a wait throws on an abbreviated one
before it opens, since it could never match.

- `waitChecks` returns `{ status, headRefOid, failed: [{ name, url, runId }], pending }`. It rolls
  up the checks of the head with the rules of `summarizeChecks`: `failure` only once nothing is
  pending, `runId` is the Actions run for `gh run`. `no-checks` is reported only once `graceMs`
  (default 300000) has passed since the wait's first check; before that, no checks keeps waiting. A
  pull request that closes or merges before CI finishes is `closed`.
- `requiredChecks: ['Quality and package', 'test (22)']` also waits for named checks to exist. The
  rollup covers only the checks GitHub has registered so far: right after a push, a fast check can
  roll up as success before slower workflows register. The names add to the rollup and never filter
  it: every registered check still counts, and a failure of an unnamed check is still `failure`.
  Each name is matched exactly against a check run (usually the job name, with any matrix suffix
  such as `test (22)`) or a commit status context; a workflow name does not match. `success` needs a
  check of every name and a passing rollup. A name that has not registered is listed in `pending`
  after the registered pending checks; it has no run yet, so do not pass it to `gh run`. `failure`
  still ends the wait as soon as every registered check has completed and one failed. Once nothing
  registered is pending and `graceMs` has passed with a required check still missing, the wait ends
  with `no-checks`, the missing names in `pending`. A wrong name therefore never ends in `success`.
  `graceMs` is measured from the wait's first check, so a chained workflow (one that a
  `workflow_run` trigger starts after other checks complete) may need a larger `graceMs`. While the
  wait runs, its saved note (the step's `wait.note` in `workflow inspect --json`) lists the missing
  names in `missing`.
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
a head that `sha` descends from is a stale view: the wait asks GitHub's compare API and keeps
waiting when it says `ahead`. Any other head, or any different head after the window, is
`head-moved`. A stale view never yields a result.

### Tolerance and spacing

Each wait tolerates `tolerate` (default 5) consecutive transient errors, so one 502 does not end it.
Transient: a gh process failure or timeout, output that is not JSON (a dropped connection), a
nonzero exit with an error body, and an `observeTimeoutMs` expiry. A 401 or 404 body or a GraphQL
`NOT_FOUND` error, an output cap overflow, JSON that fails the schema with exit 0, an
`IncompleteCollectionError` and a reviewer that throws fail the wait at once. A tolerated error
keeps the wait's note, so a reviewer's debounce survives it. `every` defaults to
`{ initialMs: 30000, maxMs: 120000 }` for `waitChecks` and `waitPr` and 30000 for `waitReview`,
whose `observeTimeoutMs` defaults to 120000 because it makes several reads per check.
`maxOutputBytes` (default 1 MiB) applies to each read.

### Reviewers

`waitReview` waits for `ReviewerBot` adapters. Each one names a `login` and the `reads` it needs
(`comments`, `reviews`, `reactions` and `alerts`; default the first three). On every check the wait
reads the union of what unfinished reviewers need and calls each one's `observe(activity, context)`
with only its own login's comments, reviews and reactions (times in epoch milliseconds), the pull
request's head, state and checks (null while the rollup belongs to another commit), and the alerts
when declared. `observe` returns `{ status, note?, detail? }`: `pending` or `running` keeps waiting;
`clean`, `findings` and `error` are final and sticky. `note` is kept for the reviewer's next check,
in the wait's checkpointed note, so it survives suspend and tick; `detail` appears in `by`.

- `codexReviewer()` follows `chatgpt-codex-connector[bot]`. A review on `sha` after `since` is
  `findings`; a +1 reaction after `since` is `clean`; a usage-limit notice after `since` is `error`;
  when the latest summary comment was updated after `since` and has rows for `sha`, any failed or
  cancelled row is `error`, any row not yet `Completed` is `running`, and rows that are all
  `Completed` are `clean` only when the previous check saw the same completed rows on the same
  summary update; an eyes reaction is `running`. "After `since`" allows 5 seconds of clock skew.
  Take `since` at or after the push of `sha`: the +1 reaction carries no SHA.
- `codeqlReviewer({ settleMs = 60000, checkName = 'CodeQL' })` waits for the `checkName` check on
  the head to complete (with any conclusion), then keeps reading the open alerts for `settleMs`,
  because alerts land shortly after the check, and reports `findings` with their numbers or `clean`.
  The observer never sleeps; the settle start lives in the note. Code scanning that is not enabled,
  or needs Advanced Security, is `clean` at once (detail `unavailable`); GitHub's
  `no analysis found` follows the same check and settle rules and is `clean` only if GitHub still
  says so after the settle window. The default `checkName` is the code-scanning results check GitHub
  publishes after the analysis is uploaded (the check run named `CodeQL` in the rollup), not the
  Actions job that runs the analysis; a different scanning tool needs its own `checkName`.

A custom reviewer is a plain object; core needs no change:

```ts
import type { ReviewerBot } from 'quiet-choir/github';

export const lint: ReviewerBot = {
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

A wait's identity is its input (repository, `pr`, `sha`, `graceMs`, `staleGraceMs`, `requiredChecks`
when given, sorted and without duplicates, `until`, `since`, and each reviewer's name, login, reads
and `identity`), its result schema, its spacing and an internal versioned identity such as
`{ helper: 'github.waitChecks', version: 1 }` in place of the observer's source text, so the
helper's code formatting or loader cannot strand a waiting run. A reviewer without `identity`
contributes the SHA-256 of its `observe` source instead. Policy stays out: `tolerate`,
`observeTimeoutMs`, `maxOutputBytes` and the time bound's policy fields may change on resume. A
later quiet-choir version that changes a wait's meaning bumps its version, which makes waits in
flight refuse to resume with "wait changed"; start a new wait ID.

Observers have no run clock, so the grace, the stale grace and the CodeQL settle are measured with
the wall clock from the wait's first check, kept in its note; `RunOptions.clock` does not move them.

### Waits under rehearsal

Under `--dry-run` the reads are synthesized, and a synthesized head never equals `sha`, so a
rehearsed `waitChecks`, `waitReview` or `waitPr` with `until: 'merged'` reports `head-moved` (and
`until: 'closed'` suspends at its first check). To rehearse another path, answer the wait's reads
with [exec fixture rules](rehearsal.md#command-fixtures) matching the wait's ID and each read's argv
(for example the GraphQL `query=` argument or the REST path), with raw `gh` responses: the `pr.head`
response (`{ data: { repository: { pullRequest } } }` with `number`, `state`, `headRefOid` set to
`sha` and `commits`), a JSON array for the REST comments, reviews and reactions, and
`{ data: { repository: { pullRequest } } }` with `state`, `headRefOid` and `mergeCommit` for
`waitPr`.

## Writes

| Write                                                       | Result                                                                                                     |
| ----------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `comment(id, { number, body })`                             | `{ id, url, created }`                                                                                     |
| `thread.reply(id, { threadId, body, resolve? })`            | `{ comment: { id, url }, created, resolved }`                                                              |
| `issue.create(id, { title, body, labels?, parent? })`       | `{ number, url, nodeId, created, parent }`                                                                 |
| `issue.close(id, { number, comment?, reason?, ifState? })`  | `{ number, state, stateReason, acted, comment }`                                                           |
| `issue.reopen(id, { number, comment?, ifState? })`          | `{ number, state, stateReason, acted, comment }`                                                           |
| `alert.dismiss(id, { number, comment, reason? })`           | `{ number, state, reason, dismissed }`                                                                     |
| `pr.create(id, { head, base, title, body, draft? })`        | `{ number, url, nodeId, state, created }`                                                                  |
| `pr.edit(id, { number, expectHead, title?, body?, base? })` | `{ number, edited, reason, head, changed }`                                                                |
| `pr.merge(id, { number, sha, method? })`                    | `{ merged: true, number, mergeCommit, head, acted }` or `{ merged: false, number, reason, head, message }` |
| `checks.rerunFailed(id, { sha, attempt?, attempts? })`      | `{ rerun, skipped, confirmed }`                                                                            |

Each write is exactly one `ctx.step` under your ID, so it leaves one step record, and a completed
write replays its result without calling gh. Its callback runs every gh command through the step's
`context.exec.json`: the commands are not steps of their own, and every attempt of the step runs
them again, reads first. A request body (a comment, a title, a state change) goes to gh as JSON on
stdin (`gh api ... --input -`), never in argv. `HOST/OWNER/REPO` adds `--hostname HOST` right after
`gh api` in every command. Arguments are validated before the step opens: numbers are positive
integers, bodies, titles, labels and branch names nonempty strings without NUL, SHAs the full 40
lowercase hex characters, branch names free of `:` (no `OWNER:BRANCH` heads), and `ifState`, the
reasons, `method` and `attempt` one of their documented values.

`close` and `reopen` take `ifState`, the state the issue must be in for the op to act: `open` for
`close` and `closed` for `reopen`, the defaults and the only accepted values. `close`'s `reason` is
`completed` (default) or `not_planned`.

### Markers

A write that creates something (a comment, a reply, an issue or a pull request) carries a marker, an
HTML comment appended to the body after a blank line:

```text
Landed in #9.

<!-- quiet-choir:RUN_ID/STEP_ID -->
```

`RUN_ID/STEP_ID` is the step's idempotency key: the run ID and the full step ID, scope prefixes
included. It contains no environment value, token, timestamp or attempt number. Before writing, the
step searches for the exact, full marker (so `run/a` never matches `run/a2`); a retry or resume of
the same step finds the comment, reply or issue an earlier attempt created, even when that attempt
crashed after GitHub committed the write and before its checkpoint.

- GitHub does not render HTML comments, but the marker is visible in the raw body and the edit view.
  A body that leaves a code fence open would show it as text.
- A fork starts a new run ID, so a fork posts again any write its source started but did not
  complete; completed writes are reused from the source as data.
- A human who edits the marker out of a body, or deletes the comment or issue, defeats it: the next
  attempt of a step that has not completed writes again.
- The body with its marker must fit GitHub's 65536-character limit; a longer body throws a plain
  Error before any write.

### Guarantees

Reconciled means the op finds its own earlier write, by its marker or by the state it left.
Conditional (check-then-act) means it reads the state and writes only when it still needs to; GitHub
offers no `If-Match` on issue state, bodies or pull request fields, so a change by someone else
between the read and the write is not detected. Conditional (atomic) means GitHub checks the
precondition in the same request; only the merge has one. No op here is at-least-once; a write of
your own through `ctx.exec` or a step of your own is, unless it reconciles.

- `comment`: reconciled; reads every comment and posts only when none carries the marker. Not
  covered: a marker removed by an edit, or a deleted comment, lets a rerun post again.
- `thread.reply`: reconciled reply by the marker over every comment of the thread; the resolve is
  check-then-act, only when wanted and the thread read reported `isResolved: false`. Not covered:
  someone resolving or unresolving the thread between the read and the mutation. `resolve: false`
  never unresolves.
- `issue.create`: reconciled by the marker over the viewer's issues in the repository (the REST
  list, not search, whose index lags). The wanted `parent` is read first, so a missing parent or a
  pull request throws before any write; a found issue's parent is read: none links it, the same
  `parent` is a no-op, another parent throws. Not covered: the list is assumed to show an issue
  right after it is created; reconciliation assumes the same `gh` account across attempts and
  resumes, and a switch of account can create a duplicate; an issue is never moved to another
  parent, and cross-repository parents are not supported.
- `issue.close`, `issue.reopen`: check-then-act; act only when the state matches `ifState`,
  otherwise `acted: false` with no write. The optional comment is reconciled and posted before the
  state change. Not covered: a state change by someone else between the read and the `PATCH`.
- `alert.dismiss`: check-then-act; dismisses only an alert that is neither `dismissed` nor `fixed`,
  otherwise `dismissed: false`. Not covered: a dismissal or reopening by someone else in between is
  overwritten.
- `pr.create`: reconciled; lists every pull request for the head in any state and into any base,
  returns the one carrying the marker (even if retargeted), else an open one into the base (whoever
  opened it, unchanged), and posts only when there is neither. Not covered: one opened by someone
  else between the list and the `POST` makes GitHub answer 422 and fails the attempt, and the retry
  returns it; a marker edited out of the body before the step completes defeats it. Same-repository
  heads only.
- `pr.edit`: check-then-act; one `PATCH` with the fields that differ, only when the pull request is
  open and its head is `expectHead`; after a committed edit nothing differs, so a retry sends
  nothing. Not covered: a push or an edit by someone else in between; a concurrent change to the
  same field is overwritten.
- `pr.merge`: atomic; the `PUT` carries `sha` and GitHub merges only while the head is that SHA;
  also reconciled by its read. Not covered: readiness (base branch, review threads, alerts, checks)
  is the caller's, since GitHub enforces only branch protection; a merge at `sha` by someone else
  also returns `merged: true` (with `acted: false`).
- `checks.rerunFailed`: check-then-act on the attempt baseline (see
  [rerunning failed runs](#rerunning-failed-runs)). Not covered: a rerun of the same run started by
  someone else between the list and the `POST`; GitHub refuses to rerun a running workflow with an
  HTTP error, which fails the attempt, and the retry skips the run. Only conclusion `failure` is
  rerun, not `cancelled` or `timed_out`. Confirmation is best effort.

Reactions, comment edits and deletions, and issue body edits are not provided: without `If-Match` an
edit cannot be made conditional, and run through `ctx.exec` or a step of your own they stay at least
once.

`acted`, `created`, `dismissed`, `edited` and `rerun` describe the attempt that returned, not the
step: after a crash past the state change, the retry finds the issue already closed and returns
`acted: false` (and `comment: null`) although an earlier attempt of the same step closed it. Read
the state fields (`state`, `stateReason`, `resolved`) for the outcome.

`issue.create` reads one page of 100 of the viewer's issues per command, newest first, so the issue
a crashed attempt just created is on the first page. A create that finds nothing reads every page:
an account that has opened thousands of issues in the repository pays one command per hundred. Raise
`maxOutputBytes` when those issues have long bodies.

`alert.dismiss` sends GitHub's reason: an explicit `reason` (`false positive`, `used in tests` or
`won't fix`) wins; otherwise it is `used in tests` when the alert's most recent instance is in a
test-only path and `false positive` otherwise. `alertDismissReason(path, reason?)` exports the rule.
The comment is truncated to GitHub's 280 characters.

### Pull requests

`pr.create(id, { head, base, title, body, draft? })` opens a pull request from `head`, a branch in
the same repository, into `base`; a head with an `OWNER:` prefix throws, since cross-fork pull
requests are not supported. It decides in this order: a pull request carrying the step's marker, in
any state and into any base, is returned; else an open one into `base`, whoever opened it, is
returned unchanged (change it with `pr.edit`); else it posts, with the marker appended to `body`.
Only a `POST` sets `created: true`.

`pr.edit(id, { number, expectHead, title?, body?, base? })` needs at least one field and the full
head SHA you expect. It returns `edited: false` with `reason: 'closed'` for a closed or merged pull
request, or `reason: 'head-moved'` when the head is not `expectHead`, without a write. Otherwise it
sends one `PATCH` with only the fields that differ and lists them in `changed`; when none differs it
sends nothing (`edited: false`, `reason: null`). A body is sent as given, without a marker, so
replacing the body of a pull request `pr.create` opened drops its marker; that is harmless once the
create step has completed.

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
403, 404 or 422, or an error body without a `status`, throws instead: the step never claims a pull
request is not mergeable without GitHub saying so. A `PUT` that leaves no JSON (a dropped
connection) fails the attempt, and the retry's first read finds the merge if GitHub committed it.

The merge is `gh api -X PUT repos/O/R/pulls/N/merge -f merge_method=METHOD -f sha=SHA`, never
`gh pr merge`, `--auto` or a merge queue: `gh pr merge` may enable auto-merge or enqueue the pull
request, which would land it later without your checks. Its two fields go in argv rather than on
stdin: both are validated tokens, never free text. After GitHub accepts the merge, the step reads
the pull request until it reports merged, at most 20 reads 3 seconds apart with the first at once,
so a following read sees it merged; if it never does, the step throws, and the retry finds the
merge.

Readiness is the caller's policy: check the base branch with `pr.view`, and the review threads, open
alerts and checks with [`waitChecks` and `waitReview`](#waits) (or `pr.reviewThreads` and
`codeScanning.alerts`) on the same `sha` before merging; see the [land example](#land-example).

### Rerunning failed runs

`checks.rerunFailed(id, { sha, attempt?, attempts? })` reruns the failed jobs of the workflow runs
of the commit `sha`. It lists every run of the commit (complete or throw: a list with fewer distinct
run IDs than GitHub's `total_count` throws `IncompleteCollectionError`, and GitHub returns at most
1000 runs for a commit), reruns each completed run with conclusion `failure` whose `run_attempt` is
at or below the baseline `attempt`, and reports runs past the baseline that failed again or are
still running in `skipped`. It reruns the commit's runs of every workflow; it has no pull request.

`attempt` is the run attempt you saw failing, a positive integer and part of the step's input: 1
(the default) for the first round, 2 after the first round's reruns failed again, and so on. A run
past the baseline was rerun already, by this step before a crash, by someone else or by an earlier
round, so a retried or resumed step does not rerun it again. One scalar cannot describe runs that
failed at different attempts: a run below the baseline that this step reran before a crash, and that
failed again before the retry, is still at or below the baseline and is rerun again.

`attempts` closes that window. It maps a workflow run ID to the attempt you saw that run fail. A run
in the map is rerun only when it is a completed failure at exactly its baseline, and is skipped once
its attempt is past it. A run not in the map follows `attempt`. Run 101 that failed at attempt 1
next to run 102 that failed at attempt 2 is `{ sha, attempt: 2, attempts: { 101: 1, 102: 2 } }`.
Keys must be canonical positive integer run IDs (`101`, not `0`, `01` or `abc`) and values positive
integers; anything else throws before the step opens.

For the next round, build the map from the previous result: each rerun run will be at `attempt + 1`
when you next see it fail, and each skipped run's reported attempt is the one you will see fail. A
retried or resumed step can report its own committed reruns as skipped, so they must be carried
over:

<!-- skills-check: fragment; reason: a statement inside a round loop; previous is the earlier round's checks.rerunFailed result -->

```ts
const next = Object.fromEntries([
  ...previous.skipped.map((run) => [run.id, run.attempt]),
  ...previous.rerun.map((run) => [run.id, run.attempt + 1]),
]);
```

A map cannot be derived from `waitChecks`: its failures carry a run ID but no run attempt. After the
reruns, the step reads the runs until every rerun one is queued, running or at a higher attempt, so
a following `waitChecks` does not read the failure it just reran; `confirmed` is false when that
never showed.

### Policy and identity

The third argument takes the same keys as a read: `timeoutMs` and `maxOutputBytes` apply to each gh
command of the write, and `retry` is the step's retry policy. There is no default retry; the writes
are safe to repeat, so pass one, such as `{ retry: { maxAttempts: 3 } }`. A rerun on resume needs no
policy: an unfinished write runs again and reconciles.

A write's identity is a version constant (`github.comment/1`, `github.thread.reply/1`,
`github.issue.create/1`, `github.issue.close/1`, `github.issue.reopen/1`, `github.alert.dismiss/1`,
`github.pr.create/1`, `github.pr.edit/1`, `github.pr.merge/1` and `github.checks.rerunFailed/2`),
its input (the repository and the normalized arguments, bodies included) and its result schema,
never the callback's source text or the policy. Changing a body or title under the ID of a completed
write refuses the resume like any changed step input; use a new ID. A later quiet-choir version that
changes an op's behaviour bumps its version. Each step records
`meta: { integration: 'github', op }`, so `workflow inspect` shows `github.comment`,
`github.issue.close` and so on.

### Writes under rehearsal

Under `--dry-run` the step callbacks run and their gh commands are synthesized, never spawned, so
the report's `commands` lists each write's reads and writes under its step ID, with the write's argv
but not its body. Synthesis takes the write path: a synthesized issue is open, a thread unresolved,
an alert open and an issue without a parent, and synthesized bodies never carry the marker. A
rehearsed `comment`, `thread.reply`, `issue.create`, `issue.close` and `alert.dismiss` therefore
list their writes; a rehearsed `issue.reopen` sees an open issue and lists only its read, and a
rehearsed reply resolves only with `resolve: true`. A synthesized pull request list holds one closed
pull request without the marker, so a rehearsed `pr.create` lists its `POST`; a synthesized head is
never a real SHA, so a rehearsed `pr.edit` or `pr.merge` lists only its read and returns
`head-moved`; and a synthesized workflow run is not a completed failure, so a rehearsed
`checks.rerunFailed` lists only its list read and reruns nothing. Answer the reads with
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
      // Round N reruns the runs that failed at or below attempt N; pass `attempts` when the runs
      // failed at different attempts (see Rerunning failed runs).
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

`examples/patterns/github-snapshot.workflow.ts` in the runtime checkout makes all six reads for one
pull request and returns its head SHA, CI state, code-scanning status, linked issue, unresolved
thread count and stacked pull requests. Reads after the pull request view are keyed by its head SHA.
Rehearse it first, then run it:

```sh
node "$QC_CHECKOUT/bin/run.js" workflow execute \
  "$QC_CHECKOUT/examples/patterns/github-snapshot.workflow.ts" \
  --input '{"repo":"OWNER/REPO","pr":N}' --dry-run --json
node "$QC_CHECKOUT/bin/run.js" workflow execute \
  "$QC_CHECKOUT/examples/patterns/github-snapshot.workflow.ts" \
  --input '{"repo":"OWNER/REPO","pr":N}' --json
```

The dry run lists five commands, because the synthesized closing issue's repository never equals the
synthesized repository name, so the issue read is skipped. A real run of a pull request that closes
an issue in the same repository makes all six reads.
