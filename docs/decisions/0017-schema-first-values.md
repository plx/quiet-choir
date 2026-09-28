# 0017: Infer from schemas and normalize values at durable boundaries

## Status

Accepted.

## Context

Returning `AgentResult<T>` required manual output projections even when metadata was not needed.
Optional object properties could survive Zod parsing as own undefined members, then fail only at a
late checkpoint. Callback return inference could widen the schema's promised type and hide a final
validation failure. Built-in CLI compiler defaults allowed unchecked array access before effects.

## Decision

Expose `value()` on both agent clients. A schema selects the existing structured call; otherwise it
uses the text call. Project output inside the tracked operation, after the usual effect pipeline.
Keep full results and semantic identities unchanged, including the error mode. Settled successes
contain the output and settled failures retain the original error. Ignoring a failed direct-output
call remains an owned failure. Successful live agent completion events expose detached usage and
session metadata; replay/reuse events do not double-report it.

Canonical JSON copying omits undefined own object members recursively. It still rejects undefined
roots and array elements, holes, special numbers, cycles, instances, symbols, and accessors. Errors
name the workflow/step boundary and JSON path. `JsonInput` admits optional dependency members;
`JsonValue` remains the strict persisted representation. Normalize parsed input before invoking the
body and normalize revalidated return copies, so fresh execution and replay expose the same keys.
Revalidated return copies preserve schema field order: sorting them could change downstream prompts
that embed JSON text. Storage/fingerprints still sort keys. Previously accepted values retain their
canonical bytes and semantic fingerprints. No checkpoint epoch change is needed.

Wrap the whole workflow/local-step callback type in `NoInfer`. Schemas alone infer their contracts,
while callbacks are checked against them. This placement preserves contextual enum returns in
workflow callbacks with context parameters. Zero-parameter callbacks can still widen literals and
need `as const` or a return annotation. Do not cast output schemas to invent a stronger type.

Use `z.object` as the default, with local unknown-key stripping and closed generated schemas.
Reserve `z.looseObject` for intentional unknown-key retention, subject to the existing Codex wire
compatibility policy. Recursive `catchall(z.json())` is not a substitute for a concrete contract.

Built-in typechecking adds `noUncheckedIndexedAccess`, without `exactOptionalPropertyTypes`. Report
effective compiler options as plain data with enum names, and render them in human output. Project
tsconfigs retain their own policy. A resumed CLI run rechecks types before importing code.

## Consequences

Previously invalid undefined object members are now accepted and omitted. Array mistakes remain
visible instead of silently becoming null. New callback/typecheck diagnostics can block an unchanged
in-flight CLI resume before the body runs; explicit source-change recovery is available. Runtime
validation remains necessary, and casts can still defeat TypeScript's checks.

The active comparison batch stays gated; broad port cleanup and removal of output casts, catchalls,
and JSON round-trips remain #65. Both distributed plugin copies teach the new authoring contract.
