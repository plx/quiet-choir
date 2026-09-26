# 0003: Separate workflow outcomes from checkpoint failures

## Status

Accepted.

## Context

An external effect can succeed while saving its completion fails. Retrying the action in response
would duplicate work, while a rejected write queue could prevent every later save. Storage and
cleanup errors also hid the workflow's original error, and lock cleanup could turn an already
persisted completion into a reported failure.

## Decision

Keep writes ordered, but isolate each write's rejection from subsequent writes. Retry known
transient filesystem errors up to three attempts (100 ms and 300 ms delays). Take snapshots when
writes execute. After exhausted retries, abort scheduling and drain active effects; failure-state
saves can still attempt to preserve the latest in-memory state.

Action/validation failures and completion-save failures have separate control paths. Only action
failures enter an explicit effect retry policy. A successful effect remains completed in memory if
its save fails. Later successful saves can preserve that completion; otherwise replay may repeat it
under ADR 0002's at-least-once contract.

Export `CheckpointError` with `save` and `release` operations and an underlying cause. Preserve
error precedence: workflow/effect error, save errors, then release errors. Multiple problems become
an `AggregateError` with the primary message first, since the CLI presents that message.

A saved completion resolves with invocation warnings if release fails with `EACCES` or `ENOENT`.
Other release failures, including changed or unknown ownership, remain fatal. Return cleanup
warnings to embedding/JSON callers and print them on CLI stderr. Do not persist warnings after
ownership has been released. Name a removed state directory and never recreate/reacquire it
implicitly.

## Consequences

Transient storage failures can recover without repeating external work. Persistent failures still
require operator attention, and the last saved record can remain `running` with `error: null`. A
reported checkpoint failure may have been superseded by a later save; inspect persisted state before
resuming. Successful runs with cleanup warnings may still need manual lock repair. This preserves
the local single-writer boundary without promising transactional external effects.
