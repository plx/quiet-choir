# Embedding and extensions

## Embed the runtime

The public entry point exports `defineWorkflow`, `z`, `runWorkflow`, `readRun`, `CliHarness`, and
their public types. `runWorkflow` validates the definition's data but does not typecheck/import a
file for you. It resolves with a typed completed run record and throws on failure. Recorded
execution failures are saved before it throws; earlier loading/compatibility errors need not create
or alter a run.

Supply `runId` and input matching the schema. Unlike the CLI's default `{}`, omitted embedded input
is undefined for a new run; on resume it uses the saved input. Optional dependencies are `harness`,
`cwd`, `stateDir`, `signal`, `fingerprint`, and `onEvent`. Local-only workflows need no harness.
`readRun({ runId, cwd, stateDir })` shares execution's path resolution and storage default;
`resolveStateDir({ cwd, stateDir })` returns the absolute directory.

The core validates explicit agent options before recording a step, using exported
`claudeOptionsSchema` and `codexOptionsSchema`. These schemas are also used by `CliHarness` and add
no defaults. Top-level undefined option values are omitted. Invalid remaining data names the step
and JSON path; invalid options name the field and value. Correcting an option before its step was
recorded permits an embedded resume when the other compatibility checks still match. CLI source
edits still change the code fingerprint.

```ts
import { defineWorkflow, runWorkflow, z, type Harness } from 'quiet-choir';

const workflow = defineWorkflow({
  name: 'adapter-example',
  version: '1',
  input: z.object({}),
  output: z.object({ label: z.string() }),
  async run(ctx) {
    const result = await ctx.codex.object('label', {
      prompt: 'Return a short label.',
      schema: z.object({ label: z.string() }),
    });
    return result.output;
  },
});

const fixtureHarness: Harness = {
  async invoke(_request, signal) {
    signal.throwIfAborted();
    return {
      text: JSON.stringify({ label: 'fixture' }),
      sessionId: null,
      usage: { inputTokens: null, outputTokens: null, costUsd: null },
    };
  },
};

const run = await runWorkflow(workflow, {
  runId: 'adapter-example',
  input: {},
  harness: fixtureHarness,
  fingerprint: 'adapter-example-v1',
});
console.log(run.output.label);
```

This fake harness performs no paid calls. Use `new CliHarness()` for real installed CLIs. Its
options are `claudeBinary`, `codexBinary`, `maxOutputBytes` (default 8 MiB combined stdout/stderr),
and `killGraceMs` (default 250 ms between SIGTERM and SIGKILL). Those adapter settings are not
automatically added to the workflow fingerprint; account for semantic changes in your version or
caller-supplied fingerprint.

## Implement an integration

Implement `Harness.invoke(request, signal): Promise<HarnessResponse>`. The request carries a
`provider` discriminator (`claude` or `codex`), its typed `options`, an absolute `cwd`, and
`outputSchema` (JSON Schema or null for text). Honor cancellation, reject process/protocol failures,
and return `{ text, sessionId, usage }`. For structured calls, `text` must contain the serialized
JSON value; the runtime parses it, validates it, and checkpoints the result.

`CliHarness` owns the documented 120-second timeout, tool, turn, budget, and sandbox defaults. The
core does not fill them in. Custom implementations must supply their own defaults and enforce
deadlines as well as cancellation.

The adapter owns one fresh invocation, not retries, run locks, or checkpoint storage. Missing usage
measurements and native IDs should be null. Do not treat a process's zero exit status as sufficient
if its protocol reports failure. Exercise adapters with fake executables and protocol fixtures
before making real calls.

The provider union and `ctx.claude`/`ctx.codex` clients are currently fixed. A custom `Harness` can
replace their transport/integration; adding `ctx.someOtherProvider` requires an explicit core API
change. There is no runtime registry for arbitrary providers, storage backends, or middleware.

## Reuse workflow logic

Ordinary async functions taking `WorkflowContext` and an ID prefix are the extension mechanism for
multi-step helpers. Call them at the workflow level and derive stable child IDs from the prefix. Use
`ctx.step` for individual local effects. Do not wrap a multi-step helper in another durable step,
and do not run effects at module import time.

For source changes in a checkout, `src/index.ts` is the deliberate public boundary. Runtime policy
lives behind the `Harness` contract; adapters depend on it, not the reverse. CLI executors consume
plain-data plans/results outside oclif. The workflow compiler embeds TypeScript 6's stable API,
while the repository build uses TypeScript 7; these are separate roles.

## Agent plugins versus runtime extensions

The repository distributes two documentation plugins: a portable Agent Plugins package for general
agents (including Codex), and a Claude Code package. These packages supply skills and references;
they do not register runtime providers or bundle the engine. Their skill files are physically
separate and may evolve independently.

When extending either documentation package, keep installed references inside that skill's
`references/` directory and link them from `SKILL.md`. Do not link to files outside the installed
plugin or assume its cache directory is a runtime checkout. Keep runtime API claims grounded in the
implementation; research proposals are not supported features.
