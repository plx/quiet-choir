# 0016: Rehearse ordinary workflows through fixture harnesses and a pure native planner

## Status

Accepted. Amended by #147 (command fixtures and typed fixture failures) and #148 (synthesized
worktree isolation; since #217 the accepted-replay probe synthesizes every worktree effect).

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

Since #306, a command failure the run settled with `onError: 'return'` or absorbed (a step left
`failed` in a completed run) exports as the same kind of rule rather than as a new error form: a
nonzero `code`, the recorded stderr tail, and the stdout tail or the failure's `parsed` value as
`json`. `ctx.exec` builds its settled `ExecStepError` deterministically from a command result, the
step's `okExitCodes` and its schema, so that rule reproduces the message, kind, code, signal, tails
and `parsed` of an exit-code or `exec.json` schema failure; the runtime and the exporter share the
failure messages that tell these apart. `json: parsed` is used unless the tail is complete JSON for
it in another layout, which keeps short pretty-printed output byte for byte, still reproduces
`parsed` when stdout was longer than its 1024-character tail, and makes export, replay and export a
fixed point. An `exec.json` failure (exit code or schema) with no `parsed` whose stdout tail fills
the 1024 characters gets no rule either, as a tail that lost its start can be valid JSON and replay
as success or with an invented `parsed`; so does an `exec.json` exit failure recorded as
`truncated`, and a `parsed` whose compact form exceeds the 16 KiB bound the runtime keeps, since the
replay would drop it. Spawn failures, timeouts, signal kills, `output-limit` and custom runner kinds
cannot come from a command result; exec error rules (#307, below) can describe them by hand, but
export does not produce them yet. Such a failure gets no rule, but it still makes the export set
`commands: "fixture"`, so its replay fails at that step instead of running the command or
synthesizing a success.

A fixture `error` rule may carry `kind` (an `ErrorKind`). The call then rejects with a
`HarnessError` of that kind whose message is the unchanged `Step <id>: <error>` text, so `retry.on`,
`StepError.kind` and kind-based branches can be rehearsed while kindless rules behave exactly as
before. Export writes agent error rules with their recorded `kind` (#305), except `unknown`, which a
kindless rule already replays as, and `cancelled`, which would be fatal on replay. That includes the
rules it writes for agent failures the workflow absorbed (steps left `failed` in a completed run by
a body `try/catch` or a settled map item), whose text comes from the step's recorded error and whose
kind comes from the last attempt.

## Amendment: synthesized worktree isolation (#148)

Rehearsal refused every worktree effect with a `ConfigurationError`, so a ticket or merge workflow,
which always isolates, could not be previewed before paid work, and its isolated calls never
appeared in the report.

Dry-run now synthesizes the two Git effects whose real outcome is predictable without writing to the
repository: an agent call with fresh isolation (`worktree: true` or `worktree: { base }`; #340
removed the older spellings from the public types), and `ctx.merge` when every input is a change
with `commit: null`. The call is planned in an absolute placeholder directory that mirrors the real
cache layout (`<root>/<runId>-dry-run/<attempt digest>/<relative cwd>`) and is never created; it
records `step.worktree` in the temporary checkpoint, returns
`{ base, commit: null, ref: null, files: [] }` and runs no `worktrees.setup`. The merge returns
`{ commit, merged: [], conflicts: [] }`, the result a real integration of unchanged inputs computes,
with `commit` the existing target branch or `HEAD`. Step identity and dependencies are unchanged, so
fingerprints match the real run. The pure replay decision gains a `rehearsalSynthesized` fact and
refuses `rehearsal-git` only without it; a `worktree` effect is refused regardless.

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
command polls) should follow `execRunner`. Amended by #150: a callback's or observer's
`context.exec` follows `execRunner`, and the report lists those commands with `parentStepId`. A poll
observer's `live: true` command is the one other process a dry-run starts: it goes to the real
`processRunner`, which the CLI wraps to list it with `outputSource: 'live'`. Outside a rehearsal
`live` is ignored, so fixture rules still answer it. An embedder that passes `rehearsal` hooks with
a synthesizing `processRunner`, as the CLI did before, now gets placeholder bases instead of a
refusal.

Still refused, with a message that names what dry-run synthesizes: `ctx.worktree` and any effect
isolated on a handle (agent, exec or step). A merge with a handle input or a captured commit was
refused here too, until #310 (below) previewed it. A branch on a captured change takes the unchanged
path in rehearsal. The CLI also prints the rehearsal warnings and summary on the failure path; the
failure document keeps its shape, and, as before (#276), a dry-run failure carries no resume advice.

The accepted-replay preflight's probe (ADR 0006, #217) is the one exception: the runtime recognizes
its rehearsal hooks and synthesizes every worktree effect, `ctx.worktree`, handle isolation and
merges of captured commits included, with placeholders and no Git command at all (its synthesis gets
no process runner). The probe only looks for a changed or skipped completed step and reports
nothing, so placeholder values cannot misreport a preview. `--dry-run` and embedders passing their
own `rehearsal` hooks keep the refusals above, except merges, which #310 previews.

## Amendment: previewed merges over captured commits (#310)

A dry-run resume or fork of a real run reaches `ctx.merge` with real inputs: a completed isolated
step replayed or reused with a captured commit, or a replayed `ctx.worktree` handle. Rehearsal
refused those merges, because computing the integration with `merge-tree` and `commit-tree` writes
objects into the repository, and a placeholder would misreport `merged` and `conflicts`.

Dry-run now synthesizes every `ctx.merge` and previews one over captured commits with the real
computation, in a quarantined object store:

- The first merge that has an input commit creates one `0700` temporary directory under the system
  temporary directory (`quiet-choir-rehearsal-objects-*`) for the rest of the rehearsal. From then
  on every rehearsal Git command runs with `GIT_OBJECT_DIRECTORY` set to it,
  `GIT_ALTERNATE_OBJECT_DIRECTORIES` set to the repository's object directory (from
  `rev-parse --path-format=absolute --git-path objects`, quoted as a C-style string when it contains
  the path delimiter), `GIT_QUARANTINE_PATH` (so Git itself refuses any ref update) and
  `GIT_NO_LAZY_FETCH`, all applied after the driver's `GIT_*` scrub and the per-call environment.
  The quarantined driver runs only `rev-parse`, `merge-tree`, `commit-tree` and `var` and refuses
  anything else before it reaches the runner. The read-only `rev-parse` driver gets the same
  `GIT_NO_LAZY_FETCH`, so neither driver fetches a missing object from a partial clone. Only Git
  2.44 or later honors that variable, so merge previews in a partial clone need Git 2.44 or later:
  before a preview over captured commits looks up any input, it lists `extensions.partialclone` and
  `remote.<name>.promisor` with `git config --name-only --get-regexp` and, if either is set, reads
  `git --version` and refuses with a `ConfigurationError` on older (or unrecognized) Git. One store
  per run, not per merge, keeps a preview's commit resolvable by later rehearsal steps, such as an
  isolation with `base: { commit }` or a stacked merge; real commits still resolve through the
  alternate. The runner removes the directory when the execution ends, on every path, after its
  operations drain. A killed process leaks it in the temporary directory.
- The real merge and the preview share the code, not just the idea: `computeIntegration` (virtual
  merge-base commits, `merge-tree`, conflict collection, the `onConflict: 'fail'` error, squash and
  the custom-message commit), `commitTree` and `resolveCommit`. Inputs are checked the same way
  (`base` and `commit` must round-trip through `rev-parse`, otherwise "Merge input commit is
  unavailable in this repository."). A `'git-config'` author runs the read-only `git var`, so a
  missing identity still fails the rehearsal. The commit date is the rehearsal attempt's start, as
  the real merge uses its attempt's start, so preview commit IDs differ from a later real run and
  vanish with the store; a workflow that persists `result.commit` outside the run sees a dangling
  ID.
- A handle input resolves from the copied record's ledger with the real ownership check and mapping
  (`latest`, or no commit when it equals the base), and a foreign handle fails with the real
  `ConfigurationError`. A handle reaches a dry-run merge only as a replayed completed `ctx.worktree`
  in a dry-run resume, and dry-run still refuses `ctx.worktree` and handle isolation, so the ledger
  holds exactly what a real resume would merge. ADR 0022 forbids fork reuse of handles, so a fork
  brings only changes.
- Unchanged inputs keep the no-op path and create no store. A captured commit or handle without a
  resolvable repository (no process runner, outside a Git working tree, or a runner that answers
  nothing) fails with a `ConfigurationError`: placeholders cannot represent `merged` or `conflicts`.
- A custom merge driver (`merge.<name>.driver`) is an arbitrary command that `merge-tree` runs, and
  the object quarantine cannot stop it writing to the checkout or anywhere else. Before creating the
  store, the preview lists the configured drivers with `git config --name-only --get-regexp` and
  refuses with a `ConfigurationError` if there is any. It does not override them: a text merge would
  report conflicts the real merge would not, which is worse than no preview.
- With `merge.renormalize` set, `merge-tree` runs the clean and smudge filters
  (`filter.<name>.clean`, `.smudge` or `.process`) on the blobs it renormalizes, and they are
  arbitrary commands too. The preview reads `merge.renormalize` with `git config --type=bool --get`
  and, when it is true, lists the configured filters the same way and refuses with a
  `ConfigurationError` if there is any. It does not turn renormalization off, which would make the
  preview diverge from the real merge. These configuration reads and the partial-clone check's
  `git --version` are the only commands besides `rev-parse` the read-only driver runs.
- The rehearsal keeps the tip each `branch` or `checkout` preview would leave, in memory, keyed by
  the ref the real merge moves (`refs/heads/<branch>`, or the checked-out branch's ref, or `HEAD`
  when detached, for `checkout`; a branch target naming the checked-out branch shares its key). A
  later merge into the same target starts from that tip, and one into `ref` or a missing branch,
  which starts from `HEAD`, starts from the checked-out branch's tip, so sequential previews
  conflict where the real merges would. A no-op into a missing branch records `HEAD`'s tip for it,
  since the real merge creates the branch there. Previews run one at a time in call order, as real
  merges do under the run's integration lock, so concurrent previews into one target chain too. A
  later fresh isolation based on `HEAD` (the default) or on a name for a previewed branch starts
  from the previewed tip, as it would after the real merge; a `{ commit }` base is unaffected. A
  `ref` target moves no ref and records no tip. No ref is written.
- Nothing else of a real merge happens: no `step.merge` preparation, no pinned or published ref, no
  checkout update and no integration or handle locks, since the repository does not change. The
  target checks and the Git version check are rehearsed since #312 (below).

The merge event and the report's `merges` entries gain `merged` and `conflicts`. The pure replay
decision is unchanged: its `kind === 'merge'` clause still refuses a merge that a caller does not
synthesize, but the runner now synthesizes every merge under rehearsal, and the `rehearsal-git`
message no longer lists merges. The accepted-replay probe keeps its Git-free placeholder merges.

## Amendment: rehearsed merge target checks (#312)

Before #312 a dry-run passed where the real run failed: a merge into an invalid branch name, a
branch checked out in a worktree or a dirty `checkout` target, and any worktree effect on Git older
than 2.38, while a dirty source checkout got no warning. The rehearsal now makes these checks with
the real code and messages:

- The real merge's target checks are one function, `checkMergeTarget`, that the real `integrate` and
  the rehearsal's merge preview both call before anything else of the merge: for a `branch` target,
  `git check-ref-format refs/heads/<branch>` (an `ExecError`), then the worktree listing (a branch
  checked out in any worktree, the current checkout included) and `git symbolic-ref -q` (a
  symbolic-ref branch); for a `checkout` target, `git status --porcelain --untracked-files=normal`.
  Messages and error classes are shared by construction, and no-op merges are checked too, as the
  real merge checks them. The real run's publish-time rechecks call the same helpers.
- The checks the real `RunWorktrees.ledger()` makes when it creates a ledger are shared too: the
  version refusal (`gitVersionRefusal`) and the dirty-source warning text. The rehearsal makes them,
  with the cache-root check, once, at the first isolation or merge that resolves a repository, and
  only while the record has no ledger, so a dry-run resume with a copied ledger skips them as the
  real recovery path does. An empty `--version` answer or a failure to run Git leaves the existing
  placeholder path in charge (the #148 decision); outside a working tree no version check runs.
- The read-only driver gains four exact argument vectors and nothing else: `check-ref-format <ref>`,
  `symbolic-ref -q <ref>` (one operand that is not an option; a second operand, or `-d`, would write
  the ref), `worktree list --porcelain -z` and `status --porcelain --untracked-files=normal`. It
  also fixes `GIT_OPTIONAL_LOCKS=0`, because `git status` otherwise refreshes stat data in the
  index. Close variants are refused before they reach the runner.
- The checks run through a read-only driver the rehearsal never replaces, so they still run after a
  merge preview has switched rehearsal Git to the quarantined driver, which refuses them.
- `git worktree list` is ordered against a concurrent `worktree add` only by the in-process
  administration queue (keyed by the realpath of the common Git directory, as the real lock is). The
  real merge also takes the interprocess lock, but that creates
  `<common Git dir>/quiet-choir/worktree-admin.lock`, a write into the repository. A `worktree add`
  in another process can still race the rehearsal's listing, which can then rarely fail.
- Reading `<common Git dir>/worktrees/*/HEAD` instead of running `git worktree list` was rejected:
  under the reftable backend that file is a stub, and it would re-implement Git's semantics instead
  of sharing the real check.
- Behaviour change: a dry-run that used to succeed now fails as the real run would, notably a
  `branch` target naming the checked-out branch, which previously shared the `checkout` target's
  preview tip, and a no-op merge into an invalid branch.
- Known limit: like the real check, `git status` may run a configured clean filter (git-lfs, for
  example) on a file whose stat data changed, and such a filter can write (to `.git/lfs`, say). The
  rehearsal runs the identical command rather than refuse, since refusing would make `checkout`
  dry-runs unusable in LFS repositories.

## Amendment: exec error rules and stale agent rules (#307)

An exec rule may carry `error` instead of `json` or `stdout`, with an optional `kind` (the same
`ErrorKind` values agent rules accept; `kind` requires `error`, and `stderr` and `code` are refused
beside it). The command rejects immediately with an `ExecError`, from `FixtureExecRules.answer`, so
`--harness fixture` and `--dry-run` behave identically and `retry.on`, `onError: 'return'` and
`try/catch` see what the real runner gives. Matching filters, first-match order and occurrence
counting are shared with result rules. Choices:

- The default `kind` is `process`, not `unknown` as for agent error rules, because the real runner
  maps every failure it cannot classify to `process` and never surfaces `unknown` from `ctx.exec`.
- The message is the rule's text verbatim, with no `Step <id>: ` prefix, because real command
  failure messages carry none; a later export can then round-trip messages.
- The error has no process result: diagnostics have a null code and signal, empty tails,
  `truncated: false` and duration 0, which is what a real spawn failure records. A real timeout also
  carries a signal and partial output, so the rule is lossy for a workflow that inspects them.
- Nothing waits: a simulated timeout rejects at once. `cancelled` is accepted for parity with agent
  rules and fails the step as cancelled.
- Export is unchanged and still writes no rule for a spawn failure or timeout. Producing error
  rules, possibly with optional diagnostics fields, is future work.

In the rehearsal `commands` list a matched error rule has output source `fixture`, its index, and
its message in `error`.

The report also lists agent rules that matched no call as `staleCallFixtures`, with a warning, as
`staleExecFixtures` does for exec rules. Entries are `{ harness, index }` with the index in the
rule's own file (`harness` is the name of a `--harness NAME=fixture:FILE` file, or null for the
global file), not the combined index that `calls[].fixtureIndex` uses, because a combined index
means nothing to the author of named files. Tracking is rehearsal-only, and rules for steps replayed
from a checkpoint are always stale.
