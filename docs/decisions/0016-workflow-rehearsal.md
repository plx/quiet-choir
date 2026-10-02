# 0016: Rehearse ordinary workflows through fixture harnesses and a pure native planner

## Status

Accepted. Amended by #147 (command fixtures and typed fixture failures) and #148 (synthesized
worktree isolation).

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

## Amendment: synthesized worktree isolation (#148)

Rehearsal refused every worktree effect with a `ConfigurationError`, so a ticket or merge workflow,
which always isolates, could not be previewed before paid work, and its isolated calls never
appeared in the report.

Dry-run now synthesizes the two Git effects whose real outcome is predictable without writing to the
repository: an agent call with fresh isolation (`'worktree'`, `worktree: true` or
`{ kind: 'worktree', base }`), and `ctx.merge` when every input is a change with `commit: null`. The
call is planned in an absolute placeholder directory that mirrors the real cache layout
(`<root>/<runId>-dry-run/<attempt digest>/<relative cwd>`) and is never created; it records
`step.worktree` in the temporary checkpoint, returns `{ base, commit: null, ref: null, files: [] }`
and runs no `worktrees.setup`. The merge returns `{ commit, merged: [], conflicts: [] }`, the result
a real integration of unchanged inputs computes, with `commit` the existing target branch or `HEAD`.
Step identity and dependencies are unchanged, so fingerprints match the real run. The pure replay
decision gains a `rehearsalSynthesized` fact and refuses `rehearsal-git` only without it; a
`worktree` effect is refused regardless.

The base is read, never written. Under rehearsal `RunWorktrees` refuses every Git command with an
internal error, and synthesis runs Git only through a read-only driver that refuses anything but
`rev-parse` before it reaches the process runner. Resolution is memoized per run and revision. A
resolvable repository with an unresolvable base, no committed `HEAD`, a cache root inside the
checkout, or an isolated `cwd` outside it fails with the real run's configuration error, since
rehearsal exists to surface those. Without a process runner, outside a Git working tree, or when the
runner answers with nothing, a placeholder of forty zeros stands in, with a warning. A dry-run
resume of an interrupted real attempt reuses its recorded base. The report marks each synthesized
call with `worktree: { synthesized: true, base, baseSource }`, lists `merges`, and warns once that
synthesized trees are unchanged.

Routing (#308): the CLI now passes the real process runner as `RunOptions.processRunner` and the
rehearsal's synthesizing runner as `RunOptions.execRunner`, the same split `--harness fixture` uses.
`ctx.exec`, including `guardFile` helpers, still never spawns under dry-run; the only process a
dry-run may start is that read-only `git rev-parse`. Later command routes (`StepContext.exec`,
command polls) should follow `execRunner`. An embedder that passes `rehearsal` hooks with a
synthesizing `processRunner`, as the CLI did before, now gets placeholder bases instead of a
refusal.

Still refused, with a message that names what dry-run synthesizes: `ctx.worktree`, any effect
isolated on a handle (agent, exec or step), and a merge with a handle input or a captured commit,
which reaches rehearsal only from a dry-run resume or fork of a real run. Synthesizing an
integration over real commits would misreport `merged` and `conflicts`, and computing it writes
objects. A branch on a captured change takes the unchanged path in rehearsal. The CLI also prints
the rehearsal warnings and summary on the failure path; the failure document keeps its shape, and,
as before (#276), a dry-run failure carries no resume advice.
