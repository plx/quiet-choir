# 0007: Explicit durable failure outcomes

**Status:** Accepted. Extends ADR 0005/0006; supersedes their current checkpoint-format choice.
Extended by [0008](0008-scoped-fan-out.md) for durable aggregate outcomes and scoped cancellation.
Amended by #274 (invalid-request, overloaded and the transient retry alias). Amended by #144
(healed-step dependents use launch and failure stamps, with a `seq` fallback). Amended by #149
(commands and files take `onError: 'return'`; settled commands keep `ExecStepError` fields). Amended
by #109 (the `idle-timeout` kind joins the transient set; see
[0042](0042-idle-deadlines-and-tool-use-diagnostics.md)). Amended by #170 (`ctx.merge` and child
workflows take `onError: 'return'`; a settled child frame is terminal). Amended by #297 (a step that
carries a `failureStamp` takes part in the healed check after a later cancelled or interrupted
relaunch). Amended by #300 (a bounded `failureHistory` makes the check per launch across repeated
failures, with the `failureStamp` watermark as the fallback).

## Context

A caught effect failure is not replayed by the original throwing API. When that failure heals on
resume, the body can choose a different fallback or pass different data into a completed effect.
Recording successful effects alone cannot preserve these decisions. JavaScript races introduce the
same problem through timing, and draining a losing effect does not cancel it.

## Decision

Add `onError: 'return'` to local and agent calls. Success returns `Settled<T>` with `ok: true` and
the normal validated value. Final failure, after applicable retries, commits a `settled-failed` step
with a plain `StepError` (`message`, `kind`, total `attempts`) before returning `ok: false`. Replay
returns the saved failure with no callback/harness invocation. `onError` participates in identity.
Both completed success and settled failure are terminal: their identities are immutable, they must
be visited on replay, and matching fork reuse can copy them with provenance. Prefix invalidation
provides the deliberate way to reconsider a saved failure and its downstream decisions.

Cancellation is not a settled outcome. External abort, sibling cancellation, and typed cancellation
errors reject and leave retryable failures. Authoring/identity errors occur before invocation and
reject. Configuration failures reject too, leaving the step unfinished so a corrected configuration
runs it live on resume: a missing harness, and any validation a harness adapter performs before
launch. Adapters signal the latter with the exported `ConfigurationError` (`CliHarness` does so for
a relative `cwd`, invalid options, and output schemas its provider cannot enforce); any other
adapter error is an ordinary effect failure. Checkpoint failures also reject; no uncommitted outcome
is returned to the body, and domain error precedence remains as specified in ADR 0003.

The existing runtime retry loop accepts `retry.on` categories. Omission retains opt-in retry of all
ordinary effect errors; an empty list disables retries. Filters and attempt limits remain policy,
outside identity. Save every attempt's error/category and available failed-call usage. Categories
come from structured protocol metadata, error types, or process codes; unclassified prose remains
`unknown`. Adapters can supply `HarnessErrorDetails.kind`. Retries use fresh sessions and never roll
back earlier edits.

Do **not** infer automatic stickiness from which Error object or cause chain escaped the body. A
wrapper error or an ordinary exhausted retry loop makes that inference ambiguous and can turn
retryable work into a permanently replayed failure. Throwing remains retryable and handled throwing
failures remain the author's responsibility. There is no `--retry-failed` or
`RunOptions.retryFailed`: explicit terminal decisions are reconsidered via a new fork and
invalidation, preserving the source.

Do **not** ship `ctx.race` in this change. Winner journaling, branch-scoped cancellation and
terminal loser rules are explicitly deferred to [#57](https://github.com/plx/quiet-choir/issues/57).
Forbid `Promise.race`/`Promise.any` over durable operations in author guidance. Use `timeoutMs` with
a settled agent call for replayable timeout decisions; tests flip the agent's would-be timing on
resume and verify the recorded timeout still selects the same downstream path.

Warn as soon as a previously failed step completes when recorded steps launched after its failure
exist, naming both the healed step and those IDs. The healed step keeps `failureStamp` (the
settlement stamp of its first terminal failure since it last completed; ADR 0006 describes the
counter) and a bounded `failureHistory` that pairs each terminal failure since then with the launch
that failed, oldest first (#300). A failed step reruns live, so the body that launched a recorded
step could observe only the failure of the healed step's latest launch at or before that launch.
With a complete history (its first entry is `failureStamp`), a recorded step therefore qualifies
only when that latest known launch has a failure that settled at or before the step's `launchStamp`.
The known launches are the history's launches plus the healed step's latest launch before this
execution; a launch without an entry (cancelled, interrupted or crashed) hides the earlier failures,
and a step launched before the first failing launch does not qualify. A sibling launched in the same
tick as a failing launch is not flagged whichever settled first, even when an earlier run's failure
preceded both. A run starts its counter one past the highest persisted stamp, so a relaunch is
stamped after every earlier failure and every earlier launch, including a completed wait that
observed the first failure without settling anything; stamps tie only within one execution, where
the latest launch at or before the step's launch is the one it ran beside. The history keeps at most
8 entries. When it is missing (records written before schema revision 12) or truncated, the recorded
step qualifies when its `launchStamp` is at least `failureStamp`, the earlier watermark; losing a
cancelled launch that a later launch overwrote only lets an earlier entry decide, which flags more,
never less. When either stamp is missing (checkpoints written before #144, or a failure saved
between retries), that pair falls back to the earlier launch-order rule: a higher `seq` qualifies.
Strict replay allows saved terminal outcomes but stops before the next live effect. The end-of-body
skipped-step error names healed steps too. Both stamp rules are conservative, not proof of
dependence: a step launched after the failure by unrelated control flow is still flagged, already
running concurrent work can finish, and a warning need not imply actual drift. `healedDependents` in
`replay-decision.ts` encodes it. The `failureStamp` and `failureHistory` survive a later
cancellation or interruption (including a `running` step left by a crashed owner) until the step
completes, so a step that failed, was cancelled or interrupted in a later run, and then succeeds is
checked when it completes (#297). A step that was only ever cancelled has no stamp and is not.

New checkpoints use format 4 because older readers cannot interpret the new terminal status. Formats
1–3 remain inspectable and are refused for resume/fork without changing their data. No implicit
migration is safe across the identity/error-mode change.

## Consequences

Explicit fallback and best-effort map results replay deterministically after failures heal. Existing
try/catch code must opt in when failures steer later work; generic JavaScript races remain unsafe. A
settled failure can let a run complete successfully and is not automatically retried even when retry
policy increases. Per-attempt diagnostics remain available independently of terminal outcome. The
upcoming map settle mode (#43) can build on the same terminal failure representation.

[ADR 0020](0020-durable-waits-and-tick.md) adds one recorded winner among signal/poll/deadline
sources. Races among arbitrary durable effects remain unsupported.

## Amendment: invalid-request, overloaded and the transient alias (#274)

Provider failures that need different responses all classified as `unknown`: a misspelled model or
invalid effort (HTTP 400/404), an overloaded provider (500/529), and a Codex rate limit reported
only as prose. `retry.on` therefore could not mean "transient failures only", and a `retry` without
`on` retried a request that can never succeed.

Two kinds join `ErrorKind`. `invalid-request` covers HTTP 400, 404 and 422; `overloaded` covers 500,
502, 503 and 529. 408/504 stay `timeout`, 429 stays `rate-limit`, and other statuses stay `unknown`.

`ProtocolFailure` gains an optional, adapter-owned `kind` for failures whose protocol metadata is
insufficient. `HarnessError.kind` is `HarnessErrorDetails.kind`, else `failure.kind`, else the
status and terminal-reason mapping. The prose exception lives in the built-in adapters' protocol
layer (`src/harnesses/protocol.ts`), never in generic runtime code: Codex's own terminal errors that
begin `rate limit exceeded`, and a notice-only failure whose last notice is a
`Reconnecting... n/m (rate limit exceeded ...)` reconnect, are `rate-limit`; a Codex
`invalid_request_error` and Claude Code's `[claude-code:unrecognized_model]` stderr tag are
`invalid-request`. These are fixed prefixes that codex-cli and Claude Code print themselves
(recorded on codex-cli 0.157.1 and Claude Code 2.1.283), so text quoted inside an unrelated error
cannot change its kind; if the CLIs change the wording, classification degrades to `unknown`.
`errorKind()` still trusts only structured kinds.

`retry.on` accepts the alias `transient`, which stands for `rate-limit`, `overloaded` and `timeout`
(and `idle-timeout` since #109). It is a filter, not a kind: saved failures and attempt kinds never
contain it, and resolved and persisted policies keep it unexpanded, so the expansion happens only in
`classifyAttemptFailure`. Omitting `on` now retries every non-fatal kind except `invalid-request`;
an explicit `on: ['invalid-request']` still retries it. Retry remains policy, so step identities do
not change.

The checkpoint format does not change. Older records validate under the widened enums; records that
contain the new kinds or the alias need this runtime, which the 0.0.0 prototype accepts.

## Amendment: idle-timeout (#109)

An agent attempt that produces no stdout or stderr for its `idleTimeoutMs` ends with the new kind
`idle-timeout`, separate from the wall-clock `timeout` so `retry.on` can target either one. It joins
the transient set: `'transient'` now stands for `rate-limit`, `overloaded`, `timeout` and
`idle-timeout`, and failure documents report it `retryable`. Older records validate under the
widened enum; records containing the new kind need this runtime. See
[ADR 0042](0042-idle-deadlines-and-tool-use-diagnostics.md).

## Amendment: commands and files (#149)

`ctx.exec`, `ctx.exec.json`, `ctx.readFile` and `ctx.writeFile` had no `onError`, so a caught
command or file failure was not a durable decision: resume ran the effect live and could take the
other branch. The only workaround, `okExitCodes: 'any'`, still threw on timeouts and signals and
lost the exit code in json mode.

The rule is now: every effect that can fail takes `onError: 'return'`. The four effects accept it
with the same two overloads as agent calls and reuse the settled-failure path above unchanged:
retries, fatal classification in `attempt-failure.ts`, terminal replay, and fork reuse and
invalidation in `replay-decision.ts`. Cancellation, a missing process adapter (`ConfigurationError`)
and checkpoint failures still reject and leave the step unfinished. Option and path validation still
rejects before any step is recorded. A command timeout settles with kind `timeout`. File failures
keep their current kinds (an oversized snapshot or an `ifMatch` conflict is `unknown`).

`EffectResult` gains a defaulted error type parameter, so the commands return
`Settled<T, ExecStepError>`. The public `ExecStepError` extends `StepError` with optional `code`,
`signal`, `stdoutTail` and `stderrTail` (1024 characters each), copied from the `ExecError`
diagnostics when the failure is an `ExecError`. For `ctx.exec.json` it also has `parsed`: stdout as
raw JSON, when the output was not truncated, at most 16384 UTF-8 bytes and valid JSON. It is not
validated against the success schema, because failure output rarely matches it, and a parse failure
never replaces the original error. `ExecError` carries the same optional `parsed`. The fields are
optional because a custom runner's plain error carries no process result and older records lack
them. Only the runner's settle branch adds them, for exec steps; settled map items keep plain
`StepError` values. `stepErrorSchema` stays non-strict and validates the new fields, so the record
format does not change.

`onError` enters the exec, read-file and write-file identities only when it is `'return'`. Omitting
it and passing `'throw'` keep the identities and fingerprints of existing calls, which
`test/builtin-identity.test.ts` pins against values captured before the change. Dropping `'return'`
from a settled call is refused as an `onError` identity change. `onError` is neither execution
policy nor part of the recorded `ExecSummary`.

`workflow fixtures` exports a settled-failed command, and one the workflow absorbed, as an ordinary
exec rule with its exit `code` and recorded output tails (#306) when a command result reproduces the
failure: an exit code outside `okExitCodes` or an `exec.json` schema failure. The replay runs that
result through the same checks, so the settled `ExecStepError` comes back with the same fields.
Spawn failures, timeouts, signal kills and output-limit failures get no rule until exec rules can
describe errors (#307); export still sets `"commands": "fixture"`, so a replay of such a run fails
at that step.

## Amendment: merges and child workflows (#170)

After #149, `ctx.merge` and `ctx.workflow` were the effects that could not settle a failure. A
`try/catch` around a failed child frame was not a durable decision: the frame stayed `failed`, its
body ran again on resume, and a healed failure sent the parent down the other branch.

`ctx.merge` takes `onError` with the same two overloads and reuses the settled step path unchanged.
The runner removes `onError` from the merge options before it builds the merge dependencies and
before Git sees them, and passes it to the effect, so it enters identity only as the effect's error
mode: an omitted or `'throw'` merge keeps its fingerprint (pinned in
`test/builtin-identity.test.ts`) and `'return'` changes it. `classifyAttemptFailure` applies as for
any step. Ordinary Git and validation errors inside the merge settle, such as an
`onConflict: 'fail'` conflict, a dirty checkout target or a target that moved. Cancellation, a
`ConfigurationError` (such as a rehearsal Git refusal) and checkpoint failures reject; option and
input schema errors reject before any step is recorded. A settled failure replays without calling
the merge, so Git is not touched. The default `onConflict: 'report'` already returns conflicts as
data, in either mode.

`ctx.workflow` takes `onError` on both its typed and its by-name overloads. Typed calls return
`Settled<O, MapStepError>` and name dispatch returns `Settled` of the declared child's output (JSON
for a bare `WorkflowContext`). A child frame records no effect of its own, so it gets a terminal
record like a settled map item ([ADR 0008](0008-scoped-fan-out.md)): the frame gains
`onError: 'return'` and, once the body ends, `settled: { outcome, steps, maps, children }`, the
outcome plus the leaf, settled-map and child-frame IDs the frame's owner scope collected. A settled
success keeps status `completed`; a settled failure keeps `failed`, with the message in `error`. The
frame emits `child.completed` or, for a failure, `child.settled` instead of `child.failed`.

A failure settles only with the predicate a settled map item uses (shared in `settled-outcome.ts`):
the parent scope is not cancelled, the error is not a cancellation, it is not this run's checkpoint
failure, and it is not fatal (authoring guards, configuration failures and latched run-budget stops
are marked fatal). The saved `MapStepError` is attributed to the originating effect and its started
attempts, or to the body with one attempt. A save that fails while committing the outcome removes
`settled` again and rejects, so a failure snapshot never claims an uncommitted settlement. Input
validation, the depth guard, duplicate IDs and identity changes happen before the frame starts, so
they reject and leave no settled frame. Descendants of a settled frame must be declared, as inside a
settled map, because resume validates them without running the body.

On resume, after the frame identity checks, declared-tree validation and capability delegation, a
frame with `settled` returns its saved outcome without running the body or emitting `child.started`.
It claims its owned steps (each emits `step.replayed`), settled maps and child frames, so the
end-of-run visit checks and an enclosing settled map or frame see them.

The frame's error mode is identity only once it is settled. A settled frame whose current call drops
or changes `onError` is refused with the existing "Child frame ... changed" error, which names the
`onError` change; a parent change stays refused for every frame, and version, input and schema
changes stay refused for every frame outside the unfinished-identity rule that #240 added (see the
redefinition amendment in [ADR 0026](0026-inline-children-and-definition-registry.md)). An unsettled
frame (running, failed, cancelled, suspended, superseded, or completed in throw mode) may change its
mode, because its body runs again anyway and nothing about it was observed durably. This matches the
step rule above, where only a terminal identity is immutable, and keeps the usual recovery open: add
`onError: 'return'` to a child that failed and resume. The refusal for a settled frame does not
suggest `--accept-code-change`, which cannot retry it.

A settled frame is terminal for the run-level checks: an unvisited one fails the run as a
control-flow change, supersession skips it, and the steps and maps it owns count as replayable
outcomes for recovery hints, as they do for a committed map item. Inspection summaries show a
compact `settled` field (`{ ok: true }`, or `{ ok: false, error }`) without the value or owned IDs.

A fork does not copy child frames or settled-map journals: it starts with no frames and reuses only
steps. It therefore runs a settled frame's body again. Owned terminal steps are reused per step by
ordinary fork reuse, so the frame normally settles to the same outcome; an `--invalidate` glob that
matches an owned step ID re-executes that step and recomputes the frame's outcome; and a plain
failed step inside a settled-failed frame is not terminal, so the fork re-executes it. Copying
frames would need frame-level reuse and causal-prefix rules for this one feature, while rerunning
the body is consistent with settled maps and needs no new fork code.

The nested `onError` and `settled` fields change the accepted shape of `children`, so the run-record
schema revision becomes 3 ([ADR 0052](0052-run-record-schema-revision.md)): a build at revision 2
refuses to rewrite such a record instead of silently dropping `settled`. Records without the fields
load and replay as before.
