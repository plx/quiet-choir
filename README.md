# quiet-choir

Write agent workflows in TypeScript. Call Claude Code and Codex through dedicated typed APIs, use
ordinary loops and branches, and resume from local checkpoints after a failure.

**Status: serious prototype spike, version 0.0.0, private package.** The CLI, runtime, and both
harness adapters work. This is a local execution engine with at-least-once effects, not a production
service.

## Agent documentation

For agents working on this repository, start with [AGENTS.md](AGENTS.md). To teach an agent to use
quiet-choir, install its [Claude Code or Codex reference plugin](docs/plugins.md). Each plugin
bundles a concise skill with topic-specific references for authoring, harness options, durability,
inspection, and extensions; the runtime is installed separately.

## Try it without an agent subscription

Use Node.js 24.x (recommended), 22.x from 22.13, or 26.x, and npm 10.9+. Node 23.x and 25.x are
unsupported. Run these bundled examples from the checkout root.

```sh
npm ci
npm run build
qc_state_dir="$(mktemp -d)"
npm run cli -- workflow execute examples/local.workflow.ts --run-id first --state-dir "$qc_state_dir"
npm run --silent cli -- workflow inspect first --state-dir "$qc_state_dir" --json
```

The local example uppercases words with bounded parallelism and checkpoints the results. To see
recovery, deliberately fail its final step, then resume with the same command and `--resume`:

```sh
qc_recovery_state_dir="$(mktemp -d)"
npm run cli -- workflow execute examples/local.workflow.ts \
  --run-id recovery --state-dir "$qc_recovery_state_dir" --input '{"failOnce":true}'
# Expected: exit 1, after the word steps have completed.

npm run --silent cli -- workflow inspect recovery --state-dir "$qc_recovery_state_dir" --json
npm run cli -- workflow execute examples/local.workflow.ts \
  --run-id recovery --state-dir "$qc_recovery_state_dir" --resume
# Word steps replay from disk; only the failed summary step executes again.
```

The CLI prints the run ID before executing. Without `--run-id`, it generates one. Reusing an
existing ID requires `--resume`; a completed run returns its saved output without calling any
harness. Keep the absolute state directory for inspection and resume.

The CLI launch directory becomes the recorded run `cwd`, the base for relative FILE and
`--state-dir` paths, the default `.quiet-choir/runs`, and agent calls' relative `cwd`. Resume must
use that same directory; there is no `--cwd` flag. `npm run cli --` launches from this checkout even
when run in a subdirectory. For work in another project, change to that project and invoke
`node /absolute/path/to/quiet-choir/bin/run.js workflow …`, or use `npx --no-install quiet-choir`
where the package is already installed. An agent option's absolute `cwd` is accepted without
confinement and must name an existing directory.

## Author a workflow

Workflows default-export `defineWorkflow(...)`. Input, final output, and structured agent responses
use [Zod](https://zod.dev/) schemas for TypeScript inference and runtime validation. Callback return
types also affect inference: a wider `T | undefined` can typecheck, then fail final validation after
paid calls. An explicit `Promise<z.infer<typeof Output>>` return annotation or `ctx.step<string>(…)`
can catch that mistake earlier.

```ts
import { defineWorkflow, z } from 'quiet-choir';

export default defineWorkflow({
  name: 'review-label',
  version: '1',
  input: z.object({ topic: z.string() }),
  output: z.object({ label: z.string(), accepted: z.boolean() }),
  async run(ctx, input) {
    const proposal = await ctx.claude.object('propose', {
      prompt: `Suggest a short label for: ${input.topic}`,
      model: 'haiku',
      schema: z.object({ label: z.string() }),
    });
    const review = await ctx.codex.object('review', {
      prompt: `Is this label clear? ${proposal.output.label}`,
      schema: z.object({ accepted: z.boolean() }),
    });
    return { label: proposal.output.label, accepted: review.output.accepted };
  },
});
```

The checked-in [duet example](examples/duet.workflow.ts) is a small real two-harness workflow:

```sh
npm run --silent cli -- workflow validate examples/duet.workflow.ts --json
qc_duet_state_dir="$(mktemp -d)"
npm run cli -- workflow execute examples/duet.workflow.ts \
  --run-id duet --state-dir "$qc_duet_state_dir" --input '{"topic":"durable agent workflows"}'
```

Install and sign in to `claude` and `codex` separately. The adapters invoke the installed CLIs and
inherit their authentication and configuration; no separate provider API key is required. The source
examples import `../src/index.js` so they work directly in this private repository. An installed
consumer imports `quiet-choir` as above.

## Operations

| API                                             | Behavior                                                                |
| ----------------------------------------------- | ----------------------------------------------------------------------- |
| `ctx.claude.text(id, options)`                  | Durable Claude text result                                              |
| `ctx.claude.object(id, { schema, ...options })` | Durable, validated Claude structured result                             |
| `ctx.codex.text` / `ctx.codex.object`           | Equivalent Codex APIs with Codex-specific options                       |
| `ctx.step(id, { input, schema, run, retry? })`  | Checkpoint a local effect; explicit dependencies detect replay drift    |
| `ctx.map(items, concurrency, mapper)`           | Bounded fan-out, ordered results; use unique step IDs inside the mapper |
| `ctx.sleep(id, milliseconds)`                   | Persist a wake time and wait only the remaining time after resume       |

Agent results contain `output`, native `sessionId`, and reported token/cost `usage`. Native session
IDs are for correlation only: `CliHarness` uses Claude `--no-session-persistence` and Codex
`--ephemeral`, so these calls have no persisted local session transcript. Each effect starts fresh.
`object` sends JSON Schema to the harness and validates the returned JSON locally. Codex defaults to
`structuredOutput: 'compat'`: optional properties become nullable on the wire, non-object roots are
wrapped, records use key/value entries (enum-keyed records require all keys), discriminated unions
use `anyOf`, and loose objects are closed. The adapter reverses these encodings before the original
Zod validation; nullable optionals retain null, while other optional nulls become absent properties.
Unknown keys are not requested for loose objects. Tuples are rejected locally; use named object
properties.

Choose `structuredOutput: 'strict'` to send a native Codex schema: use an object root, make every
property required (use `.nullable()` for missing values), and avoid records, loose objects,
discriminated unions, and tuples. `checkCodexSchema(schema)` returns JSON paths and fixes before a
workflow runs. `workflow validate` cannot inspect call-site schemas without running the body.
Refinements are enforced locally, so repeat them in the prompt. Schema transforms and class-valued
schemas cannot be converted to JSON Schema. `z.date()`, `z.void()`, `z.undefined()`, and
`z.bigint()` also fail conversion when their operation runs; `validate` checks only workflow
input/output. Use `z.null()` and return `null` for side-effect-only steps. Claude receives the
original schema and also requires an object root; other Codex restrictions and wire transforms do
not apply to it.

A local effect might use `ctx.step('read', { input: { path }, schema: z.string(), run: ... })`.
Callbacks receive `{ signal, attempt, idempotencyKey }`. Opt into retries only for repeatable
effects, with `retry: { maxAttempts: 3, delayMs: 100 }`; delays double up to 30 seconds. Agent
effects also accept explicit retry policies; the default is one attempt. A later explicit resume
retries unfinished effects, including failed agent calls. `ctx.runId` and `ctx.signal` expose run
identity and cancellation. Only local callbacks receive `idempotencyKey`; agent calls have none and
can repeat edits. Step dependencies, prompts, and identity options are stored as component hashes,
alongside the full validated result. Resolved policy, requested model/effort, and provenance are
recorded per attempt.

For embedding, call `runWorkflow(definition, { runId, input, harness: new CliHarness() })`. Its
output is typed from the workflow schema. Supply `signal`, `stateDir`, `cwd`, `onEvent`, and a code
`fingerprint` as needed. The core depends on a `Harness` interface, so tests and alternative
integrations can replace subprocesses without changing workflows. Read the saved record with
`readRun({ runId, cwd, stateDir })`; both APIs default to `<cwd>/.quiet-choir/runs` and resolve a
relative `stateDir` against `cwd`. `resolveStateDir({ cwd, stateDir })` returns that absolute path.
An `onEvent` observer may return `void` or `Promise<void>`; it is not awaited, and both synchronous
throws and rejected promises are ignored.

Explicit agent options are validated before recording the step, using the exported
`claudeOptionsSchema` and `codexOptionsSchema` also used by `CliHarness`. Top-level undefined option
values are omitted. Other invalid JSON names the step and offending JSON path. Embedded callers can
correct an invalid option and resume when no step was recorded; CLI source edits still change the
workflow fingerprint. Call-site validation runs during execution, not during `workflow validate`.

To recover a timeout without editing CLI workflow source, resume with a sticky policy override:

```sh
node "$QC_CHECKOUT/bin/run.js" workflow execute review.workflow.ts \
  --run-id review-1 --state-dir "$qc_state_dir" --resume \
  --policy '{"match":"review","timeoutMs":600000}'
```

Use the original launch directory, state path, and absolute `QC_CHECKOUT`. Completed steps replay;
only unfinished calls use the new deadline. Repeat `--policy` for ordered rules; later matching
fields win over call-site options and adapter defaults. `--policy-reset` clears saved rules. A bare
resume retains them. `model` and `reasoningEffort` overrides require `--allow-model-override` when
added; completed calls never rerun because of policy. Embedded callers use `RunOptions.policy`,
`policyReset`, and `allowModelOverride`, or edit call-site limits without changing their source
fingerprint. Globs use `*` within segments and `**` across `/`.

`CliHarness` defaults to 15 minutes, 25 Claude turns, and the unchanged $0.25 Claude per-call
budget. Custom harnesses report known limits through optional `policyDefaults(provider)`; unknown
defaults are not invented. `inspect --json` exposes saved rules and each step's `attemptHistory`,
including resolved policy and its sources. New checkpoints use version 2. Version 1 remains
inspectable but cannot resume with this runtime; retain the original runtime or choose a new run ID.
See [the policy decision](docs/decisions/0005-step-identity-and-policy.md).

## Durability contract

- The workflow body replays from the beginning. Keep orchestration deterministic; put file reads,
  randomness, clocks, network calls, and other effects inside steps. Await every workflow operation.
  The runner drains launched operations and their immediate continuations before releasing the lock.
  Ignored operation failures fail the run even if they settled before the body returned. Awaited and
  caught failures may be handled by the workflow; arbitrary detached async tasks remain the caller's
  responsibility.
- Step IDs are unique within a run, including loop iterations and helper functions. Do not nest
  steps inside a step callback. Compose them with ordinary TypeScript functions at the workflow
  level.
- Completed effects are reused by ID and semantic component hashes (kind, input/prompt, schema,
  model/effort, capabilities, and resolved cwd). Errors name changed components. Timeout, turn,
  budget, and retry policy do not affect identity. Unfinished identities may change with history
  retained; unvisited unfinished records become `superseded`. Every completed step must still be
  visited. That check runs after the body, so divergent control flow may perform new effects first.
- The CLI also hashes local compiler-discovered dependencies and the nearest tsconfig. Inputs,
  workflow name/version, schema fingerprint, and working directory must match on resume. **Bump the
  workflow version when dependency packages, environment/configuration, or other semantics change.**
  Dynamic imports assembled at runtime, external files, and node_modules are not fully
  fingerprinted.
- Results must be lossless JSON. Undefined, NaN, infinities, negative zero, functions, cycles,
  sparse arrays, getters, and class instances are rejected. Checkpoints contain data, never
  callbacks.
- Checkpoints use flushed temporary files, atomic rename, and an exclusive local writer lock. Dead
  local owners can be recovered; live or foreign-host owners are refused. Incomplete lock metadata
  or an abandoned recovery requires inspection and manual cleanup. Acquiring the lock removes only
  that run's abandoned `<runId>.json.<uuid>.tmp` files. Use a local POSIX filesystem.
- Transient checkpoint writes retry briefly. Persistent storage errors stop new effects and never
  retry a successful action in-process. `CheckpointError` identifies save/release failures; combined
  errors preserve the workflow's original cause. A failed save can leave `running` with
  `error: null`. After a saved completion, cleanup `EACCES`/`ENOENT` becomes a returned warning (CLI
  stderr); changed or uncertain ownership remains fatal. Cleanup warnings are not checkpointed.
- Effects are **at least once**. An external action can succeed without being saved after a crash or
  hard kill. Cancellation by Ctrl-C, SIGTERM, a failing map sibling, or an uncaught failure can also
  discard a result that arrives after cancellation: the step is saved as `failed` and repeats on
  resume. Agent calls stopped by cancellation or deadlines may already have edited files.
  Storage-triggered aborts preserve successful results for a later save, as described above. Only
  `ctx.step` callbacks get `idempotencyKey` for deduplication with compatible external systems.
  Native harness conversation state and workspace mutations are not transactional.
- Cancellation cooperatively aborts active work and drains it before releasing ownership. Local
  callbacks must honor their signal. A failed map cancels the run and stops scheduling more items.
  One Ctrl-C or SIGTERM drains and exits 130. A second Ctrl-C kills the runner mid-drain and can
  leave a lock and `running` record. SIGKILL, SIGHUP (closed terminal or dropped SSH), or a crash
  can leave detached harness children running and editing. Before resuming, check
  `pgrep -fl 'claude --print|codex exec'` for children belonging to the interrupted run.

This spike has no background scheduler, distributed workers, execution migration, human-approval
inbox, durable event delivery, global spending ledger, or automatic worktree isolation. Sleep waits
in the current process. Checkpoints contain plaintext workflow input/output, every completed step's
full validated result (including agent responses and files a step read), and errors. Files are
created 0600 and state/lock directories 0700; existing directory permissions are not repaired.
`.quiet-choir/` is gitignored only in this repository; exclude chosen storage in other projects too.

## Harness defaults and limits

`CliHarness` applies these defaults; the core supplies none. Custom `Harness` implementations own
their defaults and must enforce deadlines. Claude defaults to no built-in tools, `dontAsk`
permissions, 25 turns, and a $0.25 per-call budget. Explicitly enable and allow tools through
`tools` and `allowedTools`. MCP tools from config still load; `allowedTools` adds pre-approvals to
settings allow rules, and `dontAsk` denies the rest. Codex defaults to a read-only sandbox and
approvals set to `never`; opt into `workspace-write` per call. Both have a 15-minute wall-clock
limit and an 8 MiB combined output limit. Codex does not expose an equivalent per-call USD cap here.
Model selection is explicit or inherited from the installed harness. Codex `reasoningEffort` accepts
only `minimal|low|medium|high` here. Codex 0.157.1 also recognizes `none`, `xhigh`, and `max`;
per-model support is unverified. Omission can inherit an expensive configured level. The byte cap
counts the whole stdout/stderr stream, including command output; CLI runs cannot raise it, while
embedders can set `CliHarnessOptions.maxOutputBytes`. A call may hit the cap after editing files.

Prompts go over stdin without a shell. Timeouts and cancellation terminate process groups on
macOS/Linux; Windows cleanup reaches the immediate child only. These flags do not sandbox the
workflow's own TypeScript or isolate inherited hooks, MCP servers, and harness configuration. Use
trusted workflow files and a working directory/configuration suitable for the task. Claude's `cwd`
selects project `.claude/` settings and hooks; `claude -p` skips the trust dialog, so hooks can run
in never-trusted directories.

Saved harness errors include reasons recovered from stdout on both zero and nonzero normal exits,
with bounded stderr and exit metadata. A bare exit error means no usable protocol reason was found;
check `claude auth status` / `codex login status`, schemas, and the invocation flags. Failed
protocol attempts can retain usage/session metadata; this is still an incomplete spending ledger.
Claude's input count is the top-level field, excluding cache reads/writes and not summing
`modelUsage`; Codex's cache-inclusive interpretation is inferred, not verified by a live cache
comparison. Do not compare those input counts directly. Codex cost is null; Claude cost uses
`total_cost_usd`.

## CLI and development

```sh
npm run cli -- workflow typecheck examples/local.workflow.ts
npm run --silent cli -- workflow validate examples/local.workflow.ts --json
npm run --silent cli -- workflow inspect recovery --state-dir "$qc_recovery_state_dir" --json
npm run check
```

The inspection command reuses the earlier recovery example's state directory. `npm run cli` runs
`dist/`; rebuild after changing `src/`. `cli:dev` also discovers `dist/commands`, because the
current tsconfig lacks a `rootDir`/`outDir` mapping for oclif. The nearest tsconfig in or above a
workflow applies and is fingerprinted; under this checkout, unused variables can block execution.

`execute` typechecks before importing the workflow. `validate` typechecks and verifies its export
contract without calling `run`; importing either command's workflow **executes module top-level
code**. `typecheck` performs no imports or effects. `inspect` reads a saved run without importing
workflow code. A missing run reports the absolute storage directory and available run IDs. Use
`--state-dir PATH` for alternate storage and `--json` for machine-readable output. Do not write to
stdout from workflow code when consuming JSON CLI output. `--json` emits one result line only on
success: a run record for execute/inspect, or `{kind, ok, entrypoint, workflow}` for validate. A
failed execute emits no result JSON; use stderr and inspect any saved checkpoint. Generated run IDs
appear only on stderr, so scripts should supply `--run-id`. Module-level output precedes JSON.
Validate reports a source hash; a saved run's fingerprint also hashes schemas and is different.

Inherited `--log-level trace|debug|info|warn|error|fatal|silent` and `-v, --verbose` go after the
command name and are mutually exclusive. Configuration commands remain explicit stubs (exit 2);
layered project/user settings are deferred.

| Exit | Meaning                                                                                                                                                                                          |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 0    | Success, including inspection of `failed`/`running` records (check `.status`). Misplaced flags between `workflow` and its command can print help and exit 0.                                     |
| 1    | Type/import/workflow errors, missing FILE, invalid run ID, run ownership/existence errors, or incompatible resume/input. Invalid IDs are checked after module import. Read stderr for the cause. |
| 2    | Flag/input-JSON errors, resume without a run ID, non-TypeScript/declaration entrypoints, or configuration stubs.                                                                                 |
| 130  | SIGINT/SIGTERM during execution; cancellation drains and saves `failed` when storage is available.                                                                                               |

`npm run check` includes formatting, lint, strict typechecking, tests with coverage gates, build,
compiled CLI smoke tests, TypeDoc validation, and package checks. No automated test calls a paid
harness. Structured-output success paths for both adapters completed live with claude 2.1.283 and
codex-cli 0.157.1; this is evidence for those versions, not a guarantee.

Read [Architecture](docs/architecture.md), the
[durability decision](docs/decisions/0002-durable-external-workflows.md), and
[Claude API research](docs/research.md) for the reasoning and evidence behind the spike. See
[CONTRIBUTING.md](CONTRIBUTING.md) and [SECURITY.md](SECURITY.md) for repository conventions.

## Workflow comparison lab

The [Workflow Lab](comparisons/README.md) contains versioned, side-by-side comparisons of 26
original Claude Code workflows and their direct Quiet Choir ports. It includes per-workflow notes,
inert equivalence fixtures, and the source for the privately published comparison site.

## License

[MIT](LICENSE)
