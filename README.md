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

Use Node.js 24 LTS (also supported: 22.13+ and 26) and npm 10.9+.

```sh
npm ci
npm run build
npm run cli -- workflow execute examples/local.workflow.ts --run-id first
npm run cli -- workflow inspect first
```

The local example uppercases words with bounded parallelism and checkpoints the results. To see
recovery, deliberately fail its final step, then resume with the same command and `--resume`:

```sh
npm run cli -- workflow execute examples/local.workflow.ts \
  --run-id recovery --input '{"failOnce":true}'
# Expected: exit 1, after the word steps have completed.

npm run cli -- workflow execute examples/local.workflow.ts --run-id recovery --resume
# Word steps replay from disk; only the failed summary step executes again.
```

The CLI prints the run ID before executing. Without `--run-id`, it generates one. Reusing an
existing ID requires `--resume`; a completed run returns its saved output without calling any
harness.

## Author a workflow

Workflows default-export `defineWorkflow(...)`. Input, final output, and structured agent responses
use [Zod](https://zod.dev/) schemas for both TypeScript inference and runtime validation.

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
npm run cli -- workflow validate examples/duet.workflow.ts
npm run cli -- workflow execute examples/duet.workflow.ts \
  --run-id duet --input '{"topic":"durable agent workflows"}'
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
IDs are diagnostic metadata; each effect starts a fresh harness session. `object` sends JSON Schema
to the harness and validates the returned JSON locally. Codex defaults to
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
schemas cannot be converted to JSON Schema. Claude receives the original schema and also requires an
object root; other Codex restrictions and wire transforms do not apply to it.

A local effect might use `ctx.step('read', { input: { path }, schema: z.string(), run: ... })`.
Callbacks receive `{ signal, attempt, idempotencyKey }`. Opt into retries only for repeatable
effects, with `retry: { maxAttempts: 3, delayMs: 100 }`; delays double up to 30 seconds. Agent
effects have no automatic retries. A later explicit resume retries unfinished effects, including
failed agent calls.

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
- Completed effects are reused by ID and an input/options/schema fingerprint. A changed fingerprint,
  duplicate ID, or skipped recorded step fails instead of silently reusing incompatible results.
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
- Effects are **at least once**: if a process dies after an external action succeeds but before its
  result is saved, resume can repeat it. Use `idempotencyKey` with external systems that support
  deduplication. Hard-killing the runner may also leave harness children running; stop them before
  resuming. Native harness conversation state and workspace mutations are not transactional.
- Cancellation cooperatively aborts active work and drains it before releasing ownership. Local
  callbacks must honor their signal. A failed map cancels the run and stops scheduling more items.

This spike has no background scheduler, distributed workers, execution migration, human-approval
inbox, durable event delivery, global spending ledger, or automatic worktree isolation. Sleep waits
in the current process. Checkpoints store workflow input/output and error messages in plaintext with
restrictive creation modes; `.quiet-choir/` is gitignored.

## Harness defaults and limits

`CliHarness` applies these defaults; the core supplies none. Custom `Harness` implementations own
their defaults and must enforce deadlines. Claude defaults to no built-in tools, `dontAsk`
permissions, three turns, and a $0.25 per-call budget. Explicitly enable and allow tools through
`tools` and `allowedTools`. Codex defaults to a read-only sandbox and approvals set to `never`; opt
into `workspace-write` per call. Both have a 120-second wall-clock limit and an 8 MiB combined
output limit. Codex does not expose an equivalent per-call USD cap here. Model selection is explicit
or inherited from the installed harness.

Prompts go over stdin without a shell. Timeouts and cancellation terminate process groups on
macOS/Linux; Windows cleanup reaches the immediate child only. These flags do not sandbox the
workflow's own TypeScript or isolate inherited hooks, MCP servers, and harness configuration. Use
trusted workflow files and a working directory/configuration suitable for the task.

## CLI and development

```sh
npm run cli:dev -- workflow typecheck examples/local.workflow.ts
npm run cli:dev -- workflow validate examples/local.workflow.ts --json
npm run cli:dev -- workflow inspect recovery --json
npm run check
```

`execute` typechecks before importing the workflow. `validate` typechecks and verifies its export
contract without calling `run`; importing either command's workflow **executes module top-level
code**. `typecheck` performs no imports or effects. `inspect` reads a saved run without importing
workflow code. A missing run reports the absolute storage directory and available run IDs. Use
`--state-dir PATH` for alternate storage and `--json` for machine-readable output. Do not write to
stdout from workflow code when consuming JSON CLI output.

Inherited `--log-level trace|debug|info|warn|error|fatal|silent` and `-v, --verbose` go after the
command name and are mutually exclusive. Configuration commands remain explicit stubs (exit 2);
layered project/user settings are deferred.

`npm run check` includes formatting, lint, strict typechecking, tests with coverage gates, build,
compiled CLI smoke tests, TypeDoc validation, and package checks. No automated test calls a paid
harness. The prototype was live-tested with Codex 0.153.4 on a tiny structured response; Claude
2.1.252 returned an expired-OAuth error before inference, so its successful integration is verified
with fixtures only until credentials are refreshed.

Read [Architecture](docs/architecture.md), the
[durability decision](docs/decisions/0002-durable-external-workflows.md), and
[Claude API research](docs/research.md) for the reasoning and evidence behind the spike. See
[CONTRIBUTING.md](CONTRIBUTING.md) and [SECURITY.md](SECURITY.md) for repository conventions.

## License

[MIT](LICENSE)
