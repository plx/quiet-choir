# Rehearse before you pay

Set `QC_CHECKOUT` to the actual runtime checkout, not this plugin cache. The bundled example
commands below assume the checkout root as the working directory; use the workflow project directory
for your own files. This plugin supplies documentation, not executables.

Run the workflow body with free agent responses before launching installed CLIs. Validation alone
checks input/output schemas; rehearsal also reaches call-site schemas, IDs, options, JSON values,
and dynamic branches. The CLI uses the same source fingerprint for fixture and native execution.

```sh
node "$QC_CHECKOUT/bin/run.js" workflow validate examples/duet.workflow.ts --json
node "$QC_CHECKOUT/bin/run.js" workflow execute examples/duet.workflow.ts \
  --input '{"topic":"durable agent workflows"}' --dry-run --json > rehearsal.json
# Inspect the calls, prompts, schemas, argv, limits, warnings, and reached branches.
node "$QC_CHECKOUT/bin/run.js" workflow execute examples/duet.workflow.ts \
  --input '{"topic":"durable agent workflows"}' --run-id duet
```

`--dry-run` invokes no Claude/Codex executable, version discovery, or OS owner-identity probe. The
only processes it may start are read-only Git commands for isolated calls and merges
(`git rev-parse` resolving a base, `git --version`, `git status`, a merge target's checks and
configuration reads; see [worktree isolation](#worktree-isolation)), a merge preview's quarantined
commands, and a `live: true` command of a poll observer or command poll. Checkpoint files live in a
private temporary directory removed when the executor finishes. The normal/default state directory
is not created. Typechecking/importing still run normally. **Local callbacks and top-level workflow
code execute for real.** Temporary checkpoints do not undo their filesystem, subprocess, network, or
external effects. Stub named local effects when needed:
`--stub-steps 'publish/**' --stub-steps 'notify/*'`. These patterns match fully qualified IDs; `*`
stays within a segment and `**` crosses segments. Matched callbacks, file reads/writes and poll
observers receive synthesized results through their original Zod validation (a matched poll
completes without calling its observer); unmatched callbacks run normally. Commands (`ctx.exec`)
never spawn: they are synthesized from their schema unless the fixture file has a matching exec rule
(see [command fixtures](#command-fixtures)). The same holds for commands a local callback or poll
observer runs through `context.exec`, and for each check of a
[command poll](waits.md#command-polls), whose output is synthesized from its `output` schema, except
that an observer or a command poll may pass `live: true` to keep a read-only check real, such as the
initial observation of a wait. `live` is refused in a step callback. Durable sleeps complete
immediately. Rehearsal preserves capability/profile validation and still requires declared grants.

## Fixtures

`--harness cli` is the default. `--harness fixture:./fixtures.json` uses this versioned format:

```json
{
  "version": 1,
  "calls": [
    { "step": "triage", "output": { "severity": "high", "files": ["a.ts"] } },
    { "step": "review/2", "attempt": 1, "error": "simulated failure", "kind": "timeout" },
    { "step": "review/*", "harness": "codex", "output": { "findings": [] } },
    { "step": "summary", "text": "Looks fine.", "usage": { "costUsd": 0.01 } }
  ],
  "unmatched": "error"
}
```

Rules use first-match order, with optional harness and cumulative attempt filters. Exactly one of
`output`, `text`, and `error` is required. `text` is the raw adapter response; structured calls
parse it as JSON. `output` is serialized for structured calls, while a string output on a text call
stays plain text. Missing usage fields become null. Results still pass normal parsing, Zod
validation, and checkpointing; stale fixtures fail at their named step. Missing rules fail with the
step, harness, and attempt unless `unmatched` is `synthesize`. Unmatched calls and synthesis gaps
reject as configuration errors and are never settled or retried, while a rule's `error` simulates a
settleable invocation failure. An optional `kind` (an `ErrorKind`, such as `timeout`, `rate-limit`,
`overloaded` or `invalid-request`; it requires `error`) gives that failure a category: the call
rejects with a `HarnessError` of that kind and the same `Step <id>: <error>` message, so `retry.on`
filters, `StepError.kind` and branches on it can be rehearsed. Without `kind` the failure is
`unknown`, as before.

Fixture execution writes ordinary durable records. Use `--dry-run --harness fixture:./fixtures.json`
for temporary state, immediate sleeps, and synthesis of unmatched calls regardless of the file's
`unmatched` setting. Fixture overrides can direct branches and supply data that synthesis cannot.

Export successful agent outputs and command results from a completed run without importing its
workflow or acquiring its lock:

```sh
node "$QC_CHECKOUT/bin/run.js" workflow fixtures duet --json > fixtures.json
node "$QC_CHECKOUT/bin/run.js" workflow execute edited.workflow.ts \
  --dry-run --harness fixture:./fixtures.json --json
```

Export skips local/sleep effects. It keeps completed agent outputs, which retain harness and usage
but do not pin an attempt number, and agent failures as `error` rules with their original `kind`
(except `unknown` and `cancelled`), all in execution order. That covers settled failures
(`onError: 'return'`) and failures the workflow absorbed, such as a body `try/catch` around an agent
call or a settled map item, which leave the step `failed` in a completed run. A replayed rule always
rejects with a `HarnessError` of the recorded kind, so failures the runtime classified from other
error classes, such as local output validation (`schema`, which originally threw `ZodError` or
`SyntaxError`) or plain process or idle-timeout errors, keep their kind but not their error class.
Workflow code that must replay faithfully should branch on `kind` rather than `instanceof`.
Completed commands become `exec` rules in execution order, keyed by full step ID, the full argv as
`argvPrefix` (omitted for a shell command), and the recorded `envSha256` and `inputSha256`;
environment overlay values and stdin are never read or written, only those digests. A structured
command exports its parsed value as `json`; a plain one exports `stdout`, plus `stderr` and `code`
when they are not empty or zero. A command failure the run settled (`onError: 'return'`) or absorbed
(a step left `failed` in a completed run) becomes the same kind of rule when a command result can
reproduce it: an exit code outside `okExitCodes`, or an `exec.json` stdout that did not parse or
match its schema. The rule carries the exit `code`, the recorded stderr tail as `stderr`, and either
the failure's `parsed` value as `json` or the recorded stdout tail as `stdout` (complete
pretty-printed JSON under 1024 characters keeps its bytes). The replay sends that result through the
same exit-code and schema checks, so the settled error or thrown `ExecError` has the same message,
kind, code, signal, tails and `parsed`. Long pretty-printed JSON replays compact (its `stdoutTail`
differs in whitespace), output rebuilt from `parsed` uses the checkpoint's sorted key order (a
schema failure's message can list its issues in a different order), and a replayed `ExecError`
reports `truncated: false` and `durationMs: 0`. Any `exec.json` failure (exit code or schema)
without `parsed` whose stdout tail fills all 1024 characters gets no rule (the tail may have lost
its start and replay as valid output or an invented `parsed`), neither does an `exec.json` exit
failure recorded as `truncated`, and neither does a `parsed` whose compact form is over 16 KiB, so
its replay fails at that step. Spawn failures, timeouts, signal kills, `output-limit` failures and
custom runner kinds get no exported rule (an exec error rule can describe them by hand; export does
not produce them yet). When the run has any completed, settled-failed or failed command, export also
sets `"commands": "fixture"`, even when a failure produced no rule, so a replay whose argv or inputs
drift, or that reaches such a failure, fails at that step instead of running the real command;
shorten `argvPrefix` or drop a digest by hand when a value legitimately changes per run. A run
without commands exports exactly as before. It does not modify the source checkpoint.

## Command fixtures

The same file can answer `ctx.exec` and `ctx.exec.json` with an optional `exec` array, so a workflow
whose branches come from command output (CI checks, `gh` queries) rehearses the path real execution
takes:

```json
{
  "version": 1,
  "calls": [{ "step": "fix-*", "output": { "fixed": true } }],
  "exec": [
    { "step": "prepare", "json": { "pr": 7, "headRefOid": "abc123" } },
    {
      "step": "gate-*",
      "argvPrefix": ["gh", "pr", "checks"],
      "occurrence": 1,
      "json": { "state": "failure", "headRefOid": "abc123" }
    },
    { "step": "gate-*", "json": { "state": "success", "headRefOid": "abc123" } },
    { "step": "merge", "argvPrefix": ["gh", "pr", "merge"], "stdout": "merged\n" }
  ],
  "commands": "fixture"
}
```

Exec rules are first match, separate from agent `calls` and numbered in their own index space. A
rule matches a command when every filter it has holds: `step` (the same glob as agent rules),
`argvPrefix` (leading argv elements, compared exactly; a rule with a prefix never matches a
`{ shell }` command), `envSha256` and `inputSha256` (the digests the step's exec summary records),
`attempt` (cumulative, so a retry can see a different answer), and `occurrence`. A rule's occurrence
is the one-based position of the step among the distinct step IDs that met its step, argv and digest
filters so far; every rule counts every command, so it does not depend on earlier rules, and retries
keep their occurrence. Above, `gate-1` gets `failure` and `gate-2` `success`. Occurrences count only
commands that reach the process runner in this process: steps replayed from a checkpoint never do,
and concurrent commands count in launch order, so prefer full step IDs for a run you will resume. A
command from a callback's or observer's `context.exec` matches by its parent step or wait ID. All of
one parent's commands share its occurrence, so tell them apart with `argvPrefix`.

Exactly one of `json` (serialized as stdout), `stdout` and `error` is required. A result rule takes
`stderr`, default empty, and `code` (0-255), default 0; the result then goes through the step's
usual checks: a code outside `okExitCodes` fails like a real exit (kind `process`), and
`ctx.exec.json` parses and validates the stdout with its schema.

An error rule (`error`: the message, plus an optional `kind` that requires `error`; `stderr` and
`code` are refused beside it) simulates a command with no result, such as a missing binary or a
timeout. It matches like any rule (filters, first match, occurrence counting) and the command
rejects immediately with an `ExecError` of that `kind` (default `process`, not the `unknown` of
agent rules, because the real runner reports unclassified failures as `process`) whose message is
the `error` text verbatim, with no `Step <id>: ` prefix. Like a real spawn failure it has no process
result: `error.diagnostics` has a null `code` and `signal`, empty tails, `truncated: false` and a
duration of 0. A real timeout's signal and partial output are not reproduced. `retry.on`
(`transient` covers `timeout`), `onError: 'return'` and `try/catch` then behave as with the real
runner, so `{ "step": "gate-*", "attempt": 1, "error": "timed out", "kind": "timeout" }` followed by
a `gate-*` result rule rehearses a retry that recovers.

A command no rule matches is synthesized under `--dry-run` and runs for real under
`--harness fixture`. With `"commands": "fixture"` it instead fails at its step as a configuration
error, naming the step, the JSON argv and the attempt; it is never retried or settled. Unlike
`unmatched`, which `--dry-run` overrides, `commands: "fixture"` is honored under `--dry-run`,
because its purpose is to forbid synthesis.

Under `--harness fixture` without `--dry-run`, matched commands are answered without spawning
through `RunOptions.execRunner`; worktree Git operations always use the real process runner, so
isolated worktrees are still provisioned. `--dry-run` routes the same way: its synthesizing runner
is the `execRunner`, and the real runner serves only the read-only Git described below. A callback's
`context.exec` and each command-poll check follow the same `execRunner` route. Under
`commands: "fixture"` worktree Git is unaffected, because it never goes through exec rules.
`guardFile`'s baseline and restore helpers are ordinary exec effects too, so under
`commands: "fixture"` they need rules (for example a `**/baseline` step glob). Commands are not
per-harness: a named `--harness name=fixture:FILE` file with `exec` or `commands` is refused; put
them in the global `--harness fixture:FILE`.

## Worktree isolation

Dry-run synthesizes fresh worktree isolation instead of refusing it. An isolated Claude or Codex
call is planned and recorded in `calls` like any other, with `cwd` set to an absolute placeholder
directory under the worktree cache root that is never created, and returns an unchanged change
`{ base, commit: null, ref: null, files: [] }`; `worktrees.setup` does not run. `ctx.merge` over
unchanged changes returns the no-op integration a real run would compute,
`{ commit, merged: [], conflicts: [] }`, with `commit` the existing target branch or `HEAD`. Step
IDs and fingerprints are those of the real run.

A dry-run resume or fork reaches `ctx.merge` with real inputs when it replays or reuses a completed
isolated step that captured a commit, or replays a `ctx.worktree` handle (resolved from the copied
run's ledger, with the real ownership check). Such a merge is previewed with the real integration
code, so `merged`, `conflicts` and an `onConflict: 'fail'` error match what a real merge would
report. The first preview creates a temporary object directory (`quiet-choir-rehearsal-objects-*`
under the system temporary directory) with the repository's objects as a read-only alternate; from
then on every rehearsal Git command writes objects only there, runs only `rev-parse`, `merge-tree`,
`commit-tree` and `var`, and cannot update a ref. Later steps of the same rehearsal can use the
preview commit, for example as an isolation base, and a preview into a `branch` or `checkout` target
builds on earlier previews into the same target in the same rehearsal, as the real merges would
after moving it (a `ref` target moves nothing, so its previews do not chain). A no-op preview into a
missing branch counts, since the real merge creates the branch; concurrent previews run one at a
time in call order, as real merges do; and a later fresh isolation based on `HEAD` or on such a
branch starts from its previewed tip. The directory is removed when the rehearsal ends (a killed
process can leave it behind), so the preview `commit` no longer exists afterwards; it is dated at
the rehearsal attempt's start, so it also differs from a later real run's commit. A preview records
no merge preparation and pins, publishes or locks nothing. Without a resolvable repository, a
preview fails with a configuration error. So does a preview while any custom merge driver
(`merge.<name>.driver`) is configured, or while `merge.renormalize` is set and any clean, smudge or
process filter (`filter.<name>.clean`, `.smudge` or `.process`) is configured: `merge-tree` would
run that command, and it could write outside the quarantine, so the first preview reads this
configuration with read-only `git config` before any merge and refuses instead of merging
differently from the real run. Rehearsal Git runs with `GIT_NO_LAZY_FETCH`, so it never fetches a
missing object from a partial clone's promisor remote, but only Git 2.44 or later honors it: merge
previews of captured commits in a partial clone (`extensions.partialClone` or a
`remote.<name>.promisor` is configured) need Git 2.44 or later. The first such preview lists that
configuration and, in a partial clone, reads `git --version`, and refuses with a configuration error
on older Git before it looks up any input commit.

The base is resolved once per revision with `git rev-parse` through the real process runner. The
runtime refuses every other Git command under rehearsal before it reaches the runner, apart from an
exact list of reads (`git --version`;
`git status --porcelain --untracked-files=normal --no-renames`, run with `GIT_OPTIONAL_LOCKS=0` so
it never refreshes the index, and without rename detection so it reads no blob contents to pair
renames, which Git older than 2.44 could otherwise fetch in a partial clone; a merge target's
`git check-ref-format`, `git worktree list --porcelain -z` and `git symbolic-ref -q`; and a merge
preview's partial-clone, merge-driver and filter configuration reads) and a merge preview's
quarantined commands, so a dry-run never creates refs, worktrees, cache directories, repository
objects or lock files. An unresolvable base, a repository with no committed `HEAD`, or an isolated
`cwd` outside the repository fails with the configuration error a real run reports. Outside a Git
working tree, or when Git cannot run, a placeholder of forty zeros stands in for the base, with a
warning that the real run fails. A dry-run resume of an interrupted real attempt reuses its recorded
base.

Before the run has a worktree ledger, the first isolated call or merge makes the checks a real run
makes when it creates one: Git older than 2.38 and a cache root inside the checkout fail with the
real configuration error, and a source checkout with uncommitted or untracked changes records the
real warning in `worktreeWarnings`. A dry-run resume of a run that already has a ledger skips them,
as the real resume does. Every merge, a no-op included, first makes the real merge's target checks:
a `branch` target with an invalid name, one checked out in any worktree (the current checkout
included; use `target: 'checkout'` for it) or a symbolic ref, and a `checkout` target with
uncommitted or untracked changes fail with the real run's error. The worktree listing waits only for
other runs in the same process, not for the repository's lock file, so a `git worktree add` in
another process can rarely make it fail. Like the real check, `git status` may run a configured
clean filter, such as git-lfs, on a file whose timestamps changed.

`ctx.worktree`, `ctx.exec` or `ctx.step` on a worktree handle, and an agent call isolated on a
handle still fail before Git or agent invocation with a configuration error. Rehearse those with a
fixture harness in a temporary repository. A branch that depends on a captured change, such as
`if (edit.worktree?.commit)`, takes the unchanged path in rehearsal.

## Synthesis and report

Enums take the first value. Strings use `dry-run:<stepId><json-pointer>`, adjusted for length
bounds; numeric samples start at their lower bound (otherwise zero, adjusted for upper bounds),
booleans use false, nullable values prefer a populated branch, and arrays contain `max(minItems, 1)`
items. Objects fill their declared fields, including optional fields; union order determines the
first satisfiable populated branch. Local references and object intersections are supported. Samples
are bounded to avoid unbounded recursive schemas or oversized allocations.

Unsatisfied constraints, including patterns/formats, fail with a step ID, output JSON pointer, and
fixture guidance. This is a deterministic sampler, not a solver for every schema. Original Zod
validation remains authoritative. Custom refinements emit warnings because JSON Schema cannot
represent their code; transforms and non-JSON schema types still fail at their call site.

Successful `--dry-run --json` output is `{kind:"workflow.rehearsal", ok:true, ...report, run}`. The
report contains:

- `calls`: attempted live calls in invocation order, with full step ID, cumulative attempt, harness,
  cwd, prompt, original schema, output source (`fixture` or `synthesized`), fixture index, process
  plan, resolved limits, and planning/fixture error when present. `worktree` is
  `{ synthesized: true, base, baseSource }` for a synthesized isolated call (`baseSource` is
  `resolved`, `recorded` or `placeholder`) and null otherwise.
- `merges`: synthesized `ctx.merge` effects with step ID, `synthesized: true`, `commit` (a previewed
  commit exists only during the rehearsal), the number of `inputs`, the `target` kind (`ref`,
  `checkout` or `branch`), `baseSource`, and the `merged` commits and `conflicts`
  (`{ commit, files }`) a real merge would report.
- `plan`: binary, argv, stdin, cwd, process limits, and private-file placeholders. File contents are
  omitted from the report. The same pure `CliHarness.plan()` validates real invocations, including
  Codex strict-schema checks, before materializing private files.
- `replays`: reused effect IDs/kinds. Their full original prompts were never saved, so they do not
  appear as new live calls. A completed-run preview lists all reused terminal effects.
- `commands`: commands that reached the rehearsal runner, with step ID, `parentStepId` (the step or
  wait whose callback or observer ran it through `context.exec`, the wait of a command poll's check,
  or null for `ctx.exec`), command, cwd, whether it is structured, output source (`fixture`,
  `synthesized`, or `live` for an observer's or command poll's `live: true` command that ran for
  real), the matched index in the file's `exec` array (or null), and `error`: the refusal of an
  unmatched command under `commands: "fixture"` (such an entry has output source `fixture` and index
  null), or the message of a matched exec error rule (output source `fixture` and the rule's index).
- `staleExecFixtures`: indices of exec rules that matched no command, with a warning when any exist.
  A resume preview reports rules for replayed steps as stale.
- `staleCallFixtures`: agent `calls` rules that matched no call, as `{ harness, index }` with a
  warning when any exist. `index` is the position in that file's own `calls` array; `harness` is the
  name of a `--harness NAME=fixture:FILE` file, or null for the global file. Unlike
  `calls[].fixtureIndex` (combined across files), rules for replayed steps are always stale.
- `harnessCounts` (`providerCounts` retains built-in compatibility counts),
  `nominalClaudeCeilingUsd`, `stubbedSteps`, `skippedSleeps`, and `warnings`.

The nominal Claude ceiling adds per-attempt `maxBudgetUsd` for valid native plans along the
rehearsed path. `wouldPay` is false when planning itself fails before a native invocation could
start. It is not a price quote or a hard spending guarantee: final-turn costs can overshoot CLI
budgets, synthesized one-item arrays can understate fan-out, and unvisited branches are absent.
Codex calls have no budget flag and are counted without pricing. Reports contain full
prompts/output; handle them as sensitive workflow data.

Failures keep the normal [CLI error document and exits](setup-and-cli.md), adding `rehearsal` and
`error.stack`. `error.stepId` also identifies authoring failures that occur before a step record is
created. Its warnings and the `Rehearsal: ...` summary are also printed to stderr. The report's
failure checkpoint is an in-memory copy: its temporary `stateDir` has been removed, so use a fresh
rehearsal to retry. An abrupt kill can leave temporary files behind.

## Preview resume and choose a harness

```sh
node "$QC_CHECKOUT/bin/run.js" workflow execute workflow.ts \
  --dry-run --resume --run-id real-run --json
```

The executor copies the source record into temporary storage, then runs ordinary compatibility,
input, step-identity, and replay checks. Completed effects return their real saved outputs;
unfinished effects use fixtures or synthesis. Source locks/process registries are neither copied nor
recovered. Fork sources remain read-only. `--accept-code-change` and `--strict-replay` retain their
normal meanings. A preview deliberately allows the harness change only in its disposable copy; it
never grants future native execution.

`--dry-run --resume --accept-code-change` previews an accepted code change. When the replay reaches
a completed or settled-failed step whose identity changed, or skips a completed step, settled map or
child frame, it returns the same `run.incompatible` refusal as the real command, with
`error.details.divergent` and `error.details.next` spelled for the real state directory (see
[durability](durability.md#choose-a-recovery-path)). The real command runs the same replay on its
own before it changes anything, with every unfinished local step, file effect, poll observer and
command stubbed and fixtures disabled.

New records save `harness.kind`: `cli`, `fixture`, `dry-run`, `custom` for an unnamed embedded
adapter, or `none` without an adapter. A different kind on resume or fork requires
`--allow-harness-change` (embedding: `allowHarnessChange: true`), even on the completed-run fast
path. This prevents accidental reuse of simulated outputs as native results. A run that has only
ever been `none` holds no agent outputs, so any harness can resume or fork it without the flag or a
recorded change; adapters cannot claim the reserved kind `none`. The check does not establish trust
in arbitrary executable adapters. Custom adapters should give distinct modes explicit `kind` values.
Actual changed executions retain `previousKinds`; completed fast-path reads retain their original
provenance. Live CLI executions also save `harness.configDigest`; resuming under the same kind with
a different `--harness-config` requires `--allow-harness-config-change` (embedding:
`allowHarnessConfigChange: true` with `harnessConfigDigest`). Dry runs supply no digest. Earlier
format-6 records have no kind, so they remain resumable without guessing their historical adapter.
Pre-rehearsal fingerprints are unchanged.

Configure CLI executable paths and process limits with inline JSON or a file:

```sh
node "$QC_CHECKOUT/bin/run.js" workflow execute workflow.ts \
  --harness-config '{"claudeBinary":"./fake-bin/claude","maxOutputBytes":33554432}'
node "$QC_CHECKOUT/bin/run.js" workflow execute workflow.ts --dry-run --harness-config @harness.json --json
```

Allowed keys are `claudeBinary`, `codexBinary`, `maxRetainedBytes`, `maxStreamBytes`, legacy
`maxOutputBytes`, `scrubEnv`, and `killGraceMs`; other keys and invalid limits fail before workflow
import. Relative file/binary paths resolve against the launch cwd. Bare executable names use PATH.
Explicit `--kill-grace-ms` overrides the config field. `--harness-config` also configures the
dry-run planner; ordinary fixture execution gets its data from the fixture file. `module:` loading
is unsupported: register packages with `defineWorkflow({ harnesses })`. Use repeated
`--harness name=fixture:FILE` to override individual registrations. Per-package configuration
belongs under `harnesses.<name>` in the same JSON config.

## Embedding and native protocol tests

The root entry point exports `FixtureHarness`, `parseHarnessFixtures`, `HarnessFixtures`,
`FixtureCall`, `FixtureExecCall`, and `synthesizeOutput`. Supply `new FixtureHarness(fixtures)` to
`runWorkflow` for durable fixture execution; `FixtureHarness` answers agent calls only. To answer
commands, pass your own `ProcessRunner` as `RunOptions.execRunner`, which `ctx.exec` and
`context.exec` use instead of `processRunner` while worktree Git keeps `processRunner`. A
`context.exec` request, including a command poll's check, has `nested: true`; under
`RunOptions.rehearsal` an observer's or command poll's `live: true` command goes to `processRunner`.
With `RunOptions.rehearsal`, the runtime uses `processRunner` only for read-only Git (the
`git rev-parse` of synthesized isolation, the ledger and merge target checks) and merge previews,
and `rehearsal.onWorktree` observes each synthesized isolated call and merge; a `processRunner` that
spawns nothing yields placeholder bases. `HarnessRequest.call` carries `runId`, `stepId`, cumulative
`attempt`, and stable `idempotencyKey: runId/stepId`; it is attached inside the effect after
fingerprinting. `HarnessRequestInput` is the identity-free input accepted by `CliHarness.plan()` and
direct adapter calls. Planning image calls requires `imageAttachments` containing the already
captured bytes; normal runtime/direct execution captures them before planning. A plan is JSON data
and creates no files or processes. Actual invocation materializes only its indexed artifact
references, then cleans them up.

Native CLI attempts receive `QUIET_CHOIR_RUN_ID`, `QUIET_CHOIR_STEP_ID`, `QUIET_CHOIR_ATTEMPT`, and
`QUIET_CHOIR_IDEMPOTENCY_KEY` environment variables. These are routing/diagnostic metadata, not
native deduplication or conversation resumption.

Repository-only executable tools `test/bin/fake-claude.mjs` and `test/bin/fake-codex.mjs` replay
version-tagged real envelopes from `test/fixtures/harness/` with their captured exit codes. Use
`--harness-config` to select their absolute executable paths. Set `QUIET_CHOIR_FAKE_SCENARIO` to a
capture basename, or `QUIET_CHOIR_FAKE_ROUTES` to a JSON file such as:

```json
{
  "version": 1,
  "calls": [
    { "step": "review/*", "scenario": "codex-invalid-schema" },
    { "prompt": "summarize", "scenario": "claude-text-success" }
  ]
}
```

Routes are first-match, support an optional harness, and use a regular expression for `prompt`.
Defaults are the harness's text/structured success captures. `QUIET_CHOIR_FAKE_LOG` appends JSONL
with argv, cwd, stdin, schema, call identity, scenario, and CLI version. Use shell environment
variables or declared profile environments, respecting strict-profile rules. Logs contain complete
prompts and schema data. These tools need a repository checkout; there is no `quiet-choir/testing`
export. The root entry point remains the public package boundary; native protocol fakes require a
checkout.

`npm run test:contract` is an opt-in zero-cost native contract job, separate from normal CI and the
older paid Claude schema matrix. Build first, then optionally use `-- --refresh` to rewrite the
corpus or `-- --cases=codex-reconnect-success` to select cases. It runs installed CLIs with fake
keys, clean environments, isolated configuration, no inherited hooks/MCP, and local fake Messages
and Responses APIs. It checks real envelopes, exit codes, reconnection, and parsing; it does not
claim that a fake server validates provider schemas or prices. Review refreshed sanitized captures
before committing them. Ordinary tests replay the corpus and never need native authentication.

A rehearsal that reaches `ask`/`approve` stops with exit 75 and includes question presentation in
the suspended result. It never synthesizes a human approval. Its `rehearsal` report warns that
temporary state was removed; `stateDir`, `resumeCommand`, and each `answerCommand` are null. Start a
real run before requesting and delivering the decision. Later branches have not been rehearsed.
Local callbacks before the question still ran unless explicitly stubbed.

The opt-in `npm run test:contract:isolation` uses installed native CLIs with fresh temporary homes,
dummy keys, and local fake APIs to verify restricted configuration behavior without upstream
inference. See the [isolation guide](harness-isolation.md).
