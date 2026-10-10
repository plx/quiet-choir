# 0021: Keep deterministic commands and file effects in the durable core contract

Status: accepted in the prototype stack. Amended by #349 (an accepted nonzero exit whose stdout is
not JSON is kind `process`).

## Context

Workflows were delegating Git reads, test verdicts, and text writes to agents, or rebuilding process
handling in local callbacks. That lost exit diagnostics, idempotency metadata, and descendant
cleanup.

## Decision

Add `exec`/`exec.json` through an injected `ProcessRunner` port. The CLI supplies
`NodeProcessRunner`, which shares the native adapters' owned-process implementation. Keep agent
admission, grants, and usage separate from operator commands. Record command summaries and bounded
failed-attempt exit information, while hashing explicit environment values and stdin. Plain output
retains bounded head/tail; JSON refuses truncation. Command meaning is identity;
deadlines/caps/retry are policy.

`exec.json` failure kinds (amended by #349): an exit outside `okExitCodes` or a signal is `process`;
a truncated capture is `output-limit`; stdout that is not JSON after an accepted nonzero exit
(listed in `okExitCodes`, or `'any'`) is `process`, because the command failed and printed no body,
and the caller accepted that exit only to read one; any other stdout that does not parse, or JSON
that fails the schema, is `schema`. The rule reads only the exit code and whether `JSON.parse`
succeeded, never message text (ADR 0007), so an explicit retry on `process` covers a tool such as
`gh` exiting 1 with empty or partial output after a dropped connection without also retrying a
contract violation. The failure keeps the `SyntaxError` as its cause and has no `parsed`; fixture
export reproduces it as a `{ stdout, code }` rule. Failures recorded before the amendment keep their
recorded kind.

Add regular-file reads and atomic UTF-8 writes with canonical cwd path guards. Write receipts
contain hashes, never supplied content. Conditional replacement is optimistic; create-only
publication is exclusive. Expose run cwd to callbacks. A Git-backed `guardFile` composes durable
commands and a settled one-item map, so restore can resume after a terminal body without rerunning
it. Blob bytes stay within the restoring process. The body outcome is intentionally terminal for the
guard ID.

## Consequences

Embedded command workflows require an adapter. Custom mock integrations must use separate state from
real work. CLI dry-run supplies a process-free runner; file/local effects retain the existing
real-unless-stubbed rule. At-least-once external actions, escaped process groups, races with other
writers, and restoring before a hard-killed body retries remain outside the guarantee. See
[command and file contracts](../command-effects.md). Port migrations and cost comparisons remain the
separate #65 ticket; this decision supplies their primitives.
