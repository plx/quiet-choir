# 0048: An epic snapshot and a pure next-ticket selector

- Status: accepted
- Issue: #163 (slice D of #21, question 4: selection and dispatch recovery)
- Builds on: [0044](0044-gh-backed-github-reads.md) (complete-or-throw reads)

## Context

Burning down an epic one ticket per run needs two things: a complete view of the epic, and a
deterministic, explainable choice of the next ticket. The burn-down workflow written for epic #99
did both itself, in a helper script: it listed sub-issues over REST page by page, read every issue
and the blocked-by relations one command each (about 140 commands for #99), and chose with private
`parseChecklist`, `statusOf` and `pickNext` functions. None of that was reusable from a workflow,
replay-stable as one effect, or unit-tested against a recorded epic.

GitHub's GraphQL API can return the epic, its sub-issues (`subIssues`, `subIssuesSummary`), each
sub-issue's labels, assignees, blocked-by relations, linked pull requests
(`closedByPullRequestsReferences`, with `includeClosedPrs: true` for every state) and comments in
one query. A read-only probe of #99 returned 80 sub-issues and their comments in 687 KB.

## Decision

Add `gh.epic.snapshot(id, { number }, policy?)` to `quiet-choir/github`, and the pure functions
`nextTicket(snapshot, policy?)` and `outsideReferences(snapshot)`.

- **One exec.** The snapshot is exactly one `ctx.exec.json` through the slice-A read path: fixed
  `gh api graphql` argv with `-F number=N`, no `--paginate`, labelled
  `{ integration: 'github', op: 'epic.snapshot' }`. Its identity is the argv, the response schema
  and the plain exec defaults, pinned in `test/builtin-identity.test.ts`. Fetching further pages, or
  the states of issues outside the epic, would make it more than one command, so neither happens
  here.
- **Complete or throw.** The schema fails the read, as `IncompleteCollectionError` that is never
  checkpointed, when the sub-issue page or any sub-issue's labels, assignees, blocked-by relations,
  linked pull requests or comments report another page, and when fewer sub-issues are listed than
  `subIssuesSummary.total`. The count rule is a shortfall, not inequality: only a shortfall can hide
  an item, and `--dry-run` synthesizes one sub-issue with a total of 0, which a strict equality
  would reject in every rehearsal. The ticket asked for "a listed count that does not match"; this
  is the deliberate narrowing.
- **8 MiB default output cap.** `GithubReadSpec` gains an optional `maxOutputBytes` default, which
  the read applies before the caller's policy. It is policy, never identity; an oversized response
  still throws and never shrinks.
- **Parsing in the mapper.** The checkpoint holds the validated raw response; the mapper parses the
  text (checklist, dependency phrases and markers, split markers) on every run and replay, so the
  result is a compact snapshot with no bodies or comments. A parser fix therefore changes results of
  replayed snapshots without changing identity, like any mapper (ADR 0044).
- **Item set and order.** With native sub-issues (`subIssuesSummary.total > 0` or any listed), the
  items are exactly the sub-issues, in the epic body's checklist order and then GitHub's order. A
  checklist line naming an issue that is not a sub-issue stays in `snapshot.checklist` and is
  reported by the selector as `not-a-sub-issue`, never silently dropped. Without sub-issues, the
  items are the checklist lines themselves (`source: 'task-list'`), with checkbox-derived states and
  nothing else. The checklist parser ignores fenced code (backtick or tilde fences, with CommonMark
  closing rules, an unclosed fence running to the end, also inside block quotes and list items, read
  by a character loop over the container markers) and inline code (CommonMark code spans, found by a
  linear scan rather than a backtracking regex), takes each line's first reference to the client's
  repository, and skips the epic itself.
- **Rules taken from the burn-down survey, not the ticket's sketch.** The ticket proposed skipping
  items with an open linked pull request (`has-open-pr`). The survey that has been running epic #99
  instead finishes work already under way, and that is kept: an open linked pull request (drafts
  included) makes an item `in-flight` and picks it first. The full precedence for an open item is
  `in-flight`, `close-split` (a split item whose slices have all closed), `split`, `held` (a hold
  label, default `blocked`, `needs-decision`, `on-hold`), `waiting` (an open "Depends on" / "blocked
  by" / "requires" reference, an `<!-- epic:depends-on N -->` marker, or an open blocked-by
  relation) and `ready`; the pick is the first `in-flight`, else the first `close-split`, else the
  first `ready`, in listing or number order. Every other open item is in `skipped` with its reason,
  and a sub-issue of another repository is skipped as `other-repository`, since the client reads one
  repository.
- **Unknown references count as open.** A dependency or slice that is neither a snapshot item nor in
  `policy.outside` is not known to be done, so it holds its item back. `outsideReferences` lists
  those numbers so a workflow can read them with `gh.issue.view` and pass the results as
  `policy.outside`, keeping the snapshot one command and the selector pure.
- **Viewer-only split markers.** A `<!-- epic:split a,b -->` marker counts only in a comment by the
  authenticated viewer (the snapshot's `viewer`), because a split closes an item once its slices
  close: someone quoting the syntax must not close an unfinished issue. Dependency phrases count
  from any author, because a misread dependency only delays an item.
- **Incomplete is never done.** `nextTicket` throws when a snapshot holds fewer items than its
  `total`, so a hand-built or edited snapshot cannot report an incomplete epic as done.
- **Module layout.** The query, schema, parsers, mapper and selector live in the pure
  `github-epic-model.ts` with its own ESLint purity block (values only from `../index.js` and
  `./github-model.js`; no process or clock).

Claims (`gh.issue.claim`, assignees as locks) and ticking checklist lines are out of scope: they are
writes, and would follow ADR 0046's reconciled-write rules if concurrent runs ever need them.

## Consequences

- A completed snapshot replays forever under its ID. A loop that wants fresh epic state uses a fresh
  occurrence ID, such as `ctx.id('epic', n, round)`; a resumed run acts on the snapshot it recorded,
  so the candidate it picked stays pinned until the next round.
- Assignees are recorded but ignored by the selector, so two concurrent runs over one epic can pick
  the same ticket.
- Linked pull requests are those GitHub links to the issue: through a closing keyword in a pull
  request into the default branch, or by hand. A pull request stacked on another base, or one that
  works on an issue without a closing reference, is not seen, so its ticket can be picked again.
- GitHub Enterprise Server versions or accounts without sub-issues or issue dependencies lack the
  `subIssues` or `blockedBy` fields, so gh exits 1 and the read rejects; there is no fallback query.
- An epic with more than 100 sub-issues, or a sub-issue with more than 100 comments, cannot be
  snapshotted; the read throws rather than returning a shorter list.
- Changing the query or schema changes the read's identity and strands in-flight runs at that read;
  the golden digests make such a change deliberate.
