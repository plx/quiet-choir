# 0046: Reconciled GitHub writes

- Status: accepted
- Issue: #161 (slice C1 of #21)
- Builds on: [0021](0021-durable-commands-and-files.md) (commands),
  [0044](0044-gh-backed-github-reads.md) (GitHub reads), [0045](0045-head-pinned-github-waits.md)
  (versioned helper identity)

## Context

Effects are at least once: a step whose callback writes to GitHub and then crashes before its
checkpoint commits runs again on retry or resume. `docs/command-effects.md` told workflows to
reconcile their own writes, and `docs/waits.md` to do it inside `ctx.step` with idempotency keys,
markers or conditional APIs, but nothing packaged that. `merge-down-pr`'s helper posts thread
replies and review requests unconditionally, and protects itself only with a saved `last/` output
that a relay re-reads; a quiet-choir step has no such relay. GitHub offers no conditional update for
the writes this slice covers: issue state and bodies have no `If-Match`, and resolving a thread or
dismissing an alert does not check a version.

## Decision

Add `comment`, `thread.reply`, `issue.create`, `issue.close`, `issue.reopen` and `alert.dismiss` to
the client that `github(ctx, { repo })` returns. Its context parameter widens to
`Pick<WorkflowContext, 'exec' | 'poll' | 'step'>`.

- **One step per op, identified by a version.** Each op is exactly one `ctx.step` under the caller's
  ID, with the internal `identity: 'version'` that `decision.choose` uses and a version constant per
  op (`github.comment/1` and so on). The input is the repository key and the normalized arguments;
  the result schema is fixed. The callback's source text never enters identity, so a reformatted or
  differently loaded helper cannot strand a run, and a deliberate behaviour change bumps the
  version. Policy (`timeoutMs` and `maxOutputBytes` per command, `retry` for the step) stays out of
  identity. Each step records `meta: { integration: 'github', op }`.
- **Commands inside the step.** Every read and write of an op runs through `StepContext.exec.json`
  (#150), so the commands are owned by the step's attempt, rerun with it, and are synthesized under
  `--dry-run` and listed with the step as their parent. No new runtime primitive is needed.
- **Marker reconciliation for writes that create.** `comment`, the reply of `thread.reply`,
  `issue.create`, and the optional comment of `close` and `reopen` append
  `<!-- quiet-choir:RUN/STEP -->`, the step's idempotency key, after a blank line, and search for
  that exact full marker before writing. The key holds only run and step IDs, whose characters
  cannot end an HTML comment. A fork has a new run ID and so writes again whatever its source left
  unfinished; a human edit that removes a marker defeats it. Both are documented.
- **The REST issue list, not search.** `issue.create` searches the viewer's issues in the repository
  through `GET repos/O/R/issues?creator=VIEWER&state=all&sort=created&direction=desc`, page by page,
  stopping at the marker. GitHub's search index lags, and would miss exactly the issue a crashed
  attempt has just created. The cost of a miss is a scan of every issue the viewer created there; no
  heuristic bound is added, since one could miss. The list is assumed to show a new issue at once;
  GitHub documents no guarantee, and this burn-down forbids a write probe, so the residual risk is
  stated in the guarantees table. The `creator` filter also assumes the same `gh` account across
  attempts and resumes: a retry after authentication switches to another account does not see the
  earlier account's marked issue and can create a duplicate. Dropping the filter would make every
  miss page through every issue and pull request in the repository, a far larger cost for the rare
  account switch mid-run, so the limit is documented instead.
- **Sub-issue links are looked up, never assumed.** Re-linking an already linked sub-issue is not
  documented behaviour, so `issue.create` first reads the wanted parent's node ID, before any write,
  so a parent that does not exist (or is a pull request) fails before the issue is created (amended
  by #353; it used to fail after, leaving an unlinked issue). An issue found by its marker has its
  parent read (by node ID): no parent links with `addSubIssue` (never `replaceParent`), the same
  parent is a no-op, and another parent throws without a write. An issue this attempt just created
  has no parent, so it is linked directly with the node ID the POST returned; if something links it
  first, GitHub refuses, and the retry takes the found path.
- **Conditional check-then-act where no marker applies.** `close`, `reopen` and `alert.dismiss` read
  the state and write only when it still needs to change: `ifState` (`open` for `close`, `closed`
  for `reopen`) and an alert that is neither dismissed nor fixed. Without `If-Match` a concurrent
  change between the read and the write is not detected; that is stated per op. The optional comment
  of `close` and `reopen` is posted before the state change, because after a crash past the change
  the retry skips. `acted`, `created` and `dismissed` therefore describe the attempt, not the step.
  `thread.reply` resolves only when wanted (by default for bot threads, merge-down's rule) and the
  read reported the thread unresolved.
- **Request bodies on stdin.** Writes send JSON on stdin (`gh api -X METHOD PATH --input -` for
  REST, `gh api graphql --input -` with `{ query, variables }` for mutations). Bodies stay out of
  argv: out of process listings, clear of Linux's 128 KiB per-argument limit and gh's `-F @file`
  expansion, and out of the rehearsal report.
- **Rehearsal steers to the write path.** Response schemas order their enums and union branches so
  that synthesis yields an open issue, an unresolved thread, an open alert and an unlinked issue;
  synthesized bodies never carry a marker. A rehearsed `reopen` sees an open issue and skips; this
  is documented rather than special-cased.
- **Pure rules.** The marker, request builders, response and result schemas, and the decisions
  (`shouldResolve`, `parentDecision`, `stateMatches`, the alert reason rule and the 280-character
  comment truncation) live in `github-write-model.ts` under an ESLint purity block; the step
  callbacks are in `github-writes.ts`.

## Consequences

- A crash between a GitHub write and its checkpoint no longer repeats the write on retry or resume
  for the reconciled ops, and the conditional ops repeat nothing whose precondition no longer holds.
  Crash-window tests drive a stateful fake `gh` that commits a write and then fails.
- Callers that passed `github()` a context with only `exec` and `poll` must also pass `step`; a real
  workflow context is unaffected.
- Reactions, comment edits and deletions, and issue body edits are not provided: without a
  conditional API they could only be at least once. Pull request writes follow in #162.
- Write response shapes come from GitHub's documentation, not live probes. The schemas keep only the
  fields used and strip the rest, so a response with more fields still validates; a schema failure
  after a committed write costs an attempt, which the marker search then recovers.
