# 0006: Explicit reuse after workflow code changes

## Status

Accepted. Extends ADR 0005 with callback identity, explicit code acceptance, and fork reuse. Strict
resume remains the default. Checkpoint format 3 supersedes format 2 for execution and reuse. Amended
by #126: the CLI refuses an accepted replay that would fail on a changed completed step before it
changes the run. Amended by #144: steps also carry launch, settle and failure stamps, and the
healed-step check uses them instead of `seq` (ADR 0007). Amended by #145: default fork prefix reuse
is causal and treats named-map items as independent, instead of closing at the first miss. Amended
by #146: explicit acceptance reaches settled maps, which record their own `codeChanges` entries.

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
with reusedFrom provenance. Default prefix reuse is causal (#145, below): a step is copied only when
every source step that had settled before it launched was copied too, and no live step of the fork
settled before the fork requested it. Sibling items of a named map do not count. Skipped, changed or
invalidated source work therefore stops reuse for the steps launched after it settled, not for its
same-tick siblings. Matching mode is explicit because later results may depend on filesystem side
effects of earlier effects that reran. Neither mode restores workspace state or creates isolation.
New live effects use the target run's idempotency keys.

Fork provenance pins a digest, mode, invalidation globs, differences, and prefix progress. Copied
results are durable in the target and do not require a live source later. On target resume, a
changed/unavailable source closes remaining reuse and emits a saved warning; remaining effects run
live. This preserves prior copies without silently borrowing a newer source snapshot or bricking the
target. A prefix decision and the insertion of its copy are synchronous, before checkpoint awaits,
so a concurrent launch always sees the copies made before it. A changed concurrent schedule can
cause extra live work, not reuse past a known miss.

Every first-use step gets a unique seq. Before live work that skips earlier completed steps, the
runner saves a warning and emits replay.divergence. Strict replay aborts immediately, before waiting
on persistence, so concurrent launches cannot bypass the guard. The warning is a concurrency
heuristic and does not replace the end-of-body completed-step check. Ordinary warning mode may still
perform new effects before final rejection.

`seq` is launch order, not causality, so the healed-step check does not use it when it can avoid it
(#144). The run keeps a settlement counter, derived at run start from the highest persisted stamp
like `nextSeq`, so the checkpoint format is unchanged. Each terminal settlement increments it and
records `settleStamp`; a terminal failure also records `failureStamp`, kept until the step
completes, so the earliest failure since the last success wins. Each live launch records
`launchStamp`, taken synchronously when the body requests the effect, before awaited preparation.
When a failed step heals, a recorded step is flagged when its `launchStamp` (as saved before this
execution) is at least the healed step's `failureStamp`: it was launched after the failure could be
observed. Same-tick `Promise.all` siblings are therefore not flagged. When either stamp is missing,
for legacy records or a failure saved between retries, that pair falls back to the `seq` rule. The
rule is a conservative watermark: a step launched later by unrelated control flow is still flagged.
Fork-reused copies are stamped on the target run's clock. The pre-live skipped-step check above
still compares `seq`. `workflow resume` accepts `--strict-replay` like `execute --resume`.

Formats 1 and 2 remain readable for inspection, but execution/fork refuses them without modifying
checkpoint data. They lack callback/source/order metadata needed to justify this reuse contract. Use
the original runtime to resume or account for previous effects in a new run. No automatic migration
or callback-capture inference is introduced.

## Consequences

Agents can fix late bugs without repaying unchanged calls, while an edited completed local callback
cannot silently return stale data through accept-code-change. Reuse is explicit and recorded. The
remaining dependency gaps are real: callback hashing is useful evidence, not full closure capture.
All filesystem and external effects retain at-least-once behavior and are never rolled back.

## Amendment: causal prefix reuse (#145)

Default prefix reuse walked the source steps in global first-use (`seq`) order with one cursor and
closed reuse for the whole fork at the first mismatch. A fork replays copies almost synchronously,
so a concurrent named map requests its items in a different order than the source launched them. An
unchanged 12-item, 3-stage map at concurrency 6 reused 6 of 36 steps and ran 30 live; editing only
stage 3 also ran 30 live where 12 were needed. In a merge-down port, `Promise.all` ran the
implementer and an issue-filing `fix/1/followups` step together; forking with
`--invalidate 'fix/1/impl*'` re-ran the completed, independent followups step live and filed its
issues again. `--reuse matching` avoided both, but it reuses by ID alone and can return a result
whose undeclared filesystem inputs changed.

The rule now uses the stamps from #144 and the target's own record. A requested step X that passes
the identity checks (terminal source step, same kind and fingerprint, not invalidated, valid output)
is reused when `forkPrefixBlockers` in `replay-decision.ts` finds nothing:

- Every source step Y that X may have depended on is already reused into the target, with
  `reusedFrom` naming this source and Y's ID. Y may have been a cause when it had settled when X was
  launched in the source (`Y.settleStamp <= X.launchStamp`). A source step that never settled is not
  a cause. When either launch stamp is missing (a source saved before #144), the pair falls back to
  launch order: Y is a cause when its `seq` is lower.
- No step that ran live in the fork (no `reusedFrom`) settled before the fork requested X (its
  `settleStamp` is at most X's target `launchStamp`). A live re-run may have produced outputs or
  files that X now reads. This also decides a miss with no source counterpart, a new step ID: it
  closes reuse only for steps requested after it settled, not for its same-tick siblings.
- Neither rule counts a step in a sibling item of a named map that encloses X, at any level of
  nesting. Named-map items receive only their item value and their prefixes are declared item
  boundaries (ADR 0009), so the runtime treats them as independent. The naming context records the
  enclosing items with each ID prefix, so `within` views, child workflows and nested maps report the
  same items as the ID. `ctx.scope` and `within` siblings are not independent: they often run in
  sequence and share closure state (a plan step, then a build step), so stamps order them. A
  positional map adds no item prefix and also relies on stamps alone.

An unchanged concurrent named map now reuses every step whatever the schedule, an edit to stage 3
runs only the stage-3 calls live, and the port's followups step is reused. A step launched after a
missed step settled, such as a check after the `Promise.all` or a root step over the map results,
still runs live, and a sequential chain still re-runs from its changed step.

Proposal 1 of #145 was a persisted cursor per scope. It is not needed: reuse progress is the set of
reused copies already saved in the target, with their target-run stamps, so a resumed fork target
keeps its progress without new fields. A per-scope cursor would still close on harmless order
differences inside a scope, and it would duplicate (and could disagree with) those copies. Its job,
keeping a removed or skipped earlier step from being bypassed, is done by the first rule, because
such a step is never reused.

`ForkProvenance` keeps its schema, so records from either build load. `reuseClosed` now means only
that reuse is closed for the whole fork: the pinned source changed or became unavailable, or an
older build closed it on a prefix miss. A target saved that way stays closed on resume. `cursor` now
counts the source effects reused by prefix reuse; older builds used it as a position in source
launch order, and an older build reading a new record would miss and close, which is conservative.

Limitations remain. Treating named-map items as independent assumes they communicate only through
their item value and the map result; items that share mutable closure state or files can now reuse a
stale result, and `--invalidate` remains the way to force them live. A cause that the fork has not
requested yet blocks reuse, so a concurrent multi-step chain in one non-map scope can still pay for
a few extra live calls when the fork requests steps in a different order than the source settled
them; named maps and `--reuse matching` avoid it. Kinds that are never reused (worktree steps) and
fresh questions run live and settle, so their later dependents run live too. Each prefix decision
scans the source and target steps once, which is negligible for hundreds of steps.

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

## Amendment: settled map acceptance (#146)

`acceptCodeChange` now reaches settled maps: a committed map whose only changed identity component
is its mapper is accepted (ADR 0008). Each accepted map appends one `CodeChange` with `map` set to
its journal ID, `from` and `to` set to the map's old and new aggregate fingerprints, empty `files`
and `components: ['mapper']`, in the same save that updates the journal, so it is never repeated.

Map acceptance does not require a run-level change in the same resume. Embedded runs may have no
source fingerprint (`code: null`), where the run-level gate cannot see a mapper edit, and after an
accepted resume that failed before reaching the map, the run-level fingerprint is already updated
while the map still needs acceptance. The explicit flag is the operator's consent; run-level and
map-level entries are recorded independently.

A settled map refusal is a new typed recovery cause, `map-changed`, checked after divergence and
before configuration. A mapper-only change suggests `--resume --accept-code-change`; any other map
change, or a journal saved without components, suggests restoring the map or `--fork-from`, never
`--accept-code-change`. The #126 preflight replays with acceptance, so it now passes a mapper-only
map change; a non-mapper map refusal under acceptance still fails the real run after the run-level
entry is written, as before.
