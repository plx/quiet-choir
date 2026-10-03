# GitHub reads and waits

`quiet-choir/github` gives a workflow typed GitHub reads and waits over the installed `gh` CLI. Each
read is exactly one durable `ctx.exec.json` with an ID you choose, so it checkpoints, replays and
rehearses like any other command. A read never returns a silently truncated list: when GitHub
reports another page that the read did not fetch, it throws `IncompleteCollectionError`. Each
[wait](#waits) for CI, reviews or a merge is exactly one `ctx.poll`, pinned to a head SHA. The
designs are recorded in [ADR 0044](decisions/0044-gh-backed-github-reads.md) and
[ADR 0045](decisions/0045-head-pinned-github-waits.md).

The helpers read and wait only. Writes such as comments, thread replies and merges, and epic
selection, are planned separately (#161 to #163).

## Install and authenticate

Install [gh](https://cli.github.com/) and sign in with `gh auth login` (add `--hostname HOST` for
GitHub Enterprise Server). quiet-choir never handles a token: the reads inherit your environment, so
`gh`'s own login, `GH_TOKEN` or `GH_HOST` apply as they do in your shell, and nothing secret enters
argv, an environment overlay or the checkpoint. The reads need a `gh` whose `gh api` supports
`--paginate --slurp` (see `gh api --help`); they were developed against gh 2.100.

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
| `waitChecks(id, { pr, sha, timeoutMs \| deadline, ... })` | `pr.view` (plus a compare inside the stale grace)                         | `success`, `failure`, `no-checks`, `head-moved`, `closed`, `timeout` |
| `waitPr(id, { pr, sha, until, timeoutMs \| deadline })`   | One GraphQL read of state, head and merge commit (a command poll)         | `merged`, `closed`, `head-moved`, `timeout`                          |
| `waitReview(id, { pr, sha, since, reviewers, ... })`      | `pr.view`, then the comments, reviews, reactions or alerts reviewers need | `clean`, `findings`, `error`, `head-moved`, `closed`, `timeout`      |

Each wait is exactly one `ctx.poll` under your ID, so it leaves one `wait` record however many
checks it makes, suspends and resumes through `workflow tick` like any poll, and replays its result
without reading GitHub. Its reads run inside the observation through `context.exec`; they are not
steps. Exactly one of `timeoutMs` and `deadline` is required; at the bound the wait returns
`timeout` with its last progress instead of a raw deadline outcome. `sha` is the full 40-character
lowercase hex head SHA, compared with GitHub's full head SHA; a wait throws on an abbreviated one
before it opens, since it could never match.

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
`clean`, `findings` and `error` are final and sticky, so a final reviewer is not observed again.
`note` is kept for the reviewer's next check, in the wait's checkpointed note, so it survives
suspend and tick; `detail` appears in `by`.

- `codexReviewer()` follows `chatgpt-codex-connector[bot]`. A review on `sha` after `since` is
  `findings`; a +1 reaction after `since` is `clean`; a usage-limit notice after `since` is `error`;
  when the latest summary comment was updated after `since` and has a row for `sha`, a failed or
  cancelled row is `error`, and a `Completed` row is `clean` only when the previous check saw it
  too, because Codex posts its findings right after updating the summary; an eyes reaction is
  `running`. "After `since`" allows 5 seconds of clock skew. Take `since` at or after the push of
  `sha`: the +1 reaction carries no SHA.
- `codeqlReviewer({ settleMs = 60000, checkName = 'CodeQL' })` waits for the `checkName` check on
  the head to complete (with any conclusion), then keeps reading the open alerts for `settleMs`,
  because alerts land shortly after the check, and reports `findings` with their numbers or `clean`.
  The settle start lives in the note; the observer never sleeps. Code scanning that is not set up is
  `clean`.

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
example the GraphQL `query=` argument or the REST path), with raw `gh` responses: the `pr.view`
response with `headRefOid` set to `sha`, a JSON array for the REST comments, reviews and reactions,
and `{ data: { repository: { pullRequest } } }` with `state`, `headRefOid` and `mergeCommit` for
`waitPr`.

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
