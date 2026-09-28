# 0021: Keep deterministic commands and file effects in the durable core contract

Status: accepted in the prototype stack.

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
