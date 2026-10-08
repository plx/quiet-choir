# 0006: Explicit reuse after workflow code changes

## Status

Accepted. Superseded in part by [ADR 0007](0007-durable-failure-outcomes.md) (its checkpoint-format
choice). Extends ADR 0005 with callback identity, explicit code acceptance, and fork reuse. Strict
resume remains the default. Checkpoint format 3 supersedes format 2 for execution and reuse. Amended
by #126: the CLI refuses an accepted replay that would fail on a changed completed step before it
changes the run. Amended by #144: steps also carry launch, settle and failure stamps, and the
healed-step check uses them instead of `seq` (ADR 0007). Amended by #145: default fork prefix reuse
is causal and treats named-map items as independent, instead of closing at the first miss. Amended
by #146: explicit acceptance reaches settled maps, which record their own `codeChanges` entries.
Amended by #215: `runWorkflow` itself runs the #126 preflight, so embedded accepted resumes refuse
without changing the run too. Amended by #216: the preflight also refuses an accepted body that
would skip a completed step, settled map or child frame (`ReplaySkippedError`). Amended by #217: the
preflight synthesizes every Git worktree effect and consumes delivered but unconsumed answers, so it
no longer stops early at either. Amended by #284: a failed run saves its typed recovery cause, and
its `next` entries follow that cause as its recovery hint does. Amended by #300: a terminal failure
also appends to a bounded `failureHistory`, which makes the healed-step check per launch. Amended by
#302: steps record the named-map items that enclosed their launch, so prefix reuse also treats
source steps under a key the fork dropped as sibling items. Amended by #303: the preflight also
refuses an accepted resume that would meet a settled map changed beyond its mapper
(`SettledMapChangedError`).

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
(#144). The run keeps a settlement counter, derived at run start as one past the highest persisted
stamp like `nextSeq`, so the checkpoint format is unchanged and every launch of a later execution
follows every stamp an earlier one saved. Each terminal settlement increments it and records
`settleStamp`; a terminal failure also records `failureStamp`, kept until the step completes, so the
earliest failure since the last success wins, and appends `{launchStamp, failureStamp}` to the
step's bounded `failureHistory` (at most 8 entries, oldest dropped first, removed on completion;
#300). Each live launch records `launchStamp`, taken synchronously when the body requests the
effect, before awaited preparation. When a failed step heals, a recorded step is flagged when its
`launchStamp` (as saved before this execution) shows that it was launched after a failure the body
could observe. With a complete history, that is the failure of the healed step's latest known launch
at or before the recorded step's launch, so a sibling relaunched in the same tick as a later failing
launch is not flagged. When the history is missing (records before schema revision 12) or truncated,
the watermark decides: the `launchStamp` is at least the healed step's `failureStamp`. Same-tick
`Promise.all` siblings are not flagged by either rule. When either stamp is missing, for legacy
records or a failure saved between retries, that pair falls back to the `seq` rule. Both rules are
conservative: a step launched later by unrelated control flow is still flagged. The counter's start
also covers the history's stamps. Fork-reused copies are stamped on the target run's clock. The
pre-live skipped-step check above still compares `seq`. `workflow resume` accepts `--strict-replay`
like `execute --resume`.

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
  positional map (removed in #339) added no item prefix and also relied on stamps alone.

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

## Amendment: removed named-map keys (#302)

The #145 rule recognized sibling items only by the item prefixes of the fork's own map invocation.
When the fork's named map had a different key set from the source, for example because an input
changed and one item was dropped, the source steps under the removed key matched none of those
prefixes. They were judged ordinary causes, and since the fork never requests them, they were never
reused and blocked every later-launched step in the surviving items. That is conservative, but it
brought back the re-paying #145 targets in exactly the case where a map was edited. Item boundaries
cannot be recovered from the step IDs alone, because keys may contain `/`.

Each step launched live inside named-map items now records `mapItems` (record schema revision 13):
one `{ item, invocation }` entry per enclosing item, outermost first. `item` is the exact item
prefix, such as `review/gone/x/`, so keys containing `/` need no boundary recovery. `invocation` is
a digest of a random value unique to the current execution of the workflow body, the invocation's
qualified map prefix, its ordinal and its sorted item-prefix set. The ordinal counts the earlier
invocations of the same map prefix in that execution. The map prefix keeps apart two maps whose
items spell the same prefixes, such as `review` with keys `group/a` and `group/b` and a map at
`review/group/` with keys `a` and `b`. A bare map prefix is not enough: two invocations of one map
ID, such as loop rounds, share it, and treating them as siblings would let round 2 reuse past
changed round-1 work. The key set alone is not enough either, because rounds may use the same keys.
The digest covers full prefixes, so nested invocations under different outer items differ too.
Ordinals are not stable across executions, even for a deterministic body: concurrent invocations of
one map ID can start in another order after a resume, and a committed settled map item or settled
frame is claimed without running its body, so the invocations it recorded are not counted. An
ordinal-only digest could then match one recorded by an earlier execution for a different
invocation, and treat a real dependent as a sibling. The per-execution value prevents that: steps of
one invocation that different executions launched (for example an item completed before a resume and
one retried after it) never share a digest, which only blocks more. Journaling stable invocation
identities would avoid that cost but add durable state. Questions and waits record it as well.
Storing a run-level table of key sets would add a top-level field, and storing every key set on
every step would grow quadratically.

`forkPrefixBlockers` now also skips a source step Y when Y's and the requested step X's recorded
entries share an `invocation` but name different items. The rule is source-causal: in the source, X
could not depend on a sibling item (ADR 0009), whether or not the fork kept that key, and it also
handles a key whose boundary moved (source key `a/b`, fork key `a`), because it uses X's own source
item. The fork-side prefix check and the rule for live fork steps are unchanged, since the fork
never runs a removed key's steps. A reused copy records the fork's own scopes, not the source's, so
a fork of a fork compares digests from one run.

Fallbacks stay conservative. A source saved before revision 13, or a step outside every map item,
has no `mapItems`, so it behaves as before: steps under a removed key still block the surviving
items until the source is run again by this build. Steps outside the map, such as a root step over
the map results, still count the removed key's steps as causes. A source step launched by a
different execution of the source run than the requested step is never its sibling this way, so
steps under a removed key that settled before a resume still block surviving-item steps launched
after it, falling back to the fork's own item prefixes. Each recorded entry adds an item prefix and
a 64-hex digest per nesting level to a step inside a map. The limitation on items that share closure
state or files is unchanged, and `--invalidate` still forces them live.

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
or any other failure admits the real invocation, which reproduces any genuine problem itself.
Synthesized outputs can steer the copy down another branch, so a divergence past that point can
still be missed; the real run then fails as before, now with the typed cause and the fork recipe.
(This section first named a Git worktree effect and an answer delivered but not yet consumed as such
limits; since #217 the preflight passes both, see its amendment below.) The preflight reads without
the writer lock, so like check-resume it is a snapshot, not a reservation against concurrent
writers. The workflow body, but no unfinished callback, runs once more per accepted resume. #215
moved this preflight into `runWorkflow`, so embedded callers get the same guarantee; see its
amendment below.

## Amendment: recovery hints by typed cause (#276)

The saved `recoveryHint` advertised `--accept-code-change` whenever all recorded work was terminal,
which was vacuously true with nothing recorded and wrong for a grant failure or a nondeterministic
replay divergence. The runner now classifies the failure from typed errors and the saved record,
never from message text: a missing grant (`GrantRequiredError`, a `ConfigurationError`), a replay
divergence (`ReplayDivergenceError` or `StepIdentityChangedError`), another configuration failure, a
cancelled run, a recorded effect failure, or otherwise an authoring failure. The pure
`recovery-hint.ts` chooses the text. A grant failure names `--resume --grant`; a divergence names
`workflow resume RUN --strict-replay` and `--fork-from` and, with unchanged source, a value computed
in the body outside `ctx.now` or `ctx.step`; only a configuration or authoring failure mentions
`--accept-code-change`, keeping the re-finalize text when all recorded work is terminal; an effect
failure or a cancellation gets a plain resume. A run with no recorded step or map, and a dry-run,
get no hint, and `hasTerminalOutcomes` (and so check-resume's `refinalizable`) is false for a run
with nothing recorded. The CLI appends the hint only to the invocation's own `WorkflowRunError`,
never to a refusal or a dry-run, and a divergence refusal still never advertises the path it
refused.

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
entry is written, as before (until #303, below).

## Amendment: embedded accepted-replay preflight (#215)

The #126 preflight lived in the CLI executor, so an embedded
`runWorkflow({ resume: true, acceptCodeChange: true })` still recorded the acceptance, cleared the
saved output and then failed the run on a changed completed step. `runWorkflow` now runs the
preflight itself, after every gate that refuses before the body (format, record schema, harness kind
and configuration digest, compatibility, input, policy and grants) and before it changes anything in
the record it read under the writer lock. The copy is written from that record, so the preflight is
no longer a lock-free snapshot, and a custom `RunStore` is never written to. Restoring the old
record after a failed replay was rejected: the accepted body may already have settled new or fixed
unfinished effects, possibly paid ones, before reaching the changed step, and erasing them would
repeat them on the next resume.

The core owns a small synthesizing probe for this (`accepted-replay-preflight.ts`): a `dry-run`
catch-all harness with no policy defaults (limits are policy, not identity), a process runner that
answers every command with exit 0 and empty or synthesized output, and rehearsal hooks that stub
every unfinished local step, file effect and poll observer. The nested run drops every live-only
option: the bound store, named or declared adapters and their configurations, process supervision,
orphan recovery, the caller's agent limiter, event observers, launch metadata and worktree policy.
It suspends instead of blocking. Its rehearsal hooks also stop it from preflighting again, and a CLI
dry run, which is already a disposable copy, skips the preflight the same way.

When the copy meets a changed completed or settled-failed step, `runWorkflow` rejects with a bare
`StepIdentityChangedError` (same step, components and status; the copy's error is its cause) before
anything is saved. It is not wrapped in `WorkflowRunError`, and status, fingerprint, output,
`codeChanges`, waiting questions and journal bytes are unchanged. The CLI no longer runs a preflight
of its own: it maps only this marked refusal to the same `run.incompatible` refusal as before, so an
accepted resume preflights once and the body runs twice. A `WorkflowRunError` whose cause is a
`StepIdentityChangedError`, because the preflight failed open and the real run then changed the
record, still reports `workflow.failed`. The fail-open rules and their limits are unchanged:
synthesized values can steer the copy onto another branch, so it can miss a change a real run meets
or refuse one a real run would not reach; worktree effects and delivered but unconsumed answers
stopped it early until #217 (see its amendment below); and detection is still only
`StepIdentityChangedError`. Embedded callers now also run the workflow body, including any top-level
code outside effects, once more per accepted resume.

An honored abort of the run's signal while the copy replays ends the real run as an abort in the
body would: suspended and due now for a marked `RunInterruptedError`, otherwise `cancelled` (as a
`workflow cancel` bound to the execution's lock token is), saved and reported as a
`WorkflowRunError` with the abort reason as its cause. The save closes a new execution entry with
that outcome and appends its `run.suspended` or `run.cancelled` event, which reaches `onEvent` only
after it commits. The acceptance stays unrecorded: the fingerprint, `codeChanges`, output and steps
are as they were, so the next accepted resume preflights again. A format-1 record, which can be
saved only through the migration that adopts the new source, is left untouched instead.

## Amendment: refuse skipped recorded paths (#216)

An accepted edit can also leave the recorded path without changing a recorded identity: the body
stops calling a completed step, a settled map or a child frame. The end-of-body checks caught that
only after the accepted invocation had recorded the change, replaced the fingerprint and cleared the
saved output, with a plain `Error` (child frames) or the internal `ReplayDivergenceError`, so a
completed run still ended `failed` with no output.

Those checks now raise a public, branded `ReplaySkippedError` with `kind` (`steps`, `maps` or
`child-frames`), `skipped` (the recorded IDs not revisited, in record order) and `healed` (failed
steps that now succeeded, only for `steps`). The message text is unchanged. The checks run in the
order child frames, maps, steps, and the first failing one is reported, so `skipped` lists only that
check's IDs. `ReplayDivergenceError` keeps only strict replay's `before-live` and `healed` stops. A
plain resume still fails with `WorkflowRunError`, its cause now typed; a skipped child frame now
gets the divergence recovery hint instead of the authoring hint's re-finalize advice.

The #215 preflight treats `ReplaySkippedError` like `StepIdentityChangedError`: when the copy ends
on one, `runWorkflow` rejects with a bare `ReplaySkippedError` (same fields, the copy's error as
cause, the fork recipe appended to the message) before anything is saved. The CLI maps it to the
same `run.incompatible` refusal shape: `details.divergent` has one `{stepId, skipped}` entry per
skipped ID, with `skipped` set to `step`, `map` or `child-frame` (an identity entry stays
`{stepId, components}`), and `details.next` holds the
`--fork-from RUN --reuse matching --invalidate ID` command naming the first skipped ID. Forking is
the remedy because a fork does not require its body to revisit source steps; invalidating the
skipped ID is harmless when the fork never calls it and forces it live when a moved call reaches it.
`--dry-run --resume --accept-code-change` returns the same refusal.

This includes the healed-fallback case: an accepted fix to a failed step whose `catch` fallback had
already completed used to record the acceptance and then fail on the skipped fallback. It is now
refused up front, with `healed` naming the fixed step, and the fork is the way to adopt the fix.

The fail-open limits are unchanged and now cover more ground. The copy synthesizes every unfinished
effect, so a body that decides whether to call a completed step from an unfinished effect's output
can skip it in the copy and be refused although a real run would revisit it; there is no override,
and the fork in `details.next` is the escape. A copy that suspends or stops before the end of the
body finds no skip. Strict replay's `before-live` and `healed` stops under
`--strict-replay --accept-code-change` still fail open: the real run records the acceptance first.

## Amendment: preflight past worktree effects and delivered answers (#217)

The preflight still stopped early, and so failed open, in two common places. Rehearsal refused
`ctx.worktree`, isolation on a worktree handle and merges of captured commits (`rehearsal-git`, ADR
0016), and the copy held only the run record, so a question whose answer had been delivered but not
yet consumed suspended the copy where the real run would continue. An edit to a completed step after
either point still recorded the acceptance and then failed the run.

The probe now synthesizes every Git worktree effect. The runtime recognizes the probe by the
identity of its rehearsal hooks (no public option asks for this), and gives its `WorktreeRehearsal`
no process runner, so no Git command can be issued, not even `rev-parse`. `ctx.worktree` returns a
placeholder handle whose directory is never created and whose base is a `{ commit }` base's commit
or forty zeros. An agent call, command or local step isolated on a handle gets a lease in the
handle's directory whose capture reports an unchanged tree. Any merge returns the clean-integration
shape: the placeholder commit, every captured input commit as merged in order (a handle contributes
none, since its latest commit is unknown without Git), and no conflicts. The replay decision admits
a `worktree` effect only when the runner marks it synthesized, which only the probe does. A
`--dry-run` keeps its refusals and report: its synthesized values would misreport a preview to a
user, while the probe reports nothing.

The disposable copy also holds the pending answer deliveries of the run's waiting questions. For
each waiting question the copy gets the first existing answer candidate, in the order the question
reads them, across both inbox layouts and names, copied (never linked or renamed) to the same
relative path. The copy consumes or rejects only its own file, and the real run later consumes the
source delivery. Rejected deliveries and cancel requests are not copied. A copy failure other than a
delivery withdrawn mid-copy is treated as no finding.

The preflight stays fail-open, and still reports nothing about why it stopped. What can still stop
it before a changed step is a synthesized value that fails validation (such as a refinement), a
question with no delivery, an unresolved external wait, a non-mapper settled-map refusal (#303), or
a failure to copy the run. The path-parity caveat now covers synthesized worktree values too: a
placeholder handle or a conflict-free merge result can steer the copy onto a branch the real run
would not take, which can miss a divergence or, when that branch skips completed work, refuse an
edit the real run would accept. That needs completed work ordered after an unfinished Git effect
whose result decides the branch; the fork in `details.next` is the escape.

## Amendment: refuse non-mapper settled-map changes (#303)

A settled map refused for a change to its `items`, `keys`, `version` or `cwd` (or any change to a
journal saved before per-component digests, a legacy journal) still failed the real run after an
accepted resume had recorded the run-level `codeChanges` entry and replaced the saved fingerprint.
The #126 preflight ignored it: only a step identity change (#126) or a skipped record (#216) was a
finding. The map's refusal was a plain `Error` that the runtime tracked in a module-local `WeakMap`,
which a second quiet-choir module instance could not see.

The refusal is now a public, branded `SettledMapChangedError` with `mapId` (the qualified journal
ID), `components` (the changed component names in the fixed order `items`, `keys`, `mapper`,
`version`, `cwd`; empty for a legacy journal) and `legacy`. The message text is unchanged, so the
`map-changed` recovery cause and its hints (`mapperOnly` is a non-legacy change of the mapper alone)
read the class instead of the weak map. The #215 preflight treats a non-mapper
`SettledMapChangedError` like the other two findings: `runWorkflow` rejects with a bare
`SettledMapChangedError` (same fields, the copy's error as cause, the fork recipe naming the map ID
appended to the message) before anything is saved, and the CLI maps it to `run.incompatible`. A
mapper-only change is never a finding, because the accepted resume admits it (#146) and re-finalizes
with the completed items reused and no repeated effect. The search is still first-found, so an
identity change or skip met earlier in the chain wins.

The CLI refusal's `details.divergent` has one `{stepId, components, map: true}` entry with the map
ID as `stepId` (a legacy journal adds `legacy: true` and has no components), and `details.next` is
the `--fork-from RUN --reuse matching --invalidate MAP_ID` command, matching the skipped-map refusal
(#216). The message says that `--accept-code-change` accepts only a mapper change and that nothing
was changed. `--dry-run --resume --accept-code-change` returns the same refusal and leaves the run
untouched.

`--accept-code-change` therefore cannot clear these settled-map refusals: a changed `items`, `keys`,
`version` or `cwd`, any of them together with a mapper change, and any change to a legacy journal.
The remedy is the fork. Invalidating the map ID starts a fresh map journal, but `--reuse matching`
can still reuse matching leaf steps under the map; to force the items live, invalidate `'MAP/**'`
instead.

check-resume stays body-free, as above: settled-map items, keys and version are computed by the
workflow body, which check-resume never runs, so it cannot predict this refusal. Its code-change
advice now names settled maps among the changes an accepted resume refuses without changes, and
still points at the `--dry-run --resume --accept-code-change` preview, which is the dry check.

The fail-open limits are those of #216. A copy that stops before the map finds nothing, and a
synthesized value can steer the copy onto another branch. A map whose items depend on an unfinished
effect's synthesized output can be refused in the copy although a real run would compute matching
items, or the reverse; the fork in `details.next` is the escape. The frame-boundary refusal
(`committed work in child frame`) and duplicate map IDs are not settled-map changes and stay
fail-open.

## Amendment: run-budget recovery cause (#283)

A run stopped by a run budget (`RunBudgetExceededError`) was classified as authoring, so its saved
`recoveryHint` said to fix the workflow or, when all recorded work was terminal, to re-finalize.
Neither helps: resuming without raising the cap refuses the same attempt again. `RecoveryCause`
gains `{ kind: 'budget'; flag }`, found with the class's branded `instanceof` (so it works across
module instances) and never from message text. `flag` is the CLI flag of the cap that stopped the
run, `--max-run-cost-usd`, `--max-run-agent-attempts` or `--max-window-utilization`, resolved by the
runner from the shared table in `run-budget.ts` because `recovery-hint.ts` imports no runtime
values. The hint says to resume with a higher value of that flag or the flag off, and mentions
neither `--accept-code-change` nor re-finalizing, whatever `allTerminal` and `sourceChanged` say.

Rule order is now grant, divergence, settled map change, other configuration, budget, cancelled,
effect, then authoring. Budget follows the configuration-class rules because a grant, divergence,
map or configuration problem needs fixing anyway and a higher cap alone would not help; if the cap
is still too low afterwards, the next resume stops with its own budget hint. It precedes the rest
because a refused retry leaves its step failed (which was a plain effect resume), a caught refusal
or all-terminal run was authoring, and a cancelled record whose failure chain holds a latched budget
stop would hit the same cap on a plain resume. Besides the thrown error's chain, the runner passes
the execution's latched budget stop, so a refusal that never reached the thrown error (a sibling
failure rejected the body first and the cap refused a call while the run drained) still counts.
Limits: a failure holding or accompanied by a budget stop gets the budget hint, since the resume
re-runs the failed effect anyway but cannot make progress under the same cap; and a window stop with
a known reset that still failed (a concurrent failure) names `--max-window-utilization` although
waiting for the reset would also work. A window stop with a known reset that suspends cleanly still
deletes `recoveryHint` (ADR 0053). No record format, `schemaRevision`, step identity or public API
changes.

## Amendment: cause-aware next entries (#284)

The typed cause chose only the prose hint (#276, #283). The `next` entries of a failure document and
of `inspect --summary` or `list --full` still offered a plain `resume` for every failed run, which
repeats a grant, divergence, settled-map or run-budget failure, and which was offered even when the
run recorded nothing and so had no hint. `inspect` and `list` only have the saved record, so the
cause must be persisted: the runner now saves `RunRecord.recoveryCause`, a top-level field next to
`recoveryHint` (record schema revision 10), and sets and clears it at exactly the points where it
sets and clears the hint, through one helper pair. It does not live in `RootCause`, which has its
own set and clear points. The cause is saved on every failed or cancelled record, even when the hint
is withheld (nothing recorded, a dry-run), so the record stays truthful and the entry builder
applies those rules itself. `RecoveryCause` becomes a public type, since `RunRecord` is public; a
new kind is a public-type change and needs a schema revision.

The loader's pure `runNextCommands` chooses a failed run's entries from that cause:

| Saved cause                                                    | Entries                                                         |
| -------------------------------------------------------------- | --------------------------------------------------------------- |
| any, when the run recorded no step or map                      | none, matching the absent hint                                  |
| `grant`                                                        | `execute --resume --run-id RUN --state-dir DIR --grant PROFILE` |
| `grant` with `classOnly`                                       | `execute --resume --run-id RUN --state-dir DIR --grant ACCESS`  |
| `divergence`                                                   | a fork from the stored entrypoint                               |
| `map-changed`, mapper only                                     | `resume … --accept-code-change`, then a fork                    |
| `map-changed`, otherwise                                       | a fork                                                          |
| `budget`                                                       | `resume RUN --state-dir DIR FLAG <LIMIT>`                       |
| `configuration`, `authoring`, `effect`, `cancelled`, or absent | `resume RUN --state-dir DIR`, unchanged                         |

The grant entry uses `execute --resume` because `workflow resume` has no `--grant` flag; it resumes
the stored entrypoint like `resume`, and the grant is saved for later resumes. A call with call-site
capability overrides ignores named-profile grants, so its cause carries `classOnly: true` and both
the hint and the entry name only the access class. Resume entries repeat the recorded launch policy
as before. A legacy (format 1) checkpoint gets no fork entry, as for `run.incompatible`. `<LIMIT>`
is a placeholder for a higher cap or `off`; the flag parser refuses it unreplaced. The divergence
entry stays the fork only: a strict resume of a diverged run usually stops again before live work,
so it diagnoses rather than recovers and is not a `next` entry. The hint names
`workflow resume RUN --strict-replay` without a launcher prefix, as the other hints do (#298). A run
without a stored entrypoint (embedded `runWorkflow` without `launch`) is told to resume strictly
through its embedding application (`strictReplay: true`), since `workflow resume` rejects it.
Records from before revision 10 have no cause and keep the plain resume. Stale and suspended entries
do not change.

Limits: a grant failure on the first effect records nothing, so it gets no hint and no entry,
although `execute --resume --grant` would work; hint and entry stay consistent, and a later change
can revisit both together. Cancelled runs still get no entries (their status is not `failed`).
