# 0045: Head-pinned GitHub waits with pluggable reviewers

- Status: accepted
- Issue: #160 (slice B of #21)
- Builds on: [0020](0020-durable-waits-and-tick.md) (durable waits),
  [0044](0044-gh-backed-github-reads.md) (GitHub reads)

## Context

`ctx.poll` gives a wait its storage semantics (one `wait` record, a deadline, suspend and tick, a
persisted note, error tolerance) but none of GitHub's meaning. The rules for "CI finished", "the
reviewers are done" and "the pull request merged" lived only in `merge-down-pr`'s helper, where each
was learned from an incident: a review reported clean for a head that had already moved, a Codex
summary row read as clean just before its findings landed, a CodeQL alert arriving after the gate
had passed, one 502 aborting a whole wait, and GitHub reporting the previous head for a while after
a push. Every workflow that re-derives these rules can reintroduce one of those incidents.

## Decision

Add `waitChecks`, `waitPr` and `waitReview` to the client that `github(ctx, { repo })` returns. Its
context parameter widens to `Pick<WorkflowContext, 'exec' | 'poll'>`.

- **One poll per wait.** Each wait is exactly one `ctx.poll` under the caller's ID, so it leaves one
  `wait` record whatever the number of checks, suspends and resumes like any poll, and replays its
  terminal value. Every read happens inside the observation through `context.exec.json` with the
  read specs of ADR 0044; a wait creates no exec steps. `waitPr` makes one read per check and uses
  the command form; the others need more than one read per check and use observers. The poll's
  deadline outcome becomes a `timeout` result carrying the last progress.
- **Head pinning before any rule.** Every check reads the pull request head first. A result of
  `success`, `clean` or `merged` is built only when that head equals `sha`; for CI the check
  rollup's commit must equal `sha` too, and a rollup for another commit is a stale view that keeps
  polling. A different head ends the wait with `head-moved`. `waitPr` reports a merge of another
  head as `head-moved`, never `merged`. The pure decision functions encode this, and a table test
  enumerates heads, rollups, states and checks to show no other path reports success.
- **Stale views through compare.** Inside an optional `staleGraceMs` (default 0), a head that `sha`
  descends from, by GitHub's compare API (`ahead`), is a stale view: the wait keeps polling and
  remembers the head in its note. Any other head, and any different head after the window, has
  moved. This replaces merge-down's local `git merge-base --is-ancestor`, which needs a checkout.
- **Typed transient classification.** Each wait sets `onError` with a bounded `tolerate` (default 5)
  and a `classify` that reads only typed facts (ADR 0007): the `ExecError` kind, its exit code,
  whether the schema failure's cause is a JSON `SyntaxError`, a parsed GitHub error body's `status`
  (401, 404) or GraphQL error `type` (`NOT_FOUND`), and the poll timeout's error code. Process
  failures, timeouts, non-JSON output and nonzero exits with an error body are transient; output-cap
  overflows, schema mismatches on exit 0, incomplete collections, permanent GitHub errors and
  reviewer bugs are fatal. A tolerated error keeps the note.
- **Pluggable reviewers with sticky verdicts in the note.** Review detection is a `ReviewerBot`: a
  name, a login, the reads it needs and a pure `observe(activity, context)`. The wait reads the
  union of what unfinished reviewers need, filters comments, reviews and reactions to each one's
  login, and keeps each reviewer's status and returned note under `bots[name]` in the wait's note.
  `clean`, `findings` and `error` are final and never observed again, so a verdict cannot flap and a
  finished reviewer costs no reads. Codex's two-check debounce and CodeQL's settle start live in
  that note, so they survive suspend and tick. Once every reviewer is final, the same check counts
  untriaged threads (unresolved, last comment not the viewer's) and open alerts on
  `refs/pull/N/merge`. `codexReviewer()` and `codeqlReviewer({ settleMs })` port merge-down's rules;
  a third reviewer needs no core change.
- **Internal versioned poll identity.** A poll source may carry a value under the registry symbol
  `Symbol.for('quiet-choir.poll-identity')` (`poll-identity.ts`, built-in helpers only). The wait
  request's `observe` field then holds the digest of `{ helper: value }` instead of the observer's
  (or `done`'s) source text; the request schema is unchanged and polls without the key keep their
  identity. Each wait uses `{ helper: 'github.waitChecks', version: 1 }` and the like, so its
  identity does not depend on the helper's formatting or loader. Its input carries the
  meaning-changing options (repository, `pr`, `sha`, `graceMs`, `staleGraceMs`, `until`, `since`)
  and each reviewer's name, login, reads and `identity`, or the SHA-256 of its `observe` source when
  it gives none. Policy stays out. A change to a wait's meaning must bump its version;
  `test/builtin-identity.test.ts` pins the fingerprints. The integrations import exception grows to
  this key, alongside the error-brand registry (ADR 0028), and to the pure `github-wait-model.ts`.
- **Wall clock in observers.** Observers have no run clock, and adding one would change the public
  model. Each observer reads `Date.now()` once per check and passes it to the pure rules; the first
  check stores `startedAt` in the note, and the no-checks grace, the stale grace and the CodeQL
  settle are measured from it. They never mix with `previous.openedAt`, which comes from the run
  clock, so a custom `RunOptions.clock` cannot combine two clocks; it simply does not move these
  windows.

## Consequences

- A gate that waits for CI and reviewers is a few lines of workflow code (see
  [GitHub waits](../github.md#gate-example)).
- Codex's +1 reaction carries no SHA. It is tied to `sha` only by freshness against `since` and by
  the head check at the same observation, so `since` must be taken at or after the push of `sha`. A
  late review of the previous head could still read as clean, as in merge-down.
- The checks rollup sees only checks GitHub has registered: right after a push, one fast check can
  roll up as success before slower workflows register. Required-check lists are a follow-up.
- Dry runs synthesize a head that never equals `sha`, so a rehearsed wait reports `head-moved`
  unless exec fixture rules answer its reads.
- A future change to a wait's rules must bump its version, which makes in-flight waits of that kind
  refuse to resume ("wait changed") instead of silently running new rules under an old identity.
