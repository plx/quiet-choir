# 0027: Typed harness registry and integration helpers

- Status: accepted
- Issue: #64

## Context

A third agent harness previously required changes to the context, request union, executor and
checkpoint kinds. `provider` also conflated the CLI harness with the model service it uses. The JEV,
GitHub and Linear proposals (#20–#22) would repeat that coupling as new context properties.

## Decision

Workflows explicitly register package definitions with `harnesses: [definition]`. `defineHarness`
validates a stable lowercase name, positive semantic revision, strict Zod object options and
capabilities. That one value-level list determines both `ctx.agent(name)` types and runtime
preflight. Text-only definitions cannot request structured output. Claude and Codex remain implicit,
and `ctx.claude`/`ctx.codex` keep their author-facing APIs. There is no declaration merging or
package-name discovery. Imported adapter code is trusted workflow code.

`AgentRequest` names the `harness`; an option named `provider` may independently select a model
service. The request includes direct run ID, fully qualified step ID, cumulative attempt and stable
idempotency key. The former `call` view remains available. `HarnessAdapter.invoke` receives the
request, cancellation signal and optional ownership context; runtime calls always supply ownership.
Adapters perform one attempt, honor cancellation and supported policy, and reject process/protocol
failure. Structured response text is serialized JSON. Missing usage remains unknown.

Lookup is explicit `RunOptions.adapters[name]`, then the existing `RunOptions.harness` catch-all,
then the declared factory with `harnessConfigurations[name]`. Factories are lazy: replay does not
construct adapters. Duplicate names, unavailable fresh registrations, removed recorded names and
changed revisions fail preflight. Child declarations use their own registries and the root's
execution machinery. Declaration checks also cover children hidden in replayed settled maps.

All agent calls use the existing effect path for grants, retry, admission, worktrees, transcripts,
process ownership and budgets. Additional profile options live under `profiles.<role>.harnesses`.
Packages declare capability keys and a pure access classifier accepting partial profile options;
omitting the classifier conservatively requires exec access. Strict profiles prohibit call-site
capability controls. Child delegation requires exact opaque capability controls and no increased
access. Package adapters enforce those controls; this is not a sandbox for arbitrary TypeScript.

New records use `kind: 'agent'`, `harness` and `revision`. Readers normalize preceding Claude/Codex
records in memory without changing source files. Revision-one built-in identity uses a frozen
predecessor function, pinned by golden digests. The original format-one isolation refusal remains.
Other definitions hash name, revision, validated options, cwd and result schema. Declared policy,
runtime retry, timeout and profile selection are excluded. Defaults applied by adapters and operator
configuration are not identity. Package authors must bump revision when recorded options change
meaning; `node_modules` is outside workflow source fingerprinting.

`quiet-choir/harness-kit` is a deliberate public subpath for the bounded process runner, ownership
contracts, failure utilities, temporary fake executables and framework-independent conformance
assertions. Separate Claude/Codex adapters share their native implementation; `CliHarness` remains a
compatibility dispatcher and rejects unknown names. Core registration imports only pure built-in
contracts, never native process implementations. Built-in implementation modules reach runtime
utilities through the kit.

CLI configuration is explicit JSON or `@file` (`--harness-config` or `QUIET_CHOIR_HARNESS_CONFIG`),
with package settings under `harnesses.<name>`. Repeated `--harness name=fixture:FILE` entries
override selected adapters. Global fixtures and dry-run remain catch-all modes.
`configuration doctor --workflow FILE` typechecks and imports trusted source, lists its registry and
calls optional package probes, which must perform zero inference. There is no implicit project
configuration search or dynamic module flag.

Non-agent integrations are ordinary helper functions. A helper operation makes exactly one
`ctx.step`, `ctx.exec` or `ctx.wait` at workflow level. It inherits replay, idempotency and normal
failure handling; nesting durable operations inside its callback remains invalid. This deliberately
replaces the proposed `ctx.jev`, `ctx.github` and `ctx.linear` core properties. Separate packages
can still provide convenient discoverable APIs. `quiet-choir/decision` is a transport-injected
reference, not a JEV SDK implementation and not completion of #20–#22.

`StepDefinition.meta` supplies JSON inspection labels outside identity. Local callbacks may replace
their cumulative attempt usage through `reportUsage`; that evidence commits with success or failure.
Helper usage has separate totals and never consumes agent attempt slots. Reported helper cost does
contribute to the next agent's run cost gate. No report makes an external action exactly once.

## Consequences

Adding a harness requires a definition and adapter package, without runtime or command edits. A fake
third CLI verifies that boundary. Built-ins pass the same public conformance suite for text,
structured JSON, unknown usage, exit-zero protocol failure, nonzero stdout failure and cancellation.

A helper generic over an unresolved registry may lose structured-client inference because its
capability conditional type is deferred. Helpers should accept a concrete registry or only the
context methods they use. Registry/profile options remain JSON contracts; put credentials in
operator configuration or the transport, never in recorded inputs or metadata. Native sessions
remain diagnostics, not resumable conversations.
