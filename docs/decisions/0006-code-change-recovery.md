# 0006: Explicit reuse after workflow code changes

## Status

Accepted. Extends ADR 0005 with callback identity, explicit code acceptance, and fork reuse. Strict
resume remains the default. Checkpoint format 3 supersedes format 2 for execution and reuse. Amended
by #126: the CLI refuses an accepted replay that would fail on a changed completed step before it
changes the run.

## Context

A byte edit in reached source made a CLI run unrecoverable, even when only its final report logic
failed. Relaxing that gate alone would reuse stale local results because declared dependencies do
not describe callback logic. Recovery needs explicit choices, inspectable provenance, and continued
checks on completed effects.

## Decision

Local identity includes the loaded callback's `Function.prototype.toString()` and an optional step
version, plus declared input, schema, and run cwd. The CLI's tsx transform normalizes callback
comments/formatting; other loaders and compiler versions may produce extra misses. Captured values,
external helpers, environment, and bound/native implementations are not visible. Authors declare
those dependencies in input, version them, or invalidate them explicitly.

Strict resume compares canonical source/schema/engine metadata, name/version, cwd, and validated
input. Source files are realpathed, named relative to the selected tsconfig directory or nearest
package root (entrypoint directory fallback), and hashed individually. Own engine src/dist files are
excluded except explicit entrypoints. Engine package and checkpoint versions replace those
implementation files in run identity. This is not exhaustive package/environment dependency hashing.
Validation and execution share the same full fingerprint. Lock-free check-resume typechecks/imports
trusted top-level code and reports run gates; it never runs the workflow body and cannot preview its
dynamic step checks. Its result is a snapshot, not a reservation against concurrent writers.

Explicit accept-code-change waives only code and run-schema drift. Other gates and completed-step
identity checks remain. It records old/new fingerprints, changed files/components, and time, then
replays the body even for a previously completed run. The accepted identity persists before effects,
including when the invocation fails. A tail/output fix can reuse every effect while computing a new
final result. Failed local callbacks can adopt new identities under ADR 0005. Domain exceptions keep
their original identity; saved recoveryHint and CLI diagnostics explain refinalization
opportunities.

A fork creates a new checkpoint with the same workflow name and optional new input/version/source.
It inherits source input when omitted, but starts with its own policy rules. It reads a source
snapshot without locking or writing it. Only completed, revalidated, matching effects may be copied,
with reusedFrom provenance. Default prefix reuse consumes source first-use order and closes on the
first miss, including skipped or invalidated source work. Matching mode is explicit because later
results may depend on filesystem side effects of earlier effects that reran. Neither mode restores
workspace state or creates isolation. New live effects use the target run's idempotency keys.

Fork provenance pins a digest, mode, invalidation globs, differences, and prefix progress. Copied
results are durable in the target and do not require a live source later. On target resume, a
changed/unavailable source closes remaining reuse and emits a saved warning; remaining effects run
live. This preserves prior copies without silently borrowing a newer source snapshot or bricking the
target. Prefix decisions are synchronous before checkpoint awaits, preserving launch order under
concurrency. A changed concurrent schedule can cause extra live work, not reuse past a known miss.

Every first-use step gets a unique seq. Before live work that skips earlier completed steps, the
runner saves a warning and emits replay.divergence. Strict replay aborts immediately, before waiting
on persistence, so concurrent launches cannot bypass the guard. The warning is a concurrency
heuristic and does not replace the end-of-body completed-step check. Ordinary warning mode may still
perform new effects before final rejection.

Formats 1 and 2 remain readable for inspection, but execution/fork refuses them without modifying
checkpoint data. They lack callback/source/order metadata needed to justify this reuse contract. Use
the original runtime to resume or account for previous effects in a new run. No automatic migration
or callback-capture inference is introduced.

## Consequences

Agents can fix late bugs without repaying unchanged calls, while an edited completed local callback
cannot silently return stale data through accept-code-change. Reuse is explicit and recorded. The
remaining dependency gaps are real: callback hashing is useful evidence, not full closure capture.
All filesystem and external effects retain at-least-once behavior and are never rolled back.

## Amendment: refuse divergent accepted replays (#126)

Following the plain-resume advice for an edit to a completed step recorded the acceptance, cleared
the saved output and replaced the fingerprint, then failed on the step check. A completed run ended
`failed` with no output, and a suspended run waiting on a human ended `failed`.

The accepted identity still persists before effects for an admitted invocation. Before admitting
one, the CLI replays the accepted body against a disposable copy of the record (the
`--dry-run --resume` machinery). The copy disables fixtures and stubs every unfinished local step,
file effect, poll observer and command, so no unfinished callback runs live; completed effects
replay their saved outputs. When the copy meets a completed or settled-failed step whose identity
changed (the runner's typed `StepIdentityChangedError`), the command refuses with
`run.incompatible`, `details.divergent` (the first such step and its changed components) and
`details.next` (the `--fork-from RUN --reuse matching --invalidate STEP` command). Status,
fingerprint, output and `codeChanges` stay unchanged. `--dry-run --resume --accept-code-change`
returns the same refusal, and check-resume stays body-free but points at that preview.

The preflight fails open: completion, suspension, a refusal before the body, a rehearsal limitation
(such as a Git worktree effect) or any other failure admits the real invocation, which reproduces
any genuine problem itself. Synthesized outputs can steer the copy down another branch, and an
answer delivered but not yet consumed is not copied, so a divergence past that point can still be
missed; the real run then fails as before, now with the typed cause and the fork recipe. The
preflight reads without the writer lock, so like check-resume it is a snapshot, not a reservation
against concurrent writers. The workflow body, but no unfinished callback, runs once more per
accepted resume. Embedded `runWorkflow({ acceptCodeChange: true })` callers get the typed
`StepIdentityChangedError` cause but no preflight.

## Amendment: recovery hints by typed cause (#276)

The saved `recoveryHint` advertised `--accept-code-change` whenever all recorded work was terminal,
which was vacuously true with nothing recorded and wrong for a grant failure or a nondeterministic
replay divergence. The runner now classifies the failure from typed errors and the saved record,
never from message text: a missing grant (`GrantRequiredError`, a `ConfigurationError`), a replay
divergence (`ReplayDivergenceError` or `StepIdentityChangedError`), another configuration failure, a
cancelled run, a recorded effect failure, or otherwise an authoring failure. The pure
`recovery-hint.ts` chooses the text. A grant failure names `--resume --grant`; a divergence names
`--strict-replay` and `--fork-from` and, with unchanged source, a value computed in the body outside
`ctx.now` or `ctx.step`; only a configuration or authoring failure mentions `--accept-code-change`,
keeping the re-finalize text when all recorded work is terminal; an effect failure or a cancellation
gets a plain resume. A run with no recorded step or map, and a dry-run, get no hint, and
`hasTerminalOutcomes` (and so check-resume's `refinalizable`) is false for a run with nothing
recorded. The CLI appends the hint only to the invocation's own `WorkflowRunError`, never to a
refusal or a dry-run, and a divergence refusal still never advertises the path it refused.
