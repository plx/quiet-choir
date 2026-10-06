# 0026: Inline workflow frames and source-validated discovery

## Status

Accepted. Extends scope, profile, observation and journal decisions 0009, 0010, 0015 and 0019.
Amended by #170 (settled child frames; see the amendment below and
[ADR 0007](0007-durable-failure-outcomes.md)) and #240 (redefining unfinished frames; see the
amendment below and [ADR 0005](0005-step-identity-and-policy.md)).

## Context

Handwritten scoped contexts cannot record child identity, describe required input or reliably
forward future context operations. Inline composition should retain deep nesting and the root run's
limits, with explicit capability delegation and inspectable frames. Discovery must preserve the
plain-data CLI boundary without invoking workflow bodies.

## Decision

Use `ctx.workflow` for typed definitions or name dispatch among a parent's declared children. Record
frames separately from effects, validate I/O, and replay bodies under the existing naming and
operation-ownership scopes. Compact long child namespaces with SHA-256 while retaining readable
parent links. Enforce a configurable sticky depth guard, default 8. Do not alter ordinary effect IDs
or fingerprints. Frame entries use individual `children` journal changes in storage format 7.

Delegate only available parent roles. Check declared/default roles before effects and concrete calls
after overrides; remove unavailable optional built-ins so nested children cannot acquire phantom
authority. Pass mapped model/effort and limit policy down without promoting child tool exposure. All
frames use the root's limiter, budget and cancellation facilities.

Require children declared inside settled maps, because committed mappers cannot be executed to
rediscover dynamic definitions. Reclaim their recorded frame ownership and verify the declared tree
before replay. Ordinary inline bodies still run on resume; completed runs with frames revisit them
to check direct child identity. Suspended frames park with their root run.

A successful completion retires every child frame that the completing execution never reached
(neither invoked nor reclaimed through settled-map replay) and that is still `running`, `suspended`,
`failed` or `cancelled`: its status becomes the terminal `superseded`, `finishedAt` records the
supersession and an existing `error` is kept (a frame without one gets a supersession note). This
matches unvisited unfinished steps, which become `superseded` under ADR 0005, so `inspect` no longer
shows an earlier attempt's failure as the live outcome of a branch the workflow has moved past. It
covers frames that failed or were cancelled before recording any terminal effect, and frames that a
crash or an earlier suspension left running or parked. The replay checks run first and are
unchanged: an unvisited completed frame, or a frame whose descendants hold a completed or
settled-failed step or a settled map item, still fails the run with "Replay skipped completed or
settled child frames", "Replay skipped recorded steps" or "Replay skipped settled maps", and keeps
its old status. Supersession is applied last, after output validation and worktree cleanup, and is
undone if the completion checkpoint fails, so a failure snapshot never claims a retirement. Frames
visited in the completing execution keep their live outcome: an unawaited running or parked frame is
`cancelled`, and a failed frame the parent caught stays `failed`. One `child.superseded` event per
retired frame follows `run.completed`. Already superseded frames are skipped, so a later resume
emits nothing again; a later execution that invokes the frame with the same identity replays it like
any other unfinished frame. A failed, cancelled or superseded frame that owns no terminal work may
be invoked under a changed identity (see the #240 amendment); otherwise it must keep its name,
version, input and schemas on resume, and the refusal points at keeping that identity and resuming
with `--accept-code-change`.

Publish optional descriptive metadata and I/O schemas through validate. The directory registry
discovers trusted `*.workflow.ts` files, rejects duplicate names, and caches only JSON metadata
after checking source hashes. It never caches execution authority: executing a name reimports the
selected source and verifies its name. Recursive declarations become finite reference nodes in
discovery.

## Amendment: settled child frames (#170)

`ctx.workflow(id, child, input, { onError: 'return' })` makes a frame's outcome a durable branch
decision. Frame records gain two optional fields, written only for that mode so existing records
keep their shape: `onError: 'return'` and, once the body ends with a settleable outcome,
`settled: { outcome, steps, maps, children }`. The outcome is `Settled<JsonValue, MapStepError>`,
and the lists are the effect, settled-map and child-frame IDs that the frame's owner scope
collected. A settled success keeps status `completed`; a settled failure keeps `failed`. A frame
with `settled` is terminal: resume returns the outcome without running the body or emitting
`child.started`, claims the owned IDs like a committed settled map item, and reclaims the frame
itself for an enclosing settled map or frame. Its owner scope is a settled scope, so its descendants
must be declared, as inside a settled map. An unvisited settled frame fails the run as "Replay
skipped completed or settled child frames", supersession skips it, and its identity, including
`onError`, cannot change on resume. A settled failure emits `child.settled` in place of
`child.failed`. The settle predicate, the identity rule for unsettled frames and the fork decision
are in ADR 0007.

## Amendment: redefining unfinished frames (#240)

ADR 0005's unfinished-identity rule now covers inline child frames. A saved frame may adopt a
changed name, version, input digest or schema digest when all of these hold:

- its status is `failed`, `cancelled` or `superseded`, and it has no `settled` outcome;
- no committed outcome owns it: neither it nor any ancestor (following `parent` links) is listed in
  a completed settled-map item's `children` or a settled frame's `settled.children`, and no ancestor
  is settled;
- its subtree (the frame and every frame whose parent chain reaches it, including compacted
  `child:<hash>` IDs) holds no terminal work: no completed or settled-failed step attributed to a
  subtree frame or under a subtree frame's ID prefix, no settled map under such a prefix with a
  completed item, and no completed or settled descendant frame.

The predicate is one pure function (`src/workflow/runtime/child-identity.ts`) shared by the declared
tree validation and invocation. Running and suspended frames still refuse: a running frame after a
crash may have effects with unknown outcomes, and a suspended frame parks an open question or wait.
Completed and settled frames, frames holding terminal work and owned frames refuse with the existing
messages (`run.incompatible` on the declared path); for a failed, cancelled or superseded frame the
message adds why its identity cannot be redefined, naming the first few terminal IDs or the owner. A
parent change at the same frame ID, and the `onError` of a settled frame, stay refused for every
frame, because they change the call's structure rather than revising it.

Declared validation runs before any effect and changes nothing: for a redefinable frame it skips the
refusal and still validates the frame's saved declared descendants against the current declaration
of the same name, when there is one. The redefinition is recorded only when the body invokes the
frame. Invocation then writes the fresh frame record as before and adds the replaced identity,
`{ workflow: { name, version }, schemaDigest, inputDigest, redefinedAt }`, to an optional
`redefinitions` list, oldest first. Every later invocation carries that list forward, so the history
survives further resumes; frames never redefined omit the field and keep their earlier shape. The
frame save is followed by `child.redefined` (message `kid@1 -> kid@2: running`) and then
`child.started`. A frame the body no longer invokes is superseded under its old identity, as before.
`inspect` shows the history in its JSON child rows and on the text tree row. The field changes the
accepted `children` shape, so the record schema revision is 8 (see `docs/storage.md`).

A CLI resume after a version bump still edits the workflow source, so it still needs
`--accept-code-change` for the source gate; it then proceeds instead of failing on the frame.
Embedded `runWorkflow` callers redefine without it.

## Consequences

Effects and frames have separate identities and lifetimes; child completion does not memoize its
body. Child version/schema changes remain refusals after source acceptance for completed, settled,
running, suspended and owned frames and for frames holding terminal work; other unfinished frames
record a redefinition (#240). Static descriptions do not change runtime fingerprints, while the
CLI's source gate still covers their bytes. Per-frame usage is an inclusive projection over attempt
records, never another spending ledger. Cache hits skip trusted imports, so environment-dependent
declarations require explicit refresh. Separate-run children and a linked-run wait source remain
later work under #57/#18; broad port migration is #65.
