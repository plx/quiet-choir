# 0044: gh-backed, complete-or-throw GitHub reads

- Status: accepted
- Issue: #159 (slice A of #21; the ticket called this ADR 0028, a number now taken by the
  error-brand decision)
- Amends: [0027](0027-typed-harness-registry-and-integration-helpers.md) (`ExecOptions.meta`)

## Context

GitHub workflows such as `merge-down-pr` re-implemented the same reads as untyped `gh` calls: the
repository and viewer, a pull request with its check rollup and closing issues, review threads,
issues with comments, stacked pull requests and code-scanning alerts. Two defects recurred. A nested
GraphQL connection such as a thread's `comments(first: 50)` was never checked for another page, so a
long thread shrank silently. Code scanning "not enabled" was recognized by matching a thrown error's
message and returned as `[]`, so a caller could not tell "no alerts" from "not set up".

#21 settled the durability answer: memoized reads with fresh occurrence IDs, `gh` first. A helper
also has to fit ADR 0027 (one workflow-level operation per helper call) and keep step identity free
of interpreter paths and program source (#107).

## Decision

Add the `quiet-choir/github` subpath. `github(ctx, { repo })` returns `repo.info`, `pr.view`,
`pr.list`, `pr.reviewThreads`, `issue.view` and `codeScanning.alerts`.

- **One exec per read, argv-only identity.** Each read is exactly one
  `ctx.exec.json(id, argv, { schema, meta })` with the caller's ID, pure `gh` argv, no environment
  overlay, no stdin and the workflow cwd. Its identity is therefore the argv (the GraphQL query or
  REST path is the read's specification, not program source), the response schema and the fixed exec
  defaults; `test/builtin-identity.test.ts` pins it. Authentication stays in gh and its inherited
  environment; no token is ever in argv or an overlay.
- **Every read is `gh api`.** gh's own `--json` output for `pr view` or `pr list` hides nested
  `pageInfo`, so a check rollup or closing-issue list over gh's internal page size would shrink
  silently. Using `gh api` (GraphQL, or REST for code scanning) keeps every `pageInfo` visible.
- **Paginated GraphQL in one exec.** `pr.list`, `pr.reviewThreads` and `issue.view` with comments
  run `gh api graphql --paginate --slurp`. gh follows the first `pageInfo { hasNextPage endCursor }`
  in the response, which is document order, so each paginated query declares `$endCursor: String`,
  passes `after: $endCursor` to exactly one connection, and requests that connection's `pageInfo`
  before its nodes and before every other connection (comments before labels). Nested connections
  request only `hasNextPage`. A unit test pins the ordering.
- **Complete-or-throw in the schema.** The response schemas validate and strip but never transform,
  because replay re-parses the checkpoint with the same schema and identity hashes its JSON Schema.
  Their `superRefine` checks require at least one page, `hasNextPage: false` on the last page of a
  paginated connection, and `hasNextPage: false` on every nested connection (thread comments,
  closing issues, check contexts, labels). A violation adds a Zod issue with an
  `incompleteCollection` param, so the exec fails with a `schema` `ExecError` and nothing is
  checkpointed as completed; a resume runs the read again. The helper rethrows that as a branded
  `IncompleteCollectionError` with the connection, the read's ID and the `ExecError` as `cause`, so
  the run's root cause still names the read's step. Completeness is never checked after the exec:
  that would checkpoint a partial value as completed and replay the throw forever. Pure mappers turn
  the validated response into the typed result, after the exec and on replay alike.
- **Code scanning "unavailable" is data.** `codeScanning.alerts` accepts exits 0 and 1, because gh
  exits 1 on an HTTP error and prints the body on stdout. The response is one alert array or a
  GitHub error body. An error body passes only when its message says code scanning is not set up
  (`no analysis found`, `code scanning is not enabled`, `advanced security must be enabled`); the
  result is then `{ status: 'unavailable', reason, alerts: [] }`, a completed output that replays.
  Any other body, an empty stdout, a 5xx page after alerts, or another exit code rejects without
  settling. `onError: 'return'` is never used, since it would settle a transient failure
  permanently.
- **`ExecOptions.meta`.** Exec options gain JSON labels recorded on the step like
  `StepDefinition.meta`, outside identity and policy; a callback's `context.exec` rejects them
  because it writes no record. Each read records `{ integration: 'github', op }`, which `inspect`
  shows as `github.pr.view` and so on.
- **Hosts.** `HOST/OWNER/REPO` adds `--hostname HOST` right after `api`; `OWNER/REPO` uses gh's
  default host. `parseGithubRepo` accepts only `[A-Za-z0-9_.-]` segments that do not start with `-`
  and a hostname, so a spec cannot inject a flag or a path. The `-R` mapping for `pr`/`issue`
  subcommands is unused here and arrives with the first write that needs one (#161, #162).
- **Policy only.** A read accepts `timeoutMs`, `maxOutputBytes` and `retry`, never identity-bearing
  exec options. There is no default retry: telling a transient gh failure from a permanent one would
  mean guessing from messages, which ADR 0007 forbids.
- **Module layout.** Queries, schemas and mappers live in the pure `github-model.ts` with an ESLint
  purity block. Integration helpers otherwise import only the public entry point; `github.ts` may
  also import `error-brand.js`, because the brand registry is a cross-instance contract (ADR 0028),
  not runtime state.

Octokit could later sit behind the same signatures; this slice does not add it.

## Consequences

- A completed read replays forever under its ID. Observing new state needs a fresh occurrence ID,
  such as one keyed by round or head SHA, or a wait (#160). IDs inside loops must be unique per
  iteration (QC005). Reads are at least once and safe to repeat.
- Changing a query, the argv shape or a response schema changes that read's identity and strands
  in-flight runs at that read; the golden digests make such a change deliberate (#131).
- Reads of GitHub Enterprise Server versions that lack a requested field (for example
  `mergeStateStatus` or `closingIssuesReferences`) fail loudly through gh's exit 1; this has not
  been validated against a live GHES.
- Output caps throw: a read larger than `maxOutputBytes` (1 MiB by default) rejects and never
  shrinks, so callers raise the cap for large thread or comment sets.
- Code scanning runs `gh api --paginate` without `--slurp`, because an exec schema cannot see the
  exit code. gh 2.100 closes a slurped outer array even when a later page fails, so more than 100
  alerts followed by a dropped connection or a 5xx would read as a complete list. Without `--slurp`,
  gh merges REST array pages into one array and writes its closing `]` only after the last page, so
  any failure after the first page leaves unparseable JSON and the read rejects. This relies on that
  gh behavior (checked against gh 2.100 with a local server); the code-scanning golden digest makes
  a change to the argv deliberate. GraphQL reads keep `--slurp`: they accept only exit 0, and their
  last page would also report another page.
- `--dry-run` synthesizes every read from its JSON Schema (booleans false, one-item arrays, the
  first union branch), and the synthesized responses pass the completeness checks and the mappers.
