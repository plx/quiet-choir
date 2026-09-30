# 0014: Preserve saved state through the CLI error boundary

## Status

Accepted.

## Context

Scripts could parse successful runs, but failures lost their run ID, root step, and saved record.
Exit 1 mixed executed failures with loading, usage, and ownership problems. A storage failure can
leave an older checkpoint, so classifying every execution exception as a saved failure is unsafe.

## Decision

Core errors carry typed context. `WorkflowRunError` wraps the prior rejection only after a failure
snapshot saves successfully; failure attribution reuses the existing scope-aware origin tracker.
`RunRefusedError` carries stable run codes/details, and `WorkflowInputError` identifies schema
validation separately from effect failures. Checkpoint aggregates keep their prior precedence.

Executors flatten errors into plain data. The CLI owns the single numeric-exit table and renders one
JSON envelope on failure. Exit 1 requires a saved failed run; storage errors use exit 74 and report
observed state without fabricating a failure checkpoint. Existing completed-run warnings remain
successes. Interrupts use 130 and the current cancelled/forced-cleanup contract. Exit 75 remains
reserved for suspension. [ADR 0029](0029-persist-interruptions-as-resumable-suspensions.md) later
saves a first signal as a resumable `suspended` run that still exits 130.

A workflow command base catches parsing failures, redirects workflow stdout during import/run, and
restores streams for embedding tests. It deliberately keeps normal oclif logging enabled, so stderr
diagnostics are not suppressed by oclif's built-in JSON behavior. Both launchers reject misplaced
topic flags before oclif can interpret them as successful help, and normalize dispatch errors.

Run IDs, entrypoints, and inline/file/stdin JSON are checked before importing trusted code. Input
schema validation still needs the loaded definition. Neither validation nor output redirection
isolates module side effects or rolls back external effects.

## Consequences

Callers can select repair/resume actions by code and use the included record directly. Existing
embedders matching rejection classes must now inspect `WorkflowRunError.cause`. Check-resume
incompatibility uses the shared exit-3 envelope. CLI success shapes and checkpoint format 5 remain
unchanged. Lost output pipes, SIGKILL, and process crashes cannot produce a result document.
