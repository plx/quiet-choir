# Rehearse before you pay

Run the workflow body with free agent responses before launching installed CLIs. Validation alone
checks input/output schemas; rehearsal also reaches call-site schemas, IDs, options, JSON values,
and dynamic branches. The CLI uses the same source fingerprint for fixture and native execution.

```sh
node bin/run.js workflow validate examples/duet.workflow.ts --json
node bin/run.js workflow execute examples/duet.workflow.ts \
  --input '{"topic":"durable agent workflows"}' --dry-run --json > rehearsal.json
# Inspect the calls, prompts, schemas, argv, limits, warnings, and reached branches.
node bin/run.js workflow execute examples/duet.workflow.ts \
  --input '{"topic":"durable agent workflows"}' --run-id duet
```

`--dry-run` invokes no Claude/Codex executable, version discovery, or OS owner-identity probe.
Checkpoint files live in a private temporary directory removed when the executor finishes. The
normal/default state directory is not created. Typechecking/importing still run normally. **Local
callbacks and top-level workflow code execute for real.** Temporary checkpoints do not undo their
filesystem, subprocess, network, or external effects. Stub named local effects when needed:
`--stub-steps 'publish/**' --stub-steps 'notify/*'`. These patterns match fully qualified IDs; `*`
stays within a segment and `**` crosses segments. Matched callbacks receive synthesized results
through their original Zod validation; unmatched callbacks run normally. Durable sleeps complete
immediately. Rehearsal preserves capability/profile validation and still requires declared grants.

## Fixtures

`--harness cli` is the default. `--harness fixture:./fixtures.json` uses this versioned format:

```json
{
  "version": 1,
  "calls": [
    { "step": "triage", "output": { "severity": "high", "files": ["a.ts"] } },
    { "step": "review/2", "attempt": 1, "error": "simulated failure" },
    { "step": "review/*", "provider": "codex", "output": { "findings": [] } },
    { "step": "summary", "text": "Looks fine.", "usage": { "costUsd": 0.01 } }
  ],
  "unmatched": "error"
}
```

Rules use first-match order, with optional provider and cumulative attempt filters. Exactly one of
`output`, `text`, and `error` is required. `text` is the raw adapter response; structured calls
parse it as JSON. `output` is serialized for structured calls, while a string output on a text call
stays plain text. Missing usage fields become null. Results still pass normal parsing, Zod
validation, and checkpointing; stale fixtures fail at their named step. Missing rules fail with the
step, provider, and attempt unless `unmatched` is `synthesize`.

Fixture execution writes ordinary durable records. Use `--dry-run --harness fixture:./fixtures.json`
for temporary state, immediate sleeps, and synthesis of unmatched calls regardless of the file's
`unmatched` setting. Fixture overrides can direct branches and supply data that synthesis cannot.

Export successful agent outputs from a completed run without importing its workflow or acquiring its
lock:

```sh
node bin/run.js workflow fixtures duet --json > fixtures.json
node bin/run.js workflow execute edited.workflow.ts \
  --dry-run --harness fixture:./fixtures.json --json
```

Export skips local/sleep effects and settled failures; successful agent outputs retain provider and
usage but do not pin an attempt number. It does not modify the source checkpoint.

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

- `calls`: attempted live calls in invocation order, with full step ID, cumulative attempt,
  provider, cwd, prompt, original schema, output source (`fixture` or `synthesized`), fixture index,
  process plan, resolved limits, and planning/fixture error when present.
- `plan`: binary, argv, stdin, cwd, process limits, and private-file placeholders. File contents are
  omitted from the report. The same pure `CliHarness.plan()` validates real invocations, including
  Codex strict-schema checks, before materializing private files.
- `replays`: reused effect IDs/kinds. Their full original prompts were never saved, so they do not
  appear as new live calls. A completed-run preview lists all reused terminal effects.
- `providerCounts`, `nominalClaudeCeilingUsd`, `stubbedSteps`, `skippedSleeps`, and `warnings`.

The nominal Claude ceiling adds per-attempt `maxBudgetUsd` for valid native plans along the
rehearsed path. `wouldPay` is false when planning itself fails before a native invocation could
start. It is not a price quote or a hard spending guarantee: final-turn costs can overshoot CLI
budgets, synthesized one-item arrays can understate fan-out, and unvisited branches are absent.
Codex calls have no budget flag and are counted without pricing. Reports contain full
prompts/output; handle them as sensitive workflow data.

Failures keep the normal [CLI error document and exits](cli-contract.md), adding `rehearsal` and
`error.stack`. `error.stepId` also identifies authoring failures that occur before a step record is
created. The report's failure checkpoint is an in-memory copy: its temporary `stateDir` has been
removed, so use a fresh rehearsal to retry. An abrupt kill can leave temporary files behind.

## Preview resume and choose a harness

```sh
node bin/run.js workflow execute workflow.ts \
  --dry-run --resume --run-id real-run --json
```

The executor copies the source record into temporary storage, then runs ordinary compatibility,
input, step-identity, and replay checks. Completed effects return their real saved outputs;
unfinished effects use fixtures or synthesis. Source locks/process registries are neither copied nor
recovered. Fork sources remain read-only. `--accept-code-change` and `--strict-replay` retain their
normal meanings. A preview deliberately allows the harness change only in its disposable copy; it
never grants future native execution.

New records save `harness.kind`: `cli`, `fixture`, `dry-run`, `custom` for an unnamed embedded
adapter, or `none` without an adapter. A different kind on resume or fork requires
`--allow-harness-change` (embedding: `allowHarnessChange: true`), even on the completed-run fast
path. This prevents accidental reuse of simulated outputs as native results. It does not establish
trust in arbitrary executable adapters. Custom adapters should give distinct modes explicit `kind`
values. Actual changed executions retain `previousKinds`; completed fast-path reads retain their
original provenance. Earlier format-6 records have no kind, so they remain resumable without
guessing their historical adapter. Pre-rehearsal fingerprints are unchanged.

Configure CLI executable paths and process limits with inline JSON or a file:

```sh
node bin/run.js workflow execute workflow.ts \
  --harness-config '{"claudeBinary":"./fake-bin/claude","maxOutputBytes":33554432}'
node bin/run.js workflow execute workflow.ts --dry-run --harness-config @harness.json --json
```

Allowed keys are `claudeBinary`, `codexBinary`, `maxOutputBytes`, and `killGraceMs`; other keys and
invalid limits fail before workflow import. Relative file/binary paths resolve against the launch
cwd. Bare executable names use PATH. Explicit `--kill-grace-ms` overrides the config field.
`--harness-config` also configures the dry-run planner; ordinary fixture execution gets its data
from the fixture file. `module:` loading is deferred to #64.

## Embedding and native protocol tests

The root entry point exports `FixtureHarness`, `parseHarnessFixtures`, `HarnessFixtures`,
`FixtureCall`, and `synthesizeOutput`. Supply `new FixtureHarness(fixtures)` to `runWorkflow` for
durable fixture execution. `HarnessRequest.call` carries `runId`, `stepId`, cumulative `attempt`,
and stable `idempotencyKey: runId/stepId`; it is attached inside the effect after fingerprinting.
`HarnessRequestInput` is the identity-free input accepted by `CliHarness.plan()` and direct adapter
calls. Planning image calls requires `imageAttachments` containing the already captured bytes;
normal runtime/direct execution captures them before planning. A plan is JSON data and creates no
files or processes. Actual invocation materializes only its indexed artifact references, then cleans
them up.

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

Routes are first-match, support an optional provider, and use a regular expression for `prompt`.
Defaults are the provider's text/structured success captures. `QUIET_CHOIR_FAKE_LOG` appends JSONL
with argv, cwd, stdin, schema, call identity, scenario, and CLI version. Use shell environment
variables or declared profile environments, respecting strict-profile rules. Logs contain complete
prompts and schema data. These tools need a repository checkout; there is no `quiet-choir/testing`
export. See [ADR 0016](decisions/0016-workflow-rehearsal.md).

`npm run test:contract` is an opt-in zero-cost native contract job, separate from normal CI and the
older paid Claude schema matrix. Build first, then optionally use `-- --refresh` to rewrite the
corpus or `-- --cases=codex-reconnect-success` to select cases. It runs installed CLIs with fake
keys, clean environments, isolated configuration, no inherited hooks/MCP, and local fake Messages
and Responses APIs. It checks real envelopes, exit codes, reconnection, and parsing; it does not
claim that a fake server validates provider schemas or prices. Review refreshed sanitized captures
before committing them. Ordinary tests replay the corpus and never need native authentication.
