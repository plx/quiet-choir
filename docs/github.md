# GitHub reads

`quiet-choir/github` gives a workflow typed GitHub reads over the installed `gh` CLI. Each read is
exactly one durable `ctx.exec.json` with an ID you choose, so it checkpoints, replays and rehearses
like any other command. A read never returns a silently truncated list: when GitHub reports another
page that the read did not fetch, it throws `IncompleteCollectionError`. The design is recorded in
[ADR 0044](decisions/0044-gh-backed-github-reads.md).

This slice reads only. Waits for CI, reviews and merges, writes such as comments, thread replies and
merges, and epic selection are planned separately (#160 to #163).

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
| `codeScanning.alerts(id, { ref, state? })` | `gh api --paginate --slurp repos/O/R/code-scanning/alerts?...`  | `{ status: 'ok', alerts }` with number, rule, severity, path, line, message, state and URL; or `{ status: 'unavailable', reason, alerts: [] }`                                                                |

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
  (`ctx.id('threads', pr, headSha)`), or wait for it with `ctx.poll` (#160 adds GitHub waits).
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
  code-scanning read accepts exit 1 only when the body is the sole page and says code scanning is
  not enabled, has no analysis, or needs Advanced Security; it then completes with
  `status: 'unavailable'`, which replays as data. "No alerts" is `status: 'ok'` with an empty list.
- **Everything else rejects.** Not Found, bad credentials, a GraphQL error, an error page after
  alerts, an empty stdout from a network failure, a timeout or any other exit code rejects with an
  `ExecError`; nothing is settled, so a resume retries the read. One gap remains: gh prints the
  pages it already fetched when a later page fails at the network level, so a code-scanning read of
  more than 100 alerts interrupted that way would look complete.
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
response: one object for `repo.info`, `pr.view` and `issue.view`, and an array of pages for the
paginated reads and code scanning. Match by step ID, or by `argvPrefix` such as
`["gh", "api", "graphql"]`. `workflow fixtures export` writes such rules from a completed run, since
the checkpoint holds the validated raw response. See
[command fixtures](rehearsal.md#command-fixtures).

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
