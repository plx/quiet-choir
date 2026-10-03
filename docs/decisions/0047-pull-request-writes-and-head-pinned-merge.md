# 0047: Pull request writes and a head-pinned merge

- Status: accepted
- Issue: #162 (slice C2 of #21)
- Builds on: [0044](0044-gh-backed-github-reads.md) (GitHub reads),
  [0045](0045-head-pinned-github-waits.md) (head pinning, versioned helper identity) and
  [0046](0046-reconciled-github-writes.md) (reconciled writes, markers, version-identified steps)

## Context

`merge-down-pr`'s helper encodes the pull request rules by hand: `land` reads the pull request,
returns `{ merged: false }` when the head moved, merges with `PUT .../pulls/N/merge -f sha=SHA`
rather than `gh pr merge` (which may enable auto-merge or enqueue the pull request), and polls until
it reports merged. Its protection against a crash between the merge and its own bookkeeping is a
saved `last/` output that a relay re-reads; a retry of `land` after such a crash fails on the pull
request no longer being open. `rerunFailed` reruns every completed failed run of a commit, so
running it again after the reruns failed a second time reruns the same jobs. Edits read the head and
then write, a check-then-act. Nothing creates pull requests. A quiet-choir step that repeats any of
these after a crash has none of the relay's protection.

## Decision

Add `pr.create`, `pr.edit`, `pr.merge` and `checks.rerunFailed` to the client, built the way 0046
built its writes: each op is one `ctx.step` with the internal `identity: 'version'`, a version
constant (`github.pr.create/1`, `github.pr.edit/1`, `github.pr.merge/1`,
`github.checks.rerunFailed/1`), the repository and normalized arguments as input, `meta`
`{ integration: 'github', op }`, and every gh command through `StepContext.exec`, so `--dry-run`
lists them. They use only `gh api`; no op runs `gh pr` or `gh run`.

- **REST reads inside the writes.** `GET repos/O/R/pulls/N` reports `merged`, `merge_commit_sha` and
  `head.sha` after a merge, and the list `GET .../pulls?head=OWNER:BRANCH&base=BASE&state=all`
  filters on the owner-qualified head, so a fork's branch of the same name never matches (the
  GraphQL `headRefName` filter would). The list uses plain `--paginate` without `--slurp`, as the
  code-scanning read does, so a failed later page rejects. Head SHAs stay plain strings in the
  response schemas, so synthesis never fails on them.
- **Create order.** `pr.create` returns a pull request carrying the step's marker in any state
  first, so a step never opens a second pull request even after its first was closed; then any open
  pull request for the head and base, whoever opened it, unchanged; and only otherwise posts, with
  the marker. GitHub's one-open-pull-request rule makes a race a 422 that fails the attempt, and the
  retry finds the winner. Cross-fork heads (`OWNER:BRANCH`) throw.
- **Edit is check-then-act.** `pr.edit` requires `expectHead`, reads the pull request, returns
  `reason: 'closed'` or `'head-moved'` as data without a write, and otherwise patches only the
  fields that differ; after a committed edit nothing differs, so a retry sends nothing. It carries
  no marker: a set is harmless to repeat. GitHub has no `If-Match`, so a concurrent change between
  the read and the `PATCH` is not detected, and that is stated.
- **The merge is pinned atomically and reconciled.** `pr.merge` reads first: merged at `sha` is
  success with the existing merge commit and no `PUT` (the crash window), merged at another head
  throws (it can be reported neither as merged at `sha` nor as `merged: false`), closed and another
  head are refusals as data. Otherwise it sends `PUT .../pulls/N/merge` with `sha`, which GitHub
  checks in the same request: the one compare-and-set among these writes. A refused `PUT`
  (`okExitCodes: [0, 1]`, so GitHub's error body is data) reads again; that read wins, then 409 is
  `head-moved` and 405 `not-mergeable` with GitHub's message, and anything else throws. The ticket's
  reasons gain `closed`, because a caller loop needs it as data. `not-mergeable` is claimed only on
  GitHub's 405, so a 403, 404, 422 or a body without `status` (older GitHub Enterprise Server) costs
  an attempt rather than a wrong verdict. Readiness (base branch, threads, alerts) stays with the
  caller, who has the 0044 reads and 0045 waits; the op never enables auto-merge or a merge queue.
- **Confirmation loop.** After a successful `PUT` the step reads the pull request until it reports
  merged, at most 20 reads 3 seconds apart, as `land` does; exhausting it throws, and the retry's
  first read reconciles. The loop is an internal helper with an injected sleep, so its lag and
  exhaustion are tested without waiting; the default sleep honours the step's cancellation signal.
- **Merge fields in argv.** 0046 sends request bodies on stdin. The merge sends `merge_method` and
  `sha` as `-f` fields instead: both are validated tokens (one of three method names and a full
  40-character SHA), never free text, so none of 0046's reasons (process listings, argument size,
  `@file` expansion) applies, and the pinned SHA stays visible in argv and the rehearsal report. It
  also matches the reference helper.
- **Rerun baseline.** `checks.rerunFailed` takes the baseline explicitly as step input: `attempt`,
  the run attempt the caller saw failing (default 1; a second round passes 2). It lists every run of
  the commit (`--paginate --slurp`, failing as an incomplete collection when fewer runs than
  `total_count` arrive), reruns each completed run with conclusion `failure` at or below the
  baseline through `POST .../rerun-failed-jobs` (a plain exec, since GitHub answers 201 with no
  body), and reports runs past the baseline that failed again or are running as `skipped`. A run
  past the baseline was rerun already, by this step before a crash, by a person or by an earlier
  round, so it is never rerun again. The plan asked for exactly the baseline; at or below it also
  reruns a failed run no earlier round saw, which no round can have rerun. The step then confirms,
  with the merge's bounds, that every rerun run is queued, running or at a higher attempt, so a
  following `waitChecks` does not read the stale failure; that is best effort and reported as
  `confirmed`.
- **Guarantee classes.** `docs/github.md` names a class for every op, 0046's included: reconciled,
  conditional (check-then-act), conditional (atomic, the merge's `sha`), or at-least-once.

## Consequences

- A crash between a merge, a create or a rerun and its checkpoint no longer repeats it on retry or
  resume, and a merge can never land a head other than the one named. Crash-window tests drive the
  stateful fake `gh`, which commits the write and exits 1 without output.
- The completeness check on the runs list tolerates more rows than `total_count`, because a run
  created between pages repeats a row and a synthesized list is one row with a count of 0; only
  fewer rows fail.
- A rehearsed `pr.edit` or `pr.merge` sees a synthesized head that is never `sha` and returns
  `head-moved` after its read; a rehearsed `pr.create` posts; a rehearsed rerun finds no completed
  failure. Exec fixture rules rehearse the other paths.
- Write response shapes come from GitHub's documentation and read-only probes, never live writes.
  The schemas keep only the fields used, so a response with more fields still validates.
- Closing-keyword rewriting, lease pushes, cross-fork pull requests, custom merge commit messages,
  auto-merge and merge queues stay out of scope.
