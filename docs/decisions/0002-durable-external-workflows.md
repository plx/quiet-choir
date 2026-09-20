# 0002: External TypeScript workflows with local durable steps

## Status

Accepted for the prototype spike.

## Context

Claude's dynamic workflows move agent orchestration into JavaScript. We want the same ability to
compose branches, loops, and parallel work using TypeScript, with dedicated Claude and Codex APIs
and useful recovery after process interruption. The repository is a prototype, so its durability
contract should be small enough to test and explicit enough to judge before investing further.

## Decision

Workflow definitions are ordinary TypeScript functions with a name, compatibility version, and Zod
input/output schemas. Agent clients expose `text` and `object`; structured calls request a harness
schema and validate output locally. Local effects use `ctx.step` with an explicit input, result
schema, and callback. Checkpointed values must survive JSON serialization unchanged.

Every durable operation has a unique, stable step ID. A run stores completed results and operation
input fingerprints in an atomic JSON checkpoint. An exclusive local owner lock prevents two
processes from executing the same run simultaneously. Resume reruns the workflow body and returns
saved results when a step's identity and inputs match. Workflow name/version and CLI fingerprints of
reachable local source files reject incompatible resumes. The explicit version remains necessary for
semantic changes in dependencies or environments outside that fingerprint.

Workflow code outside durable operations must be deterministic and free of side effects. Local
callbacks must not nest durable operations, and callers must await every operation they start.
`ctx.map` bounds concurrency while preserving result order. `ctx.sleep` saves a wake deadline, so a
restart waits only the remaining duration.

Interrupted effects have **at-least-once** execution: if an external action completed before its
checkpoint was saved, resume may repeat it. Local callbacks receive an idempotency key and can opt
into bounded retries. Agent failures throw without automatic retries. Harness session IDs are
informational; this layer does not resume native Claude/Codex conversations.

## Consequences

The core stays independent of either CLI through a replaceable harness interface. Named checkpoints
preserve completed sibling work after a failure, and runtime schemas support both inferred types and
validation at process/storage boundaries. Ordinary TypeScript makes libraries and composition
available without adding a separate workflow language.

Authors are responsible for replay discipline and effects that can safely repeat. The runner does
not sandbox workflow source, detect every source of nondeterminism, or guarantee exactly-once
external actions. A local lock and atomic files are not a distributed coordination system. There is
no service, scheduler, migration system, or claim of recovery from disk loss. Durable sleep is a
saved deadline, not a scheduled job that runs without a process.

A lock with missing/corrupt ownership metadata, an owner on another host, or an interrupted recovery
claim is retained for manual inspection. Automatic reclamation is limited to a confirmed dead local
PID. This is conservative local coordination; it does not solve PID reuse or shared-filesystem
leases.

These limits are deliberate places to evaluate the spike. A production successor could preserve the
workflow-facing contract while replacing persistence, scheduling, and harness transports.
