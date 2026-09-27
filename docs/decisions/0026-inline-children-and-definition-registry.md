# 0026: Inline workflow frames and source-validated discovery

## Status

Accepted. Extends scope, profile, observation and journal decisions 0009, 0010, 0015 and 0019.

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

Publish optional descriptive metadata and I/O schemas through validate. The directory registry
discovers trusted `*.workflow.ts` files, rejects duplicate names, and caches only JSON metadata
after checking source hashes. It never caches execution authority: executing a name reimports the
selected source and verifies its name. Recursive declarations become finite reference nodes in
discovery.

## Consequences

Effects and frames have separate identities and lifetimes; child completion does not memoize its
body. Child version/schema changes remain refusals after source acceptance. Static descriptions do
not change runtime fingerprints, while the CLI's source gate still covers their bytes. Per-frame
usage is an inclusive projection over attempt records, never another spending ledger. Cache hits
skip trusted imports, so environment-dependent declarations require explicit refresh. Separate-run
children and a linked-run wait source remain later work under #57/#18; broad port migration is #65.
