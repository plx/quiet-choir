# 0016: Rehearse ordinary workflows through fixture harnesses and a pure native planner

## Status

Accepted. Amended by #147 (command fixtures and typed fixture failures).

## Context

Static workflow validation cannot discover late step schemas, duplicate IDs, or dynamic branches.
Embedding a fake harness gave different source fingerprints from CLI execution, and handcrafted
process fakes often modeled native exit codes incorrectly. Replaying simulated outputs under a
native adapter also had no provenance guard.

## Decision

Attach required `HarnessRequest.call` identity inside an attempt, after computing the existing
semantic fingerprint. Keep `HarnessRequestInput` for pure planning and direct adapter use. Native
arguments and private-file descriptors are built once as JSON data; materialization owns temporary
files and output decoding. Rehearsal calls this planner but never its process runner or discovery.
Adapters remain outside the core. The core accepts live rehearsal hooks for local substitution and
schema diagnostics and skips durable sleeps when that explicit mode is active.

Fixture JSON uses ordered step globs, provider/attempt filters, and output/text/error alternatives.
Responses take the usual parsing, validation, and checkpoint path. A bounded deterministic schema
sampler supplies missing rehearsal values, requiring fixtures when it cannot satisfy constraints.
Local callbacks run unless explicitly stubbed. Rehearsal is execution of a path, not static
traversal, isolation, or an accurate estimate of every future call.

The executor manages a private temporary checkpoint directory. Resume previews copy record data,
never source owner locks or child registries; source/fork compatibility still applies. Ordinary
records save harness kind outside identity and require explicit authorization when it changes.
Legacy unlabelled format-6 records remain resumable, without asserting their adapter was native. The
format epoch and semantic identities remain unchanged. A captured parent-commit checkpoint verifies
that compatibility independently of newly created records.

Keep fake native CLIs and their capture job **repository-only**, under `test/bin` and `test/`. Do
not add `quiet-choir/testing` or another package export. Native captures follow fast-moving
installed CLI contracts and are development tooling; the deliberate root API supplies the portable
`FixtureHarness` and planner instead. The installed package continues to expose `src/index.ts`'s
compiled boundary. Both independent agent documentation plugins describe the same rehearsal loop
through skill-relative references.

## Consequences

Rehearsal catches errors only on the visited path. Minimal arrays, first enum/union choices, custom
refinements, and real local effects must remain explicit in reports and documentation. Failed
rehearsals preserve step/stack diagnostics in their output but remove temporary state on normal
exit. Reports contain full prompts and results; private artifact payloads are omitted.

Harness kinds guard accidental mixing, not adversarial adapters. Embedders need distinct kind names
for distinct simulation/native modes; old unlabelled runs cannot be retroactively classified.
Cumulative call identity enables fixture routing and stable external deduplication keys without
claiming that native agents deduplicate file edits.

Normal tests replay captured bytes through shipped scripts. The opt-in `test:contract` job uses
installed CLIs with fake credentials and isolated loopback APIs, checks semantic protocol/exit
contracts, and refreshes sanitized version-tagged captures. It makes no paid inference calls and
remains separate from the older paid Claude schema matrix. Custom `module:` loading remains #64.

## Amendment: command fixtures and typed fixture failures (#147)

Rehearsal synthesized every `ctx.exec` result and `--harness fixture` replaced agents only, so a
workflow that branches on command output (CI checks, `gh` queries) rehearsed paths real execution
never takes, and fixture `error` rules always settled as `unknown`.

The fixture file (still version 1) gains an optional ordered `exec` array of command rules and an
optional `"commands": "fixture"` mode. Exec rules live beside `calls` rather than inside it, so
agent rules, their matching and their `fixtureIndex` numbering are unchanged and the public
`FixtureCall` type keeps its shape; exec rules have their own index space (`FixtureExecCall`). A
rule filters on step glob, an exact argv prefix (never matching a shell command), the recorded
environment and stdin digests, the attempt, and a per-rule occurrence counted over distinct step IDs
in this process. The matched result enters the normal exec path, so exit-code contracts and schemas
still apply.

Commands that no rule matches keep today's behavior (synthesized under `--dry-run`, real under
`--harness fixture`) unless `commands: "fixture"` is set; then they fail at their step as a
`ConfigurationError`, never retried or settled. Dry-run honors this mode, unlike `unmatched`,
because its purpose is to forbid synthesis. Under `--harness fixture`, commands go through the new
`RunOptions.execRunner`, a process runner for `ctx.exec` only; worktree Git keeps
`RunOptions.processRunner`, so fixture runs still provision real isolated checkouts. Exec rules come
only from the global fixture file: a named per-harness file with `exec` or `commands` is refused,
because commands are not per-harness. Exec outputs answered by fixtures are guarded by the existing
harness-kind provenance (`fixture` or `dry-run`).

`workflow fixtures` exports completed commands as exec rules keyed by full step ID, full argv and
both digests, and then sets `commands: "fixture"`, so a replay that drifts fails loudly instead of
running a real command such as a merge. Environment overlay values and stdin are never exported.

A fixture `error` rule may carry `kind` (an `ErrorKind`). The call then rejects with a
`HarnessError` of that kind whose message is the unchanged `Step <id>: <error>` text, so `retry.on`,
`StepError.kind` and kind-based branches can be rehearsed while kindless rules behave exactly as
before. Export still writes agent error rules without `kind`.
